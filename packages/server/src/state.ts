/**
 * AppState: everything the routes share. One instance per server.
 *
 * - settings (persisted through core's loadSettings/saveSettings)
 * - the current instruction file and where it came from
 * - the running Installer (at most one) and its pending prompt
 * - the DownloadManager (recreated when the mod directory changes)
 * - a ring buffer of `{ seq, event }` envelopes for WebSocket replay
 * - a ring buffer of log lines for `GET /api/logs`
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  CheckpointStore,
  DownloadManager,
  InMemoryTelemetry,
  Installer,
  RealFileSystem,
  RingBuffer,
  checkSelectionConstraints,
  computeInstallOrder,
  computeSelection,
  createDefaultSettings,
  createLogger,
  createPatcher,
  defaultSettingsPath,
  loadSettings,
  saveSettings,
  type DownloadItem as CoreDownloadItem,
  type Guid,
  type InstallSummary,
  type InstructionFile,
  type ModSyncLogger,
  type UserPrompt,
  type UserPromptAnswer,
  type UserSettings,
  type ValidationIssue,
} from "@modsync/core";
import type { ElectronBridge, EventEnvelope, ServerEvent } from "./types.js";

export interface SelectionResult {
  selectedGuids: Guid[];
  order: Guid[];
  issues: ValidationIssue[];
}

export interface InstallStatus {
  running: boolean;
  phase?: "base" | "widescreen";
  order?: Guid[];
  currentMod?: Guid;
  summary?: InstallSummary;
  pendingPrompt?: UserPrompt;
  /** Id handed out by `POST /api/install`; the checkpoint session id once known. */
  sessionId?: string;
}

/** Wire shape of a download for the web UI (`packages/web/src/types.ts`). */
export interface DownloadItem {
  id: string;
  modGuid: Guid;
  url: string;
  status: "queued" | "downloading" | "finished" | "failed" | "needs-browser";
  fileName?: string;
  receivedBytes: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  error?: string;
  path?: string;
  reason?: string;
}

