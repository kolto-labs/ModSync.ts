/**
 * DownloadManager: a small queue that fetches mod archives into the mod
 * directory with resume, progress, hashing and host-specific handling.
 *
 * Emits `DownloadEvent`s via `emit("event", e)`.
 */
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { DownloadEvent, Guid } from "../model/types.js";
import { classifyUrl, fileNameFromUrl, nexusDownloadLinkUrl, type UrlClassification } from "./hosts.js";

export type DownloadState = "queued" | "downloading" | "done" | "failed" | "needs-browser" | "paused";

export interface DownloadItem {
  id: string;
  modGuid: Guid;
  url: string;
  state: DownloadState;
  classification: UrlClassification;
  /** Final file name once known (from Content-Disposition, the URL or `opts.fileName`). */
  fileName?: string;
  /** Absolute path of the finished file. */
  path?: string;
  receivedBytes: number;
  totalBytes?: number;
  sha1?: string;
  error?: string;
  /** Why a browser is needed. */
  reason?: string;
  expectedSha1?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface EnqueueOptions {
  /** Force the destination file name. */
  fileName?: string;
  /** Verify the SHA1 once the download finishes. */
  expectedSha1?: string;
}

export interface DownloadManagerOptions {
  modDirectory: string;
  maxConcurrentDownloads?: number;
  nexusApiKey?: string;
  /** Opens `nxm://` links (Vortex) or pages that need a browser. Required for nxm links. */
  openExternal?: (url: string) => void | Promise<void>;
  /** Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Minimum interval between progress events per download. Default 250ms. */
  progressIntervalMs?: number;
  userAgent?: string;
}

/** RFC 6266 Content-Disposition -> file name (prefers `filename*`). */
export function parseContentDispositionFileName(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const ext = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (ext) {
    const raw = ext[2].trim().replace(/^"|"$/g, "");
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded) return decoded;
    } catch {
      /* fall through to plain filename */
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  if (plain) {
    const v = (plain[1] !== undefined ? plain[1].replace(/\\(.)/g, "$1") : plain[2]).trim();
    if (v) return v;
  }
  return undefined;
}

/** Strip directories and characters that are unsafe in a file name. */
export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "";
  return cleaned;
}

interface NexusLink {
  name?: string;
  short_name?: string;
  URI: string;
}

