/**
 * Native TSLPatcher engine: applies a parsed `changes.ini` (PatcherConfig) to
 * a game directory through a PatcherFs. Processing order is fixed:
 * Settings, TLKList, InstallList, 2DAList, GFFList, CompileList, HACKList,
 * SSFList. Every file is backed up before its first modification; files that
 * did not exist are listed in `<backup>/remove these files.txt`.
 */
import * as path from "node:path";
import { decodeCp1252, encodeCp1252 } from "../binary.js";
import { Encapsulated, encapsulatedFileTypeFromPath, isEncapsulatedPath, readEncapsulated, writeEncapsulated } from "../erf.js";
import {
  GffFieldType,
  type GffField,
  type GffLocString,
  type GffRoot,
  type GffStruct,
  type GffValue,
  createGffStruct,
  getFieldByPath,
  getStructByPath,
  readGff,
  splitGffPath,
  writeGff,
} from "../gff.js";
import { splitResourceName } from "../restypes.js";
import { readSsf, writeSsf } from "../ssf.js";
import { Tlk, readTlk, writeTlk } from "../tlk.js";
import { TwoDA, read2da, write2da, type TwoDARowMatch } from "../twoda.js";
import type {
  CompileFileConfig,
  GffAddField,
  GffFileConfig,
  GffModifier,
  HackFileConfig,
  InstallFolderConfig,
  OverrideType,
  PatchFileCommon,
  PatcherConfig,
  PatcherSettings,
  PatcherValue,
  RowTarget,
  SsfFileConfig,
  TlkListConfig,
  TwoDAFileConfig,
  TwoDAModifier,
  TwoDAStore,
} from "./config.js";
import { NullPatcherLogger, type PatcherFs, type PatcherLogger } from "./fs.js";
import { PatcherMemory, PatcherTokenError, parseToken } from "./memory.js";

export interface TslPatcherOptions {
  /** absolute path of the mod's tslpatchdata folder */
  tslpatchdataDir: string;
  /** absolute path of the game installation */
  gameDir: string;
  fs: PatcherFs;
  logger?: PatcherLogger;
  /** read, resolve and validate everything, write nothing */
  dryRun?: boolean;
  /** where to put backups; default `<tslpatchdata>/../backup/<timestamp>` */
  backupDir?: string;
}

export interface PatcherLog {
  errors: string[];
  warnings: string[];
  infos: string[];
  /** absolute paths written (or, in dry-run mode, that would have been written) */
  filesWritten: string[];
  /** absolute game paths copied into the backup folder */
  filesBackedUp: string[];
  /** backup folder used (undefined when nothing was backed up) */
  backupDir?: string;
  mutationPlan: PatcherMutationPlan;
}

export type PatcherMutation =
  | { kind: "write"; path: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "mkdirp"; path: string };

export interface PatcherMutationPlan {
  mode: "planned" | "applied";
  complete: boolean;
  mutations: PatcherMutation[];
  unsupported: string[];
}

export const REMOVE_FILES_LIST = "remove these files.txt";
export const UNINSTALL_MANIFEST = "modsync-uninstall.json";

class PatcherFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatcherFileError";
  }
}

interface Destination {
  /** relative folder or archive path (posix separators, no trailing slash) */
  rel: string;
  isArchive: boolean;
}

function normRel(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
}

function timestamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function parseIntValue(raw: string, what: string): number {
  const v = raw.trim();
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^0x[0-9a-f]+$/i.test(v)) return parseInt(v, 16);
  throw new PatcherFileError(`${what}: expected an integer, got "${raw}"`);
}

function parseFloatValue(raw: string, what: string): number {
  const n = Number(raw.trim());
  if (raw.trim() === "" || Number.isNaN(n)) throw new PatcherFileError(`${what}: expected a number, got "${raw}"`);
  return n;
}

export class TslPatcher {
  private readonly fs: PatcherFs;
  private readonly logger: PatcherLogger;
  private readonly dryRun: boolean;
  private readonly tslpatchdataDir: string;
  private readonly gameDir: string;
  private readonly backupRoot: string;
  private readonly backupIdentityBound: boolean;
  private backupEnabled = true;
  private backupOutputsPlanned = false;

  private log: PatcherLog = { errors: [], warnings: [], infos: [], filesWritten: [], filesBackedUp: [], mutationPlan: { mode: "applied", complete: false, mutations: [], unsupported: [] } };
  private mem = new PatcherMemory();
  private readonly dirCache = new Map<string, string[]>();
  private readonly archives = new Map<string, Encapsulated>();
  private readonly overlay = new Map<string, Uint8Array>();
  private readonly touched = new Set<string>();
  private createdFiles: string[] = [];

  constructor(opts: TslPatcherOptions) {
    this.fs = opts.fs;
    this.logger = opts.logger ?? NullPatcherLogger;
    this.dryRun = opts.dryRun ?? false;
    this.tslpatchdataDir = path.resolve(opts.tslpatchdataDir);
    this.gameDir = path.resolve(opts.gameDir);
    this.backupIdentityBound = Boolean(opts.backupDir);
    this.backupRoot = opts.backupDir ? path.resolve(opts.backupDir) : path.join(path.dirname(this.tslpatchdataDir), "backup", timestamp());
  }

  /** Token memory of the last/ongoing `apply` (useful for tests and diagnostics). */
  get memory(): PatcherMemory {
    return this.mem;
  }

