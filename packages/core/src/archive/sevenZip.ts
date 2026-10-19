/**
 * 7z adapter built on 7z-wasm (7-Zip 24.09 compiled with Emscripten).
 *
 * The wasm module exposes an in-memory FS plus NODEFS mounts. We mount the
 * archive's directory and the destination directory on demand, run one 7z
 * command synchronously (callMain is blocking, so a single shared module
 * instance is safe), then unmount.
 *
 * A byte offset can be given for self-extracting executables: the 7z payload
 * is streamed into a temporary file first. When `sevenZipPath` is provided the
 * external 7z CLI is used as a fallback whenever the wasm build fails.
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import SevenZipImport from "7z-wasm";
import type { SevenZipModule, SevenZipModuleOptions } from "7z-wasm";

import { baseName, joinPath, normalizePath, parentPath, toNative } from "../fs/paths.js";
import type { ArchiveEntry, ArchiveExtractOptions, ArchiveFormat, ArchiveReader } from "../ports/archive.js";
import { ArchiveEntryNotFoundError, ArchiveError, extractThroughStaging, findEntry, normalizeEntryPath, reconcileDirectoryEntries, sortEntries } from "./common.js";

type SevenZipFactory = (opts?: Partial<SevenZipModuleOptions>) => Promise<SevenZipModule>;

// The UMD build assigns both module.exports and module.exports.default.
const sevenZipFactory: SevenZipFactory =
  typeof SevenZipImport === "function"
    ? (SevenZipImport as unknown as SevenZipFactory)
    : (SevenZipImport as unknown as { default: SevenZipFactory }).default;

export interface SevenZipSource {
  path: string;
  /** Byte offset of the 7z signature inside the file (0 for a plain .7z). */
  offset?: number;
}

export interface SevenZipOptions {
  /** External 7z CLI used as a fallback when the wasm build fails. */
  sevenZipPath?: string;
  format?: Extract<ArchiveFormat, "7z" | "7z-sfx">;
  password?: string;
}

export interface SevenZipRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * `Attributes` holds the Windows flags that are set ("D", but also "RD", "HD",
 * "HSD", "DA"... for read-only/hidden/system folders), then optionally a Unix
 * mode ("drwxr-xr-x"). The directory flag is not necessarily the first letter.
 */
export function sevenZipAttributesMarkDirectory(attributes: string): boolean {
  return attributes.split(/\s+/).some((token) => (/^[^-\s]*D[^-\s]*$/.test(token)) || /^d[-rwxsStT]{9}/.test(token));
}

/**
 * Parse `7z l -slt -ba` output into entries. Blocks are separated by blank
 * lines and hold `Key = Value` pairs; the archive's own block (which has a
 * `Type` but no `Size`) is skipped.
 */
export function parseSevenZipListing(text: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const idx = line.indexOf(" = ");
      if (idx === -1) continue;
      fields.set(line.slice(0, idx).trim(), line.slice(idx + 3).trim());
    }
    const rawPath = fields.get("Path");
    if (rawPath === undefined || !fields.has("Size") || fields.has("Type")) continue;
    const normalized = normalizeEntryPath(rawPath);
    if (!normalized) continue;
    const attributes = fields.get("Attributes") ?? "";
    if (fields.has("Symbolic Link") || fields.has("Hard Link") || /(?:^|\s)l[rwx-]{9}/.test(attributes)) throw new ArchiveError("Archive links are not supported", "");
    const isDirectory = normalized.isDirectory || sevenZipAttributesMarkDirectory(attributes) || fields.get("Folder") === "+";
    const key = normalized.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const size = Number.parseInt(fields.get("Size") ?? "0", 10);
    entries.push({ path: normalized.path, isDirectory, size: isDirectory || Number.isNaN(size) ? 0 : size });
  }
  return sortEntries(reconcileDirectoryEntries(entries));
}

// ---- wasm module management ------------------------------------------------

interface WasmRuntime {
  module: SevenZipModule;
  sink: { stdout: string[]; stderr: string[] };
}

export const SEVEN_ZIP_WASM_RECYCLE_MOUNTS = 200;

interface RuntimeSlot {
  runtime: Promise<WasmRuntime>;
  mounts: number;
}

let runtimeSlot: RuntimeSlot | undefined;
let mountCounter = 0;

