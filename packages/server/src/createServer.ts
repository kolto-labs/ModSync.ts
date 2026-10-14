/**
 * createModSyncServer: Fastify app wiring (CORS, auth, WebSocket, REST
 * routes, static web bundle with SPA fallback).
 */
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { registerRoutes } from "./routes/index.js";
import { AppState, HttpError } from "./state.js";
import type { ModSyncServer, ModSyncServerOptions } from "./types.js";
import { registerWebSocket } from "./ws.js";

export const BODY_LIMIT = 50 * 1024 * 1024;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** Origins allowed by CORS: any scheme/port on localhost, plus no-origin (curl, Electron file://). */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === "null") return true; // Electron file:// / sandboxed
  try {
    const u = new URL(origin);
    return LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Extract the bearer token from the Authorization header or `?token=`. */
export function tokenFromRequest(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1].trim();
  }
  const q = req.query as Record<string, unknown> | undefined;
  if (q && typeof q.token === "string" && q.token) return q.token;
  return undefined;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const NOT_BUILT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ModSync</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#ddd;background:#1b1d22}code{background:#2a2d34;padding:.1em .3em;border-radius:3px}</style>
</head><body>
<h1>ModSync server is running</h1>
<p>The web bundle is not built, so there is no UI to show here. Build it with
<code>pnpm --filter @modsync/web build</code> and restart, or point the server at a bundle with <code>--static &lt;dir&gt;</code>.</p>
<p>The REST API is available under <code>/api/*</code> (see <code>/api/health</code>).</p>
</body></html>
`;

export async function createModSyncServer(opts: ModSyncServerOptions = {}): Promise<ModSyncServer> {
  const state = new AppState({
    settingsPath: opts.settingsPath,
    electronBridge: opts.electronBridge,
    eventBufferSize: opts.eventBufferSize,
  });
  await state.init();

  const app: FastifyInstance = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: BODY_LIMIT,
    // Directory paths and GUIDs in params; keep the raw value.
    routerOptions: { ignoreTrailingSlash: true },
  });
  app.decorate("modsyncState", state);

  // Node's initial idle sweep misses preconnects and connections that become
  // idle after a request drains. End only idle HTTP sockets, never active ones.
  let closing = false;
  const httpSockets = new Map<Socket, number>();
  app.server.on("connection", (socket) => {
    if (closing) { socket.destroy(); return; }
    httpSockets.set(socket, 0);
    socket.once("close", () => httpSockets.delete(socket));
  });
  app.server.on("request", (request, response) => {
    const socket = request.socket;
    httpSockets.set(socket, (httpSockets.get(socket) ?? 0) + 1);
    response.once("finish", () => {
      const remaining = Math.max(0, (httpSockets.get(socket) ?? 1) - 1);
      if (!httpSockets.has(socket)) return;
      httpSockets.set(socket, remaining);
      if (closing && remaining === 0) socket.end();
    });
  });
  app.server.on("upgrade", (_request, socket) => httpSockets.delete(socket as Socket));

  await app.register(cors, {
    origin: (origin, cb) => cb(null, isLocalOrigin(origin)),
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    exposedHeaders: ["x-log-last-seq", "x-log-first-seq"],
  });
  // A destroyed renderer cannot acknowledge the WebSocket close handshake.
  // Bound that handshake so desktop shutdown does not wait ws's 30-second default.
  await app.register(websocket, { options: { maxPayload: 1024 * 1024, closeTimeout: 1_000 } });

  // Accept text bodies (markdown / TOML uploads) as strings in addition to JSON.
  app.addContentTypeParser(["text/plain", "text/markdown", "application/toml"], { parseAs: "string" }, (_req, body, done) => {
    done(null, { content: body });
  });

  app.addHook("onRequest", async (_request, reply) => {
    if (closing) reply.code(503).send({ error: "ShuttingDown", message: "Server is shutting down" });
  });

  // ------------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------------
  const token = opts.token;
  if (token) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.method === "OPTIONS") return;
      const url = req.raw.url ?? "";
      const protectedPath = url.startsWith("/api/") || url === "/api" || url.startsWith("/ws");
      if (!protectedPath) return;
      const presented = tokenFromRequest(req);
      if (!presented || !constantTimeEqual(presented, token)) {
        reply.code(401).send({ error: "unauthorized", message: "Missing or invalid token" });
      }
    });
  }

  // ------------------------------------------------------------------
  // Errors
  // ------------------------------------------------------------------
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send({ error: err.name, message: err.message });
      return;
    }
    const status = typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) state.logger.error(`${req.method} ${req.url} failed: ${err.stack ?? err.message}`);
    reply.code(status).send({ error: err.code ?? err.name ?? "Error", message: err.message });
  });

  // ------------------------------------------------------------------
  // Routes
  // ------------------------------------------------------------------
  registerRoutes(app, state);
  registerWebSocket(app, state);

  // ------------------------------------------------------------------
  // Static web bundle
  // ------------------------------------------------------------------
  const staticDir = opts.staticDir ? resolvePath(opts.staticDir) : undefined;
  const hasBundle = staticDir !== undefined && existsSync(join(staticDir, "index.html"));
  if (hasBundle) {
    await app.register(fastifyStatic, { root: staticDir, prefix: "/", wildcard: false, index: ["index.html"] });
    // Any other GET that is not an API call is a client-side route: serve the SPA shell.
    app.get("/*", async (req, reply) => {
      const url = req.raw.url ?? "/";
      if (url.startsWith("/api/") || url.startsWith("/ws")) {
        reply.code(404).send({ error: "NotFound", message: `Route ${req.method}:${url} not found` });
        return;
      }
      return reply.sendFile("index.html");
    });
  } else {
    if (staticDir) state.logger.warn(`web bundle not found at ${staticDir}; serving a placeholder page`);
    app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(NOT_BUILT_HTML));
  }

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({ error: "NotFound", message: `Route ${req.method}:${req.url} not found` });
  });

  let closeTask: Promise<void> | undefined;
  return {
    app,
    async listen(port: number, host: string): Promise<string> {
      await app.listen({ port, host });
      const addr = app.server.address();
      if (addr && typeof addr === "object") {
        const h = addr.family === "IPv6" && addr.address !== "::" ? `[${addr.address}]` : addr.address === "::" || addr.address === "0.0.0.0" ? "127.0.0.1" : addr.address;
        return `http://${h}:${addr.port}`;
      }
      return `http://${host}:${port}`;
    },
    close(): Promise<void> {
      if (closeTask) return closeTask;
      closing = true;
      closeTask = (async () => {
        opts.onShutdownStage?.("state-draining");
        await state.close();
        opts.onShutdownStage?.("state-drained");
        for (const [socket, active] of httpSockets) if (active === 0) socket.destroy();
        await app.close();
        // An admitted handler may have queued background work after the first drain.
        await state.close();
        opts.onShutdownStage?.("server-closed");
      })();
      return closeTask;

    },
  };
}

/** The AppState behind an app created by `createModSyncServer` (tests, embedding). */
export function stateOf(app: FastifyInstance): AppState {
  return (app as unknown as { modsyncState: AppState }).modsyncState;
}
