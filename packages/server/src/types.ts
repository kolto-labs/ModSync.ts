/**
 * Public types of @modsync/server.
 */
import type { FastifyInstance } from "fastify";
import type { DownloadEvent, InstallEvent } from "@modsync/core";

/** Native helpers Electron hands to the server (see packages/electron/src/ipc.ts). */
export interface ElectronBridge {
  pickDirectory: (opts?: { title?: string; defaultPath?: string }) => Promise<string | undefined>;
  pickFile: (opts?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<string | undefined>;
  openExternal: (url: string) => Promise<void>;
}

export interface ModSyncServerOptions {
  /** Bearer token every `/api/*` request and the `/ws` upgrade must carry. Omit to disable auth. */
  token?: string;
  /** Built web bundle served at `/` with an SPA fallback. */
  staticDir?: string;
  /** Settings file; default `defaultSettingsPath()` from core. */
  settingsPath?: string;
  /** Explicit opt-in Rust CLI persistence backend; requires expected-revision/stdin contract. */
  rustAuthoringExecutable?: string;
  /** Existing directories explicitly permitted for new standalone exports. */
  exportDirectories?: string[];
  /** Additional active install/game roots excluded from exports. */
  protectedDirectories?: string[];
  electronBridge?: ElectronBridge;
  /** Fastify logger; default off. */
  logger?: boolean;
  /** Lifecycle diagnostics for desktop shutdown; contains no request URLs or credentials. */
  onShutdownStage?: (stage: "state-draining" | "state-drained" | "server-closed") => void;
  /** Ring buffer capacity for install/download events (default 5000). */
  eventBufferSize?: number;
}

export interface ModSyncServer {
  app: FastifyInstance;
  /** Bind and resolve with the base URL, e.g. `http://127.0.0.1:51234`. */
  listen(port: number, host: string): Promise<string>;
  close(): Promise<void>;
}

/** Event streamed over the WebSocket. */
export type ServerEvent = InstallEvent | DownloadEvent;

/** The WebSocket envelope; `seq` is monotonic so a client can ask for a replay. */
export interface EventEnvelope {
  seq: number;
  event: ServerEvent;
}

export type ClientMessage = { type: "replay"; lastSeq?: number } | { type: "answer"; answer: unknown } | { type: "ping" };

export const SERVER_VERSION = "2.0.0";
