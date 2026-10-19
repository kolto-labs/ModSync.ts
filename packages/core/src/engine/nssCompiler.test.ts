import { chmod, readFile, stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NullLogger } from "../logging/logger.js";
import { NSS_COMPILER_ENV, NSS_GAME_ENV, nssCompilerHookFromEnv, parseNssGame, resolveNssGame, type NssProcessRunner } from "./nssCompiler.js";
import { createPatcher, runProcess } from "./patcherPort.js";
import { makeSandbox, writeText, type Sandbox } from "./testing.js";

const FAKE_COMPILER = `#!/bin/bash
ARGS="$*"
inc=()
while [ $# -gt 0 ]; do
  case "$1" in
    -c) shift ;;
    -o) out="$2"; shift 2 ;;
    -g) game="$2"; shift 2 ;;
    -n) nws="$2"; shift 2 ;;
    -i) inc+=("$2"); shift 2 ;;
    -*) echo "unrecognized option $1" >&2; exit 2 ;;
    *) in="$1"; shift ;;
  esac
done
[ -f "$nws" ] || { echo "missing nwscript" >&2; exit 3; }
if grep -q FAIL_ME "$in"; then echo "syntax error in $in" >&2; exit 1; fi
{
  echo "game=$game"
  echo "nwscript=$(cat "$nws")"
  echo "args=$ARGS"
  echo "src=$(cat "$in")"
  for name in $(grep -o '#include "[^"]*"' "$in" | cut -d'"' -f2); do
    for dir in "\${inc[@]}"; do [ -f "$dir/$name.nss" ] && echo "resolved=$name:$(cat "$dir/$name.nss" | head -1)" && break; done
  done
} > "$out"
`;

let sb: Sandbox;
let fake: string;
const savedEnv = { compiler: process.env[NSS_COMPILER_ENV], game: process.env[NSS_GAME_ENV] };

