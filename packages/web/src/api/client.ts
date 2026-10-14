import type {AuthoringPrediction as IndependentAuthoringPrediction} from "../../../core/src/authoring/predictionRuntime";
/**
 * Typed API client for the ModSync server (see docs/PLAN.md "Server API").
 *
 * - Bearer token comes from `?token=` (persisted to localStorage) or localStorage.
 * - `?mock=1` or `VITE_MOCK=1` switches to an in-memory fake server (./mock.ts)
 *   so the UI can be exercised without `@modsync/server`.
 * - WebSocket client reconnects with backoff and sends `{type:"replay", lastSeq}`
 *   on every (re)connect so no event is missed.
 */
import type {
  ArchiveListResult,
  BrowseResult,
  CheckpointSession,
  DownloadEvent,
  DownloadItem,
  GameDetectResult,
  GraphResult,
  Guid,
  HealthResult,
  InstallEvent,
  InstallStatus,
  InstructionFile,
  MarkdownStyle,
  MergeResult,
  SelectionResult,
  Tier,
  UserPromptAnswer,
  UserSettings,
  ValidationReport,
} from "../types";
import { createMockClient } from "./mock";

export type ServerEvent = InstallEvent | DownloadEvent;
export interface EventEnvelope {
  seq: number;
  event: ServerEvent;
}
export type EventHandler = (envelope: EventEnvelope) => void;

export class EventBus {
  private handlers = new Set<EventHandler>();
  /** Recent envelopes keyed by seq, used to tell replayed duplicates from a restarted server. */
  private recent = new Map<number, string>();
  lastSeq = 0;

  /**
   * True when this envelope was already delivered (a replay after reconnect).
   * If the seq is not newer but the payload differs from what we saw at that
   * seq, the server restarted its counter: the bus resets and accepts it.
   */
  isDuplicate(envelope: EventEnvelope): boolean {
    if (envelope.seq > this.lastSeq) return false;
    const seen = this.recent.get(envelope.seq);
    if (seen !== undefined && seen === JSON.stringify(envelope.event)) return true;
    if (seen === undefined && this.recent.size > 0 && envelope.seq >= Math.min(...this.recent.keys())) return true;
    this.lastSeq = envelope.seq - 1;
    this.recent.clear();
    return false;
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(envelope: EventEnvelope): void {
    if (envelope.seq > this.lastSeq) this.lastSeq = envelope.seq;
    this.recent.set(envelope.seq, JSON.stringify(envelope.event));
    if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value as number);
    for (const h of [...this.handlers]) {
      try {
        h(envelope);
      } catch (err) {
        console.error("event handler failed", err);
      }
    }
  }
}

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface AuthoringSessionResult {
  file: InstructionFile;
  session: { directory: string; head: { format: 1; cursor: number; revisions: { id: string; label: string }[] }; revisionId: string; headSha256: string; revisionSha256: string; readOnly: true };
}

export type AuthoringPersistRequest = { directory:string; expectedRevision:string } & ({ operation:"edit"; label:string; operations:Record<string,unknown>[] } | { operation:"undo"|"redo" });
export interface AuthoringPersistResult { backend:"rust-cli"; currentRevision:string; file:InstructionFile; head:AuthoringSessionResult["session"]["head"]; session:AuthoringSessionResult["session"] }

export interface ApiClient {
  readonly events: EventBus;
  readonly isMock: boolean;
  connect(onState?: (s: ConnectionState) => void): () => void;

