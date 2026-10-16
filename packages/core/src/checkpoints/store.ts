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
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, lstat } from "node:fs/promises";
import { dirname, join, resolve, basename, isAbsolute } from "node:path";
import type { FileSystemPort } from "../ports/filesystem.js";
import { withPortableRootOwnership, type PhysicalInstallOptIn } from "../fs/portableLock.js";
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
  /**
   * CI-only explicit opt-in to restore a non-virtual game directory under the
   * portable lockfile. Without it physical restore stays refused.
   */
  physicalRestore?: PhysicalInstallOptIn;
}

export interface CreateCheckpointMeta {
  label: string;
  modGuid?: Guid;
  instructionGuid?: Guid;
  /** Absolute paths (files or directories) the instruction reported as created/modified/deleted. */
  touched: string[];
  /**
   * Subset of `touched` that was not passed to `beforeTouch` first (patchers,
   * external programs). Their pre-mutation content is unknown, so a physical
   * restore to an earlier checkpoint is refused.
   */
  unpredicted?: string[];
}

/** `session.json` on disk: the public session plus the label given to `startSession`. */
export interface StoredCheckpointSession extends CheckpointSession {
  label: string;
  /** Checkpoint indexes that first saw paths whose true baseline is unknown (recorded as absent). */
  unverifiedBaselineAt?: number[];
  /** Durable unfinished instruction; retained if execution/checkpoint finalization fails. */
  /** Durable multi-document publication intent. No automatic recovery/acknowledgement. */
  pendingPublication?: { kind: "baseline" | "checkpoint"; previousIndex: number; targetIndex: number; baselineCount: number; storeDirectory: string; kotorDirectory: string; startedAt: string };
  pendingMutation?: { schemaVersion?: number; operationId?: string; binding?: {sessionId:string;storeDirectory:string;kotorDirectory:string}; baselineSha256?:string; previousManifestSha256?:string; instructionGuid: Guid; previousCheckpointId: string; predicted: string[]; startedAt: string; completedCheckpointId?: string };
  pendingRestore?: { schemaVersion: 1; operationId: string; binding: { sessionId: string; storeDirectory: string; kotorDirectory: string }; targetCheckpointId: string; targetCheckpointIndex: number; targetStateSha256: string; startedAt: string };
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

function safeSessionId(value:unknown):asserts value is string {
 if(typeof value!=="string"||!value||value.length>200||!/^[-_a-zA-Z0-9]+$/.test(value))throw new CheckpointError("Invalid checkpoint session identifier");
}
function safeIndex(value:unknown):asserts value is number {
 if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0)throw new CheckpointError("Invalid checkpoint index");
}
function safeSha(value:unknown):asserts value is string {
 if(typeof value!=="string"||!/^[0-9a-f]{40}$/.test(value))throw new CheckpointError("Invalid canonical checkpoint digest");
}
function safeRelative(value:unknown):asserts value is string {
 if(typeof value!=="string"||!value||/[\\:\x00-\x1f\x7f]/.test(value)||value.split("/").some(part=>!part||part==="."||part===".."||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)))throw new CheckpointError("Invalid canonical checkpoint relative path");
}
function rememberCasePath(path:string,spellings:Map<string,string>):void {
 let prefix="";for(const part of path.split("/")){prefix=prefix?`${prefix}/${part}`:part;const key=prefix.toLowerCase(),previous=spellings.get(key);if(previous!==undefined&&previous!==prefix)throw new CheckpointError("Checkpoint path has inconsistent case spelling");spellings.set(key,prefix);}
}
function safeAbsolute(value:unknown):asserts value is string {
 if(typeof value!=="string"||!isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value)||toPosix(resolve(value))!==value)throw new CheckpointError("Invalid canonical checkpoint root/path");
}
/** No-follow static intake proof, not protection from concurrent hostile ancestor replacement. */
async function ordinaryPath(path:string,directory:boolean|"entry"=false,allowMissing=false):Promise<void>{
 const chain:string[]=[];for(let p=resolve(path);;p=dirname(p)){chain.unshift(p);if(dirname(p)===p)break;}
 for(let index=0;index<chain.length;index++){
  const current=chain[index]!;let entry;
  try{entry=await lstat(current);}catch(error){if(allowMissing&&(error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  if(entry.isSymbolicLink()||(index<chain.length-1||directory===true?!entry.isDirectory():directory==="entry"?(!entry.isDirectory()&&!entry.isFile()):!entry.isFile()))throw new CheckpointError("Checkpoint path contains a symlink or unexpected type");
  if(index>0){const name=basename(current),matches=(await readdir(dirname(current))).filter(candidate=>candidate.toLowerCase()===name.toLowerCase());if(matches.length!==1||matches[0]!==name)throw new CheckpointError("Checkpoint path has a case alias/collision");}
 }
}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==="object"&&!Array.isArray(value);}
function validateSession(value:unknown,sessionId:string):asserts value is StoredCheckpointSession {
 safeSessionId(sessionId);if(!record(value)||value.id!==sessionId||!Array.isArray(value.checkpoints)||!value.checkpoints.length)throw new CheckpointError("Invalid checkpoint session record");
 safeAbsolute(value.kotorDirectory);if(typeof value.anchorInterval!=="number"||!Number.isSafeInteger(value.anchorInterval)||value.anchorInterval<1)throw new CheckpointError("Invalid checkpoint anchor interval");
 value.checkpoints.forEach((cp,index)=>{if(!record(cp)||cp.sessionId!==sessionId||cp.id!==`${sessionId}-${index}`||cp.index!==index||typeof cp.isAnchor!=="boolean"||(index===0&&!cp.isAnchor))throw new CheckpointError("Invalid checkpoint identity/order");for(const key of ["changedCount","storedBytes"])if(typeof cp[key]!=="number"||!Number.isSafeInteger(cp[key])||(cp[key] as number)<0)throw new CheckpointError("Invalid checkpoint counters");});
 const publication=value.pendingPublication;if(publication!==undefined){if(!record(publication)||(publication.kind!=="baseline"&&publication.kind!=="checkpoint")||typeof publication.startedAt!=="string")throw new CheckpointError("Invalid checkpoint publication intent");safeIndex(publication.previousIndex);safeIndex(publication.targetIndex);safeIndex(publication.baselineCount);safeAbsolute(publication.storeDirectory);safeAbsolute(publication.kotorDirectory);if(publication.kotorDirectory!==value.kotorDirectory||publication.previousIndex!==value.checkpoints.length-1||publication.targetIndex!==publication.previousIndex+(publication.kind==="checkpoint"?1:0))throw new CheckpointError("Checkpoint publication intent disagrees with saved history/root");}
 const pending=value.pendingMutation;if(record(pending)&&pending.schemaVersion===1){if(typeof pending.operationId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pending.operationId)||!record(pending.binding)||pending.binding.sessionId!==sessionId||pending.binding.kotorDirectory!==value.kotorDirectory)throw new CheckpointError("Invalid schema1 checkpoint operation binding");safeAbsolute(pending.binding.storeDirectory);safeAbsolute(pending.binding.kotorDirectory);for(const digest of [pending.baselineSha256,pending.previousManifestSha256])if(typeof digest!=="string"||!/^[0-9a-f]{64}$/.test(digest))throw new CheckpointError("Invalid checkpoint manifest observation digest");}
 if(pending!==undefined){if(!record(pending)||typeof pending.instructionGuid!=="string"||!Array.isArray(pending.predicted)||!value.checkpoints.some(cp=>(cp as Record<string,unknown>).id===pending.previousCheckpointId)||typeof pending.startedAt!=="string")throw new CheckpointError("Invalid checkpoint pending mutation");pending.predicted.forEach(safeAbsolute);if(pending.completedCheckpointId!==undefined){const completed=value.checkpoints.find(cp=>(cp as Record<string,unknown>).id===pending.completedCheckpointId),previous=value.checkpoints.find(cp=>(cp as Record<string,unknown>).id===pending.previousCheckpointId);if(!record(completed)||!record(previous)||completed.instructionGuid!==pending.instructionGuid||completed.index!==(previous.index as number)+1)throw new CheckpointError("Invalid checkpoint completion identity");}}
 const restore=value.pendingRestore;if(restore!==undefined){if(!record(restore)||restore.schemaVersion!==1||typeof restore.operationId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(restore.operationId)||!record(restore.binding)||restore.binding.sessionId!==sessionId||restore.binding.kotorDirectory!==value.kotorDirectory||typeof restore.targetCheckpointId!=="string"||typeof restore.targetStateSha256!=="string"||!/^[0-9a-f]{64}$/.test(restore.targetStateSha256)||typeof restore.startedAt!=="string")throw new CheckpointError("Invalid checkpoint restore intent");safeAbsolute(restore.binding.storeDirectory);safeAbsolute(restore.binding.kotorDirectory);safeIndex(restore.targetCheckpointIndex);if(!value.checkpoints.some(cp=>cp.id===restore.targetCheckpointId&&cp.index===restore.targetCheckpointIndex))throw new CheckpointError("Checkpoint restore intent targets unknown checkpoint");}
}
function validateManifest(value:unknown,sessionId:string,index:number):asserts value is CheckpointManifest {
 if(!record(value)||value.id!==`${sessionId}-${index}`||value.index!==index||typeof value.isAnchor!=="boolean"||!Array.isArray(value.entries))throw new CheckpointError("Invalid checkpoint manifest identity");
 const paths=new Set<string>(),spellings=new Map<string,string>();for(const entry of value.entries){if(!record(entry))throw new CheckpointError("Invalid checkpoint entry");safeRelative(entry.path);rememberCasePath(entry.path,spellings);const key=entry.path.toLowerCase();if(paths.has(key))throw new CheckpointError("Duplicate/case-aliased checkpoint path");paths.add(key);if(entry.sha1!==undefined)safeSha(entry.sha1);if(entry.size!==undefined&&(typeof entry.size!=="number"||!Number.isSafeInteger(entry.size)||entry.size<0))throw new CheckpointError("Invalid checkpoint entry size");if(entry.mtimeMs!==undefined&&(typeof entry.mtimeMs!=="number"||!Number.isFinite(entry.mtimeMs)||entry.mtimeMs<0))throw new CheckpointError("Invalid checkpoint timestamp");}
}

async function readJson<T>(p: string): Promise<T> {
  await ordinaryPath(p);return JSON.parse(await readFile(p, "utf8")) as T;
}

async function syncDirectory(path:string):Promise<void>{
 const handle=await open(path,"r");try{await handle.sync();}finally{await handle.close();}
}
async function mkdirDurable(path:string):Promise<void>{
 await ordinaryPath(path,true,true);const firstCreated=await mkdir(path,{recursive:true});await ordinaryPath(path,true);
 const boundary=firstCreated?dirname(firstCreated):path;
 for(let cursor=path;;cursor=dirname(cursor)){await syncDirectory(cursor);if(cursor===boundary||dirname(cursor)===cursor)break;}
}
async function publishDurable(path:string,data:string|Uint8Array):Promise<void>{
 await ordinaryPath(path,false,true);await mkdirDurable(dirname(path));const tmp=`${path}.${randomUUID()}.tmp`;
 const handle=await open(tmp,"wx");try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
 await rename(tmp,path);await syncDirectory(dirname(path));
}
async function writeJsonAtomic(path:string,value:unknown):Promise<void>{
 const sessionId=basename(dirname(path)),name=basename(path);if(name==="session.json")validateSession(value,sessionId);else {if(!/^(0|[1-9][0-9]*)\.json$/.test(name))throw new CheckpointError("Invalid checkpoint publication filename");validateManifest(value,sessionId,Number(name.slice(0,-5)));}
 await publishDurable(path,JSON.stringify(value,null,2));
}
// Shared across store instances in this process; this is not an operating-system writer lock.
const storeLockKey=Symbol.for("modsync.checkpoint-store.root-queues");
const storeGlobals=globalThis as typeof globalThis & {[storeLockKey]?:Map<string,Promise<unknown>>};
const STORE_LOCKS=storeGlobals[storeLockKey]??=new Map<string,Promise<unknown>>();
async function canonicalStoreRoot(path:string):Promise<string>{
 let current=resolve(path);const missing:string[]=[];
 for(;;){try{return join(await realpath(current),...missing.reverse());}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;missing.push(basename(current));const parent=dirname(current);if(parent===current)throw error;current=parent;}}
}