async function createRuntime(): Promise<WasmRuntime> {
  const sink = { stdout: [] as string[], stderr: [] as string[] };
  const module = await sevenZipFactory({
    print: (line) => sink.stdout.push(line),
    printErr: (line) => sink.stderr.push(line),
    stdin: () => null as unknown as number,
    quit: () => undefined,
    noExitRuntime: true,
  });
  // 7-Zip sets mode 000 on some extracted directories (tar); keep them usable.
  const chmodOrig = module.FS.chmod.bind(module.FS);
  module.FS.chmod = (p: string, mode: number, dontFollow?: boolean) => {
    if (mode) chmodOrig(p, mode, dontFollow);
  };
  module.FS.mkdir("/mnt");
  return { module, sink };
}

function acquireRuntime(mountCount: number): RuntimeSlot {
  if (runtimeSlot && runtimeSlot.mounts >= SEVEN_ZIP_WASM_RECYCLE_MOUNTS) runtimeSlot = undefined;
  runtimeSlot ??= { runtime: createRuntime(), mounts: 0 };
  runtimeSlot.mounts += mountCount;
  return runtimeSlot;
}

/** Drop the shared module after a crash so the next call starts clean. */
function resetRuntime(slot: RuntimeSlot): void {
  if (runtimeSlot === slot) runtimeSlot = undefined;
}