  health(): Promise<HealthResult>;
  getSettings(): Promise<UserSettings>;
  updateSettings(patch: Partial<UserSettings>): Promise<UserSettings>;
  fsRoots(): Promise<{ roots: string[] }>;
  fsBrowse(path: string): Promise<BrowseResult>;
  authoringArchive(directory:string,cursor:number,name:string): Promise<ArchiveListResult>;
  archiveList(path: string): Promise<ArchiveListResult>;
  detectGame(path: string): Promise<GameDetectResult>;
  loadFile(body: { path: string } | { content: string } | { url: string }): Promise<InstructionFile>;
  loadAuthoringSession(directory: string, cursor?: number): Promise<AuthoringSessionResult>;
  authoringCapabilities(): Promise<{reader:true; persistenceBackend:"rust-cli"|null;predictionBackend:"rust-cli"|null;independentPredictionBackend?:"typescript-vfs"}>;
  predictAuthoringSession(request:{directory:string;expectedRevision:string;sourceDirectory:string;gameDirectory:string;component:number;instructions:number}):Promise<{backend:"rust-cli";revisionId:string;entries:{path:string;directory:boolean;content_known:boolean;bytes:number|null}[];events:{component:string;step:number;message:string}[]}>;
  predictAuthoringIndependent(request:{directory:string;expectedRevision:string;modDirectory:string;kotorDirectory:string;componentGuid:string;instructionCount:number}):Promise<{backend:"typescript-vfs";revisionId:string;prediction:IndependentAuthoringPrediction}>;
  persistAuthoringSession(request:AuthoringPersistRequest): Promise<AuthoringPersistResult>;
  authoringInputs(directory:string,cursor:number): Promise<{revisionId:string;inputs:{name:string;bytes:number;sha256:string;verified:false}[]}>;
  verifyAuthoringInput(directory:string,cursor:number,name:string): Promise<{revisionId:string;name:string;verified:true}>;
  getFile(): Promise<InstructionFile | null>;
  putFile(file: InstructionFile): Promise<InstructionFile>;
  saveFile(path: string): Promise<void>;
  importMarkdown(body: { content: string } | { path: string }): Promise<{ file: InstructionFile; warnings: string[] }>;
  exportMarkdown(style: MarkdownStyle): Promise<{ markdown: string }>;
  mergeFile(content: string): Promise<MergeResult>;
  setModSelection(guid: Guid, selected: boolean, options?: Record<Guid, boolean>): Promise<void>;
  selectDefaults(tier?: Tier): Promise<void>;
  getSelection(): Promise<SelectionResult>;
  getGraph(): Promise<GraphResult>;
  validate(): Promise<ValidationReport>;
  install(opts: { phase?: "base" | "widescreen"; modGuids?: Guid[] }): Promise<{ sessionId: string }>;
  cancelInstall(): Promise<void>;
  answerPrompt(answer: UserPromptAnswer): Promise<void>;
  installStatus(): Promise<InstallStatus>;
  downloads(): Promise<DownloadItem[]>;
  startDownloads(modGuids?: Guid[]): Promise<void>;
  openBrowser(url: string): Promise<void>;
  checkpoints(): Promise<CheckpointSession[]>;
  restoreCheckpoint(sessionId: string, checkpointId: string): Promise<void>;
  logs(since?: number): Promise<string[]>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Token / mode discovery
// ---------------------------------------------------------------------------

const TOKEN_KEY = "modsync.token";

function readQuery(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

export function getToken(): string | undefined {
  const q = readQuery().get("token");
  if (q) {
    try {
      localStorage.setItem(TOKEN_KEY, q);
    } catch {
      /* ignore */
    }
    return q;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function isMockMode(): boolean {
  const q = readQuery().get("mock");
  if (q === "1" || q === "true") return true;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_MOCK === "1" || env?.VITE_MOCK === "true";
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function createHttpClient(): ApiClient {
  const events = new EventBus();

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
      const msg =
        (obj && typeof obj.message === "string" && obj.message) ||
        (obj && typeof obj.error === "string" && obj.error) ||
        `${method} ${path} failed with ${res.status}`;
      throw new ApiError(res.status, msg, data);
    }
    return data as T;
  }

  const get = <T>(path: string) => request<T>("GET", path);
  const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
  const put = <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {});
  const q = (params: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
    const str = s.toString();
    return str ? `?${str}` : "";
  };

  function connect(onState?: (s: ConnectionState) => void): () => void {
    let ws: WebSocket | undefined;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      if (closed) return;
      onState?.("connecting");
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const token = getToken();
      const url = `${proto}://${window.location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        console.warn("ws open failed", err);
        schedule();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        onState?.("connected");
        ws?.send(JSON.stringify({ type: "replay", lastSeq: events.lastSeq }));
      };
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(String(msg.data)) as Partial<EventEnvelope>;
          if (data && typeof data.seq === "number" && data.event) {
            if (events.isDuplicate(data as EventEnvelope)) return; // replayed after reconnect
            events.emit(data as EventEnvelope);
          }
        } catch (err) {
          console.warn("bad ws message", err);
        }
      };
      ws.onclose = () => {
        onState?.("disconnected");
        schedule();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    };

    const schedule = () => {
      if (closed) return;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6));
      timer = setTimeout(open, delay);
    };

    open();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }

  return {
    events,
    isMock: false,
    connect,
    health: () => get("/api/health"),
    getSettings: () => get("/api/settings"),
    updateSettings: (patch) => put("/api/settings", patch),
    fsRoots: () => get("/api/fs/roots"),
    fsBrowse: (path) => get(`/api/fs/browse${q({ path })}`),
    archiveList: (path) => get(`/api/archive/list${q({ path })}`),
    detectGame: (path) => get(`/api/game/detect${q({ path })}`),
    loadFile: (body) => post("/api/file/load", body),
    loadAuthoringSession: (directory, cursor) => post("/api/file/authoring-session", { directory, cursor }),
    predictAuthoringSession: request => post("/api/file/authoring-predict",request),
    predictAuthoringIndependent: request => post("/api/file/authoring-predict-independent",request),
    authoringCapabilities: () => get("/api/file/authoring-capabilities"),
    persistAuthoringSession: (request) => post("/api/file/authoring-persist", request),
    authoringArchive: (directory,cursor,name) => post("/api/file/authoring-archive",{directory,cursor,name}),
    authoringInputs: (directory,cursor) => post("/api/file/authoring-inputs", {directory,cursor}),
    verifyAuthoringInput: (directory,cursor,verifyName) => post("/api/file/authoring-inputs", {directory,cursor,verifyName}),
    getFile: () => get("/api/file"),
    putFile: (file) => put("/api/file", file),
    saveFile: (path) => post("/api/file/save", { path }),
    importMarkdown: (body) => post("/api/file/import-markdown", body),
    exportMarkdown: (style) => post("/api/file/export-markdown", { style }),
    mergeFile: (content) => post("/api/file/merge", { content }),
    setModSelection: (guid, selected, options) =>
      put(`/api/mods/${encodeURIComponent(guid)}/selection`, { selected, options }),
    selectDefaults: (tier) => post("/api/mods/select-defaults", tier ? { tier } : {}),
    getSelection: () => get("/api/selection"),
    getGraph: () => get("/api/graph"),
    validate: () => post("/api/validate"),
    install: (opts) => post("/api/install", opts),
    cancelInstall: () => post("/api/install/cancel"),
    answerPrompt: (answer) => post("/api/install/answer", answer),
    installStatus: () => get("/api/install/status"),
    downloads: () => get("/api/downloads"),
    startDownloads: (modGuids) => post("/api/downloads/start", modGuids ? { modGuids } : {}),
    openBrowser: (url) => post("/api/downloads/open-browser", { url }),
    checkpoints: () => get("/api/checkpoints"),
    restoreCheckpoint: (session, id) =>
      post(`/api/checkpoints/${encodeURIComponent(session)}/${encodeURIComponent(id)}/restore`),
    logs: (since) => get(`/api/logs${q({ since })}`),
  };
}

// ---------------------------------------------------------------------------

let instance: ApiClient | undefined;

/** The process-wide API client (real or mock depending on the URL / env). */
export function getApi(): ApiClient {
  if (!instance) {
    instance = isMockMode() ? createMockClient(new EventBus()) : createHttpClient();
  }
  return instance;
}

export const api: ApiClient = getApi();