  async apply(config: PatcherConfig): Promise<PatcherLog> {
    this.log = { errors: [], warnings: [], infos: [], filesWritten: [], filesBackedUp: [], mutationPlan: { mode: this.dryRun ? "planned" : "applied", complete: false, mutations: [], unsupported: [] } };
    this.mem = new PatcherMemory();
    this.touched.clear();
    this.createdFiles = [];
    this.backupOutputsPlanned = false;
    this.archives.clear();
    this.overlay.clear();
    this.dirCache.clear();
    this.backupEnabled = config.settings.backupFiles;
    if (this.dryRun) this.info("dry run: no files will be written");

    try {
      if (!(await this.checkRequired(config.settings))) return this.log;
      await this.guard("TLKList", () => this.processTlk(config.tlk));
      await this.processInstall(config.install);
      for (const f of config.twoda) await this.guard(`2DAList ${f.filename}`, () => this.process2da(f));
      for (const f of config.gff) await this.guard(`GFFList ${f.filename}`, () => this.processGff(f));
      for (const f of config.compile) await this.guard(`CompileList ${f.filename}`, () => this.processCompile(f));
      for (const f of config.hack) await this.guard(`HACKList ${f.filename}`, () => this.processHack(f));
      for (const f of config.ssf) await this.guard(`SSFList ${f.filename}`, () => this.processSsf(f));
    } catch (error) {
      this.markUnsupported("patcher apply aborted before completion");
      throw error;
    } finally {
      try {
        await this.finishBackup();
      } catch (error) {
        this.markUnsupported("backup finalization failed");
        throw error;
      } finally {
        this.finalizeMutationPlan();
      }
    }
    this.info(`done: ${this.log.filesWritten.length} file(s) ${this.dryRun ? "would be " : ""}written, ${this.log.warnings.length} warning(s), ${this.log.errors.length} error(s)`);
    return this.log;
  }

  // ----------------------------------------------------------------------
  // logging
  // ----------------------------------------------------------------------

  private info(msg: string): void {
    this.log.infos.push(msg);
    this.logger.info(msg);
  }
  private warn(msg: string): void {
    this.log.warnings.push(msg);
    this.logger.warn(msg);
  }
  private error(msg: string): void {
    this.log.errors.push(msg);
    this.logger.error(msg);
  }