class WasmCrashError extends Error {
  override readonly name = "WasmCrashError";
  constructor(
    message: string,
    readonly trap: boolean,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

const WASM_TRAP_MESSAGE = /table index is out of bounds|memory access out of bounds|unreachable|indirect call|null function|Aborted\(/i;

function isWasmTrap(err: unknown): boolean {
  return err instanceof Error && (err.name === "RuntimeError" || WASM_TRAP_MESSAGE.test(err.message));
}

function removeMemfsTree(fs: SevenZipModule["FS"], p: string): void {
  let st: ReturnType<typeof fs.stat>;
  try {
    st = fs.stat(p);
  } catch {
    return;
  }
  if (fs.isDir(st.mode)) {
    for (const name of fs.readdir(p)) {
      if (name === "." || name === "..") continue;
      removeMemfsTree(fs, `${p}/${name}`);
    }
    fs.rmdir(p);
  } else {
    fs.unlink(p);
  }
}

interface Mount {
  host: string;
  mountPoint: string;
}

/**
 * Run one 7z command in the wasm build. `mounts` maps host directories to
 * MEMFS mount points; `memfsFiles` are written before the run and removed
 * after. A wasm trap discards the shared module and replays the identical
 * command (mounts and MEMFS files included) once on a fresh module. Throws on
 * module-level crashes (not on non-zero 7z exit codes).
 */
export async function runSevenZipWasm(
  args: string[],
  mounts: Mount[] = [],
  memfsFiles: Record<string, string> = {},
): Promise<SevenZipRunResult> {
  try {
    return await runSevenZipWasmOnce(args, mounts, memfsFiles);
  } catch (err) {
    if (!(err instanceof WasmCrashError) || !err.trap) throw err;
    try {
      return await runSevenZipWasmOnce(args, mounts, memfsFiles);
    } catch (retryErr) {
      if (retryErr instanceof WasmCrashError) throw err;
      throw retryErr;
    }
  }
}

async function runSevenZipWasmOnce(args: string[], mounts: Mount[], memfsFiles: Record<string, string>): Promise<SevenZipRunResult> {
  const slot = acquireRuntime(mounts.length);
  const { module, sink } = await slot.runtime;
  const FS = module.FS;
  sink.stdout.length = 0;
  sink.stderr.length = 0;
  const mounted: string[] = [];
  const created: string[] = [];
  try {
    for (const m of mounts) {
      FS.mkdir(m.mountPoint);
      FS.mount(module.NODEFS, { root: m.host }, m.mountPoint);
      mounted.push(m.mountPoint);
    }
    for (const [p, content] of Object.entries(memfsFiles)) {
      const dir = p.slice(0, p.lastIndexOf("/"));
      if (dir && !existsInMemfs(FS, dir)) FS.mkdir(dir);
      FS.writeFile(p, content);
      created.push(p);
    }
    let code: number;
    try {
      code = (module.callMain(args) as unknown as number | undefined) ?? 0;
    } catch (err) {
      resetRuntime(slot);
      throw new WasmCrashError(`7z-wasm crashed running "${args.join(" ")}": ${describeWasmError(err)}`, isWasmTrap(err), err);
    }
    return { code, stdout: sink.stdout.join("\n"), stderr: sink.stderr.join("\n") };
  } finally {
    for (const p of created) {
      try {
        removeMemfsTree(FS, p);
      } catch {
        /* ignore */
      }
    }
    for (const mp of mounted.reverse()) {
      try {
        FS.unmount(mp);
        FS.rmdir(mp);
      } catch {
        /* ignore */
      }
    }
  }
}

function existsInMemfs(fs: SevenZipModule["FS"], p: string): boolean {
  try {
    fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function describeWasmError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "number") return `native exception ${err} (input missing or unreadable?)`;
  return String(err);
}

function nextMountPoint(): string {
  mountCounter += 1;
  return `/mnt/m${mountCounter}`;
}

// ---- CLI fallback ----------------------------------------------------------

export function runSevenZipCli(sevenZipPath: string, args: string[], signal?: AbortSignal): Promise<SevenZipRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

// ---- adapter ---------------------------------------------------------------

const QUIET = ["-bd", "-bsp0"];

export class SevenZipArchive implements ArchiveReader {
  readonly format: "7z" | "7z-sfx";
  readonly archivePath: string;
  readonly offset: number;
  private readonly sevenZipPath: string | undefined;
  private readonly password: string | undefined;
  private entriesPromise: Promise<ArchiveEntry[]> | undefined;
  /** Path of the file 7z actually reads (the archive, or a temp slice when offset > 0). */
  private inputPromise: Promise<string> | undefined;
  private tempDirs: string[] = [];
  private closed = false;

  private constructor(source: SevenZipSource, opts: SevenZipOptions) {
    this.archivePath = normalizePath(source.path);
    this.offset = source.offset ?? 0;
    this.sevenZipPath = opts.sevenZipPath;
    this.password = opts.password;
    this.format = opts.format ?? "7z";
  }

  static async open(source: string | SevenZipSource, opts: SevenZipOptions = {}): Promise<SevenZipArchive> {
    const src = typeof source === "string" ? { path: source } : source;
    const archive = new SevenZipArchive(src, opts);
    await archive.records();
    return archive;
  }

  async list(): Promise<ArchiveEntry[]> {
    return (await this.records()).map((e) => ({ ...e }));
  }

  async extract(destDir: string, filter?: (entry: ArchiveEntry) => boolean, options: ArchiveExtractOptions = {}): Promise<string[]> {
    const entries = (await this.records()).filter((entry) => !filter || filter(entry));
    const files = entries.filter((entry) => !entry.isDirectory);
    return extractThroughStaging(normalizePath(destDir), entries, async (temp) => {
      options.signal?.throwIfAborted();
      if (files.length) await this.extractTo(temp, files.map((entry) => entry.path).join("\n") + "\n", options.signal);
      options.signal?.throwIfAborted();
    }, options);
  }

  async readEntry(entryPath: string): Promise<Uint8Array> {
    const entry = findEntry(await this.records(), entryPath);
    if (!entry) throw new ArchiveEntryNotFoundError(this.archivePath, entryPath);
    if (entry.isDirectory) throw new ArchiveError(`"${entryPath}" is a directory`, this.archivePath);
    const temp = await mkdtemp(path.join(tmpdir(), "modsync-7z-read-"));
    try {
      await this.extractTo(temp, entry.path + "\n");
      const buf = await readFile(joinPath(temp, entry.path));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const dirs = this.tempDirs;
    this.tempDirs = [];
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  }

  // ---- internals

  private records(): Promise<ArchiveEntry[]> {
    this.entriesPromise ??= (async () => {
      const input = await this.input();
      const result = await this.run(["l", "-ba", "-slt", ...QUIET, ...this.passwordArgs()], input, (mounts) => {
        const memfsInput = joinPath(mounts.input, baseName(input));
        return ["l", "-ba", "-slt", ...QUIET, ...this.passwordArgs(), memfsInput];
      });
      return parseSevenZipListing(result.stdout);
    })();
    return this.entriesPromise;
  }

  private passwordArgs(): string[] {
    return this.password !== undefined ? [`-p${this.password}`] : [];
  }

  /** Extract into a host directory, optionally restricted to a newline-separated list of entry paths. */
  private async extractTo(dest: string, listfile: string | undefined, signal?: AbortSignal): Promise<void> {
    const input = await this.input();
    let cliListfile: string | undefined;
    try {
      await this.run(
        ["x", "-y", ...QUIET, "-scsUTF-8", "-spd", ...this.passwordArgs()],
        input,
        (mounts) => {
          const args = ["x", "-y", ...QUIET, "-scsUTF-8", "-spd", ...this.passwordArgs(), `-o${mounts.output}`];
          if (listfile !== undefined) args.push(`-i@${mounts.listfile}`);
          args.push(joinPath(mounts.input, baseName(input)));
          return args;
        },
        {
          output: dest,
          listfile,
          signal,
          cliArgs: async () => {
            const args = ["x", "-y", ...QUIET, "-scsUTF-8", "-spd", ...this.passwordArgs(), `-o${toNative(dest)}`];
            if (listfile !== undefined) {
              const dir = await this.tempDir();
              cliListfile = path.join(dir, "listfile.txt");
              await writeFile(cliListfile, listfile, "utf8");
              args.push(`-i@${cliListfile}`);
            }
            args.push(toNative(input));
            return args;
          },
        },
      );
    } finally {
      if (cliListfile) await rm(cliListfile, { force: true });
    }
  }

  /**
   * Run through wasm, falling back to the CLI when configured. `wasmArgs`
   * receives the MEMFS mount points; the CLI gets host paths.
   */
  private async run(
    baseArgs: string[],
    input: string,
    wasmArgs: (mounts: { input: string; output: string; listfile: string }) => string[],
    extra: { output?: string; listfile?: string; signal?: AbortSignal; cliArgs?: () => Promise<string[]> } = {},
  ): Promise<SevenZipRunResult> {
    extra.signal?.throwIfAborted();
    let wasmError: Error | undefined;
    try {
      const inputMount = nextMountPoint();
      const outputMount = extra.output !== undefined ? nextMountPoint() : "";
      const listfilePath = extra.listfile !== undefined ? `/mnt/list${mountCounter}.txt` : "";
      const mounts: Mount[] = [{ host: parentPath(input), mountPoint: inputMount }];
      if (extra.output !== undefined) mounts.push({ host: extra.output, mountPoint: outputMount });
      const result = await runSevenZipWasm(
        wasmArgs({ input: inputMount, output: outputMount, listfile: listfilePath }),
        mounts,
        extra.listfile !== undefined ? { [listfilePath]: extra.listfile } : {},
      );
      if (result.code === 0) return result;
      wasmError = new ArchiveError(this.describeFailure("7z-wasm", result), this.archivePath);
    } catch (err) {
      wasmError = err instanceof Error ? err : new Error(String(err));
    }

    extra.signal?.throwIfAborted();
    if (!this.sevenZipPath) throw wasmError;
    const args = extra.cliArgs ? await extra.cliArgs() : [...baseArgs, toNative(input)];
    const result = await runSevenZipCli(this.sevenZipPath, args, extra.signal);
    if (result.code === 0) return result;
    throw new ArchiveError(`${wasmError.message}; CLI fallback: ${this.describeFailure(this.sevenZipPath, result)}`, this.archivePath, {
      cause: wasmError,
    });
  }

  private describeFailure(tool: string, result: SevenZipRunResult): string {
    const detail = result.stderr.trim() || result.stdout.trim();
    return `${tool} exited with code ${result.code} for "${this.archivePath}"${detail ? `: ${detail}` : ""}`;
  }

  /** The file 7z reads: the archive itself, or the payload sliced out of an SFX stub. */
  private input(): Promise<string> {
    this.inputPromise ??= (async () => {
      if (this.offset <= 0) return this.archivePath;
      const dir = await this.tempDir();
      const slice = path.join(dir, `${baseName(this.archivePath).replace(/\.[^.]*$/, "")}.7z`);
      await pipeline(createReadStream(this.archivePath, { start: this.offset }), createWriteStream(slice));
      return normalizePath(slice);
    })();
    return this.inputPromise;
  }

  private async tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "modsync-7z-"));
    this.tempDirs.push(dir);
    return dir;
  }
}

export function openSevenZip(source: string | SevenZipSource, opts?: SevenZipOptions): Promise<ArchiveReader> {
  return SevenZipArchive.open(source, opts);
}
