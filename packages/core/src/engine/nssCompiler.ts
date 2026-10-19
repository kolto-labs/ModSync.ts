/**
 * Optional external NSS compiler for the Native patcher's `[CompileList]`.
 *
 * Nothing is bundled: when `MODSYNC_NSS_COMPILER` names a command line
 * compiler (bionsscomp-style flags: `-c <in> -o <out> -g <1|2> -n <nwscript>
 * -i <dir>`), scripts without a precompiled `.ncs` are compiled through it.
 * Without the variable the engine behaves as before.
 *
 *   MODSYNC_NSS_COMPILER  path of the compiler; a `.exe` runs through `wine` outside Windows
 *   MODSYNC_NSS_GAME      `1`/`k1`/`kotor1` or `2`/`k2`/`kotor2`/`tsl`; default: detected from the game directory
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { CompileScriptHook, CompileScriptRequest } from "@modsync/kotor-formats";

import { RealFileSystem } from "../fs/realFileSystem.js";
import { detectGame } from "../game/detect.js";
import type { FileSystemPort } from "../ports/filesystem.js";

export const NSS_COMPILER_ENV = "MODSYNC_NSS_COMPILER";
export const NSS_GAME_ENV = "MODSYNC_NSS_GAME";

export interface NssRunOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type NssProcessRunner = (command: string, args: string[], opts: { cwd?: string }) => Promise<NssRunOutcome>;

/** Parse `MODSYNC_NSS_GAME`; undefined when unset or unrecognised. */
export function parseNssGame(value: string | undefined): 1 | 2 | undefined {
  switch (value?.trim().toLowerCase()) {
    case "1":
    case "k1":
    case "kotor1":
    case "kotor":
      return 1;
    case "2":
    case "k2":
    case "kotor2":
    case "tsl":
      return 2;
    default:
      return undefined;
  }
}

/** Game for compilation: the env override, else detection from `gameDir`; undefined when neither decides. */
export async function resolveNssGame(env: NodeJS.ProcessEnv, gameDir: string, port?: FileSystemPort): Promise<1 | 2 | undefined> {
  const forced = parseNssGame(env[NSS_GAME_ENV]);
  if (forced) return forced;
  try {
    const detected = await detectGame(gameDir, port ?? new RealFileSystem());
    return detected.game === "KOTOR2" ? 2 : detected.game === "KOTOR1" ? 1 : undefined;
  } catch {
    return undefined;
  }
}

/** Build the engine hook from the environment; undefined when `MODSYNC_NSS_COMPILER` is unset. */
export function nssCompilerHookFromEnv(env: NodeJS.ProcessEnv, run: NssProcessRunner): CompileScriptHook | undefined {
  const compiler = env[NSS_COMPILER_ENV]?.trim();
  if (!compiler) return undefined;
  return (req) => compileWithExternalCompiler(compiler, req, run);
}

const INCLUDE_RE = /^[ \t]*#include[ \t]*"([^"\r\n]+)"/gim;

function includeNames(source: Uint8Array): string[] {
  const text = Buffer.from(source).toString("latin1");
  return [...text.matchAll(INCLUDE_RE)].map((m) => m[1]!.trim().replace(/\.nss$/i, "")).filter((n) => n && !/[\\/]/.test(n) && n !== "..");
}

async function findCaseInsensitive(dir: string, filename: string): Promise<string | undefined> {
  const wanted = filename.toLowerCase();
  try {
    const hit = (await fsp.readdir(dir)).find((entry) => entry.toLowerCase() === wanted);
    return hit ? path.join(dir, hit) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Make every `#include`d script reachable from `tmpDir` or `includeDirs`:
 * scripts shipped next to the mod are used as is; anything else is extracted
 * from the game (override, then chitin.key/BIF). Includes found nowhere are
 * left for the compiler to report.
 */
async function stageIncludes(source: Uint8Array, req: CompileScriptRequest, tmpDir: string): Promise<void> {
  const seen = new Set<string>();
  const queue = includeNames(source);
  while (queue.length > 0) {
    const name = queue.shift()!;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const file = `${name}.nss`;
    let found: Uint8Array | undefined;
    let needsCopy = false;
    for (const dir of [...req.includeDirs, tmpDir]) {
      const local = await findCaseInsensitive(dir, file);
      if (!local) continue;
      found = await fsp.readFile(local);
      needsCopy = path.basename(local) !== file;
      break;
    }
    if (!found) {
      found = await req.readGameResource(file);
      needsCopy = found !== undefined;
    }
    if (!found) continue;
    if (needsCopy) await fsp.writeFile(path.join(tmpDir, file), found);
    queue.push(...includeNames(found));
  }
}

async function compileWithExternalCompiler(compiler: string, req: CompileScriptRequest, run: NssProcessRunner): Promise<Uint8Array> {
  const base = path.basename(req.name).replace(/\.nss$/i, "");
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "modsync-nss-"));
  try {
    await fsp.writeFile(path.join(tmpDir, `${base}.nss`), req.source);
    const nwscript = await req.readGameResource("nwscript.nss");
    if (!nwscript) throw new Error("cannot extract nwscript.nss from the game's override folder or chitin.key/BIF archives");
    await fsp.writeFile(path.join(tmpDir, "nwscript.nss"), nwscript);
    await stageIncludes(req.source, req, tmpDir);

    const args = ["-c", `${base}.nss`, "-o", `${base}.ncs`, "-g", String(req.game), "-n", "nwscript.nss"];
    for (const dir of [...req.includeDirs, tmpDir]) args.push("-i", dir);
    const viaWine = /\.exe$/i.test(compiler) && process.platform !== "win32";
    let outcome: NssRunOutcome;
    try {
      outcome = await run(viaWine ? "wine" : compiler, viaWine ? [compiler, ...args] : args, { cwd: tmpDir });
    } catch (err) {
      throw new Error(`cannot run ${viaWine ? "wine " : ""}${compiler}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (outcome.code !== 0) {
      const detail = (outcome.stderr.trim() || outcome.stdout.trim()).slice(0, 1000);
      throw new Error(`${path.basename(compiler)} exited with ${outcome.code ?? outcome.signal ?? "no status"}${detail ? `: ${detail}` : ""}`);
    }
    try {
      return new Uint8Array(await fsp.readFile(path.join(tmpDir, `${base}.ncs`)));
    } catch {
      throw new Error(`${path.basename(compiler)} reported success but wrote no ${base}.ncs`);
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}