export function toWireDownload(item: CoreDownloadItem): DownloadItem {
  const status: DownloadItem["status"] =
    item.state === "done"
      ? "finished"
      : item.state === "paused"
        ? "queued"
        : item.state;
  return {
    id: item.id,
    modGuid: item.modGuid,
    url: item.url,
    status,
    fileName: item.fileName,
    receivedBytes: item.receivedBytes,
    totalBytes: item.totalBytes,
    error: item.error,
    path: item.path,
    reason: item.reason,
  };
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface AppStateOptions {
  settingsPath?: string;
  electronBridge?: ElectronBridge;
  eventBufferSize?: number;
}

export class AppState {
  settings: UserSettings = createDefaultSettings();
  readonly settingsPath: string;
  readonly electronBridge?: ElectronBridge;

  file: InstructionFile | null = null;
  filePath: string | null = null;
  fileWarnings: string[] = [];

  installer: Installer | null = null;
  installRunning = false;
  installSessionId?: string;
  installPhase?: "base" | "widescreen";
  installOrder?: Guid[];
  currentMod?: Guid;
  lastSummary?: InstallSummary;
  pendingPrompt?: UserPrompt;

  readonly events: RingBuffer<ServerEvent>;
  readonly logs = new RingBuffer<string>(5000);
  readonly logger: ModSyncLogger;
  readonly telemetry = new InMemoryTelemetry();

  private downloads: DownloadManager | null = null;
  private installTask?: Promise<void>;
  private settingsTask: Promise<unknown> = Promise.resolve();
  private readonly subscribers = new Set<(env: EventEnvelope) => void>();
  private bytesPerSecond = new Map<string, number>();

  constructor(opts: AppStateOptions = {}) {
    this.settingsPath = opts.settingsPath ?? defaultSettingsPath();
    this.electronBridge = opts.electronBridge;
    this.events = new RingBuffer<ServerEvent>(opts.eventBufferSize ?? 5000);
    this.logger = createLogger({
      level: "debug",
      sink: (line) => {
        this.logs.push(line);
      },
    });
  }

  async init(): Promise<void> {
    try {
      this.settings = await loadSettings(this.settingsPath);
    } catch (err) {
      this.logger.warn(`settings could not be loaded, using defaults: ${err instanceof Error ? err.message : String(err)}`);
      this.settings = createDefaultSettings();
    }
    this.logger.info(`settings loaded from ${this.settingsPath}`);
  }

  // -------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------

  /** Push an event to the ring buffer and every WebSocket subscriber. */
  publish(event: ServerEvent): EventEnvelope {
    const seq = this.events.push(event);
    const env: EventEnvelope = { seq, event };
    for (const cb of [...this.subscribers]) {
      try {
        cb(env);
      } catch (err) {
        this.logger.warn(`event subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return env;
  }

  subscribe(cb: (env: EventEnvelope) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Envelopes with a seq strictly greater than `lastSeq`. */
  replay(lastSeq: number): EventEnvelope[] {
    return this.events.since(lastSeq).map((e) => ({ seq: e.seq, event: e.item }));
  }

  // -------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------

  async updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
    // Serialize writes so simultaneous requests cannot lose each other's changes.
    const task = this.settingsTask.then(async () => {
      if (this.installRunning) throw new HttpError(409, "Cannot change settings while an installation is running");
      const next: UserSettings = { ...this.settings };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null) continue;
        (next as unknown as Record<string, unknown>)[k] = v;
      }
      const downloadsChanged =
        next.modDirectory !== this.settings.modDirectory ||
        next.maxConcurrentDownloads !== this.settings.maxConcurrentDownloads ||
        next.nexusApiKey !== this.settings.nexusApiKey;
      if (downloadsChanged && this.downloads?.isRunning) {
        throw new HttpError(409, "Pause downloads before changing download settings");
      }
      await saveSettings(next, this.settingsPath);
      this.settings = next;
      if (downloadsChanged) this.downloads = null;
      return next;
    });
    this.settingsTask = task.catch(() => undefined);
    return task;
  }

  // -------------------------------------------------------------------
  // File / selection
  // -------------------------------------------------------------------

  requireFile(): InstructionFile {
    if (!this.file) throw new HttpError(409, "No instruction file is loaded");
    return this.file;
  }

  setFile(file: InstructionFile, path: string | null, warnings: string[] = []): InstructionFile {
    if (this.installRunning) throw new HttpError(409, "Cannot replace the instruction file while an installation is running");
    this.lastSummary = undefined;
    this.currentMod = undefined;
    this.pendingPrompt = undefined;
    this.installSessionId = undefined;
    this.installPhase = undefined;
    this.installOrder = undefined;
    // Preserve monotonic sequence numbers while discarding events for the old document.
    this.events.clear();
    this.file = file;
    this.filePath = path;
    this.fileWarnings = warnings;
    this.logger.info(`instruction file loaded${path ? ` from ${path}` : ""}: ${file.mods.length} mods`);
    return file;
  }

  /** Selection + order + constraint issues for the current file. */
  recomputeSelection(): SelectionResult {
    const file = this.requireFile();
    const sel = computeSelection(file, this.settings);
    const issues = checkSelectionConstraints(file, sel, this.settings.compatibilityLevel);
    const { order, issues: orderIssues } = computeInstallOrder(file, sel);
    return { selectedGuids: [...sel.selectedGuids], order, issues: [...issues, ...orderIssues] };
  }

  // -------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------

  checkpointRoot(): string {
    return this.settings.checkpointDirectory?.trim() || join(this.settings.kotorDirectory, ".modsync", "checkpoints");
  }

  createCheckpointStore(kotorDirectory = this.settings.kotorDirectory): CheckpointStore {
    return new CheckpointStore({ rootDir: this.checkpointRoot(), kotorDirectory, fs: new RealFileSystem() });
  }

  // -------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------

  installStatus(): InstallStatus {
    return {
      running: this.installRunning,
      phase: this.installPhase,
      order: this.installOrder,
      currentMod: this.currentMod,
      summary: this.lastSummary,
      pendingPrompt: this.pendingPrompt,
      sessionId: this.installSessionId,
    };
  }

  /** Create the installer, wire its events, start `run()` in the background. */
  startInstall(opts: { phase?: "base" | "widescreen"; modGuids?: Guid[] }): { sessionId: string } {
    const file = this.requireFile();
    if (this.installRunning) throw new HttpError(409, "An installation is already running");
    if (!this.settings.kotorDirectory) throw new HttpError(400, "kotorDirectory is not set");
    if (!this.settings.modDirectory) throw new HttpError(400, "modDirectory is not set");

    const sessionId = randomUUID();
    const fs = new RealFileSystem();
    const logger = this.logger.child("install");
    const installer = new Installer(file, this.settings, {
      fs,
      logger,
      patcher: createPatcher(this.settings, logger),
      checkpoints: this.settings.createCheckpoints ? this.createCheckpointStore() : undefined,
      telemetry: this.settings.telemetryEnabled ? this.telemetry : undefined,
    });

    this.installer = installer;
    this.installRunning = true;
    this.installSessionId = sessionId;
    this.installPhase = opts.phase ?? "base";
    this.installOrder = undefined;
    this.currentMod = undefined;
    this.lastSummary = undefined;
    this.pendingPrompt = undefined;

    installer.on("event", (event) => {
      switch (event.type) {
        case "install-started":
          this.installOrder = [...event.order];
          break;
        case "mod-started":
          this.currentMod = event.modGuid;
          break;
        case "prompt":
          this.pendingPrompt = event.prompt;
          break;
        case "instruction-finished":
        case "mod-finished":
          this.pendingPrompt = undefined;
          break;
        case "install-finished":
          this.lastSummary = event.summary;
          if (event.summary.checkpointSessionId) this.installSessionId = event.summary.checkpointSessionId;
          break;
        default:
          break;
      }
      this.publish(event);
    });

    this.installTask = installer
      .run(opts)
      .then((summary) => {
        this.lastSummary = summary;
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`install failed: ${message}`);
        this.publish({ type: "install-error", message });
      })
      .finally(() => {
        this.installRunning = false;
        this.currentMod = undefined;
        this.pendingPrompt = undefined;
        if (this.installer === installer) this.installer = null;
      });

    return { sessionId };
  }

  answerPrompt(answer: UserPromptAnswer): void {
    if (!this.installer) throw new HttpError(409, "No installation is running");
    const prompt = this.pendingPrompt;
    if (!prompt || answer.promptId !== prompt.id) throw new HttpError(409, "This prompt is no longer pending");
    if (answer.accepted !== undefined && typeof answer.accepted !== "boolean") throw new HttpError(400, "accepted must be a boolean");
    if (answer.choiceId !== undefined && (typeof answer.choiceId !== "string" || !prompt.choices.some((c) => c.id === answer.choiceId))) {
      throw new HttpError(400, "choiceId must identify one of the pending prompt's choices");
    }
    if (prompt.choices.length && !answer.choiceId && !prompt.allowNone && answer.accepted !== false) {
      throw new HttpError(400, "choiceId is required for this prompt");
    }
    if (!this.installer.answerPrompt(answer)) throw new HttpError(409, "This prompt is no longer pending");
    this.pendingPrompt = undefined;
  }

  cancelInstall(): boolean {
    if (!this.installer) return false;
    this.installer.cancel();
    return true;
  }

  // -------------------------------------------------------------------
  // Downloads
  // -------------------------------------------------------------------

  hasDownloadManager(): boolean {
    return this.downloads !== null;
  }

  getDownloadManager(): DownloadManager {
    if (this.downloads) return this.downloads;
    if (!this.settings.modDirectory) throw new HttpError(400, "modDirectory is not set");
    const bridge = this.electronBridge;
    const manager = new DownloadManager({
      modDirectory: this.settings.modDirectory,
      maxConcurrentDownloads: this.settings.maxConcurrentDownloads,
      nexusApiKey: this.settings.nexusApiKey,
      userAgent: "ModSync/2.0",
      openExternal: bridge ? (url) => bridge.openExternal(url) : undefined,
    });
    manager.on("event", (event) => {
      if (event.type === "download-progress") this.bytesPerSecond.set(event.id, event.bytesPerSecond);
      if (event.type === "download-finished" || event.type === "download-failed") this.bytesPerSecond.delete(event.id);
      this.publish(event);
    });
    this.downloads = manager;
    return manager;
  }

  listDownloads(): DownloadItem[] {
    if (!this.downloads) return [];
    return this.downloads.list().map((item) => {
      const wire = toWireDownload(item);
      const bps = this.bytesPerSecond.get(item.id);
      if (bps !== undefined && wire.status === "downloading") wire.bytesPerSecond = bps;
      return wire;
    });
  }

  async close(): Promise<void> {
    this.cancelInstall();
    this.downloads?.pause();
    await this.installTask;
    await this.settingsTask;
    await this.logger.flush();
  }
}