function restoreEnv(): void {
  for (const [name, value] of [[NSS_COMPILER_ENV, savedEnv.compiler], [NSS_GAME_ENV, savedEnv.game]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(async () => {
  sb = await makeSandbox("modsync-nss-");
  fake = `${sb.root}/fake-compiler.sh`;
  await writeText(fake, FAKE_COMPILER);
  await chmod(fake, 0o755);
});
afterEach(async () => {
  restoreEnv();
  await sb.cleanup();
});

const resources = (files: Record<string, string>) => async (name: string): Promise<Uint8Array | undefined> => {
  const hit = files[name.toLowerCase()];
  return hit === undefined ? undefined : new TextEncoder().encode(hit);
};

describe("nss compiler hook", () => {
  it("parses the game variable", () => {
    expect(["1", "K1", "kotor1", "2", "TSL", "k2", "kotor2", "3", "", undefined].map(parseNssGame)).toEqual([1, 1, 1, 2, 2, 2, 2, undefined, undefined, undefined]);
  });

  it("is absent unless the compiler variable is set", () => {
    expect(nssCompilerHookFromEnv({}, runProcess)).toBeUndefined();
    expect(nssCompilerHookFromEnv({ [NSS_COMPILER_ENV]: "  " }, runProcess)).toBeUndefined();
    expect(nssCompilerHookFromEnv({ [NSS_COMPILER_ENV]: fake }, runProcess)).toBeTypeOf("function");
  });

  it("resolves the game from the variable, then from the game directory", async () => {
    expect(await resolveNssGame({ [NSS_GAME_ENV]: "2" }, sb.kotor)).toBe(2);
    expect(await resolveNssGame({}, sb.kotor)).toBeUndefined();
    await writeText(`${sb.kotor}/swkotor2.exe`, "");
    expect(await resolveNssGame({}, sb.kotor)).toBe(2);
  });

  it("runs the compiler with bionsscomp flags, stages includes and removes its temp dir", async () => {
    await writeText(`${sb.mods}/tslpatchdata/local_inc.nss`, "// local include\n");
    const cwds: string[] = [];
    const run: NssProcessRunner = (command, args, opts) => (cwds.push(opts.cwd ?? ""), runProcess(command, args, opts));
    const hook = nssCompilerHookFromEnv({ [NSS_COMPILER_ENV]: fake }, run)!;
    const source = '#include "Local_Inc"\n#include "k_inc_base"\nvoid main() { }';
    const ncs = await hook({
      name: "demo.nss",
      source: new TextEncoder().encode(source),
      game: 2,
      includeDirs: [`${sb.mods}/tslpatchdata`],
      readGameResource: resources({ "nwscript.nss": "// api", "k_inc_base.nss": '#include "k_inc_deep"\n// base include\n', "k_inc_deep.nss": "// deep include\n" }),
    });
    const out = Buffer.from(ncs).toString();
    expect(out).toContain("game=2");
    expect(out).toContain("nwscript=// api");
    expect(out).toMatch(/^args=-c demo\.nss -o demo\.ncs -g 2 -n nwscript\.nss -i .*tslpatchdata -i .*modsync-nss-/m);
    expect(out).toContain("resolved=Local_Inc:// local include");
    expect(out).toContain("resolved=k_inc_base:#include \"k_inc_deep\"");
    expect(cwds).toHaveLength(1);
    await expect(stat(cwds[0]!)).rejects.toThrow();
  });

  it("surfaces compiler diagnostics and cleans up on failure", async () => {
    const cwds: string[] = [];
    const run: NssProcessRunner = (command, args, opts) => (cwds.push(opts.cwd ?? ""), runProcess(command, args, opts));
    const hook = nssCompilerHookFromEnv({ [NSS_COMPILER_ENV]: fake }, run)!;
    const request = { name: "bad.nss", source: new TextEncoder().encode("FAIL_ME"), game: 1 as const, includeDirs: [], readGameResource: resources({ "nwscript.nss": "// api" }) };
    await expect(hook(request)).rejects.toThrow(/fake-compiler\.sh exited with 1: syntax error in bad\.nss/);
    await expect(stat(cwds[0]!)).rejects.toThrow();
  });

  it("fails clearly when nwscript.nss cannot be extracted", async () => {
    const hook = nssCompilerHookFromEnv({ [NSS_COMPILER_ENV]: fake }, runProcess)!;
    await expect(hook({ name: "a.nss", source: new Uint8Array(), game: 1, includeDirs: [], readGameResource: async () => undefined })).rejects.toThrow(/cannot extract nwscript\.nss/);
  });

  it.runIf(process.platform !== "win32")("launches an .exe compiler through wine", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const run: NssProcessRunner = async (command, args, opts) => {
      calls.push({ command, args });
      await writeText(`${opts.cwd}/demo.ncs`, "NCS");
      return { code: 0, signal: null, stdout: "", stderr: "" };
    };
    const hook = nssCompilerHookFromEnv({ [NSS_COMPILER_ENV]: "/opt/tools/nsscomp.exe" }, run)!;
    const ncs = await hook({ name: "demo.nss", source: new Uint8Array(), game: 1, includeDirs: [], readGameResource: resources({ "nwscript.nss": "// api" }) });
    expect(Buffer.from(ncs).toString()).toBe("NCS");
    expect(calls[0]!.command).toBe("wine");
    expect(calls[0]!.args.slice(0, 3)).toEqual(["/opt/tools/nsscomp.exe", "-c", "demo.nss"]);
  });

  describe("through the native patcher", () => {
    async function prepare(): Promise<void> {
      await writeText(`${sb.mods}/m/tslpatchdata/changes.ini`, "[CompileList]\nFile0=demo.nss\n");
      await writeText(`${sb.mods}/m/tslpatchdata/demo.nss`, "void main() { }");
      await writeText(`${sb.kotor}/Override/nwscript.nss`, "// api");
    }
    const install = (dryRun: boolean) =>
      createPatcher({ ...sb.settings, patcherEngine: "Native" }, NullLogger).install({ tslpatchdataDir: `${sb.mods}/m/tslpatchdata`, gameDir: sb.kotor, dryRun });

    it("compiles a CompileList script when the compiler variable is set", async () => {
      await prepare();
      process.env[NSS_COMPILER_ENV] = fake;
      process.env[NSS_GAME_ENV] = "2";
      const result = await install(false);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.filesWritten).toEqual([`${sb.kotor}/Override/demo.ncs`]);
      const written = await readFile(`${sb.kotor}/Override/demo.ncs`, "utf8");
      expect(written).toContain("game=2");
      expect(written).toContain("src=void main() { }");
    });

    it("keeps the unavailable-compiler error without the variable", async () => {
      await prepare();
      delete process.env[NSS_COMPILER_ENV];
      const result = await install(false);
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toMatch(/script compilation unavailable/);
    });

    it("leaves a dry run unverified and does not invoke the compiler", async () => {
      await prepare();
      process.env[NSS_COMPILER_ENV] = `${sb.root}/does-not-exist.sh`;
      const result = await install(true);
      expect(result.ok).toBe(true);
      expect(result.unverified).toHaveLength(1);
      expect(result.filesWritten).toEqual([]);
    });
  });
});