export class CheckpointStore {
  readonly rootDir: string;
  readonly kotorDirectory: string;
  readonly anchorInterval: number;
  private readonly fs: FileSystemPort;
  private readonly physicalRestore: PhysicalInstallOptIn | undefined;
  /** Root-wide same-process serialization covers CAS capture through reference publication and GC. */


  constructor(opts: CheckpointStoreOptions) {
    if (!opts.fs) throw new CheckpointError("CheckpointStore requires a FileSystemPort");
    this.rootDir = toPosix(opts.rootDir);safeAbsolute(this.rootDir);
    this.kotorDirectory = toPosix(opts.kotorDirectory);safeAbsolute(this.kotorDirectory);
    this.fs = opts.fs;
    this.physicalRestore = opts.physicalRestore;
    this.anchorInterval = Math.max(1, Math.floor(opts.anchorInterval ?? 10));
  }

  // ---------------------------------------------------------------------
  // Paths
  // ---------------------------------------------------------------------

  private get casDir(): string {
    return join(this.rootDir, "cas");
  }

  private sessionDir(sessionId: string): string {
    safeSessionId(sessionId);return join(this.rootDir, "sessions", sessionId);
  }

  private sessionFile(sessionId: string): string {
    return join(this.sessionDir(sessionId), "session.json");
  }

