/**
 * CheckpointStore: content-addressed snapshots of the KOTOR directory taken
 * after every install instruction so the user can roll back to any step.
 *
 * Layout under `rootDir`:
 *   cas/<sha1[0..2]>/<sha1>                  content blobs (deduplicated)
 *   sessions/<sessionId>/session.json       CheckpointSession (+ label)
 *   sessions/<sessionId>/<index>.json       manifest for checkpoint <index>
 *
 * Checkpoint 0 is the baseline. Its manifest grows lazily: the installer calls
 * `beforeTouch(session, paths)` before an instruction runs, which stores the
 * current content of each path (or records it as absent) the first time the
 * path is seen in the session. Every later checkpoint is either an anchor
 * (full manifest of every tracked path, every `anchorInterval`-th index) or
 * a delta (entries that changed relative to the previous checkpoint).
 *
 * The state at checkpoint k is therefore:
 *   baseline  ⊕  anchor(a)  ⊕  delta(a+1) ⊕ ... ⊕ delta(k)
 * with `a` the nearest anchor at or before k. Starting from the baseline
 * covers paths that were first tracked after `a` (they were untouched, hence
 * still in their baseline state, at k).
 *
 * Game files are only touched through the injected FileSystemPort; the
 * store's own directory uses node:fs directly.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileSystemPort } from "../ports/filesystem.js";
import type { CheckpointFileEntry, CheckpointMeta, CheckpointSession, Guid } from "../model/types.js";

export interface CheckpointStoreOptions {
  /** Directory that holds the CAS and session manifests. */
  rootDir: string;
  /** Absolute path of the game directory being tracked. */
  kotorDirectory: string;
  /** Port used to read/write game files. */
  fs: FileSystemPort;
  /** Every Nth checkpoint is a full manifest. Default 10. */
  anchorInterval?: number;
}

export interface CreateCheckpointMeta {
  label: string;
  modGuid?: Guid;
  instructionGuid?: Guid;
  /** Absolute paths (files or directories) the instruction reported as created/modified/deleted. */
  touched: string[];
}

/** `session.json` on disk: the public session plus the label given to `startSession`. */
export interface StoredCheckpointSession extends CheckpointSession {
  label: string;
}

/** `<index>.json` on disk. */
export interface CheckpointManifest {
  id: string;
  index: number;
  isAnchor: boolean;
  entries: CheckpointFileEntry[];
}

export interface CheckpointStats {
  /** Distinct blobs referenced by the session (or in the whole CAS). */
  blobCount: number;
  /** Total size of those blobs. */
  bytes: number;
  /** Checkpoints in the session (0 when computed for the whole store). */
  checkpointCount: number;
  /** Paths tracked by the session. */
  trackedCount: number;
}

/** Path relative to kotorDirectory -> sha1 (undefined = absent). */
export type CheckpointState = Map<string, string | undefined>;

export type RestoreProgress = (done: number, total: number) => void;

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function sha1Hex(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

function nowId(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}`;
  return `${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}

async function writeJsonAtomic(p: string, value: unknown): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, p);
}

export class CheckpointStore {
  readonly rootDir: string;
  readonly kotorDirectory: string;
  readonly anchorInterval: number;
  private readonly fs: FileSystemPort;
  /** Per-session serialization so concurrent calls never interleave manifest writes. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: CheckpointStoreOptions) {
    if (!opts.fs) throw new CheckpointError("CheckpointStore requires a FileSystemPort");
    this.rootDir = toPosix(opts.rootDir);
    this.kotorDirectory = toPosix(opts.kotorDirectory);
    this.fs = opts.fs;
    this.anchorInterval = Math.max(1, Math.floor(opts.anchorInterval ?? 10));
  }

  // ---------------------------------------------------------------------
  // Paths
  // ---------------------------------------------------------------------

  private get casDir(): string {
    return join(this.rootDir, "cas");
  }

  private sessionDir(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new CheckpointError("Invalid checkpoint session ID");
    return join(this.rootDir, "sessions", sessionId);
  }

  private sessionFile(sessionId: string): string {
    return join(this.sessionDir(sessionId), "session.json");
  }

  private manifestFile(sessionId: string, index: number): string {
    return join(this.sessionDir(sessionId), `${index}.json`);
  }

  private blobPath(sha1: string): string {
    if (!/^[a-f0-9]{40}$/.test(sha1)) throw new CheckpointError("Invalid checkpoint blob hash");
    return join(this.casDir, sha1.slice(0, 2), sha1);
  }

  /** Absolute game path -> path relative to kotorDirectory, or undefined when outside it. */
  relativePath(absolute: string): string | undefined {
    const p = toPosix(absolute);
    const root = this.kotorDirectory;
    if (p.length <= root.length + 1) return undefined;
    if (p.slice(0, root.length).toLowerCase() !== root.toLowerCase() || p[root.length] !== "/") return undefined;
    const rel = p.slice(root.length + 1);
    if (!rel || rel.split("/").some((seg) => seg === "..")) return undefined;
    return rel;
  }

