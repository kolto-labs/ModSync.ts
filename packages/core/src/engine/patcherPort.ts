/**
 * PatcherPort: the seam between the Patcher action and the engine that
 * applies a TSLPatcher-style `changes.ini`.
 *
 * Three engines:
 *   - Native: `TslPatcher` from @modsync/kotor-formats, in-process. Honors
 *     dry runs and can read through a FileSystemPort (so validation sees the
 *     VirtualFileSystem instead of the disk).
 *   - HoloPatcher: spawns the external CLI in `--install --console` mode.
 *   - TSLPatcher: spawns the legacy exe (through `wine` outside Windows) and
 *     waits for the user to finish; nothing is automated.
 *
 * External engines never run during a dry run; the ini is parsed with the
 * native parser instead so a malformed changes.ini still fails closed.
 */

import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";

import {
  NodePatcherFs,
  TslPatcher,
  parseChangesIni,
  parseNamespacesIni,
  type Namespace,
  type PatcherFs,
} from "@modsync/kotor-formats";

import { baseName, joinPath, normalizePath, parentPath, toNative } from "../fs/paths.js";
import type { Logger, UserSettings } from "../model/types.js";
import type { FileSystemPort } from "../ports/filesystem.js";

export interface PatcherRequest {
  /** Absolute path of the mod's `tslpatchdata` folder. */
  tslpatchdataDir: string;
  /** Absolute path of the game installation. */
  gameDir: string;
  /** 0-based index into `namespaces.ini`. */
  namespaceIndex?: number;
  /** Name of the changes ini inside tslpatchdata (default `changes.ini`). */
  iniName?: string;
  dryRun: boolean;
  onLog?: (line: string) => void;
  /**
   * Optional port to read mod and game files through (the Native engine
   * only). When omitted the engine reads the real disk.
   */
  fs?: FileSystemPort;
  /** Path of the TSLPatcher executable found next to tslpatchdata, if any. */
  executablePath?: string;
}

export interface PatcherResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Absolute game paths written (or that would be written in a dry run). */
  filesWritten: string[];
  log: string[];
}

export interface PatcherPort {
  install(req: PatcherRequest): Promise<PatcherResult>;
}

export const NAMESPACES_INI = "namespaces.ini";
export const CHANGES_INI = "changes.ini";

/** Decode an ini file: UTF-8 when BOM'd, otherwise windows-1252 (TSLPatcher's native encoding). */
export function decodeIni(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("windows-1252").decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

/** Find a child entry of `dir` by case-insensitive name. */
export async function findChildCaseInsensitive(
  fs: FileSystemPort,
  dir: string,
  name: string,
): Promise<string | undefined> {
  const wanted = name.toLowerCase();
  try {
    for (const entry of await fs.readDir(dir)) {
      if (entry.name.toLowerCase() === wanted) return entry.path;
    }
  } catch {
    /* not a directory */
  }
  return undefined;
}

/**
 * Read `namespaces.ini` from the tslpatchdata dir or its parent. Returns
 * undefined when there is none or it declares no namespaces (the default
 * `changes.ini` applies). A malformed file throws.
 */
export async function listNamespaces(tslpatchdataDir: string, fs: FileSystemPort): Promise<Namespace[] | undefined> {
  const dir = normalizePath(tslpatchdataDir);
  const candidates = [dir, parentPath(dir)];
  for (const c of candidates) {
    const found = await findChildCaseInsensitive(fs, c, NAMESPACES_INI);
    if (found) {
      const namespaces = parseNamespacesIni(decodeIni(await fs.readFile(found)));
      return namespaces.length > 0 ? namespaces : undefined;
    }
  }
  return undefined;
}

/** Adapt a FileSystemPort to the minimal PatcherFs the native engine needs. */
export function patcherFsFromPort(fs: FileSystemPort): PatcherFs {
  return {
    exists: (p) => fs.exists(p),
    ...(fs.isSymbolicLink ? { isSymbolicLink: (p: string) => fs.isSymbolicLink!(p) } : {}),
    ...(fs.realpath ? { realpath: (p: string) => fs.realpath!(p) } : {}),
    readFile: (p) => fs.readFile(p),
    writeFile: (p, data) => fs.writeFile(p, data),
    mkdirp: (p) => fs.mkdirp(p),
    readDir: async (p) => {
      try {
        return (await fs.readDir(p)).map((e) => e.name);
      } catch {
        return [];
      }
    },
    copyFile: (src, dest) => fs.copyFile(src, dest),
    rename: (src, dest) => fs.move(src, dest),
    unlink: (p) => fs.remove(p),
  };
}

/** Resolve which ini and data folder a request points at. */
async function resolveTarget(
  req: PatcherRequest,
  fs: PatcherFs,
): Promise<{ dataDir: string; iniPath: string; namespace?: Namespace }> {
  let dataDir = normalizePath(req.tslpatchdataDir);
  let iniName = req.iniName ?? CHANGES_INI;
  let namespace: Namespace | undefined;
  if (req.namespaceIndex !== undefined) {
    let nsText: string | undefined;
    for (const dir of [dataDir, parentPath(dataDir)]) {
      const entry = (await fs.readDir(dir)).find((n) => n.toLowerCase() === NAMESPACES_INI);
      if (entry) {
        nsText = decodeIni(await fs.readFile(joinPath(dir, entry)));
        break;
      }
    }
    const namespaces = nsText === undefined ? [] : parseNamespacesIni(nsText);
    if (namespaces.length === 0) {
      if (req.namespaceIndex !== 0) {
        throw new Error(
          nsText === undefined
            ? `namespace ${req.namespaceIndex} requested but no ${NAMESPACES_INI} found`
            : `namespace index ${req.namespaceIndex} is out of range (0 namespaces)`,
        );
      }
    } else {
      namespace = namespaces[req.namespaceIndex];
      if (!namespace) {
        throw new Error(`namespace index ${req.namespaceIndex} is out of range (${namespaces.length} namespaces)`);
      }
      iniName = req.iniName ?? namespace.iniName;
      if (namespace.dataFolderName) {
        const sub = (await fs.readDir(dataDir)).find((n) => n.toLowerCase() === namespace!.dataFolderName!.toLowerCase());
        if (sub) dataDir = joinPath(dataDir, sub);
      }
    }
  }
  const iniEntry = (await fs.readDir(dataDir)).find((n) => n.toLowerCase() === iniName.toLowerCase());
  return { dataDir, iniPath: joinPath(dataDir, iniEntry ?? iniName), namespace };
}

function makeLog(req: PatcherRequest, logger: Logger): { lines: string[]; push: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    push: (line) => {
      lines.push(line);
      req.onLog?.(line);
      logger.debug(`[patcher] ${line}`);
    },
  };
}

