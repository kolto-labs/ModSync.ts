import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RealFileSystem } from "../../fs/realFileSystem.js";
import { toNative } from "../../fs/paths.js";
import type { Instruction } from "../../model/types.js";
import { createInstallContext, type InstallContext } from "../context.js";
import type { SpawnOutcome } from "../patcherPort.js";
import { computeSelection } from "../selection.js";
import { createProcessHost, type ProcessHost, type ProcessRunner } from "../windowsExec.js";
import { file, instr, makeSandbox, mod, writeText, type Sandbox } from "../testing.js";
import { executeInstruction } from "./index.js";

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox("modsync-execute-");
});
afterEach(async () => {
  await sb.cleanup();
});

interface Call {
  command: string;
  args: string[];
  opts: Parameters<ProcessRunner>[2];
}

function harness(
  hostPartial: Partial<ProcessHost> = {},
  outcome: Partial<SpawnOutcome> = {},
  dryRun = false,
): { ctx: InstallContext; calls: Call[]; lookups: string[] } {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const processHost = createProcessHost({
    platform: "linux",
    env: { DISPLAY: ":0", PATH: "/usr/bin" },
    run: async (command, args, opts) => {
      calls.push({ command, args, opts });
      return { code: 0, signal: null, stdout: "", stderr: "", ...outcome };
    },
    findExecutable: async (name) => {
      lookups.push(name);
      return name === "wine" ? "/usr/bin/wine" : undefined;
    },
    ...hostPartial,
  });
  const ctx = createInstallContext({
    settings: sb.settings,
    selection: computeSelection(file([mod(1)]), sb.settings),
    fs: new RealFileSystem(),
    dryRun,
    processHost,
  });
  return { ctx, calls, lookups };
}

const exeInstruction = (args?: string): Instruction => instr("Execute", { source: ["<<modDirectory>>/fixup/setup.exe"], arguments: args });

describe("Execute through wine", () => {
  beforeEach(async () => {
    await writeText(`${sb.mods}/fixup/setup.exe`, "MZ\u0090\u0000 generic windows installer stand-in");
  });

  it("runs a Windows executable through wine on a non-Windows host", async () => {
    const { ctx, calls } = harness();
    const result = await executeInstruction(ctx, exeInstruction("/silent"), mod(1));
    expect(result.code).toBe("Success");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/usr/bin/wine");
    expect(calls[0].args).toEqual([toNative(`${sb.mods}/fixup/setup.exe`), "/silent"]);
    expect(calls[0].opts.env?.WINEDEBUG).toBe("-all");
    expect(result.message).toContain("exit 0");
  });

  it("starts the program in its own folder and keeps the touched-path bookkeeping", async () => {
    const { ctx, calls } = harness();
    const result = await executeInstruction(ctx, exeInstruction(), mod(1));
    expect(calls[0].opts.cwd).toBe(toNative(`${sb.mods}/fixup`));
    expect(result.touched).toEqual([`${sb.mods}/fixup`]);
  });

  it.skipIf(process.platform === "win32")("translates arguments that point into the game directory", async () => {
    const { ctx, calls } = harness();
    const result = await executeInstruction(ctx, exeInstruction(`/silent "/DIR=${sb.kotor}/Override" ${sb.kotor} /tmp/elsewhere`), mod(1));
    expect(result.code).toBe("Success");
    const win = (p: string): string => `Z:${p.replace(/\//g, "\\")}`;
    expect(calls[0].args.slice(1)).toEqual(["/silent", `/DIR=${win(`${sb.kotor}/Override`)}`, win(sb.kotor), "/tmp/elsewhere"]);
  });

  it("wraps wine in xvfb-run on a headless Linux host", async () => {
    const { ctx, calls } = harness({
      env: { PATH: "/usr/bin" },
      findExecutable: async (name) => ({ wine: "/usr/bin/wine", "xvfb-run": "/usr/bin/xvfb-run" })[name],
    });
    await executeInstruction(ctx, exeInstruction(), mod(1));
    expect(calls[0].command).toBe("/usr/bin/xvfb-run");
    expect(calls[0].args.slice(3, 5)).toEqual(["/usr/bin/wine", toNative(`${sb.mods}/fixup/setup.exe`)]);
  });

  it("reports a missing wine as an error instead of skipping the program", async () => {
    const { ctx, calls } = harness({ findExecutable: async () => undefined });
    const result = await executeInstruction(ctx, exeInstruction(), mod(1));
    expect(result.code).toBe("ExecuteError");
    expect(result.message).toMatch(/wine/);
    expect(result.message).toContain("setup.exe");
    expect(calls).toHaveLength(0);
    expect(result.touched ?? []).toEqual([]);
  });

  it("fails the instruction when the program exits non-zero", async () => {
    const { ctx } = harness({}, { code: 7, stderr: "installer refused" });
    const result = await executeInstruction(ctx, exeInstruction(), mod(1));
    expect(result.code).toBe("ExecuteError");
    expect(result.message).toContain("code 7");
    expect(result.message).toContain("installer refused");
    expect(result.touched ?? []).toEqual([]);
  });

  it("reports a wine that cannot be spawned", async () => {
    const { ctx } = harness({
      run: async () => {
        throw new Error("spawn EACCES");
      },
    });
    const result = await executeInstruction(ctx, exeInstruction(), mod(1));
    expect(result.code).toBe("ExecuteError");
    expect(result.message).toContain("spawn EACCES");
  });

  it("spawns the program directly on Windows", async () => {
    const { ctx, calls, lookups } = harness({ platform: "win32" });
    const result = await executeInstruction(ctx, exeInstruction("/silent"), mod(1));
    expect(result.code).toBe("Success");
    expect(calls[0].command).toBe(toNative(`${sb.mods}/fixup/setup.exe`));
    expect(calls[0].args).toEqual(["/silent"]);
    expect(calls[0].opts.env).toBeUndefined();
    expect(lookups).toEqual([]);
  });

  it("spawns native binaries directly even on a non-Windows host", async () => {
    await writeText(`${sb.mods}/native/tool.sh`, "#!/bin/sh\nexit 0\n");
    await writeText(`${sb.mods}/native/tool.bin`, "\u007fELF generic native stand-in");
    for (const name of ["tool.sh", "tool.bin"]) {
      const { ctx, calls, lookups } = harness();
      const result = await executeInstruction(ctx, instr("Execute", { source: [`<<modDirectory>>/native/${name}`], arguments: "-x" }), mod(1));
      expect(result.code).toBe("Success");
      expect(calls[0].command).toBe(toNative(`${sb.mods}/native/${name}`));
      expect(calls[0].args).toEqual(["-x"]);
      expect(calls[0].opts.env).toBeUndefined();
      expect(lookups).toEqual([]);
    }
  });

  it("does not start anything or look for wine in a dry run", async () => {
    const { ctx, calls, lookups } = harness({}, {}, true);
    const result = await executeInstruction(ctx, exeInstruction(), mod(1));
    expect(result.code).toBe("Success");
    expect(calls).toHaveLength(0);
    expect(lookups).toEqual([]);
  });
});