  /** Run one file's processing; failures are recorded and do not stop the remaining files. */
  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof PatcherFileError || err instanceof PatcherTokenError) this.error(`${what}: ${err.message}`);
      else if (err instanceof Error) this.error(`${what}: ${err.name}: ${err.message}`);
      else this.error(`${what}: ${String(err)}`);
    }
  }

  // ----------------------------------------------------------------------
  // paths & files
  // ----------------------------------------------------------------------

  private async listDir(dir: string): Promise<string[]> {
    let entries = this.dirCache.get(dir);
    if (!entries) {
      entries = await this.fs.readDir(dir);
      this.dirCache.set(dir, entries);
    }
    // Dry runs must see files and parent directories from earlier sections.
    for (const abs of this.overlay.keys()) {
      const relative = path.relative(dir, abs);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        const first = relative.split(path.sep)[0]!;
        if (!entries.includes(first)) entries.push(first);
      }
    }
    return entries;
  }

  private noteCreated(abs: string): void {
    const dir = path.dirname(abs);
    const entries = this.dirCache.get(dir);
    if (entries && !entries.includes(path.basename(abs))) entries.push(path.basename(abs));
  }

  /**
   * Resolve `rel` under `base` matching each segment case-insensitively
   * against the directory listing (Linux game installs frequently mix case).
   * Unmatched trailing segments are appended as written.
   */
  private async resolveCase(base: string, rel: string): Promise<{ path: string; exists: boolean }> {
    const portable = rel.replace(/\\/g, "/");
    if (path.posix.isAbsolute(portable) || /^[a-z]:/i.test(portable) || portable.split("/").includes("..")) {
      throw new PatcherFileError(`path "${rel}" must stay within ${base}`);
    }
    const segs = normRel(rel).split("/").filter((s) => s !== "");
    const canonicalBase = this.fs.realpath && await this.fs.exists(base) ? await this.fs.realpath(base) : base;
    let cur = base;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const entries = await this.listDir(cur);
      let match = entries.find((e) => e === seg);
      if (match === undefined) {
        const lower = seg.toLowerCase();
        match = entries.find((e) => e.toLowerCase() === lower);
      }
      if (match === undefined) {
        return { path: path.join(cur, ...segs.slice(i)), exists: false };
      }
      cur = path.join(cur, match);
      if (await this.fs.isSymbolicLink?.(cur) && !await this.fs.exists(cur)) {
        throw new PatcherFileError(`path "${rel}" contains a dangling symbolic link`);
      }
      if (this.fs.realpath && await this.fs.exists(cur)) {
        const canonical = await this.fs.realpath(cur);
        const relative = path.relative(canonicalBase, canonical);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new PatcherFileError(`path "${rel}" resolves outside ${base} through a symbolic link`);
        }
      }
    }
    const exists = segs.length === 0 ? true : this.overlay.has(cur) || await this.fs.exists(cur);
    return { path: cur, exists };
  }

  private gamePath(rel: string): Promise<{ path: string; exists: boolean }> {
    return this.resolveCase(this.gameDir, rel);
  }

  /** Locate a file in tslpatchdata (or a sub folder) case-insensitively. */
  private async findSource(name: string, sourceFolder?: string): Promise<string | undefined> {
    const base = sourceFolder ? (await this.resolveCase(this.tslpatchdataDir, sourceFolder)).path : this.tslpatchdataDir;
    const r = await this.resolveCase(base, name);
    return r.exists ? r.path : undefined;
  }

  private parseDestination(dest: string): Destination {
    const portable = dest.replace(/\\/g, "/");
    if (path.posix.isAbsolute(portable) || /^[a-z]:/i.test(portable) || portable.split("/").includes("..")) {
      throw new PatcherFileError(`destination "${dest}" must stay within the game directory`);
    }
    const rel = normRel(dest);
    return { rel, isArchive: isEncapsulatedPath(rel) };
  }

  private async readAbs(abs: string): Promise<Uint8Array | undefined> {
    const pending = this.overlay.get(abs);
    if (pending) return pending;
    if (!(await this.fs.exists(abs))) return undefined;
    return this.fs.readFile(abs);
  }

  private async loadArchive(abs: string, createIfMissing: boolean): Promise<Encapsulated | undefined> {
    let enc = this.archives.get(abs);
    if (enc) return enc;
    const data = await this.readAbs(abs);
    if (data) enc = readEncapsulated(data);
    else if (createIfMissing) {
      const type = encapsulatedFileTypeFromPath(abs) ?? "ERF ";
      enc = new Encapsulated(type);
      this.warn(`archive ${abs} does not exist; creating an empty ${type.trim()}`);
    } else return undefined;
    this.archives.set(abs, enc);
    return enc;
  }

  private resourceKey(filename: string): { resref: string; type: number } {
    const { resref, ext, type } = splitResourceName(filename);
    if (type === undefined) throw new PatcherFileError(`"${filename}": unknown resource extension ".${ext}" (cannot be stored in an archive)`);
    return { resref, type };
  }

  /** Read a game file (folder destination) or archive resource; undefined when absent. */
  private async readGameResource(dest: Destination, filename: string): Promise<Uint8Array | undefined> {
    if (dest.isArchive) {
      const abs = (await this.gamePath(dest.rel)).path;
      const enc = await this.loadArchive(abs, false);
      if (!enc) return undefined;
      const { resref, type } = this.resourceKey(filename);
      return enc.get(resref, type)?.data;
    }
    const r = await this.gamePath(`${dest.rel}/${filename}`);
    return this.readAbs(r.path);
  }

  private async gameResourceExists(dest: Destination, filename: string): Promise<boolean> {
    return (await this.readGameResource(dest, filename)) !== undefined;
  }

  /** Write a game file or archive resource, backing up first. */
  private async writeGameResource(dest: Destination, filename: string, data: Uint8Array): Promise<string> {
    if (dest.isArchive) {
      const abs = (await this.gamePath(dest.rel)).path;
      const enc = (await this.loadArchive(abs, true))!;
      const { resref, type } = this.resourceKey(filename);
      enc.set(resref, type, data);
      await this.writeAbs(abs, writeEncapsulated(enc));
      this.info(`${this.dryRun ? "would write" : "wrote"} ${filename} into ${abs}`);
      return abs;
    }
    const abs = (await this.gamePath(`${dest.rel}/${filename}`)).path;
    await this.writeAbs(abs, data);
    this.info(`${this.dryRun ? "would write" : "wrote"} ${abs}`);
    return abs;
  }

  private async writeAbs(abs: string, data: Uint8Array): Promise<void> {
    await this.backupBeforeWrite(abs);
    this.overlay.set(abs, data);
    if (!this.log.filesWritten.includes(abs)) this.log.filesWritten.push(abs);
    this.recordMutation({ kind: "mkdirp", path: path.dirname(abs) });
    if (!this.dryRun) await this.fs.mkdirp(path.dirname(abs));
    this.recordMutation({ kind: "write", path: abs });
    if (this.dryRun) return;
    await this.fs.writeFile(abs, data);
    this.noteCreated(abs);
  }

  private async backupBeforeWrite(abs: string): Promise<void> {
    if (this.touched.has(abs)) return;
    this.touched.add(abs);
    const exists = await this.fs.exists(abs);
    if (!exists) {
      this.createdFiles.push(abs);
      return;
    }
    if (!this.backupEnabled) return;
    const rel = path.relative(this.gameDir, abs);
    const target = path.join(this.backupRoot, rel.startsWith("..") ? path.basename(abs) : rel);
    this.backupOutputsPlanned = true;
    this.recordMutation({ kind: "mkdirp", path: path.dirname(target) });
    if (this.dryRun) {
      this.recordMutation({ kind: "copy", from: abs, to: target });
      return;
    }
    await this.fs.mkdirp(path.dirname(target));
    this.recordMutation({ kind: "copy", from: abs, to: target });
    await this.fs.copyFile(abs, target);
    this.log.filesBackedUp.push(abs);
    this.log.backupDir = this.backupRoot;
    this.logger.debug(`backed up ${abs} -> ${target}`);
  }

  private async finishBackup(): Promise<void> {
    if (!this.backupEnabled) return;
    const hasBackups = this.dryRun ? this.backupOutputsPlanned : this.log.filesBackedUp.length > 0;
    if (this.createdFiles.length === 0 && !hasBackups) return;
    this.backupOutputsPlanned = true;
    this.recordMutation({ kind: "mkdirp", path: this.backupRoot });
    if (!this.dryRun) await this.fs.mkdirp(this.backupRoot);
    if (!this.dryRun) this.log.backupDir = this.backupRoot;
    if (this.createdFiles.length > 0) {
      const removeListPath = path.join(this.backupRoot, REMOVE_FILES_LIST);
      this.recordMutation({ kind: "write", path: removeListPath });
      if (!this.dryRun) await this.fs.writeFile(removeListPath, encodeCp1252(this.createdFiles.join("\n") + "\n"));
    }
    const manifestPath = path.join(this.backupRoot, UNINSTALL_MANIFEST);
    const manifest = { gameDir: this.gameDir, created: this.createdFiles, backedUp: this.log.filesBackedUp, timestamp: new Date().toISOString() };
    this.recordMutation({ kind: "write", path: manifestPath });
    if (this.dryRun) return;
    this.log.backupDir = this.backupRoot;
    await this.fs.writeFile(manifestPath, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  }

  private recordMutation(mutation: PatcherMutation): void {
    this.log.mutationPlan.mutations.push(mutation);
  }

  private markUnsupported(reason: string): void {
    if (!this.log.mutationPlan.unsupported.includes(reason)) this.log.mutationPlan.unsupported.push(reason);
  }

  private finalizeMutationPlan(): void {
    if (this.backupOutputsPlanned && !this.backupIdentityBound) this.markUnsupported("backup output identity is not caller-bound");
    this.log.mutationPlan.complete = this.log.errors.length === 0 && this.log.mutationPlan.unsupported.length === 0;
  }

  /** `!OverrideType` handling when installing into a module while Override holds a same-named file. */
  private async checkOverrideType(dest: Destination, filename: string, type: OverrideType): Promise<void> {
    if (!dest.isArchive || type === "ignore") return;
    const r = await this.gamePath(`Override/${filename}`);
    if (!r.exists) return;
    if (type === "warn") {
      this.warn(`${filename} is being installed into ${dest.rel} but a copy in Override (${r.path}) will take precedence`);
      return;
    }
    const bak = `${r.path}.bak`;
    if (this.dryRun) {
      if (!this.fs.rename) {
        this.markUnsupported(`rename unavailable for ${r.path} -> ${bak}`);
        this.info(`would rename ${r.path} to ${bak}`);
        return;
      }
      this.markUnsupported("dry-run rename state projection is not implemented");
      await this.backupBeforeWrite(r.path);
      this.recordMutation({ kind: "rename", from: r.path, to: bak });
      this.info(`would rename ${r.path} to ${bak}`);
      return;
    }
    if (!this.fs.rename) {
      this.warn(`cannot rename ${r.path} to .bak: file system does not support rename`);
      this.markUnsupported(`rename unavailable for ${r.path} -> ${bak}`);
      return;
    }
    await this.backupBeforeWrite(r.path);
    this.recordMutation({ kind: "rename", from: r.path, to: bak });
    await this.fs.rename(r.path, bak);
    this.dirCache.delete(path.dirname(r.path));
    this.info(`renamed ${r.path} to ${bak}`);
  }

  /**
   * Load the file a list section patches: the game copy when present (unless
   * `!ReplaceFile=1`), else the tslpatchdata copy.
   */
  private async loadTarget(cfg: PatchFileCommon): Promise<{ data: Uint8Array; source: string; dest: Destination }> {
    const dest = this.parseDestination(cfg.destination);
    if (!cfg.replaceFile) {
      const game = await this.readGameResource(dest, cfg.filename);
      if (game) return { data: game, source: `game ${dest.rel}`, dest };
    }
    const src = await this.findSource(cfg.filename, cfg.sourceFolder);
    if (src) return { data: await this.fs.readFile(src), source: "tslpatchdata", dest };
    if (cfg.replaceFile) {
      const game = await this.readGameResource(dest, cfg.filename);
      if (game) {
        this.warn(`${cfg.filename}: !ReplaceFile=1 but no copy in tslpatchdata; patching the game copy`);
        return { data: game, source: `game ${dest.rel}`, dest };
      }
    }
    throw new PatcherFileError(`${cfg.filename} not found in ${dest.rel} nor in tslpatchdata`);
  }

  private async saveTarget(cfg: PatchFileCommon, dest: Destination, data: Uint8Array): Promise<void> {
    const name = cfg.saveAs ?? cfg.filename;
    await this.checkOverrideType(dest, name, cfg.overrideType);
    await this.writeGameResource(dest, name, data);
  }

  // ----------------------------------------------------------------------
  // tokens
  // ----------------------------------------------------------------------

  private resolveValue(v: PatcherValue): string {
    switch (v.kind) {
      case "constant":
        return v.value;
      case "strref":
        return String(this.mem.getStrRef(v.token));
      case "2damemory":
        return this.mem.get2da(v.token);
      case "high":
        throw new PatcherFileError("high() is only valid as a 2DA cell value");
    }
  }

  private resolveInt(v: PatcherValue, what: string): number {
    return parseIntValue(this.resolveValue(v), what);
  }

  // ----------------------------------------------------------------------
  // [Settings]
  // ----------------------------------------------------------------------

  private async checkRequired(settings: PatcherSettings): Promise<boolean> {
    let ok = true;
    for (const group of settings.required) {
      for (const file of group.files) {
        const r = await this.gamePath(`Override/${file}`);
        if (!r.exists) {
          ok = false;
          this.error(`required file ${file} is missing from Override${group.message ? `: ${group.message}` : ""}`);
        }
      }
    }
    if (!ok) this.error("aborting: required files are missing");
    return ok;
  }

  // ----------------------------------------------------------------------
  // [TLKList]
  // ----------------------------------------------------------------------

  private async processTlk(cfg: TlkListConfig): Promise<void> {
    if (cfg.modifiers.length === 0) return;
    const rel = cfg.destination ? `${cfg.destination}/dialog.tlk` : "dialog.tlk";
    const target = await this.gamePath(rel);
    const data = await this.readAbs(target.path);
    if (!data) {
      this.error(`TLKList: ${target.path} not found`);
      return;
    }
    const dialog = readTlk(data, { warn: (m) => this.warn(m) });
    const sources = new Map<string, Tlk>();
    const loadSource = async (name: string): Promise<Tlk> => {
      const key = name.toLowerCase();
      let tlk = sources.get(key);
      if (!tlk) {
        const src = await this.findSource(name, cfg.sourceFolder);
        if (!src) throw new PatcherFileError(`TLKList: ${name} not found in tslpatchdata`);
        tlk = readTlk(await this.fs.readFile(src), { warn: (m) => this.warn(m) });
        sources.set(key, tlk);
      }
      return tlk;
    };
    const entryOf = async (file: string | undefined, index: number): Promise<{ text: string; sound: string; soundLength?: number }> => {
      const name = file ?? cfg.sourceFile;
      const tlk = await loadSource(name);
      const e = tlk.entries[index];
      if (!e) throw new PatcherFileError(`TLKList: ${name} has no entry ${index} (${tlk.entries.length} entries)`);
      return { text: e.text, sound: e.soundResRef, ...(e.soundLength === undefined ? {} : { soundLength: e.soundLength }) };
    };

    let applied = 0;
    for (const m of cfg.modifiers) {
      try {
        if (m.kind === "append") {
          const e = await entryOf(m.sourceFile, m.sourceIndex);
          const idx = dialog.add(e.text, e.sound, e.soundLength);
          this.mem.setStrRef(m.token, idx);
          this.logger.debug(`TLKList: StrRef${m.token} -> ${idx}`);
        } else if (m.kind === "replace") {
          const e = await entryOf(m.sourceFile, m.sourceIndex);
          if (m.dialogIndex >= dialog.entries.length) throw new PatcherFileError(`TLKList: cannot replace strref ${m.dialogIndex}, dialog.tlk has ${dialog.entries.length} entries`);
          dialog.replace(m.dialogIndex, e.text, e.sound, e.soundLength);
          this.mem.setStrRef(m.dialogIndex, m.dialogIndex);
        } else {
          const idx = dialog.add(m.text, m.sound);
          this.mem.setStrRef(m.token, idx);
        }
        applied++;
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err));
      }
    }
    if (applied === 0) return;
    await this.writeAbs(target.path, writeTlk(dialog, { warn: (m) => this.warn(m) }));
    this.info(`${this.dryRun ? "would write" : "wrote"} ${target.path} (${applied} TLK change(s), ${dialog.entries.length} entries)`);
  }

  // ----------------------------------------------------------------------
  // [InstallList]
  // ----------------------------------------------------------------------

  private async processInstall(folders: InstallFolderConfig[]): Promise<void> {
    for (const folder of folders) {
      for (const file of folder.files) {
        await this.guard(`InstallList ${file.filename}`, async () => {
          const src = await this.findSource(file.filename, file.sourceFolder);
          if (!src) throw new PatcherFileError(`${file.filename} not found in tslpatchdata`);
          const dest = this.parseDestination(file.destination ?? folder.destination);
          const name = file.saveAs ?? file.filename;
          if (!file.replaceExisting && (await this.gameResourceExists(dest, name))) {
            this.warn(`${name} already exists in ${dest.rel}; skipping (use Replace<N> to overwrite)`);
            return;
          }
          const data = await this.fs.readFile(src);
          await this.checkOverrideType(dest, name, file.overrideType);
          await this.writeGameResource(dest, name, data);
        });
      }
    }
  }

  // ----------------------------------------------------------------------
  // [2DAList]
  // ----------------------------------------------------------------------

  private async process2da(cfg: TwoDAFileConfig): Promise<void> {
    const { data, source, dest } = await this.loadTarget(cfg);
    const table = read2da(data);
    this.logger.debug(`2DAList: ${cfg.filename} loaded from ${source} (${table.height} rows)`);
    for (const m of cfg.modifiers) this.apply2daModifier(table, m, cfg.filename);
    await this.saveTarget(cfg, dest, write2da(table));
  }

  private resolveCell(v: PatcherValue, table: TwoDA, column: string): string {
    if (v.kind === "high") return String(table.maxIntInColumn(column) + 1);
    return this.resolveValue(v);
  }

  private resolveRowLabel(v: PatcherValue | undefined, table: TwoDA): string {
    if (!v) return String(table.height);
    if (v.kind === "high") return String(table.maxIntRowLabel() + 1);
    return this.resolveValue(v);
  }

  private findTargetRow(table: TwoDA, target: RowTarget, filename: string, section: string): TwoDARowMatch {
    const value = this.resolveValue(target.value);
    let match: TwoDARowMatch | undefined;
    if (target.kind === "rowIndex") {
      const idx = parseIntValue(value, `[${section}] RowIndex`);
      const row = table.getRow(idx);
      if (row) match = { index: idx, row };
    } else if (target.kind === "rowLabel") match = table.getRowByLabel(value);
    else {
      if (!table.hasColumn("label")) throw new PatcherFileError(`[${section}] LabelIndex used but ${filename} has no "label" column`);
      match = table.findRow("label", value);
    }
    if (!match) throw new PatcherFileError(`[${section}] no row in ${filename} matches ${target.kind}=${value}`);
    return match;
  }

  private applyCells(table: TwoDA, index: number, cells: Map<string, PatcherValue>, filename: string, section: string): void {
    for (const [column, v] of cells) {
      if (!table.hasColumn(column)) throw new PatcherFileError(`[${section}] column "${column}" does not exist in ${filename}`);
      table.setCell(index, column, this.resolveCell(v, table, column));
    }
  }

  private applyStores(table: TwoDA, index: number, stores: TwoDAStore[], filename: string, section: string): void {
    for (const s of stores) {
      let value: string;
      if (s.source.kind === "rowIndex") value = String(index);
      else if (s.source.kind === "rowLabel") value = table.getRow(index)!.label;
      else {
        if (!table.hasColumn(s.source.column)) throw new PatcherFileError(`[${section}] cannot store column "${s.source.column}": not in ${filename}`);
        value = table.getCell(index, s.source.column) ?? "";
      }
      this.store(s.pool, s.token, value, section);
    }
  }

  private store(pool: "2damemory" | "strref", token: number, value: string, section: string): void {
    if (pool === "2damemory") this.mem.set2da(token, value);
    else this.mem.setStrRef(token, parseIntValue(value, `[${section}] StrRef${token} store`));
    this.logger.debug(`[${section}] ${pool === "2damemory" ? "2DAMEMORY" : "StrRef"}${token} = ${value}`);
  }

  private apply2daModifier(table: TwoDA, m: TwoDAModifier, filename: string): void {
    const section = m.section;
    switch (m.kind) {
      case "addRow": {
        let index: number | undefined;
        if (m.exclusiveColumn) {
          if (!table.hasColumn(m.exclusiveColumn)) throw new PatcherFileError(`[${section}] ExclusiveColumn "${m.exclusiveColumn}" does not exist in ${filename}`);
          const cellSpec = [...m.cells.entries()].find(([c]) => c.toLowerCase() === m.exclusiveColumn!.toLowerCase());
          if (!cellSpec) throw new PatcherFileError(`[${section}] ExclusiveColumn "${m.exclusiveColumn}" has no value in the section`);
          const value = this.resolveCell(cellSpec[1], table, m.exclusiveColumn);
          const existing = table.findRow(m.exclusiveColumn, value);
          if (existing) {
            index = existing.index;
            this.info(`[${section}] ${filename}: row with ${m.exclusiveColumn}=${value} already exists (index ${index}); modifying it instead of adding`);
          }
        }
        if (index === undefined) {
          index = table.addRow(this.resolveRowLabel(m.rowLabel, table));
          this.logger.debug(`[${section}] ${filename}: added row ${index}`);
        }
        this.applyCells(table, index, m.cells, filename, section);
        this.applyStores(table, index, m.stores, filename, section);
        break;
      }
      case "changeRow": {
        const target = this.findTargetRow(table, m.target, filename, section);
        this.applyCells(table, target.index, m.cells, filename, section);
        this.applyStores(table, target.index, m.stores, filename, section);
        break;
      }
      case "copyRow": {
        const src = this.findTargetRow(table, m.target, filename, section);
        let index: number | undefined;
        if (m.exclusiveColumn) {
          if (!table.hasColumn(m.exclusiveColumn)) throw new PatcherFileError(`[${section}] ExclusiveColumn "${m.exclusiveColumn}" does not exist in ${filename}`);
          const cellSpec = [...m.cells.entries()].find(([c]) => c.toLowerCase() === m.exclusiveColumn!.toLowerCase());
          if (cellSpec) {
            const value = this.resolveCell(cellSpec[1], table, m.exclusiveColumn);
            const existing = table.findRow(m.exclusiveColumn, value);
            if (existing) {
              index = existing.index;
              this.info(`[${section}] ${filename}: row with ${m.exclusiveColumn}=${value} already exists (index ${index}); modifying it instead of copying`);
            }
          }
        }
        if (index === undefined) index = table.copyRow(src.index, this.resolveRowLabel(m.newRowLabel, table));
        this.applyCells(table, index, m.cells, filename, section);
        this.applyStores(table, index, m.stores, filename, section);
        break;
      }
      case "addColumn": {
        if (table.hasColumn(m.columnLabel)) this.warn(`[${section}] column "${m.columnLabel}" already exists in ${filename}; applying the inserts to the existing column`);
        else table.addColumn(m.columnLabel, m.defaultValue);
        for (const ins of m.indexInserts) {
          if (!table.getRow(ins.index)) throw new PatcherFileError(`[${section}] I${ins.index}: no such row in ${filename}`);
          table.setCell(ins.index, m.columnLabel, this.resolveCell(ins.value, table, m.columnLabel));
        }
        for (const ins of m.labelInserts) {
          const row = table.getRowByLabel(ins.label);
          if (!row) throw new PatcherFileError(`[${section}] L${ins.label}: no row labelled "${ins.label}" in ${filename}`);
          table.setCell(row.index, m.columnLabel, this.resolveCell(ins.value, table, m.columnLabel));
        }
        for (const s of m.stores) {
          let index: number;
          if (s.source.kind === "index") index = s.source.index;
          else {
            const row = table.getRowByLabel(s.source.label);
            if (!row) throw new PatcherFileError(`[${section}] no row labelled "${s.source.label}" in ${filename}`);
            index = row.index;
          }
          const cell = table.getCell(index, m.columnLabel);
          if (cell === undefined) throw new PatcherFileError(`[${section}] row ${index} does not exist in ${filename}`);
          this.store(s.pool, s.token, cell, section);
        }
        break;
      }
    }
  }

  // ----------------------------------------------------------------------
  // [GFFList]
  // ----------------------------------------------------------------------

  private async processGff(cfg: GffFileConfig): Promise<void> {
    const { data, source, dest } = await this.loadTarget(cfg);
    const root = readGff(data);
    this.logger.debug(`GFFList: ${cfg.filename} loaded from ${source}`);
    for (const m of cfg.modifiers) this.applyGffModifier(root, m, cfg.filename);
    await this.saveTarget(cfg, dest, writeGff(root));
  }

  /** Replace `2DAMEMORY<N>` path segments with their stored (path) values. */
  private resolveGffPath(p: string): string {
    const out: string[] = [];
    for (const seg of splitGffPath(p)) {
      const t = parseToken(seg);
      if (t?.kind === "2damemory") out.push(...splitGffPath(this.mem.get2da(t.token)));
      else if (t?.kind === "strref") out.push(String(this.mem.getStrRef(t.token)));
      else out.push(seg);
    }
    return out.join("/");
  }

  private applyGffModifier(root: GffRoot, m: GffModifier, filename: string): void {
    if (m.kind === "storePath") {
      this.mem.set2da(m.token, "");
      return;
    }
    if (m.kind === "add") {
      this.applyAddField(root, m, this.resolveGffPath(m.path), filename);
      return;
    }
    const p = this.resolveGffPath(m.path);
    const field = getFieldByPath(root, p);
    if (!field) throw new PatcherFileError(`${filename}: field "${p}" not found`);
    if (m.part) {
      if (field.type !== GffFieldType.LocString) throw new PatcherFileError(`${filename}: "${p}" is not an ExoLocString`);
      const ls = field.value as GffLocString;
      if (m.part.kind === "strref") ls.strref = this.resolveInt(m.value, `${filename} ${p}(strref)`);
      else ls.substrings.set(m.part.id, this.resolveValue(m.value));
      return;
    }
    field.value = this.coerceGffValue(this.resolveValue(m.value), field.type, field.value, `${filename} ${p}`);
  }

  private coerceGffValue(raw: string, type: GffFieldType, existing: GffValue | undefined, what: string): GffValue {
    switch (type) {
      case GffFieldType.Byte:
      case GffFieldType.Char:
      case GffFieldType.Word:
      case GffFieldType.Short:
      case GffFieldType.DWord:
      case GffFieldType.Int:
      case GffFieldType.StrRef:
        return parseIntValue(raw, what);
      case GffFieldType.DWord64:
      case GffFieldType.Int64:
        try {
          return BigInt(raw.trim());
        } catch {
          throw new PatcherFileError(`${what}: expected a 64-bit integer, got "${raw}"`);
        }
      case GffFieldType.Float:
      case GffFieldType.Double:
        return parseFloatValue(raw, what);
      case GffFieldType.String:
      case GffFieldType.ResRef:
        return raw;
      case GffFieldType.Void:
        return /^([0-9a-f]{2})+$/i.test(raw.trim()) ? Uint8Array.from(raw.trim().match(/../g)!.map((h) => parseInt(h, 16))) : encodeCp1252(raw);
      case GffFieldType.Vector: {
        const parts = raw.split("|").map((x) => parseFloatValue(x, what));
        if (parts.length !== 3) throw new PatcherFileError(`${what}: Position needs x|y|z, got "${raw}"`);
        return { x: parts[0]!, y: parts[1]!, z: parts[2]! };
      }
      case GffFieldType.Orientation: {
        const parts = raw.split("|").map((x) => parseFloatValue(x, what));
        if (parts.length !== 4) throw new PatcherFileError(`${what}: Orientation needs x|y|z|w, got "${raw}"`);
        return { x: parts[0]!, y: parts[1]!, z: parts[2]!, w: parts[3]! };
      }
      case GffFieldType.LocString: {
        const strref = parseIntValue(raw, `${what} (strref)`);
        const prev = existing && typeof existing === "object" && "substrings" in existing ? existing : undefined;
        return { strref, substrings: new Map(prev?.substrings ?? []) };
      }
      case GffFieldType.Struct:
      case GffFieldType.List:
        throw new PatcherFileError(`${what}: cannot assign a value to a ${GffFieldType[type]} field`);
      default:
        throw new PatcherFileError(`${what}: unsupported field type ${type}`);
    }
  }

  private buildAddValue(add: GffAddField, what: string): GffValue {
    switch (add.fieldType) {
      case GffFieldType.Struct:
        return createGffStruct(add.typeId);
      case GffFieldType.List:
        return [];
      case GffFieldType.LocString: {
        const ls: GffLocString = { strref: -1, substrings: new Map() };
        if (add.locString?.strref) ls.strref = this.resolveInt(add.locString.strref, `${what} StrRef`);
        for (const [id, v] of add.locString?.substrings ?? []) ls.substrings.set(id, this.resolveValue(v));
        return ls;
      }
      default:
        if (!add.value) throw new PatcherFileError(`${what}: missing Value`);
        return this.coerceGffValue(this.resolveValue(add.value), add.fieldType, undefined, what);
    }
  }

  private applyAddField(root: GffRoot, add: GffAddField, parentPath: string, filename: string): void {
    const what = `${filename} [${add.section}]`;
    let parentStruct: GffStruct | undefined = getStructByPath(root, parentPath);
    let parentList: GffStruct[] | undefined;
    if (!parentStruct) {
      const f = getFieldByPath(root, parentPath);
      if (f?.type === GffFieldType.List) parentList = f.value as GffStruct[];
      else throw new PatcherFileError(`${what}: parent path "${parentPath}" not found`);
    }

    let newPath: string;
    if (parentList) {
      if (add.fieldType !== GffFieldType.Struct) throw new PatcherFileError(`${what}: only Struct fields can be added to the list "${parentPath}"`);
      const s = createGffStruct(add.typeId);
      parentList.push(s);
      const index = parentList.length - 1;
      newPath = `${parentPath}/${index}`;
      for (const t of add.storeListIndex) this.mem.set2da(t, String(index));
      this.logger.debug(`${what}: appended struct ${index} to ${parentPath}`);
    } else {
      parentStruct = parentStruct!;
      if (add.label === "") throw new PatcherFileError(`${what}: Label is required when the parent "${parentPath || "(root)"}" is a struct`);
      newPath = parentPath ? `${parentPath}/${add.label}` : add.label;
      const existing = parentStruct.fields.get(add.label);
      if (existing) {
        this.modifyExistingField(existing, add, what);
        this.logger.debug(`${what}: field ${newPath} already exists; modified`);
      } else {
        const field: GffField = { type: add.fieldType, value: this.buildAddValue(add, what) };
        parentStruct.fields.set(add.label, field);
        this.logger.debug(`${what}: added ${GffFieldType[add.fieldType]} ${newPath}`);
      }
      if (add.storeListIndex.length > 0) {
        // Index of the parent struct within its own list when applicable, else the field is not in a list.
        const segs = splitGffPath(parentPath);
        const last = segs[segs.length - 1];
        if (last !== undefined && /^\d+$/.test(last)) for (const t of add.storeListIndex) this.mem.set2da(t, last);
        else this.warn(`${what}: ListIndex requested but "${newPath}" is not a list element`);
      }
    }
    for (const t of add.storeFieldPath) this.mem.set2da(t, newPath);
    for (const child of add.children) this.applyAddField(root, child, newPath, filename);
  }

  private modifyExistingField(existing: GffField, add: GffAddField, what: string): void {
    if (add.fieldType === GffFieldType.Struct || add.fieldType === GffFieldType.List) {
      if (existing.type !== add.fieldType) throw new PatcherFileError(`${what}: existing field is ${GffFieldType[existing.type]}, not ${GffFieldType[add.fieldType]}`);
      if (add.fieldType === GffFieldType.Struct && add.typeId !== 0) (existing.value as GffStruct).id = add.typeId;
      return;
    }
    if (add.fieldType === GffFieldType.LocString) {
      if (existing.type !== GffFieldType.LocString) throw new PatcherFileError(`${what}: existing field is ${GffFieldType[existing.type]}, not ExoLocString`);
      const ls = existing.value as GffLocString;
      if (add.locString?.strref) ls.strref = this.resolveInt(add.locString.strref, `${what} StrRef`);
      for (const [id, v] of add.locString?.substrings ?? []) ls.substrings.set(id, this.resolveValue(v));
      return;
    }
    existing.type = add.fieldType;
    existing.value = this.buildAddValue(add, what);
  }

  // ----------------------------------------------------------------------
  // [CompileList]
  // ----------------------------------------------------------------------

  private async processCompile(cfg: CompileFileConfig): Promise<void> {
    const ncsName = cfg.filename.replace(/\.nss$/i, "") + ".ncs";
    const src = await this.findSource(ncsName, cfg.sourceFolder);
    if (!src) {
      throw new PatcherFileError(`script compilation unavailable: ${cfg.filename} requires a compiler or precompiled ${ncsName} in tslpatchdata`);
    }
    const source = await this.findSource(cfg.filename, cfg.sourceFolder);
    if (source && /#(?:2DAMEMORY|StrRef)\d+#/i.test(decodeCp1252(await this.fs.readFile(source)))) {
      throw new PatcherFileError(`${cfg.filename} contains memory substitutions requiring source compilation; cannot use precompiled ${ncsName}`);
    }
    this.warn(`CompileList: ${cfg.filename} installed from precompiled ${ncsName} (compiled from precompiled ncs, not from source)`);
    const dest = this.parseDestination(cfg.destination);
    const name = cfg.saveAs ? cfg.saveAs.replace(/\.nss$/i, "") + ".ncs" : ncsName;
    if (!cfg.replaceFile && await this.gameResourceExists(dest, name)) {
      this.warn(`CompileList: ${name} already exists in ${dest.rel}; skipping (use !ReplaceFile=1 to overwrite)`);
      return;
    }
    await this.checkOverrideType(dest, name, cfg.overrideType);
    await this.writeGameResource(dest, name, await this.fs.readFile(src));
  }

  // ----------------------------------------------------------------------
  // [HACKList]
  // ----------------------------------------------------------------------

  private async processHack(cfg: HackFileConfig): Promise<void> {
    const { data, source, dest } = await this.loadTarget(cfg);
    const bytes = data.slice();
    this.logger.debug(`HACKList: ${cfg.filename} loaded from ${source} (${bytes.length} bytes)`);
    for (const edit of cfg.edits) {
      const value = this.resolveInt(edit.value, `${cfg.filename} offset ${edit.offset}`);
      if (edit.offset < 0 || edit.offset + 2 > bytes.length) throw new PatcherFileError(`${cfg.filename}: offset ${edit.offset} is outside the file (${bytes.length} bytes)`);
      if (value < 0 || value > 0xffff) throw new PatcherFileError(`${cfg.filename}: value ${value} at offset ${edit.offset} does not fit in 16 bits`);
      bytes[edit.offset] = (value >> 8) & 0xff;
      bytes[edit.offset + 1] = value & 0xff;
    }
    await this.saveTarget(cfg, dest, bytes);
  }

  // ----------------------------------------------------------------------
  // [SSFList]
  // ----------------------------------------------------------------------

  private async processSsf(cfg: SsfFileConfig): Promise<void> {
    const { data, source, dest } = await this.loadTarget(cfg);
    const ssf = readSsf(data);
    this.logger.debug(`SSFList: ${cfg.filename} loaded from ${source}`);
    for (const s of cfg.sounds) ssf.sounds[s.index] = this.resolveInt(s.value, `${cfg.filename} ${s.name}`);
    await this.saveTarget(cfg, dest, writeSsf(ssf));
  }
}