class NativePatcher implements PatcherPort {
  constructor(private readonly logger: Logger) {}

  async install(req: PatcherRequest): Promise<PatcherResult> {
    const log = makeLog(req, this.logger);
    const fs = req.fs ? patcherFsFromPort(req.fs) : new NodePatcherFs();
    try {
      const target = await resolveTarget(req, fs);
      if (!(await fs.exists(target.iniPath))) {
        return fail(log.lines, `changes ini not found: ${target.iniPath}`);
      }
      const config = parseChangesIni(decodeIni(await fs.readFile(target.iniPath)));
      log.push(`applying ${baseName(target.iniPath)} from ${target.dataDir} to ${req.gameDir}${req.dryRun ? " (dry run)" : ""}`);
      const engine = new TslPatcher({
        tslpatchdataDir: target.dataDir,
        gameDir: normalizePath(req.gameDir),
        fs,
        dryRun: req.dryRun,
        logger: {
          info: (m) => log.push(m),
          warn: (m) => log.push(`warning: ${m}`),
          error: (m) => log.push(`error: ${m}`),
          debug: (m) => this.logger.debug(`[patcher] ${m}`),
        },
      });
      const result = await engine.apply(config);
      return {
        ok: result.errors.length === 0,
        errors: [...result.errors],
        warnings: [...result.warnings],
        filesWritten: result.filesWritten.map(normalizePath),
        log: log.lines,
      };
    } catch (err) {
      return fail(log.lines, err instanceof Error ? err.message : String(err));
    }
  }
}

function fail(log: string[], message: string): PatcherResult {
  log.push(`error: ${message}`);
  return { ok: false, errors: [message], warnings: [], filesWritten: [], log };
}

/** Parse the target ini without applying it (dry run for the external engines). */
async function dryRunParse(req: PatcherRequest, logger: Logger, engineName: string): Promise<PatcherResult> {
  const log = makeLog(req, logger);
  const fs = req.fs ? patcherFsFromPort(req.fs) : new NodePatcherFs();
  try {
    const target = await resolveTarget(req, fs);
    if (!(await fs.exists(target.iniPath))) return fail(log.lines, `changes ini not found: ${target.iniPath}`);
    parseChangesIni(decodeIni(await fs.readFile(target.iniPath)));
    const warning = `dry run: ${engineName} is not executed; ${baseName(target.iniPath)} parsed successfully`;
    log.push(warning);
    return { ok: true, errors: [], warnings: [warning], filesWritten: [], log: log.lines };
  } catch (err) {
    return fail(log.lines, err instanceof Error ? err.message : String(err));
  }
}