export class DownloadManager extends EventEmitter {
  private readonly items = new Map<string, DownloadItem>();
  private readonly order: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly fetchImpl: typeof fetch;
  private readonly opts: Required<Pick<DownloadManagerOptions, "modDirectory" | "maxConcurrentDownloads" | "progressIntervalMs">> &
    DownloadManagerOptions;
  private readonly partPaths = new Map<string, string>();
  private readonly pathOwners = new Map<string, string>();
  private running = false;
  private active = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(opts: DownloadManagerOptions) {
    super();
    this.opts = {
      ...opts,
      maxConcurrentDownloads: Math.max(1, opts.maxConcurrentDownloads ?? 3),
      progressIntervalMs: opts.progressIntervalMs ?? 250,
    };
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  override on(event: "event", listener: (e: DownloadEvent) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  private emitEvent(e: DownloadEvent): void {
    this.emit("event", e);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get modDirectory(): string {
    return this.opts.modDirectory;
  }

  /** Add a download. Returns the queued item (a snapshot; use `get(id)` for live state). */
  enqueue(modGuid: Guid, url: string, opts: EnqueueOptions = {}): DownloadItem {
    const id = randomBytes(6).toString("hex");
    const item: DownloadItem = {
      id,
      modGuid,
      url,
      state: "queued",
      classification: classifyUrl(url),
      fileName: opts.fileName ? sanitizeFileName(opts.fileName) || undefined : undefined,
      receivedBytes: 0,
      expectedSha1: opts.expectedSha1?.toLowerCase(),
    };
    this.items.set(id, item);
    this.order.push(id);
    this.emitEvent({ type: "download-queued", id, modGuid, url });
    this.pump();
    return { ...item };
  }

  /** Begin (or resume) processing the queue. Paused items are re-queued. */
  start(): void {
    this.running = true;
    for (const item of this.items.values()) if (item.state === "paused" && !this.controllers.has(item.id)) item.state = "queued";
    this.pump();
  }

  /** Stop starting new downloads and abort in-flight ones (their `.part` files are kept for resume). */
  pause(): void {
    this.running = false;
    for (const [id, ctrl] of this.controllers) {
      const item = this.items.get(id);
      if (item) item.state = "paused";
      ctrl.abort();
    }
  }

  /** Put a failed or needs-browser item back in the queue. */
  retry(id: string): boolean {
    const item = this.items.get(id);
    if (!item || this.controllers.has(id) || item.state === "downloading" || item.state === "done") return false;
    item.state = "queued";
    item.error = undefined;
    item.reason = undefined;
    this.pump();
    return true;
  }

  list(): DownloadItem[] {
    return this.order.map((id) => ({ ...this.items.get(id)! }));
  }

  get(id: string): DownloadItem | undefined {
    const item = this.items.get(id);
    return item ? { ...item } : undefined;
  }

  /** Resolves when no download is active and nothing is queued (or the manager is paused). */
  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private isIdle(): boolean {
    if (this.active > 0) return false;
    if (!this.running) return true;
    for (const i of this.items.values()) if (i.state === "queued") return false;
    return true;
  }

  private pump(): void {
    if (!this.running) return this.notifyIdle();
    while (this.active < this.opts.maxConcurrentDownloads) {
      const next = this.order.map((id) => this.items.get(id)!).find((i) => i.state === "queued");
      if (!next) break;
      next.state = "downloading";
      this.active++;
      void this.run(next).finally(() => {
        this.active--;
        this.pump();
      });
    }
    this.notifyIdle();
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of resolvers) r();
  }

  // -------------------------------------------------------------------
  // Per-item flow
  // -------------------------------------------------------------------

  private async run(item: DownloadItem): Promise<void> {
    const ctrl = new AbortController();
    this.controllers.set(item.id, ctrl);
    item.startedAt = new Date().toISOString();
    try {
      const c = item.classification;
      if (c.nxm) return await this.handleNxm(item);
      if (c.host === "nexus") {
        const direct = await this.resolveNexus(item, ctrl.signal);
        if (!direct) return;
        return await this.download(item, direct, ctrl.signal);
      }
      if (c.needsBrowser) return this.needsBrowser(item, c.reason ?? "this host requires a browser");
      return await this.download(item, item.url, ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted) {
        item.state = this.running ? "queued" : "paused";
        return;
      }
      this.fail(item, err instanceof Error ? err.message : String(err));
    } finally {
      this.controllers.delete(item.id);
    }
  }

  private fail(item: DownloadItem, error: string): void {
    item.state = "failed";
    item.error = error;
    item.finishedAt = new Date().toISOString();
    this.emitEvent({ type: "download-failed", id: item.id, error, url: item.url });
  }

  private needsBrowser(item: DownloadItem, reason: string): void {
    item.state = "needs-browser";
    item.reason = reason;
    item.finishedAt = new Date().toISOString();
    this.emitEvent({ type: "download-needs-browser", id: item.id, url: item.url, reason });
  }

  private async handleNxm(item: DownloadItem): Promise<void> {
    if (!this.opts.openExternal) {
      return this.fail(item, "nxm:// links need an external handler (Vortex) and none is configured");
    }
    await this.opts.openExternal(item.url);
    this.needsBrowser(item, "nxm:// link handed to the system handler (Vortex)");
  }

  /** Resolve a Nexus mod page to a direct link via the API, or flag it for the browser. */
  private async resolveNexus(item: DownloadItem, signal: AbortSignal): Promise<string | undefined> {
    const { game, modId, fileId } = item.classification;
    if (!this.opts.nexusApiKey) {
      this.needsBrowser(item, "Nexus Mods downloads need an API key or a browser session");
      return undefined;
    }
    if (!game || modId === undefined || fileId === undefined) {
      this.needsBrowser(item, "Nexus URL has no file_id; pick the file in the browser");
      return undefined;
    }
    const api = nexusDownloadLinkUrl(game, modId, fileId);
    const res = await this.fetchImpl(api, {
      headers: { apikey: this.opts.nexusApiKey, accept: "application/json", ...this.uaHeader() },
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      this.needsBrowser(item, `Nexus API refused the key (${res.status}); premium is required for API downloads`);
      return undefined;
    }
    if (!res.ok) throw new Error(`Nexus API returned ${res.status} for ${api}`);
    const links = (await res.json()) as NexusLink[];
    const first = Array.isArray(links) ? links.find((l) => typeof l?.URI === "string") : undefined;
    if (!first) throw new Error("Nexus API returned no download links");
    return first.URI;
  }

  /** Keep distinct queue items from sharing a partial or final file. */
  private reservePath(name: string, id: string): string {
    let path = join(this.opts.modDirectory, name);
    const owner = this.pathOwners.get(path);
    if (owner && owner !== id) {
      const ext = extname(name);
      path = join(this.opts.modDirectory, `${name.slice(0, name.length - ext.length)}-${id}${ext}`);
    }
    this.pathOwners.set(path, id);
    return path;
  }

  private uaHeader(): Record<string, string> {
    return this.opts.userAgent ? { "user-agent": this.opts.userAgent } : {};
  }

  // -------------------------------------------------------------------
  // HTTP download with resume + hashing
  // -------------------------------------------------------------------

  private async download(item: DownloadItem, url: string, signal: AbortSignal): Promise<void> {
    await mkdir(this.opts.modDirectory, { recursive: true });
    const provisionalName = item.fileName ?? sanitizeFileName(fileNameFromUrl(url) ?? "") ?? "";
    let partPath = this.partPaths.get(item.id);
    if (!partPath) {
      partPath = this.reservePath(`${provisionalName || `download-${item.id}`}.part`, item.id);
      this.partPaths.set(item.id, partPath);
    }

    // Resume when a partial file exists.
    let offset: number;
    try {
      offset = (await stat(partPath)).size;
    } catch {
      offset = 0;
    }
    const headers: Record<string, string> = { ...this.uaHeader() };
    if (offset > 0) headers.range = `bytes=${offset}-`;

    let res = await this.fetchImpl(url, { headers, signal, redirect: "follow" });
    let resuming = false;
    if (offset > 0) {
      if (res.status === 206) {
        const cr = res.headers.get("content-range") ?? "";
        const m = /bytes\s+(\d+)-/i.exec(cr);
        if (m && Number(m[1]) === offset) {
          resuming = true;
        } else {
          // Server sent an unexpected range: start over.
          await res.body?.cancel().catch(() => undefined);
          res = await this.fetchImpl(url, { headers: this.uaHeader(), signal, redirect: "follow" });
        }
      } else if (res.status === 416) {
        // Part is complete or bogus; restart from scratch.
        await rm(partPath, { force: true });
        res = await this.fetchImpl(url, { headers: this.uaHeader(), signal, redirect: "follow" });
      }
    }
    if (!resuming) offset = 0;

    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      return this.needsBrowser(item, `server answered ${res.status}; log in through the browser`);
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.startsWith("text/html")) {
      await res.body?.cancel().catch(() => undefined);
      return this.needsBrowser(item, "server returned an HTML page instead of a file");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    }
    if (!res.body) throw new Error("empty response body");

    // Final file name.
    const cdName = sanitizeFileName(parseContentDispositionFileName(res.headers.get("content-disposition")) ?? "");
    const finalName = item.fileName || cdName || sanitizeFileName(fileNameFromUrl(res.url || url) ?? "") || `download-${item.id}`;
    item.fileName = finalName;
    const finalPath = this.reservePath(finalName, item.id);
    item.fileName = basename(finalPath);

    // Total size.
    const lengthHeader = res.headers.get("content-length");
    let total: number | undefined;
    if (resuming) {
      const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
      if (m) total = Number(m[1]);
      else if (lengthHeader) total = offset + Number(lengthHeader);
    } else if (lengthHeader) {
      total = Number(lengthHeader);
    }
    if (total !== undefined && !Number.isFinite(total)) total = undefined;
    item.totalBytes = total;
    item.receivedBytes = offset;
    this.emitEvent({ type: "download-started", id: item.id, fileName: item.fileName!, totalBytes: total });

    // Hash whatever we already have.
    const hash = createHash("sha1");
    if (resuming) {
      await new Promise<void>((resolve, reject) => {
        createReadStream(partPath)
          .on("data", (chunk) => hash.update(chunk as Buffer))
          .on("end", resolve)
          .on("error", reject);
      });
    }

    const out = await open(partPath, resuming ? "a" : "w");

    let lastEmit = 0;
    let lastBytes = offset;
    let lastTime = performance.now();
    const progress = (force = false) => {
      const now = performance.now();
      if (!force && now - lastEmit < this.opts.progressIntervalMs) return;
      const dt = Math.max(1, now - lastTime);
      const bytesPerSecond = ((item.receivedBytes - lastBytes) * 1000) / dt;
      lastEmit = now;
      lastTime = now;
      lastBytes = item.receivedBytes;
      this.emitEvent({
        type: "download-progress",
        id: item.id,
        receivedBytes: item.receivedBytes,
        totalBytes: item.totalBytes,
        bytesPerSecond: Math.round(bytesPerSecond),
      });
    };

    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        hash.update(value);
        let written = 0;
        while (written < value.byteLength) {
          const result = await out.write(value, written, value.byteLength - written);
          if (result.bytesWritten === 0) throw new Error("download file write made no progress");
          written += result.bytesWritten;
        }
        item.receivedBytes += value.byteLength;
        progress();
      }
    } finally {
      await out.close().catch(() => undefined);
    }

    signal.throwIfAborted();
    if (total !== undefined && item.receivedBytes !== total) {
      throw new Error(`incomplete download: got ${item.receivedBytes} of ${total} bytes`);
    }
    progress(true);

    const sha1 = hash.digest("hex");
    if (item.expectedSha1 && item.expectedSha1 !== sha1) {
      await rm(partPath, { force: true });
      throw new Error(`SHA1 mismatch: expected ${item.expectedSha1}, got ${sha1}`);
    }
    await rm(finalPath, { force: true });
    await rename(partPath, finalPath);
    item.sha1 = sha1;
    item.path = finalPath;
    item.state = "done";
    item.finishedAt = new Date().toISOString();
    this.emitEvent({ type: "download-finished", id: item.id, fileName: item.fileName!, path: finalPath, sha1 });
  }
}