  absolutePath(relative: string): string {
    if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes(":") || relative.includes("\0") || relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new CheckpointError("Invalid checkpoint file path");
    }
    return `${this.kotorDirectory}/${relative}`;
  }

  // ---------------------------------------------------------------------
  // Locking
  // ---------------------------------------------------------------------

  private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------

  async startSession(label: string): Promise<CheckpointSession> {
    const id = nowId();
    const createdAt = new Date().toISOString();
    const baseline: CheckpointMeta = {
      id: `${id}-0`,
      sessionId: id,
      index: 0,
      isAnchor: true,
      createdAt,
      label,
      changedCount: 0,
      storedBytes: 0,
    };
    const session: StoredCheckpointSession = {
      id,
      label,
      kotorDirectory: this.kotorDirectory,
      createdAt,
      anchorInterval: this.anchorInterval,
      checkpoints: [baseline],
    };
    await mkdir(this.sessionDir(id), { recursive: true });
    await writeJsonAtomic(this.manifestFile(id, 0), { id: baseline.id, index: 0, isAnchor: true, entries: [] });
    await writeJsonAtomic(this.sessionFile(id), session);
    return session;
  }

  async getSession(sessionId: string): Promise<StoredCheckpointSession> {
    try {
      const session = await readJson<StoredCheckpointSession>(this.sessionFile(sessionId));
      if (session.id !== sessionId || typeof session.kotorDirectory !== "string" || !isAbsolute(session.kotorDirectory) || !Number.isSafeInteger(session.anchorInterval) || session.anchorInterval < 1 || !Array.isArray(session.checkpoints) || !session.checkpoints.length || session.checkpoints.some((cp, index) => cp.index !== index || cp.sessionId !== sessionId || cp.id !== `${sessionId}-${index}` || cp.isAnchor !== (index % session.anchorInterval === 0))) {
        throw new CheckpointError("Invalid checkpoint session metadata");
      }
      return session;
    } catch {
      throw new CheckpointError(`Unknown checkpoint session "${sessionId}"`);
    }
  }

  /** All sessions, newest first. */
  async list(): Promise<CheckpointSession[]> {
    const dir = join(this.rootDir, "sessions");
    if (!(await exists(dir))) return [];
    const out: StoredCheckpointSession[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        out.push(await this.getSession(entry.name));
      } catch {
        /* skip half-written sessions */
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async delete(sessionId: string): Promise<void> {
    await this.withLock(sessionId, () => rm(this.sessionDir(sessionId), { recursive: true, force: true }));
  }

  /** Remove CAS blobs that no session references. Returns the number removed. */
  async gc(): Promise<number> {
    const referenced = new Set<string>();
    for (const s of await this.list()) {
      for (const cp of s.checkpoints) {
        const m = await this.readManifest(s.id, cp.index);
        for (const e of m.entries) if (e.sha1) referenced.add(e.sha1);
      }
    }
    let removed = 0;
    if (!(await exists(this.casDir))) return 0;
    for (const bucket of await readdir(this.casDir)) {
      const bucketDir = join(this.casDir, bucket);
      let names: string[];
      try {
        names = await readdir(bucketDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (referenced.has(name)) continue;
        await rm(join(bucketDir, name), { force: true });
        removed++;
      }
    }
    return removed;
  }

  // ---------------------------------------------------------------------
  // Manifests
  // ---------------------------------------------------------------------

  private async readManifest(sessionId: string, index: number): Promise<CheckpointManifest> {
    try {
      const manifest = await readJson<CheckpointManifest>(this.manifestFile(sessionId, index));
      const session = await this.getSession(sessionId);
      if (manifest.index !== index || manifest.id !== `${sessionId}-${index}` || manifest.isAnchor !== (index % session.anchorInterval === 0) || !Array.isArray(manifest.entries)) throw new CheckpointError("Invalid checkpoint manifest");
      const seen = new Set<string>();
      for (const entry of manifest.entries) {
        this.absolutePath(entry.path);
        if (seen.has(entry.path) || (entry.sha1 !== undefined && !/^[a-f0-9]{40}$/.test(entry.sha1))) throw new CheckpointError("Invalid checkpoint manifest entry");
        seen.add(entry.path);
      }
      return manifest;
    } catch {
      throw new CheckpointError(`Missing manifest ${index} for session "${sessionId}"`);
    }
  }

  private findCheckpoint(session: CheckpointSession, checkpointId: string): CheckpointMeta {
    const cp =
      session.checkpoints.find((c) => c.id === checkpointId) ??
      (/^\d+$/.test(checkpointId) ? session.checkpoints.find((c) => c.index === Number(checkpointId)) : undefined);
    if (!cp) throw new CheckpointError(`Unknown checkpoint "${checkpointId}" in session "${session.id}"`);
    return cp;
  }

  private async computeState(sessionId: string, index: number): Promise<CheckpointState> {
    const state: CheckpointState = new Map();
    const apply = (m: CheckpointManifest) => {
      for (const e of m.entries) state.set(e.path, e.sha1);
    };
    apply(await this.readManifest(sessionId, 0));
    if (index === 0) return state;
    const interval = (await this.getSession(sessionId)).anchorInterval;
    const anchor = index - (index % interval);
    if (anchor > 0) apply(await this.readManifest(sessionId, anchor));
    for (let i = anchor + 1; i <= index; i++) apply(await this.readManifest(sessionId, i));
    return state;
  }

  /** Tracked-file state (relative path -> sha1, undefined = absent) at a checkpoint. */
  async getState(sessionId: string, checkpointId: string): Promise<CheckpointState> {
    const session = await this.getSession(sessionId);
    const cp = this.findCheckpoint(session, checkpointId);
    return this.computeState(sessionId, cp.index);
  }

  // ---------------------------------------------------------------------
  // Blobs
  // ---------------------------------------------------------------------

  /** Store `data` in the CAS; returns the sha1 and how many new bytes were written (0 if deduplicated). */
  private async putBlob(data: Uint8Array): Promise<{ sha1: string; added: number }> {
    const sha1 = sha1Hex(data);
    const path = this.blobPath(sha1);
    if (await exists(path)) return { sha1, added: 0 };
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
    return { sha1, added: data.byteLength };
  }

  async readBlob(sha1: string): Promise<Uint8Array> {
    try {
      const data = new Uint8Array(await readFile(this.blobPath(sha1)));
      if (sha1Hex(data) !== sha1) throw new CheckpointError(`Blob ${sha1} failed integrity verification`);
      return data;
    } catch (err) {
      if (err instanceof CheckpointError) throw err;
      throw new CheckpointError(`Blob ${sha1} is missing from the checkpoint store`);
    }
  }

  async hasBlob(sha1: string): Promise<boolean> {
    return exists(this.blobPath(sha1));
  }

  /**
   * Expand the given absolute paths into relative file paths: files map to
   * themselves, existing directories are walked, paths outside the game
   * directory are ignored.
   */
  private async expandPaths(paths: string[]): Promise<string[]> {
    const out = new Set<string>();
    for (const raw of paths) {
      const rel = this.relativePath(raw);
      if (!rel) continue;
      const abs = this.absolutePath(rel);
      await this.assertContained(abs);
      const st = await this.fs.stat(abs);
      if (st?.isDirectory) {
        for (const file of await this.fs.walk(abs)) {
          const r = this.relativePath(file);
          if (r) out.add(r);
        }
      } else {
        out.add(rel);
      }
    }
    return [...out];
  }

  /** Snapshot the current content of one game file into the CAS. */
  private async capture(rel: string): Promise<{ entry: CheckpointFileEntry; added: number }> {
    const abs = this.absolutePath(rel);
    await this.assertContained(abs);
    const st = await this.fs.stat(abs);
    if (!st || st.isDirectory) return { entry: { path: rel }, added: 0 };
    const data = await this.fs.readFile(abs);
    const { sha1, added } = await this.putBlob(data);
    return { entry: { path: rel, sha1, size: data.byteLength, mtimeMs: st.mtimeMs }, added };
  }

  // ---------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------

  /**
   * Call before an instruction runs with every path it may modify. Paths seen
   * for the first time in the session have their current content stored and
   * recorded in the baseline (checkpoint 0); missing files are recorded as
   * absent. Returns the number of newly tracked paths.
   */
  beforeTouch(session: CheckpointSession, paths: string[]): Promise<number> {
    return this.withLock(session.id, async () => {
      const rels = await this.expandPaths(paths);
      if (rels.length === 0) return 0;
      const baseline = await this.readManifest(session.id, 0);
      const tracked = new Set(baseline.entries.map((e) => e.path));
      let added = 0;
      let bytes = 0;
      for (const rel of rels) {
        if (tracked.has(rel)) continue;
        const cap = await this.capture(rel);
        baseline.entries.push(cap.entry);
        tracked.add(rel);
        bytes += cap.added;
        added++;
      }
      if (added > 0) {
        await writeJsonAtomic(this.manifestFile(session.id, 0), baseline);
        const stored = await this.getSession(session.id);
        stored.checkpoints[0].changedCount = baseline.entries.length;
        stored.checkpoints[0].storedBytes += bytes;
        await writeJsonAtomic(this.sessionFile(session.id), stored);
        session.checkpoints[0] = stored.checkpoints[0];
      }
      return added;
    });
  }

  /**
   * Record a checkpoint after an instruction. Hashes the current state of
   * `touched` (files or directories under kotorDirectory) and writes either a
   * delta against the previous checkpoint or, on anchor indices, a full
   * manifest. Touched paths that were never passed to `beforeTouch` are
   * assumed to have been created by the instruction (baseline: absent).
   */
  create(session: CheckpointSession, meta: CreateCheckpointMeta): Promise<CheckpointMeta> {
    return this.withLock(session.id, async () => {
      const stored = await this.getSession(session.id);
      const prevIndex = stored.checkpoints.length - 1;
      const index = prevIndex + 1;
      const isAnchor = index % stored.anchorInterval === 0;

      const baseline = await this.readManifest(session.id, 0);
      const expanded = new Set(await this.expandPaths(meta.touched));
      // A removed directory cannot be walked anymore. Its previously tracked
      // children must still be captured as absent in this checkpoint.
      const touchedRoots = meta.touched.map((path) => this.relativePath(path)).filter((path): path is string => !!path);
      for (const entry of baseline.entries) {
        if (touchedRoots.some((root) => entry.path === root || entry.path.startsWith(`${root}/`))) expanded.add(entry.path);
      }
      const rels = [...expanded];
      const tracked = new Set(baseline.entries.map((e) => e.path));
      let baselineDirty = false;
      for (const rel of rels) {
        if (!tracked.has(rel)) {
          baseline.entries.push({ path: rel });
          tracked.add(rel);
          baselineDirty = true;
        }
      }
      if (baselineDirty) await writeJsonAtomic(this.manifestFile(session.id, 0), baseline);

      const prevState = await this.computeState(session.id, prevIndex);
      const changed: CheckpointFileEntry[] = [];
      let storedBytes = 0;
      for (const rel of rels) {
        const cap = await this.capture(rel);
        storedBytes += cap.added;
        if (prevState.get(rel) !== cap.entry.sha1 || !prevState.has(rel)) {
          changed.push(cap.entry);
        }
      }

      let entries: CheckpointFileEntry[];
      if (isAnchor) {
        const full = new Map<string, CheckpointFileEntry>();
        for (const [path, sha1] of prevState) full.set(path, sha1 === undefined ? { path } : { path, sha1 });
        // keep sizes for entries we already know about
        for (const e of changed) full.set(e.path, e);
        entries = [...full.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      } else {
        entries = changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      }

      const id = `${session.id}-${index}`;
      const cp: CheckpointMeta = {
        id,
        sessionId: session.id,
        index,
        isAnchor,
        createdAt: new Date().toISOString(),
        label: meta.label,
        modGuid: meta.modGuid,
        instructionGuid: meta.instructionGuid,
        changedCount: changed.length,
        storedBytes,
      };
      await writeJsonAtomic(this.manifestFile(session.id, index), { id, index, isAnchor, entries } satisfies CheckpointManifest);
      stored.checkpoints.push(cp);
      if (baselineDirty) stored.checkpoints[0].changedCount = baseline.entries.length;
      await writeJsonAtomic(this.sessionFile(session.id), stored);
      session.checkpoints.length = 0;
      session.checkpoints.push(...stored.checkpoints);
      return cp;
    });
  }

  // ---------------------------------------------------------------------
  // Restoring
  // ---------------------------------------------------------------------

  /**
   * Bring every tracked file back to its state at the checkpoint: writes CAS
   * content for present files and deletes files that were absent. Files whose
   * on-disk hash already matches are skipped.
   */
  restore(sessionId: string, checkpointId: string, onProgress?: RestoreProgress): Promise<void> {
    return this.withLock(sessionId, async () => {
      const session = await this.getSession(sessionId);
      if (resolve(session.kotorDirectory) !== resolve(this.kotorDirectory)) throw new CheckpointError("Checkpoint session belongs to a different game directory");
      const state = await this.computeState(sessionId, this.findCheckpoint(session, checkpointId).index);
      const paths = [...state.keys()].sort();
      // Validate every target and every blob before the first game mutation.
      // Missing/corrupt data must not leave a half-restored installation.
      const verified = new Set<string>();
      for (const rel of paths) {
        await this.assertContained(this.absolutePath(rel));
        const want = state.get(rel);
        if (want && !verified.has(want)) {
          await this.readBlob(want);
          verified.add(want);
        }
        const current = await this.fs.stat(this.absolutePath(rel));
        if (want && current?.isDirectory) throw new CheckpointError(`Cannot restore file over directory: ${rel}`);
      }
      const total = paths.length;
      let done = 0;
      onProgress?.(0, total);
      for (const rel of paths) {
        await this.assertContained(this.absolutePath(rel));
        const want = state.get(rel);
        const abs = this.absolutePath(rel);
        const st = await this.fs.stat(abs);
        if (want === undefined) {
          if (st && !st.isDirectory) await this.fs.remove(abs);
        } else {
          const same = st && !st.isDirectory ? (await this.fs.sha1(abs)) === want : false;
          if (!same) {
            const data = await this.readBlob(want);
            await this.fs.mkdirp(dirname(abs));
            await this.fs.writeFile(abs, data);
          }
        }
        done++;
        onProgress?.(done, total);
      }
    });
  }

  private async assertContained(path: string): Promise<void> {
    if (!this.fs.realpath) return;
    const root = await this.fs.realpath(this.kotorDirectory);
    let existing = path;
    while (!(await this.fs.exists(existing))) {
      if (await this.fs.isSymbolicLink?.(existing)) throw new CheckpointError("Checkpoint destination contains a dangling symbolic link");
      const parent = dirname(existing);
      if (parent === existing) throw new CheckpointError("Checkpoint destination has no existing parent");
      existing = parent;
    }
    let canonical: string;
    try {
      canonical = await this.fs.realpath(existing);
    } catch (err) {
      throw new CheckpointError(`Checkpoint destination cannot be resolved safely: ${err instanceof Error ? err.message : String(err)}`);
    }
    const rel = relative(root, canonical);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new CheckpointError("Checkpoint destination escapes the game directory");
  }

  // ---------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------

  /**
   * Blob count and bytes referenced by a session; without a session id, the
   * whole content store is measured.
   */
  async stats(sessionId?: string): Promise<CheckpointStats> {
    if (sessionId === undefined) {
      let blobCount = 0;
      let bytes = 0;
      if (await exists(this.casDir)) {
        for (const bucket of await readdir(this.casDir)) {
          const bucketDir = join(this.casDir, bucket);
          let names: string[];
          try {
            names = await readdir(bucketDir);
          } catch {
            continue;
          }
          for (const name of names) {
            if (name.endsWith(".tmp")) continue;
            const st = await stat(join(bucketDir, name));
            blobCount++;
            bytes += st.size;
          }
        }
      }
      return { blobCount, bytes, checkpointCount: 0, trackedCount: 0 };
    }
    const session = await this.getSession(sessionId);
    const sizes = new Map<string, number>();
    let trackedCount = 0;
    for (const cp of session.checkpoints) {
      const m = await this.readManifest(sessionId, cp.index);
      if (cp.index === 0) trackedCount = m.entries.length;
      for (const e of m.entries) {
        if (!e.sha1 || sizes.has(e.sha1)) continue;
        sizes.set(e.sha1, e.size ?? (await stat(this.blobPath(e.sha1)).then((s) => s.size, () => 0)));
      }
    }
    let bytes = 0;
    for (const s of sizes.values()) bytes += s;
    return { blobCount: sizes.size, bytes, checkpointCount: session.checkpoints.length, trackedCount };
  }
}
