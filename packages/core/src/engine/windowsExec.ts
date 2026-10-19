/**
 * Launch planning for Execute: decide whether a program runs natively or
 * through `wine`. A Windows executable (MZ/PE header) or a .bat/.cmd script on
 * a non-Windows host cannot be spawned directly, so it goes through wine;
 * anything else (ELF, shell scripts, every program on Windows) is spawned as
 * before.
 *
 * Everything that touches the host (platform, environment, PATH lookup, the
 * file header, the spawn itself) lives on `ProcessHost` so tests can drive it
 * with a stub and never need a real wine.
 */

import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";

import { normalizePath } from "../fs/paths.js";
import { runProcess } from "./patcherPort.js";

export type ProcessRunner = typeof runProcess;

export interface ProcessHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run: ProcessRunner;
  /** Absolute path of an executable found on PATH, if any. */
  findExecutable(name: string): Promise<string | undefined>;
  /** First `length` bytes of a file (fewer if the file is shorter). */
  readHead(nativePath: string, length: number): Promise<Uint8Array>;
}

export interface Launch {
  command: string;
  args: string[];
  /** Only set when the launch needs a different environment than the parent's. */
  env?: NodeJS.ProcessEnv;
  /** Text written to the program's stdin; when absent stdin is closed. */
  stdin?: string;
  viaWine: boolean;
}

export class WineUnavailableError extends Error {
  override readonly name = "WineUnavailableError";
}

const WINE_BINARIES = ["wine", "wine64"];
const HEAD_BYTES = 64;
const XVFB_SCREEN = "-screen 0 1280x1024x24";

async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const st = await fsp.stat(candidate);
      if (!st.isFile()) continue;
      await fsp.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

async function readFileHead(nativePath: string, length: number): Promise<Uint8Array> {
  const handle = await fsp.open(nativePath, "r");
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function createProcessHost(overrides: Partial<ProcessHost> = {}): ProcessHost {
  const env = overrides.env ?? process.env;
  return {
    platform: process.platform,
    env,
    run: runProcess,
    findExecutable: (name) => findOnPath(name, env),
    readHead: readFileHead,
    ...overrides,
  };
}

/** True when the bytes start with the DOS "MZ" magic every Windows PE executable carries. */
export function isWindowsExecutable(head: Uint8Array): boolean {
  return head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
}

/** Map an absolute POSIX path to the Windows path wine sees (its default `Z:` drive is the host root). */
export function toWinePath(posixPath: string): string {
  return `Z:${normalizePath(posixPath).replace(/\//g, "\\")}`;
}

function isUnder(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * Rewrite arguments that point into one of `roots` (the game and mod
 * directories) to wine drive paths. Handles a bare path and `key=value`
 * (`/DIR=/abs/path`). Flags, relative values and paths elsewhere are left
 * untouched.
 */
export function translateArgumentsForWine(args: string[], roots: string[]): string[] {
  const normalizedRoots = roots.filter((r) => r.startsWith("/")).map((r) => normalizePath(r));
  const translate = (value: string): string | undefined => {
    if (!value.startsWith("/")) return undefined;
    const normalized = normalizePath(value);
    return normalizedRoots.some((root) => isUnder(root, normalized)) ? toWinePath(normalized) : undefined;
  };
  return args.map((arg) => {
    const whole = translate(arg);
    if (whole !== undefined) return whole;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      const value = translate(arg.slice(eq + 1));
      if (value !== undefined) return `${arg.slice(0, eq + 1)}${value}`;
    }
    return arg;
  });
}

const WINE_SCRIPT_EXTENSIONS = new Set([".bat", ".cmd"]);

/** True for Windows batch scripts, which no non-Windows host can spawn directly. */
export function isWindowsBatchScript(nativePath: string): boolean {
  return WINE_SCRIPT_EXTENSIONS.has(path.extname(nativePath).toLowerCase());
}

/**
 * Opt-in stdin for Execute. When the instruction's `metadata.stdin` is a string
 * it is fed to the program verbatim (answers to prompts). When it is the
 * literal `"arguments"` the parsed arguments are fed one per line and no longer
 * passed on the command line. Without it nothing changes: stdin stays closed.
 */
export function resolveExecuteStdin(
  metadata: Record<string, unknown> | undefined,
  args: string[],
): { args: string[]; stdin?: string } {
  const marker = metadata?.stdin;
  if (marker === "arguments") return { args: [], stdin: args.length > 0 ? `${args.join("\n")}\n` : "" };
  if (typeof marker === "string") return { args, stdin: marker };
  return { args };
}

async function wineLaunch(host: ProcessHost, what: string, wineArgs: string[]): Promise<Launch> {
  let wine: string | undefined;
  for (const name of WINE_BINARIES) {
    wine = await host.findExecutable(name);
    if (wine) break;
  }
  if (!wine) {
    throw new WineUnavailableError(
      `it is ${what} and this ${host.platform} host needs wine to run it, but neither ${WINE_BINARIES.map((n) => `"${n}"`).join(" nor ")} was found on PATH (install wine, and xvfb for headless hosts)`,
    );
  }

  const env: NodeJS.ProcessEnv = { ...host.env };
  if (env.WINEDEBUG === undefined) env.WINEDEBUG = "-all";

  const headless = host.platform === "linux" && !host.env.DISPLAY && !host.env.WAYLAND_DISPLAY;
  const xvfb = headless ? await host.findExecutable("xvfb-run") : undefined;
  if (xvfb) return { command: xvfb, args: ["-a", "-s", XVFB_SCREEN, wine, ...wineArgs], env, viaWine: true };
  return { command: wine, args: wineArgs, env, viaWine: true };
}

/**
 * Decide how to start `exe` (a native path). On Windows, and for anything
 * that is neither a Windows executable nor a .bat/.cmd script, the launch is
 * the plain program. Otherwise it runs through wine (`wine <exe>` or
 * `wine cmd /c <Z: path>` for scripts), inside `xvfb-run` when the host has no
 * display and xvfb is installed. Throws `WineUnavailableError` when wine is
 * needed but missing. `stdin` is passed through untouched on the launch.
 */
export async function planLaunch(
  host: ProcessHost,
  exe: string,
  args: string[],
  roots: string[],
  stdin?: string,
): Promise<Launch> {
  const withStdin = (launch: Launch): Launch => (stdin === undefined ? launch : { ...launch, stdin });
  const native: Launch = { command: exe, args, viaWine: false };
  if (host.platform === "win32") return withStdin(native);
  if (isWindowsBatchScript(exe)) {
    const script = exe.startsWith("/") ? toWinePath(exe) : exe;
    return withStdin(
      await wineLaunch(host, "a Windows batch script", ["cmd", "/c", script, ...translateArgumentsForWine(args, roots)]),
    );
  }
  let head: Uint8Array;
  try {
    head = await host.readHead(exe, HEAD_BYTES);
  } catch {
    return withStdin(native);
  }
  if (!isWindowsExecutable(head)) return withStdin(native);
  return withStdin(await wineLaunch(host, "a Windows executable", [exe, ...translateArgumentsForWine(args, roots)]));
}
