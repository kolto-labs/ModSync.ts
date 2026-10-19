import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RealFileSystem } from "../../fs/realFileSystem.js";
import { createInstallContext } from "../context.js";
import { computeSelection } from "../selection.js";
import { file, instr, makeSandbox, mod, writeText, type Sandbox } from "../testing.js";
import { executeInstruction } from "./index.js";
import { TSLPATCHDATA_MAX_DEPTH, findTslpatchdataDir, locateTslpatchdata } from "./patcher.js";

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox();
});
afterEach(async () => {
  await sb.cleanup();
});

const fs = new RealFileSystem();
const CHANGES = "[InstallList]\ninstall_folder0=Override\n\n[Override]\nFile0=new.txt\n";

async function seedData(dataDir: string): Promise<void> {
  await writeText(`${dataDir}/changes.ini`, CHANGES);
  await writeText(`${dataDir}/new.txt`, "patched");
}

function realCtx() {
  return createInstallContext({
    settings: sb.settings,
    selection: computeSelection(file([mod(1)]), sb.settings),
    fs: new RealFileSystem(),
    dryRun: false,
  });
}

describe("findTslpatchdataDir", () => {
  it("finds a direct child", async () => {
    await seedData(`${sb.mods}/m/tslpatchdata`);
    expect(await findTslpatchdataDir(fs, `${sb.mods}/m`)).toBe(`${sb.mods}/m/tslpatchdata`);
  });

  it("matches the folder name case-insensitively", async () => {
    await seedData(`${sb.mods}/m/TSLPatchData`);
    expect(await findTslpatchdataDir(fs, `${sb.mods}/m`)).toBe(`${sb.mods}/m/TSLPatchData`);
  });

  it("finds tslpatchdata nested one wrapper level down", async () => {
    await seedData(`${sb.mods}/m/Wrapper/tslpatchdata`);
    expect(await findTslpatchdataDir(fs, `${sb.mods}/m`)).toBe(`${sb.mods}/m/Wrapper/tslpatchdata`);
  });

  it("finds tslpatchdata nested two wrapper levels down, case-insensitively", async () => {
    await seedData(`${sb.mods}/m/Outer/Inner/TslPatchData`);
    expect(await findTslpatchdataDir(fs, `${sb.mods}/m`)).toBe(`${sb.mods}/m/Outer/Inner/TslPatchData`);
  });

  it("prefers the shallowest match", async () => {
    await seedData(`${sb.mods}/m/tslpatchdata`);
    await seedData(`${sb.mods}/m/Wrapper/tslpatchdata`);
    expect(await findTslpatchdataDir(fs, `${sb.mods}/m`)).toBe(`${sb.mods}/m/tslpatchdata`);
    await seedData(`${sb.mods}/n/A/tslpatchdata`);
    await seedData(`${sb.mods}/n/B/C/tslpatchdata`);
    expect(await findTslpatchdataDir(fs, `${sb.mods}/n`)).toBe(`${sb.mods}/n/A/tslpatchdata`);
  });

  it("does not search deeper than the depth limit", async () => {
    expect(TSLPATCHDATA_MAX_DEPTH).toBe(3);
    await seedData(`${sb.mods}/m/A/B/C/tslpatchdata`);
    expect(await findTslpatchdataDir(fs, `${sb.mods}/m`)).toBeUndefined();
  });

  it("ignores a file named tslpatchdata", async () => {
    await writeText(`${sb.mods}/m/tslpatchdata`, "not a folder");
    expect(await findTslpatchdataDir(fs, `${sb.mods}/m`)).toBeUndefined();
  });

  it("fails with the relative paths when several matches share the shallowest depth", async () => {
    await seedData(`${sb.mods}/m/Alpha/tslpatchdata`);
    await seedData(`${sb.mods}/m/Beta/TSLPatchData`);
    await expect(findTslpatchdataDir(fs, `${sb.mods}/m`)).rejects.toMatchObject({
      name: "ActionError",
      code: "PatcherError",
      message: expect.stringMatching(/ambiguous.*"Alpha\/tslpatchdata", "Beta\/TSLPatchData"/),
    });
  });

  it("returns undefined when there is none", async () => {
    await writeText(`${sb.mods}/m/readme.txt`, "hi");
    expect(await findTslpatchdataDir(fs, `${sb.mods}/m`)).toBeUndefined();
  });
});