  private manifestFile(sessionId: string, index: number): string {
    safeIndex(index);return join(this.sessionDir(sessionId), `${index}.json`);
  }

  private blobPath(sha1: string): string {
    safeSha(sha1);return join(this.casDir, sha1.slice(0, 2), sha1);
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
    safeRelative(relative);return `${this.kotorDirectory}/${relative}`;
  }

  // ---------------------------------------------------------------------
  // Locking
  // ---------------------------------------------------------------------

  private async withLock<T>(sessionId:string,fn:()=>Promise<T>):Promise<T>{
    safeSessionId(sessionId);return this.withRootLock(fn);
  }

  private async withRootLock<T>(fn:()=>Promise<T>):Promise<T>{
    const key=await canonicalStoreRoot(this.rootDir);
    const prev=STORE_LOCKS.get(key)??Promise.resolve();const next=prev.then(fn,fn);
    const tail=next.catch(()=>undefined);STORE_LOCKS.set(key,tail);
    try{return await next;}finally{if(STORE_LOCKS.get(key)===tail)STORE_LOCKS.delete(key);}
  }

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------

  startSession(label: string): Promise<CheckpointSession> {
    return this.withRootLock(()=>this.startSessionOwned(label));
  }

  private async startSessionOwned(label:string):Promise<CheckpointSession>{
    await ordinaryPath(this.rootDir,true,true);
    // Do not hide unresolved or unreadable prior recovery records by starting a new run.
    let previous:string[];
    await ordinaryPath(join(this.rootDir,"sessions"),true,true);
    try { previous=await readdir(join(this.rootDir,"sessions")); }
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;previous=[];}
    for(const name of previous){
      safeSessionId(name);const path=join(this.rootDir,"sessions",name),entry=await lstat(path);if(entry.isSymbolicLink())throw new CheckpointError("Checkpoint session directory contains a symlink");if(!entry.isDirectory())continue;
      const stored=await this.getSession(name);
      if(stored.pendingPublication)throw new CheckpointError(`Unfinished checkpoint publication ${stored.id} requires recovery`);
      if(stored.pendingMutation&&!stored.pendingMutation.completedCheckpointId)throw new CheckpointError(`Unfinished checkpoint session ${stored.id} requires recovery`);
      if(stored.pendingRestore)throw new CheckpointError(`Unfinished checkpoint restore ${stored.id} requires recovery`);
    }
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
    await mkdirDurable(this.sessionDir(id));
    await writeJsonAtomic(this.manifestFile(id, 0), { id: baseline.id, index: 0, isAnchor: true, entries: [] });
    await writeJsonAtomic(this.sessionFile(id), session);
    return session;
  }

  async getSession(sessionId: string): Promise<StoredCheckpointSession> {
    try {
      safeSessionId(sessionId);const value=await readJson<unknown>(this.sessionFile(sessionId));validateSession(value,sessionId);
      if(value.pendingPublication&&(value.pendingPublication.storeDirectory!==this.rootDir||value.pendingPublication.kotorDirectory!==this.kotorDirectory))throw new CheckpointError("Checkpoint publication belongs to a different store root");
      if(value.pendingMutation?.schemaVersion===1&&(value.pendingMutation.binding?.storeDirectory!==this.rootDir||value.pendingMutation.binding.kotorDirectory!==this.kotorDirectory))throw new CheckpointError("Checkpoint operation belongs to different snapshot/store roots");
      return value;
    } catch {
      throw new CheckpointError(`Unknown checkpoint session "${sessionId}"`);
    }
  }

  /** All sessions, newest first. */
  async list(): Promise<CheckpointSession[]> {
    const dir = join(this.rootDir, "sessions");
    await ordinaryPath(dir,true,true);if (!(await exists(dir))) return [];
    const out: StoredCheckpointSession[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink())throw new CheckpointError("Checkpoint session directory contains a symlink");
      if (!entry.isDirectory()) continue;out.push(await this.getSession(entry.name));
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async delete(sessionId: string): Promise<void> {
    await this.withLock(sessionId, async () => {
      const stored=await this.getSession(sessionId);
      if(stored.pendingPublication)throw new CheckpointError("Cannot delete an unfinished checkpoint publication");
      if(stored.pendingMutation&&!stored.pendingMutation.completedCheckpointId)throw new CheckpointError("Cannot delete an unfinished recovery session");
      if(stored.pendingRestore)throw new CheckpointError("Cannot delete an unfinished checkpoint restore");
      await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    });
  }

  /** Remove CAS blobs that no session references. Returns the number removed. */
  gc(): Promise<number> {
    return this.withRootLock(()=>this.gcOwned());
  }

  private async gcOwned():Promise<number>{
    const referenced = new Set<string>();
    for (const s of await this.list()) {
      const stored=await this.getSession(s.id);
      if(stored.pendingPublication||(stored.pendingMutation&&!stored.pendingMutation.completedCheckpointId)||stored.pendingRestore)throw new CheckpointError("Garbage collection is unavailable while checkpoint recovery is pending");
      for (const cp of s.checkpoints) {
        const m = await this.readManifest(s.id, cp.index);
        for (const e of m.entries) if (e.sha1) referenced.add(e.sha1);
      }
    }
    // Prove all retained bytes before deleting any possible alternate repair material.
    for(const hash of referenced)await this.readBlob(hash);
    const candidates:string[]=[];
    await ordinaryPath(this.casDir,true,true);if (!(await exists(this.casDir))) return 0;
    for(const bucket of await readdir(this.casDir)){
      if(!/^[0-9a-f]{2}$/.test(bucket))throw new CheckpointError("Invalid checkpoint CAS bucket");
      const directory=join(this.casDir,bucket);await ordinaryPath(directory,true);
      for(const name of await readdir(directory)){
        if(name.endsWith(".tmp"))continue;safeSha(name);if(name.slice(0,2)!==bucket)throw new CheckpointError("Checkpoint blob is in the wrong bucket");
        const path=this.blobPath(name);await ordinaryPath(path);if(!referenced.has(name))candidates.push(path);
      }
    }
    for(const path of candidates){await ordinaryPath(path);await rm(path);}
    return candidates.length;
  }

  // ---------------------------------------------------------------------
  // Manifests
  // ---------------------------------------------------------------------

  private async readManifest(sessionId: string, index: number, duringRestore = false): Promise<CheckpointManifest> {
    try {
      safeSessionId(sessionId);safeIndex(index);const session=await this.getSession(sessionId);this.requirePublished(session,duringRestore);const checkpoint=session.checkpoints[index];if(!checkpoint)throw new CheckpointError("Checkpoint manifest index is outside the saved history");
      const value=await readJson<unknown>(this.manifestFile(sessionId,index));validateManifest(value,sessionId,index);
      if(value.isAnchor!==checkpoint.isAnchor||((index===0||!checkpoint.isAnchor)&&value.entries.length!==checkpoint.changedCount)||(checkpoint.isAnchor&&value.entries.length<checkpoint.changedCount))throw new CheckpointError("Checkpoint manifest disagrees with saved anchor/count metadata");return value;
    } catch {
      throw new CheckpointError(`Missing manifest ${index} for session "${sessionId}"`);
    }
  }

  private findCheckpoint(session: CheckpointSession, checkpointId: string): CheckpointMeta {
    safeSessionId(checkpointId);
    const cp =
      session.checkpoints.find((c) => c.id === checkpointId) ??
      (/^\d+$/.test(checkpointId) ? session.checkpoints.find((c) => c.index === Number(checkpointId)) : undefined);
    if (!cp) throw new CheckpointError(`Unknown checkpoint "${checkpointId}" in session "${session.id}"`);
    return cp;
  }

  private async computeState(sessionId: string, index: number, duringRestore = false): Promise<CheckpointState> {
    safeIndex(index);const session=await this.getSession(sessionId);if(!session.checkpoints[index])throw new CheckpointError("Checkpoint index is outside saved history");
    const state: CheckpointState = new Map(),spellings=new Map<string,string>();
    const apply = (m: CheckpointManifest) => {
      for (const e of m.entries) {rememberCasePath(e.path,spellings);state.set(e.path, e.sha1);}
    };
    apply(await this.readManifest(sessionId, 0, duringRestore));
    if (index === 0) return state;
    const anchor = session.checkpoints.slice(0,index+1).reduce((nearest,checkpoint)=>checkpoint.isAnchor?checkpoint.index:nearest,0);
    if (anchor > 0) apply(await this.readManifest(sessionId, anchor, duringRestore));
    for (let i = anchor + 1; i <= index; i++) apply(await this.readManifest(sessionId, i, duringRestore));
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
    await ordinaryPath(path,false,true);if(await exists(path)) {const bytes=await readFile(path);if(sha1Hex(bytes)!==sha1)throw new CheckpointError("Existing baseline blob digest mismatch");const handle=await open(path,"r");try{await handle.sync();}finally{await handle.close();}await syncDirectory(dirname(path));return {sha1,added:0};}
    await publishDurable(path,data);
    return { sha1, added: data.byteLength };
  }

  async readBlob(sha1: string): Promise<Uint8Array> {
    try {
      const path=this.blobPath(sha1);await ordinaryPath(path);const data=new Uint8Array(await readFile(path));if(sha1Hex(data)!==sha1)throw new CheckpointError("Checkpoint blob digest mismatch");return data;
    } catch {
      throw new CheckpointError(`Blob ${sha1} is missing from the checkpoint store`);
    }
  }

  async hasBlob(sha1: string): Promise<boolean> {
    const path=this.blobPath(sha1);await ordinaryPath(path,false,true);return exists(path);
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
      await ordinaryPath(abs,"entry",true);const st = await this.fs.stat(abs);
      if (st?.isDirectory) {
        for (const file of await this.walkOrdinary(abs)) {
          const r = this.relativePath(file);
          if (r) out.add(r);
        }
      } else {
        out.add(rel);
      }
    }
    return [...out];
  }

  private async walkOrdinary(directory:string):Promise<string[]>{
    await ordinaryPath(directory,true,true);
    try{for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))throw new CheckpointError("Game snapshot directory contains a symlink or unsupported type");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const files:string[]=[];for(const entry of await this.fs.readDir(directory)){await ordinaryPath(entry.path,"entry",true);if(entry.isDirectory)files.push(...await this.walkOrdinary(entry.path));else files.push(entry.path);}return files;
  }

  /** Snapshot the current content of one game file into the CAS. */
  private async capture(rel: string): Promise<{ entry: CheckpointFileEntry; added: number }> {
    const abs = this.absolutePath(rel);
    await ordinaryPath(abs,"entry",true);const st = await this.fs.stat(abs);
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
      const stored=await this.getSession(session.id);this.requirePublished(stored);
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
        await this.beginPublication(stored,"baseline",baseline.entries.length);
        await writeJsonAtomic(this.manifestFile(session.id, 0), baseline);
        stored.checkpoints[0].changedCount = baseline.entries.length;
        stored.checkpoints[0].storedBytes += bytes;
        delete stored.pendingPublication;
        await writeJsonAtomic(this.sessionFile(session.id), stored);
        session.checkpoints[0] = stored.checkpoints[0];
      }
      return added;
    });
  }

  /** Exact raw bytes observed through static safe intake; not a concurrent OS snapshot. */
  private async manifestObservation(sessionId:string,index:number):Promise<string>{
    await this.readManifest(sessionId,index);
    const path=this.manifestFile(sessionId,index);await ordinaryPath(path);
    return createHash("sha256").update(await readFile(path)).digest("hex");
  }

  /** Inventory only. Neither a completed marker nor a hash observation proves quiescence. */
  async inspectRecovery(sessionId:string):Promise<{sessionId:string;recoveryAvailable:false;physicalRestore:false;pendingPublication:boolean;pendingRestore:boolean;mutationSchema:"schema1"|"legacy"|"none";mutationStatus:"unfinished"|"completed-audit"|"none";reason:string}>{
    const stored=await this.getSession(sessionId),pending=stored.pendingMutation;
    return {sessionId:stored.id,recoveryAvailable:false,physicalRestore:false,pendingPublication:!!stored.pendingPublication,pendingRestore:!!stored.pendingRestore,mutationSchema:pending?(pending.schemaVersion===1?"schema1":"legacy"):"none",mutationStatus:pending?(pending.completedCheckpointId?"completed-audit":"unfinished"):"none",reason:"Paired install-root ownership, external-writer quiescence and verified durable recovery acknowledgement are unavailable"};
  }

  /** `duringRestore` lets the verified physical restore read manifests while its own intent is pending. */
  private requirePublished(session:StoredCheckpointSession,duringRestore=false):void {
    if(session.kotorDirectory!==this.kotorDirectory)throw new CheckpointError("Checkpoint session belongs to a different game root");
    if(session.pendingPublication)throw new CheckpointError("Unfinished checkpoint publication requires verified recovery; state cannot be reconstructed or recorded");
    if(session.pendingRestore&&!duringRestore)throw new CheckpointError("Unfinished checkpoint restore requires verified recovery; state cannot be reconstructed or recorded");
  }

  private async stateObservation(sessionId:string,index:number):Promise<string>{
    const state=await this.computeState(sessionId,index),canonical=[...state.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,sha1])=>`${path}\0${sha1??""}\n`).join("");
    return createHash("sha256").update(canonical).digest("hex");
  }

  /** Hash of the tracked paths as they are on disk now, in the same canonical form as `stateObservation`. */
  private async diskStateObservation(sessionId:string,index:number):Promise<string>{
    const state=await this.computeState(sessionId,index,true),lines:string[]=[];
    for(const rel of [...state.keys()].sort((a,b)=>a<b?-1:a>b?1:0)){
      const abs=this.absolutePath(rel);await ordinaryPath(abs,"entry",true);const st=await this.fs.stat(abs);
      lines.push(`${rel}\0${st&&!st.isDirectory?await this.fs.sha1(abs):""}\n`);
    }
    return createHash("sha256").update(lines.join("")).digest("hex");
  }

  beginRestoreIntent(sessionId:string,checkpointId:string):Promise<{operationId:string;targetCheckpointId:string;targetCheckpointIndex:number;targetStateSha256:string}>{
    return this.beginRestoreIntentOwned(sessionId,checkpointId,false);
  }

  /** `allowUnfinishedMutationRollback` permits only the checkpoint taken before the unfinished instruction. */
  private async beginRestoreIntentOwned(sessionId:string,checkpointId:string,allowUnfinishedMutationRollback:boolean):Promise<{operationId:string;targetCheckpointId:string;targetCheckpointIndex:number;targetStateSha256:string}>{
    return this.withLock(sessionId,async()=>{
      const stored=await this.getSession(sessionId);this.requirePublished(stored);
      const unfinished=stored.pendingMutation&&!stored.pendingMutation.completedCheckpointId?stored.pendingMutation:undefined;
      if(unfinished&&allowUnfinishedMutationRollback&&unfinished.predicted.length===0)throw new CheckpointError("Unfinished mutation had no predicted paths (patcher/external program); its partial effects cannot be rolled back from checkpoints");
      if(unfinished&&!(allowUnfinishedMutationRollback&&this.findCheckpoint(stored,checkpointId).id===unfinished.previousCheckpointId))throw new CheckpointError(allowUnfinishedMutationRollback?"Unfinished mutation can only be rolled back to the checkpoint taken just before it":"Unfinished mutation requires recovery before checkpoint restore");
      const checkpoint=this.findCheckpoint(stored,checkpointId),state=await this.computeState(sessionId,checkpoint.index),verified=new Set<string>();
      for(const sha1 of state.values())if(sha1!==undefined&&!verified.has(sha1)){await this.readBlob(sha1);verified.add(sha1);}
      const targetStateSha256=await this.stateObservation(sessionId,checkpoint.index),operationId=randomUUID();
      stored.pendingRestore={schemaVersion:1,operationId,binding:{sessionId:stored.id,storeDirectory:this.rootDir,kotorDirectory:this.kotorDirectory},targetCheckpointId:checkpoint.id,targetCheckpointIndex:checkpoint.index,targetStateSha256,startedAt:new Date().toISOString()};
      await writeJsonAtomic(this.sessionFile(sessionId),stored);
      return {operationId,targetCheckpointId:checkpoint.id,targetCheckpointIndex:checkpoint.index,targetStateSha256};
    });
  }

  async getRestoreIntent(sessionId:string):Promise<StoredCheckpointSession["pendingRestore"]>{
    const stored=await this.getSession(sessionId),restore=stored.pendingRestore;
    if (restore && (restore.binding.storeDirectory !== this.rootDir || restore.binding.kotorDirectory !== this.kotorDirectory)) {
      throw new CheckpointError("Checkpoint restore intent belongs to a different store or game root");
    }
    return restore;
  }

  async acknowledgeRestore(sessionId:string,operationId:string,verifiedStateSha256:string):Promise<void>{
    return this.withLock(sessionId,async()=>{
      const stored=await this.getSession(sessionId),restore=stored.pendingRestore;
      if(!restore||restore.operationId!==operationId)throw new CheckpointError("Checkpoint restore intent identity changed");
      if (restore.binding.storeDirectory !== this.rootDir || restore.binding.kotorDirectory !== this.kotorDirectory) {
        throw new CheckpointError("Checkpoint restore intent belongs to a different store or game root");
      }
      if (this.physicalRestore?.ownership !== "portable-lockfile") {
        throw new CheckpointError("Physical restore verification authority is not implemented; restore intent remains pending");
      }
      const observed = await this.diskStateObservation(sessionId, restore.targetCheckpointIndex);
      if (observed !== restore.targetStateSha256 || observed !== verifiedStateSha256) {
        throw new CheckpointError("Physical restore verification failed: on-disk state does not match the checkpoint; restore intent remains pending");
      }
      delete stored.pendingRestore;
      if (stored.pendingMutation && !stored.pendingMutation.completedCheckpointId && stored.pendingMutation.previousCheckpointId === restore.targetCheckpointId) {
        delete stored.pendingMutation;
      }
      await writeJsonAtomic(this.sessionFile(sessionId), stored);
    });
  }

  private async beginPublication(stored:StoredCheckpointSession,kind:"baseline"|"checkpoint",baselineCount:number):Promise<void>{
    this.requirePublished(stored);
    const previousIndex=stored.checkpoints.length-1;
    stored.pendingPublication={kind,previousIndex,targetIndex:previousIndex+(kind==="checkpoint"?1:0),baselineCount,storeDirectory:toPosix(resolve(this.rootDir)),kotorDirectory:this.kotorDirectory,startedAt:new Date().toISOString()};
    await writeJsonAtomic(this.sessionFile(stored.id),stored);
  }

  /** Publish recovery identity only after the pre-mutation baseline is durable. */
  beginMutation(session:CheckpointSession,instructionGuid:Guid,predicted:string[]):Promise<string>{
    return this.withLock(session.id,async()=>{
      const stored=await this.getSession(session.id);this.requirePublished(stored);
      if(stored.pendingMutation&&!stored.pendingMutation.completedCheckpointId)throw new CheckpointError("Unfinished mutation requires recovery before further installation");
      const previous=stored.checkpoints[stored.checkpoints.length-1],operationId=randomUUID();
      const baselineSha256=await this.manifestObservation(session.id,0),previousManifestSha256=await this.manifestObservation(session.id,previous.index);
      stored.pendingMutation={schemaVersion:1,operationId,binding:{sessionId:stored.id,storeDirectory:this.rootDir,kotorDirectory:this.kotorDirectory},baselineSha256,previousManifestSha256,instructionGuid,previousCheckpointId:previous.id,predicted:[...predicted],startedAt:new Date().toISOString()};
      await writeJsonAtomic(this.sessionFile(session.id),stored);
      return operationId;
    });
  }
  /** Retain completed audit identity; this does not acknowledge recovery or quiescence. */
  completeMutation(session:CheckpointSession,instructionGuid:Guid,operationId:string):Promise<void>{
    return this.withLock(session.id,async()=>{
      const stored=await this.getSession(session.id);this.requirePublished(stored);
      if(stored.pendingMutation?.schemaVersion!==1||stored.pendingMutation.operationId!==operationId||stored.pendingMutation.instructionGuid!==instructionGuid)throw new CheckpointError("Pending mutation identity changed");
      const checkpoint=stored.checkpoints[stored.checkpoints.length-1];
      if(checkpoint.instructionGuid!==instructionGuid)throw new CheckpointError("Finalized checkpoint identity differs");
      stored.pendingMutation.completedCheckpointId=checkpoint.id;
      await writeJsonAtomic(this.sessionFile(session.id),stored);
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
      const stored = await this.getSession(session.id);this.requirePublished(stored);
      const prevIndex = stored.checkpoints.length - 1;
      const index = prevIndex + 1;
      const isAnchor = index % stored.anchorInterval === 0;

      const rels = await this.expandPaths(meta.touched);
      const baseline = await this.readManifest(session.id, 0);
      const prevState = await this.computeState(session.id, prevIndex);
      const tracked = new Set(baseline.entries.map((e) => e.path));
      let baselineDirty = false;
      const unpredicted = new Set(await this.expandPaths(meta.unpredicted ?? []));
      let unverified = false;
      for (const rel of rels) {
        if (!tracked.has(rel)) {
          if (unpredicted.has(rel)) unverified = true;
          baseline.entries.push({ path: rel });
          prevState.set(rel, undefined);
          tracked.add(rel);
          baselineDirty = true;
        }
      }


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
      if (unverified) stored.unverifiedBaselineAt = [...(stored.unverifiedBaselineAt ?? []), index];
      await this.beginPublication(stored,"checkpoint",baseline.entries.length);
      if(baselineDirty)await writeJsonAtomic(this.manifestFile(session.id,0),baseline);
      await writeJsonAtomic(this.manifestFile(session.id, index), { id, index, isAnchor, entries } satisfies CheckpointManifest);
      stored.checkpoints.push(cp);
      if (baselineDirty) stored.checkpoints[0].changedCount = baseline.entries.length;
      delete stored.pendingPublication;
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
    if (!this.fs.isVirtual) {
      if (this.physicalRestore?.ownership !== "portable-lockfile") return Promise.reject(new CheckpointError("Independent TypeScript physical checkpoint restore is unavailable until paired OS writer ownership and verified quiescence/recovery are implemented. CI-only explicit opt-in: portable lockfile ownership (see docs/PHYSICAL_INSTALL.md)"));
      return withPortableRootOwnership([this.kotorDirectory], () => this.restorePhysical(sessionId, checkpointId, onProgress));
    }
    return this.restoreOwned(sessionId, checkpointId, onProgress);
  }

  /**
   * Opt-in physical restore: refuse when an earlier checkpoint's baseline is
   * unknown, persist a restore intent, write the files, then clear the intent
   * only if the on-disk hash of every tracked path equals the checkpoint's.
   * Any failure leaves the intent pending (later sessions then refuse to start).
   * Directories are not tracked, so emptied directories may remain.
   */
  private async restorePhysical(sessionId: string, checkpointId: string, onProgress?: RestoreProgress): Promise<void> {
    const stored = await this.getSession(sessionId);
    const target = this.findCheckpoint(stored, checkpointId);
    const unverified = (stored.unverifiedBaselineAt ?? []).filter((index) => index > target.index);
    if (unverified.length) {
      throw new CheckpointError(`Physical restore to checkpoint ${target.index} refused: checkpoint ${unverified[0]} modified paths (patcher/external program) whose pre-mutation content was never captured`);
    }
    const intent = await this.beginRestoreIntentOwned(sessionId, checkpointId, true);
    await this.restoreOwned(sessionId, checkpointId, onProgress, true);
    await this.acknowledgeRestore(sessionId, intent.operationId, intent.targetStateSha256);
  }

  private restoreOwned(sessionId: string, checkpointId: string, onProgress?: RestoreProgress, duringRestore = false): Promise<void> {
    return this.withLock(sessionId, async () => {
      const state = await this.computeState(sessionId, this.findCheckpoint(await this.getSession(sessionId), checkpointId).index, duringRestore);
      const paths = [...state.keys()].sort();
      // Reject incomplete/corrupt snapshots before changing even the virtual
      // destination. Recheck on materialization; this is not an OS snapshot.
      const verified = new Set<string>();
      for (const rel of paths) {
        const want = state.get(rel);
        if (want !== undefined && !verified.has(want)) {
          await this.readBlob(want);
          verified.add(want);
        }
      }
      const total = paths.length;
      let done = 0;
      onProgress?.(0, total);
      for (const rel of paths) {
        const want = state.get(rel);
        const abs = this.absolutePath(rel);
        await ordinaryPath(abs,false,true);const st = await this.fs.stat(abs);
        if (want === undefined) {
          if (st) await this.fs.remove(abs);
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
      await ordinaryPath(this.casDir,true,true);if (await exists(this.casDir)) {
        for (const bucket of await readdir(this.casDir)) {
          if(!/^[0-9a-f]{2}$/.test(bucket))throw new CheckpointError("Invalid checkpoint CAS bucket");
          const bucketDir = join(this.casDir, bucket);await ordinaryPath(bucketDir,true);
          let names: string[];
          try {
            names = await readdir(bucketDir);
          } catch {
            continue;
          }
          for (const name of names) {
            if (name.endsWith(".tmp")) continue;
            safeSha(name);if(name.slice(0,2)!==bucket)throw new CheckpointError("Checkpoint blob is in the wrong bucket");await ordinaryPath(this.blobPath(name));
            const st = await stat(this.blobPath(name));
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
