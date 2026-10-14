#!/usr/bin/env node
/**
 * Standalone entry: `node dist/main.js [--port 8471] [--host 127.0.0.1]
 * [--token <t> | --no-token] [--open] [--static <dir>] [--settings <path>]`.
 *
 * Exported as `runServerMain(argv)` so `modsync serve` can reuse it.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createModSyncServer } from "./createServer.js";
import type { ModSyncServer } from "./types.js";

export interface ServerCliOptions {
  port: number;
  host: string;
  /** undefined = generate one; "" (via --no-token) = no auth. */
  token?: string;
  noToken: boolean;
  open: boolean;
  staticDir?: string;
  settingsPath?: string;
  rustAuthoringExecutable?: string;
  exportDirectories?: string[];
  protectedDirectories?: string[];
  help: boolean;
}

export const DEFAULT_PORT = 8471;
export const DEFAULT_HOST = "127.0.0.1";

export const SERVER_USAGE = `Usage: modsync-server [options]

Options:
  --port <n>         TCP port (default ${DEFAULT_PORT}; 0 picks a free port)
  --host <addr>      Bind address (default ${DEFAULT_HOST})
  --token <t>        Require this bearer token (default: generate one and print it)
  --no-token         Disable authentication (only do this on a trusted machine)
  --open             Open the UI in the default browser
  --static <dir>     Web bundle directory (default: packages/web/dist)
  --settings <path>  Settings file (default: platform config dir)
  --export-dir <path>     Allow new exports in this existing folder (repeatable)
  --protect-dir <path>    Exclude an active game/install root (repeatable)
  --authoring-rust <path>  Opt in to Rust CLI locked session persistence
  -h, --help         Show this help
`;

export function parseServerArgs(argv: string[]): ServerCliOptions {
  const out: ServerCliOptions = { port: DEFAULT_PORT, host: DEFAULT_HOST, noToken: false, open: false, help: false };
  const takeValue = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const [flag, inline] = a.startsWith("--") && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = takeValue(flag, i);
      i++;
      return v;
    };
    switch (flag) {
      case "--port": {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("--port must be an integer between 0 and 65535");
        out.port = n;
        break;
      }
      case "--host":
        out.host = value();
        break;
      case "--token":
        out.token = value();
        break;
      case "--no-token":
        out.noToken = true;
        break;
      case "--open":
        out.open = true;
        break;
      case "--static":
        out.staticDir = value();
        break;
      case "--export-dir":
        (out.exportDirectories ??= []).push(resolvePath(value()));
        break;
      case "--protect-dir":
        (out.protectedDirectories ??= []).push(resolvePath(value()));
        break;
      case "--authoring-rust":
        out.rustAuthoringExecutable = resolvePath(value());
        break;
      case "--settings":
        out.settingsPath = value();
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        throw new Error(`Unknown option ${a}`);
    }
  }
  return out;
}

/** `packages/web/dist` relative to this package (works from src/ via tsx and from dist/). */
export function defaultStaticDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolvePath(here, "../../web/dist"), resolvePath(here, "../../../web/dist")];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

/** Open a URL with the platform's default handler. Never throws. */
export function openInBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* ignore */
  }
}

export interface RunServerResult {
  server: ModSyncServer;
  url: string;
  token?: string;
}

/**
 * Start the server from CLI-style arguments. Resolves once listening; the
 * process keeps running until SIGINT/SIGTERM.
 */
export async function runServerMain(argv: string[] = process.argv.slice(2), log: (line: string) => void = console.log): Promise<RunServerResult | undefined> {
  let opts: ServerCliOptions;
  try {
    opts = parseServerArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(SERVER_USAGE);
    process.exitCode = 2;
    return undefined;
  }
  if (opts.help) {
    log(SERVER_USAGE);
    return undefined;
  }
  const token = opts.noToken ? undefined : (opts.token ?? randomBytes(24).toString("hex"));
  const staticDir = opts.staticDir ? resolvePath(opts.staticDir) : defaultStaticDir();
  const server = await createModSyncServer({ token, staticDir, settingsPath: opts.settingsPath, rustAuthoringExecutable: opts.rustAuthoringExecutable, exportDirectories: opts.exportDirectories, protectedDirectories: opts.protectedDirectories });
  const base = await server.listen(opts.port, opts.host);
  const url = token ? `${base}/?token=${encodeURIComponent(token)}` : `${base}/`;
  log(`ModSync server listening on ${base}`);
  if (!existsSync(staticDir)) log(`(web bundle not found at ${staticDir}; only the API is served)`);
  if (token) log(`Token: ${token}`);
  else log("Authentication disabled (--no-token)");
  log(`Open: ${url}`);
  if (opts.open) openInBrowser(url);

  const shutdown = (): void => {
    log("shutting down...");
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { server, url, token };
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runServerMain().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