describe("locateTslpatchdata", () => {
  it("resolves a mod directory with a nested wrapper to the nested folder", async () => {
    await seedData(`${sb.mods}/m/Wrapper/tslpatchdata`);
    const located = await locateTslpatchdata(realCtx(), `${sb.mods}/m`);
    expect(located?.tslpatchdataDir).toBe(`${sb.mods}/m/Wrapper/tslpatchdata`);
  });

  it("still accepts the tslpatchdata folder itself", async () => {
    await seedData(`${sb.mods}/m/Wrapper/tslpatchdata`);
    const located = await locateTslpatchdata(realCtx(), `${sb.mods}/m/Wrapper/tslpatchdata`);
    expect(located?.tslpatchdataDir).toBe(`${sb.mods}/m/Wrapper/tslpatchdata`);
  });
});

describe("Patcher action source discovery", () => {
  it("applies a patcher nested under a wrapper folder found through a wildcard source", async () => {
    await seedData(`${sb.mods}/Pack v1/Wrapper/TSLPatchData`);
    const r = await executeInstruction(
      realCtx(),
      instr("Patcher", { source: ["<<modDirectory>>\\Pack*"], destination: "<<kotorDirectory>>" }),
      mod(1),
    );
    expect(r.code).toBe("Success");
    expect(await readFile(`${sb.kotor}/Override/new.txt`, "utf8")).toBe("patched");
  });

  it("reads namespaces.ini from the wrapper folder that contains the nested tslpatchdata", async () => {
    const wrapper = `${sb.mods}/Pack v1/Wrapper`;
    await seedData(`${wrapper}/tslpatchdata`);
    await writeText(`${wrapper}/namespaces.ini`, "[Namespaces]\nNamespace0=one\n\n[one]\nName=First\nIniName=changes.ini\n");
    const prompts: string[] = [];
    const ctx = createInstallContext({
      settings: sb.settings,
      selection: computeSelection(file([mod(1)]), sb.settings),
      fs: new RealFileSystem(),
      dryRun: false,
      prompt: async (p) => {
        prompts.push(p.id);
        return { promptId: p.id, choiceId: "0" };
      },
    });
    const r = await executeInstruction(ctx, instr("Patcher", { source: ["<<modDirectory>>\\Pack*"], destination: "<<kotorDirectory>>" }), mod(1));
    expect(r.code).toBe("Success");
    expect(prompts).toHaveLength(0);
    expect(await readFile(`${sb.kotor}/Override/new.txt`, "utf8")).toBe("patched");
  });

  it("reports an ambiguity error instead of guessing", async () => {
    await seedData(`${sb.mods}/Pack v1/Alpha/tslpatchdata`);
    await seedData(`${sb.mods}/Pack v1/Beta/tslpatchdata`);
    const r = await executeInstruction(realCtx(), instr("Patcher", { source: ["<<modDirectory>>\\Pack*"] }), mod(1));
    expect(r.code).toBe("PatcherError");
    expect(r.message).toContain("Alpha/tslpatchdata");
    expect(r.message).toContain("Beta/tslpatchdata");
  });

  it("lists the top-level entries when no tslpatchdata folder exists", async () => {
    await writeText(`${sb.mods}/Pack v1/readme.txt`, "hi");
    await writeText(`${sb.mods}/Pack v1/Override/a.tga`, "A");
    const r = await executeInstruction(realCtx(), instr("Patcher", { source: ["<<modDirectory>>\\Pack*"] }), mod(1));
    expect(r.code).toBe("FileNotFoundPre");
    expect(r.message).toContain('no "tslpatchdata" folder found');
    expect(r.message).toContain("Override/");
    expect(r.message).toContain("readme.txt");
  });
});