export interface SpawnOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Spawn a process, capture its output and wait for it to exit. */
export function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; signal?: AbortSignal; stdin?: string },
): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: false,
      });
    } catch (err) {
      reject(err);
      return;
    }
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.stdin);
    }
    let stdout = "";
    let stderr = "";
    const feed = (chunk: Buffer, sink: "out" | "err"): void => {
      const text = chunk.toString("utf8");
      if (sink === "out") stdout += text;
      else stderr += text;
      if (opts.onLine) for (const line of text.split(/\r?\n/)) if (line.trim()) opts.onLine(line);
    };
    child.stdout?.on("data", (c: Buffer) => feed(c, "out"));
    child.stderr?.on("data", (c: Buffer) => feed(c, "err"));
    const onAbort = (): void => {
      child.kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.once("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.once("close", (code, signal) => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

class HoloPatcher implements PatcherPort {
  constructor(
    private readonly settings: UserSettings,
    private readonly logger: Logger,
  ) {}

  async install(req: PatcherRequest): Promise<PatcherResult> {
    if (req.dryRun) return dryRunParse(req, this.logger, "HoloPatcher");
    const exe = this.settings.holoPatcherPath;
    const log = makeLog(req, this.logger);
    if (!exe) return fail(log.lines, "HoloPatcher engine selected but holoPatcherPath is not set");
    const args = ["--install", "--game-dir", toNative(normalizePath(req.gameDir)), "--tslpatchdata", toNative(normalizePath(req.tslpatchdataDir))];
    if (req.namespaceIndex !== undefined) args.push("--namespace-option-index", String(req.namespaceIndex));
    args.push("--console");
    log.push(`${exe} ${args.join(" ")}`);
    try {
      const out = await runProcess(exe, args, { cwd: parentPath(normalizePath(exe)), onLine: log.push });
      if (out.code !== 0) {
        return fail(log.lines, `HoloPatcher exited with code ${out.code ?? out.signal}${out.stderr ? `: ${out.stderr.trim()}` : ""}`);
      }
      const warnings = out.stdout.split(/\r?\n/).filter((l) => /warning/i.test(l));
      return { ok: true, errors: [], warnings, filesWritten: [], log: log.lines };
    } catch (err) {
      return fail(log.lines, err instanceof Error ? err.message : String(err));
    }
  }
}

class LegacyTslPatcher implements PatcherPort {
  constructor(
    private readonly settings: UserSettings,
    private readonly logger: Logger,
  ) {}

  async install(req: PatcherRequest): Promise<PatcherResult> {
    if (req.dryRun) return dryRunParse(req, this.logger, "TSLPatcher.exe");
    const log = makeLog(req, this.logger);
    let exe = req.executablePath ?? this.settings.tslPatcherPath;
    if (!exe) {
      // Look next to tslpatchdata for the classic exe.
      const parent = parentPath(normalizePath(req.tslpatchdataDir));
      try {
        const names = await fsp.readdir(parent);
        const hit = names.find((n) => /^tslpatcher.*\.exe$/i.test(n));
        if (hit) exe = joinPath(parent, hit);
      } catch {
        /* ignore */
      }
    }
    if (!exe) return fail(log.lines, "TSLPatcher engine selected but no TSLPatcher.exe was found (set tslPatcherPath)");
    const native = toNative(normalizePath(exe));
    const command = process.platform === "win32" ? native : "wine";
    const args = process.platform === "win32" ? [] : [native];
    const warning = "TSLPatcher.exe runs interactively; ModSync waits for it to exit and cannot verify what it changed";
    log.push(warning);
    log.push(`${command} ${args.join(" ")}`);
    try {
      const out = await runProcess(command, args, { cwd: parentPath(normalizePath(exe)), onLine: log.push });
      if (out.code !== 0) return fail(log.lines, `TSLPatcher exited with code ${out.code ?? out.signal}`);
      return { ok: true, errors: [], warnings: [warning], filesWritten: [], log: log.lines };
    } catch (err) {
      return fail(log.lines, err instanceof Error ? err.message : String(err));
    }
  }
}

/** Pick the engine configured in settings. */
export function createPatcher(settings: UserSettings, logger: Logger): PatcherPort {
  switch (settings.patcherEngine) {
    case "HoloPatcher":
      return new HoloPatcher(settings, logger);
    case "TSLPatcher":
      return new LegacyTslPatcher(settings, logger);
    default:
      return new NativePatcher(logger);
  }
}
