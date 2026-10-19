import { copyFile, mkdir, readFile, readdir, stat, symlink } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openArchive } from "../../archive/index.js";
import { RealFileSystem } from "../../fs/realFileSystem.js";
import { VirtualFileSystem } from "../../fs/virtualFileSystem.js";
import type { FileSystemPort } from "../../ports/filesystem.js";
import type { UserPrompt, UserPromptAnswer } from "../../model/types.js";
import { createInstallContext, type InstallContext } from "../context.js";
import { computeSelection } from "../selection.js";
import { G, file, instr, makeSandbox, mod, option, writeText, writeZip, type Sandbox } from "../testing.js";
import { executeInstruction, predictTouched, splitArguments } from "./index.js";

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox();
});
afterEach(async () => {
  await sb.cleanup();
});

type Flavor = "real" | "vfs";
const FLAVORS: Flavor[] = ["vfs", "real"];

function makeCtx(
  flavor: Flavor,
  f = file([mod(1)]),
  extra: { prompt?: (p: UserPrompt) => Promise<UserPromptAnswer>; signal?: AbortSignal; dryRun?: boolean } = {},
): InstallContext {
  const fs: FileSystemPort = flavor === "vfs" ? new VirtualFileSystem(new RealFileSystem()) : new RealFileSystem();
  return createInstallContext({
    settings: sb.settings,
    selection: computeSelection(f, sb.settings),
    fs,
    dryRun: extra.dryRun ?? flavor === "vfs",
    prompt: extra.prompt,
    signal: extra.signal,
  });
}

const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

describe.each(FLAVORS)("actions on %s file system", (flavor) => {
  it("Extract unpacks a real zip next to itself", async () => {
    await writeZip(`${sb.mods}/Cool Mod v1.zip`, { "Override/a.tpc": "A", "readme.txt": "hi", "sub/dir/b.tga": "B" });
    const ctx = makeCtx(flavor);
    const m = mod(1);
    const r = await executeInstruction(ctx, instr("Extract", { source: ["<<modDirectory>>\\Cool Mod*.zip"] }), m);
    expect(r.code).toBe("Success");
    const dest = `${sb.mods}/Cool Mod v1`;
    expect(await ctx.fs.exists(`${dest}/Override/a.tpc`)).toBe(true);
    expect(await ctx.fs.exists(`${dest}/sub/dir/b.tga`)).toBe(true);
    expect(r.touched).toContain(`${dest}/Override/a.tpc`);
    if (flavor === "real") {
      expect(await readFile(`${dest}/readme.txt`, "utf8")).toBe("hi");
    } else {
      expect(await exists(dest)).toBe(false);
      expect((ctx.fs as VirtualFileSystem).getMutations().some((mu) => mu.path === `${dest}/readme.txt`)).toBe(true);
    }
  });

  it("Extract reports a missing archive as FileNotFoundPre and honours destination", async () => {
    const ctx = makeCtx(flavor);
    const r = await executeInstruction(ctx, instr("Extract", { source: ["<<modDirectory>>/nothing*.zip"] }), mod(1));
    expect(r.code).toBe("FileNotFoundPre");
    await writeZip(`${sb.mods}/x.zip`, { "f.txt": "1" });
    const ctx2 = makeCtx(flavor); // a VFS snapshots listings on first touch
    const r2 = await executeInstruction(ctx2, instr("Extract", { source: ["<<modDirectory>>/x.zip"], destination: "<<modDirectory>>/out" }), mod(1));
    expect(r2.code).toBe("Success");
    expect(await ctx2.fs.exists(`${sb.mods}/out/f.txt`)).toBe(true);
  });

  it("Extract fails with ArchiveError on a corrupt archive", async () => {
    await writeText(`${sb.mods}/bad.zip`, "this is not a zip");
    const r = await executeInstruction(makeCtx(flavor), instr("Extract", { source: ["<<modDirectory>>/bad.zip"] }), mod(1));
    expect(r.code).toBe("ArchiveError");
  });

  it("Move with overwrite true replaces, overwrite false keeps existing", async () => {
    await writeText(`${sb.mods}/m/a.txt`, "new");
    await writeText(`${sb.mods}/m/b.txt`, "new");
    await writeText(`${sb.kotor}/Override/a.txt`, "old");
    const ctx = makeCtx(flavor);
    const r = await executeInstruction(ctx, instr("Move", { source: ["<<modDirectory>>/m/*"], destination: "<<kotorDirectory>>/Override", overwrite: false }), mod(1));
    expect(r.code).toBe("Success");
    expect(new TextDecoder().decode(await ctx.fs.readFile(`${sb.kotor}/Override/a.txt`))).toBe("old");
    expect(new TextDecoder().decode(await ctx.fs.readFile(`${sb.kotor}/Override/b.txt`))).toBe("new");
    expect(await ctx.fs.exists(`${sb.mods}/m/a.txt`)).toBe(true); // kept, not moved
    expect(await ctx.fs.exists(`${sb.mods}/m/b.txt`)).toBe(false);
    const r2 = await executeInstruction(ctx, instr("Move", { source: ["<<modDirectory>>/m/a.txt"], destination: "<<kotorDirectory>>/Override", overwrite: true }), mod(1));
    expect(r2.code).toBe("Success");
    expect(new TextDecoder().decode(await ctx.fs.readFile(`${sb.kotor}/Override/a.txt`))).toBe("new");
    expect(r2.touched).toContain(`${sb.kotor}/Override/a.txt`);
    if (flavor === "real") expect(await readFile(`${sb.kotor}/Override/a.txt`, "utf8")).toBe("new");
    else expect(await readFile(`${sb.kotor}/Override/a.txt`, "utf8")).toBe("old");
  });

  it("Move merges a folder into the game folder that already has the same name in another casing", async () => {
    await writeText(`${sb.mods}/m/OVERRIDE/new.txt`, "new");
    await writeText(`${sb.mods}/m/OVERRIDE/deep/inner.txt`, "inner");
    await writeText(`${sb.kotor}/Override/keep.txt`, "keep");
    const ctx = makeCtx(flavor);
    const r = await executeInstruction(ctx, instr("Move", { source: ["<<modDirectory>>/m/OVERRIDE"], destination: "<<kotorDirectory>>" }), mod(1));
    expect(r.code).toBe("Success");
    expect((await ctx.fs.readDir(sb.kotor)).map((e) => e.name)).toEqual(["Override"]);
    for (const rel of ["keep.txt", "new.txt", "deep/inner.txt"]) expect(await ctx.fs.exists(`${sb.kotor}/Override/${rel}`), rel).toBe(true);
    expect(await ctx.fs.exists(`${sb.mods}/m/OVERRIDE`)).toBe(false);
  });

  it("Move into a lower-case destination folder reuses the existing Override folder", async () => {
    await writeText(`${sb.mods}/m/a.txt`, "a");
    const ctx = makeCtx(flavor);
    const r = await executeInstruction(ctx, instr("Move", { source: ["<<modDirectory>>/m/a.txt"], destination: "<<kotorDirectory>>/override/sub" }), mod(1));
    expect(r.code).toBe("Success");
    expect((await ctx.fs.readDir(sb.kotor)).map((e) => e.name)).toEqual(["Override"]);
    expect(await ctx.fs.exists(`${sb.kotor}/Override/sub/a.txt`)).toBe(true);
  });

  it("Move replaces a file that blocks a folder only with overwrite", async () => {
    await writeText(`${sb.mods}/m/Tools/x.txt`, "x");
    await writeText(`${sb.kotor}/Tools`, "i am a file");
    const ctx = makeCtx(flavor);
    const kept = await executeInstruction(ctx, instr("Move", { source: ["<<modDirectory>>/m/Tools"], destination: "<<kotorDirectory>>", overwrite: false }), mod(1));
    expect(kept.code).toBe("UnknownError");
    expect(kept.message).toMatch(/a file with that name exists/);
    const replaced = await executeInstruction(ctx, instr("Move", { source: ["<<modDirectory>>/m/Tools"], destination: "<<kotorDirectory>>", overwrite: true }), mod(1));
    expect(replaced.code).toBe("Success");
    expect((await ctx.fs.stat(`${sb.kotor}/Tools`))?.isDirectory).toBe(true);
    expect(await ctx.fs.exists(`${sb.kotor}/Tools/x.txt`)).toBe(true);
  });

  it("Move reports a missing source and a missing destination", async () => {
    const ctx = makeCtx(flavor);
    const r = await executeInstruction(ctx, instr("Move", { source: ["<<modDirectory>>/nope/*"], destination: "<<kotorDirectory>>/Override" }), mod(1));
    expect(r.code).toBe("FileNotFoundPre");
    const r2 = await executeInstruction(ctx, instr("Move", { source: ["<<modDirectory>>"] }), mod(1));
    expect(r2.code).toBe("UnknownError");
  });

  it("Copy merges a directory into an existing directory", async () => {
    await writeText(`${sb.mods}/src/Override/x.txt`, "x");
    await writeText(`${sb.mods}/src/Override/deep/y.txt`, "y");
    await writeText(`${sb.kotor}/Override/keep.txt`, "k");
    const ctx = makeCtx(flavor);
    const r = await executeInstruction(ctx, instr("Copy", { source: ["<<modDirectory>>/src/Override"], destination: "<<kotorDirectory>>" }), mod(1));
    expect(r.code).toBe("Success");
    for (const p of ["keep.txt", "x.txt", "deep/y.txt"]) expect(await ctx.fs.exists(`${sb.kotor}/Override/${p}`)).toBe(true);
    expect(await ctx.fs.exists(`${sb.mods}/src/Override/x.txt`)).toBe(true);
    expect(r.touched).toContain(`${sb.kotor}/Override/deep/y.txt`);
  });

  it("Delete removes matches and warns for missing files", async () => {
    await writeText(`${sb.kotor}/Override/a.tpc`, "a");
    await writeText(`${sb.kotor}/Override/b.tpc`, "b");
    const ctx = makeCtx(flavor);
    const r = await executeInstruction(ctx, instr("Delete", { source: ["<<kotorDirectory>>/override/*.TPC", "<<kotorDirectory>>/Override/missing.txt"] }), mod(1));
    expect(r.code).toBe("Success");
    expect(r.message).toContain("missing.txt");
    expect(await ctx.fs.exists(`${sb.kotor}/Override/a.tpc`)).toBe(false);
    expect(r.touched.sort()).toEqual([`${sb.kotor}/Override/a.tpc`, `${sb.kotor}/Override/b.tpc`]);
  });

  it("Rename renames within the directory or to a placeholder path", async () => {
    await writeText(`${sb.mods}/r/old.txt`, "1");
    const ctx = makeCtx(flavor);
    const r = await executeInstruction(ctx, instr("Rename", { source: ["<<modDirectory>>/r/old.txt"], destination: "new.txt" }), mod(1));
    expect(r.code).toBe("Success");
    expect(await ctx.fs.exists(`${sb.mods}/r/new.txt`)).toBe(true);
    expect(await ctx.fs.exists(`${sb.mods}/r/old.txt`)).toBe(false);
    const r2 = await executeInstruction(ctx, instr("Rename", { source: ["<<modDirectory>>/r/new.txt"], destination: "<<kotorDirectory>>/Override/moved.txt" }), mod(1));
    expect(r2.code).toBe("Success");
    expect(await ctx.fs.exists(`${sb.kotor}/Override/moved.txt`)).toBe(true);
    const r3 = await executeInstruction(ctx, instr("Rename", { source: ["<<modDirectory>>/r/gone.txt"], destination: "x" }), mod(1));
    expect(r3.code).toBe("FileNotFoundPre");
  });

  it("DelDuplicate removes the .tpc twin of a .tga", async () => {
    await writeText(`${sb.kotor}/Override/tex.tpc`, "1");
    await writeText(`${sb.kotor}/Override/TEX.tga`, "2");
    await writeText(`${sb.kotor}/Override/lonely.tpc`, "3");
    const ctx = makeCtx(flavor);
    const r = await executeInstruction(ctx, instr("DelDuplicate", { source: ["<<kotorDirectory>>/Override"], arguments: "tpc" }), mod(1));
    expect(r.code).toBe("Success");
    expect(await ctx.fs.exists(`${sb.kotor}/Override/tex.tpc`)).toBe(false);
    expect(await ctx.fs.exists(`${sb.kotor}/Override/TEX.tga`)).toBe(true);
    expect(await ctx.fs.exists(`${sb.kotor}/Override/lonely.tpc`)).toBe(true);
  });

  it("CleanList deletes files listed for selected mods and options only", async () => {
    await writeText(
      `${sb.mods}/ctf/cleanlist.txt`,
      ["# comment", "HD Astromechs,c_drdastro.tpc,c_drdastro01.tpc", "Not Selected Mod,keep.tpc", "HK-47,hk47.tpc"].join("\r\n"),
    );
    for (const n of ["c_drdastro.tpc", "C_DRDASTRO01.tpc", "keep.tpc", "hk47.tpc", "other.tpc"]) await writeText(`${sb.mods}/ctf/Override/${n}`, n);
    const f = file([
      mod(1, { name: "Character Textures" }),
      mod(2, { name: "HD Astromechs" }),
      mod(3, { name: "Visually Repair HK-47", options: [option(31, { name: "HK-47 only" })] }),
    ]);
    const ctx = makeCtx(flavor, f);
    const r = await executeInstruction(
      ctx,
      instr("CleanList", { source: ["<<modDirectory>>/ctf/cleanlist.txt"], destination: "<<modDirectory>>/ctf/Override" }),
      f.mods[0],
    );
    expect(r.code).toBe("Success");
    const left = (await ctx.fs.readDir(`${sb.mods}/ctf/Override`)).map((e) => e.name).sort();
    expect(left).toEqual(["keep.tpc", "other.tpc"]);
    expect(r.touched).toHaveLength(3);
  });

  it("Choose auto-answers a single folder and prompts for several", async () => {
    await writeText(`${sb.mods}/ws/1024x768/a.gui`, "1");
    await writeText(`${sb.mods}/ws/1920x1080/a.gui`, "2");
    await writeText(`${sb.mods}/ws/readme.txt`, "not a folder");
    await writeText(`${sb.mods}/single/only/b.gui`, "3");
    const prompts: UserPrompt[] = [];
    const ctx = makeCtx(flavor, undefined, {
      prompt: async (p) => {
        prompts.push(p);
        return { promptId: p.id, choiceId: p.choices[1].id };
      },
    });
    const r = await executeInstruction(ctx, instr("Choose", { source: ["<<modDirectory>>/ws/*"] }), mod(1));
    expect(r.code).toBe("Success");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].kind).toBe("choose-folder");
    expect(prompts[0].choices.map((c) => c.label)).toEqual(["1024x768", "1920x1080"]);
    expect(new TextDecoder().decode(await ctx.fs.readFile(`${sb.kotor}/Override/a.gui`))).toBe("2");

    const r2 = await executeInstruction(ctx, instr("Choose", { source: ["<<modDirectory>>/single/*"], destination: "<<kotorDirectory>>/Override/sub" }), mod(1));
    expect(r2.code).toBe("Success");
    expect(prompts).toHaveLength(1);
    expect(await ctx.fs.exists(`${sb.kotor}/Override/sub/b.gui`)).toBe(true);
  });

  it("Choose over option GUIDs records the answer in the selection", async () => {
    const f = file([mod(1, { options: [option(11, { isSelected: false }), option(12, { isSelected: false })] })]);
    const prompts: UserPrompt[] = [];
    const ctx = makeCtx(flavor, f, {
      prompt: async (p) => {
        prompts.push(p);
        return { promptId: p.id, choiceId: G(12) };
      },
    });
    const r = await executeInstruction(ctx, instr("Choose", { source: [`{${G(11).toUpperCase()}}`, G(12)] }), f.mods[0]);
    expect(r.code).toBe("Success");
    expect(prompts[0].kind).toBe("choose-option");
    expect(ctx.selection.selectedGuids.has(G(12))).toBe(true);
    expect(ctx.selection.selectedGuids.has(G(11))).toBe(false);
    // A pre-selected option answers without prompting.
    const f2 = file([mod(1, { options: [option(11, { isSelected: false }), option(12)] })]);
    const ctx2 = makeCtx(flavor, f2, { prompt: async () => { throw new Error("should not prompt"); } });
    const r2 = await executeInstruction(ctx2, instr("Choose", { source: [G(11), G(12)] }), f2.mods[0]);
    expect(r2.code).toBe("Success");
    expect(r2.message).toContain("Option 12");
  });

  it("gates on platform, dependencies and restrictions", async () => {
    const f = file([mod(1), mod(2, { isSelected: false }), mod(3)]);
    const ctx = makeCtx(flavor, f);
    const dep = await executeInstruction(ctx, instr("Delete", { source: ["<<modDirectory>>/x"], dependencies: [G(2)] }), f.mods[0]);
    expect(dep.code).toBe("DependencyNotSelected");
    const res = await executeInstruction(ctx, instr("Delete", { source: ["<<modDirectory>>/x"], restrictions: [G(3)] }), f.mods[0]);
    expect(res.code).toBe("RestrictionSelected");
    const plat = await executeInstruction(ctx, instr("Delete", { source: ["<<modDirectory>>/x"], platform: "Mobile" }), f.mods[0]);
    expect(plat.code).toBe("Skipped");
  });

  it("maps sandbox escapes to PathEscape and never throws", async () => {
    const ctx = makeCtx(flavor);
    const r = await executeInstruction(ctx, instr("Delete", { source: ["<<modDirectory>>/../../etc/passwd"] }), mod(1));
    expect(r.code).toBe("PathEscape");
    const r2 = await executeInstruction(ctx, instr("Move", { source: ["relative/path"], destination: "<<kotorDirectory>>" }), mod(1));
    expect(r2.code).toBe("PathEscape");
  });

  it("returns UserCancelled when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx(flavor, undefined, { signal: controller.signal });
    const r = await executeInstruction(ctx, instr("Delete", { source: ["<<modDirectory>>/x"] }), mod(1));
    expect(r.code).toBe("UserCancelled");
  });

  it("rejects escaping symlinks across copy, delete, rename, and extraction", async () => {
    const outside = `${sb.root}/outside`;
    await mkdir(outside);
    await writeText(`${outside}/secret.txt`, "untouched");
    await writeText(`${sb.mods}/safe.txt`, "safe");
    await symlink(outside, `${sb.kotor}/linked`, "dir");
    await symlink(`${outside}/secret.txt`, `${sb.mods}/secret.txt`);
    await writeZip(`${sb.mods}/archive.zip`, { "secret.txt": "overwritten" });
    for (const instruction of [
      instr("Copy", { source: ["<<modDirectory>>/safe.txt"], destination: "<<kotorDirectory>>/linked" }),
      instr("Delete", { source: ["<<modDirectory>>/secret.txt"] }),
      instr("Rename", { source: ["<<modDirectory>>/safe.txt"], destination: "<<kotorDirectory>>/linked/renamed.txt" }),
      instr("Extract", { source: ["<<modDirectory>>/archive.zip"], destination: "<<kotorDirectory>>/linked" }),
    ]) {
      const result = await executeInstruction(makeCtx(flavor), instruction, mod(1));
      expect(result.code, instruction.action).toBe("PathEscape");
    }
    expect(await readFile(`${outside}/secret.txt`, "utf8")).toBe("untouched");
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  it("rejects archive entries targeting an escaping link inside a valid destination", async () => {
    const outside = `${sb.root}/outside`;
    await mkdir(outside);
    await symlink(outside, `${sb.kotor}/Override/linked`, "dir");
    await writeZip(`${sb.mods}/archive.zip`, { "linked/secret.txt": "bad" });
    const result = await executeInstruction(makeCtx(flavor), instr("Extract", { source: ["<<modDirectory>>/archive.zip"], destination: "<<kotorDirectory>>/Override" }), mod(1));
    expect(result.code).toBe("PathEscape");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects dangling destination links before writing", async () => {
    const outside = `${sb.root}/new-secret.txt`;
    await writeText(`${sb.mods}/safe.txt`, "safe");
    await symlink(outside, `${sb.kotor}/Override/safe.txt`);
    const result = await executeInstruction(makeCtx(flavor), instr("Copy", { source: ["<<modDirectory>>/safe.txt"], destination: "<<kotorDirectory>>/Override", overwrite: true }), mod(1));
    expect(result.code).toBe("PathEscape");
    expect(await exists(outside)).toBe(false);
  });

  it("Execute checks existence in dry run and runs the program otherwise", async () => {
    if (process.platform === "win32") return;
    await mkdir(`${sb.mods}/tool`, { recursive: true });
    await copyFile(process.execPath, `${sb.mods}/tool/node`);
    const args = `-e "require('fs').writeFileSync('made.txt', 'ok')"`;
    const dry = makeCtx(flavor, undefined, { dryRun: true });
    const r = await executeInstruction(dry, instr("Execute", { source: ["<<modDirectory>>/tool/node"], arguments: args }), mod(1));
    expect(r.code).toBe("Success");
    expect(await exists(`${sb.mods}/tool/made.txt`)).toBe(false);
    const missing = await executeInstruction(dry, instr("Execute", { source: ["<<modDirectory>>/tool/nope"], arguments: args }), mod(1));
    expect(missing.code).toBe("FileNotFoundPre");

    if (flavor !== "real") return;
    const real = makeCtx("real", undefined, { dryRun: false });
    const r2 = await executeInstruction(real, instr("Execute", { source: ["<<modDirectory>>/tool/node"], arguments: args }), mod(1));
    expect(r2.code).toBe("Success");
    expect(await readFile(`${sb.mods}/tool/made.txt`, "utf8")).toBe("ok");
    const r3 = await executeInstruction(real, instr("Execute", { source: ["<<modDirectory>>/tool/node"], arguments: `-e "process.exit(3)"` }), mod(1));
    expect(r3.code).toBe("ExecuteError");
    expect(r3.message).toContain("3");
  });

  it("Patcher applies an InstallList through the native engine", async () => {
    await writeText(`${sb.mods}/pm/tslpatchdata/changes.ini`, "[InstallList]\ninstall_folder0=Override\n\n[Override]\nFile0=new.txt\n");
    await writeText(`${sb.mods}/pm/tslpatchdata/new.txt`, "patched");
    await writeText(`${sb.mods}/pm/TSLPatcher.exe`, "MZ");
    const ctx = makeCtx(flavor);
    for (const src of ["<<modDirectory>>/pm", "<<modDirectory>>/pm/TSLPatcher.exe", "<<modDirectory>>/pm/TSLPATCHDATA"]) {
      const r = await executeInstruction(ctx, instr("Patcher", { source: [src], destination: "<<kotorDirectory>>" }), mod(1));
      expect(r.code, src).toBe("Success");
    }
    if (flavor === "real") {
      expect(await readFile(`${sb.kotor}/Override/new.txt`, "utf8")).toBe("patched");
    } else {
      expect(await exists(`${sb.kotor}/Override/new.txt`)).toBe(false);
    }
    const bad = await executeInstruction(ctx, instr("Patcher", { source: ["<<modDirectory>>/nothing"] }), mod(1));
    expect(bad.code).toBe("FileNotFoundPre");
  });

  it("Patcher prompts for a namespace and accepts an index argument", async () => {
    const base = `${sb.mods}/ns/tslpatchdata`;
    await writeText(
      `${base}/namespaces.ini`,
      "[Namespaces]\nNamespace0=one\nNamespace1=two\n\n[one]\nName=First\nIniName=changes.ini\n\n[two]\nName=Second\nIniName=two.ini\nDataFolderName=two\n",
    );
    await writeText(`${base}/changes.ini`, "[InstallList]\ninstall_folder0=Override\n\n[Override]\nFile0=one.txt\n");
    await writeText(`${base}/one.txt`, "1");
    await writeText(`${base}/two/two.ini`, "[InstallList]\ninstall_folder0=Override\n\n[Override]\nFile0=two.txt\n");
    await writeText(`${base}/two/two.txt`, "2");
    const prompts: UserPrompt[] = [];
    const ctx = makeCtx(flavor, undefined, {
      prompt: async (p) => {
        prompts.push(p);
        return { promptId: p.id, choiceId: "1" };
      },
    });
    const r = await executeInstruction(ctx, instr("Patcher", { source: ["<<modDirectory>>/ns"] }), mod(1));
    expect(r.code).toBe("Success");
    expect(prompts[0].kind).toBe("patcher-namespace");
    expect(prompts[0].choices.map((c) => c.label)).toEqual(["First", "Second"]);
    expect(r.touched).toContain(`${sb.kotor}/Override/two.txt`);
    expect(await exists(`${sb.kotor}/Override/two.txt`)).toBe(flavor === "real");
    const r2 = await executeInstruction(ctx, instr("Patcher", { source: ["<<modDirectory>>/ns"], arguments: "0" }), mod(1));
    expect(r2.code).toBe("Success");
    expect(prompts).toHaveLength(1);
    expect(r2.touched).toContain(`${sb.kotor}/Override/one.txt`);
  });
});

describe("streaming native extract action", () => {
  it("extracts a large file without using the full-entry read API", async () => {
    const payload = "streamed archive bytes\n".repeat(250_000);
    await writeZip(`${sb.mods}/Large.zip`, { "large.txt": payload });
    const reader = await openArchive(`${sb.mods}/Large.zip`);
    const read = vi.spyOn(reader, "readEntry").mockRejectedValue(new Error("full-entry buffering is forbidden"));
    const ctx = makeCtx("real");
    ctx.openArchive = async () => reader;
    const result = await executeInstruction(ctx, instr("Extract", { source: ["<<modDirectory>>/Large.zip"] }), mod(1));
    expect(result.code).toBe("Success");
    expect(read).not.toHaveBeenCalled();
    expect(await readFile(`${sb.mods}/Large/large.txt`, "utf8")).toBe(payload);
  });
});

describe("predictTouched", () => {
  it("predicts move targets without mutating", async () => {
    await writeText(`${sb.mods}/m/a.txt`, "a");
    await writeText(`${sb.mods}/m/d/b.txt`, "b");
    const ctx = makeCtx("real");
    const paths = await predictTouched(ctx, instr("Move", { source: ["<<modDirectory>>/m/*"], destination: "<<kotorDirectory>>/Override" }));
    expect(paths.sort()).toEqual([`${sb.kotor}/Override/a.txt`, `${sb.kotor}/Override/d/b.txt`, `${sb.mods}/m/a.txt`, `${sb.mods}/m/d/b.txt`].sort());
    expect((await readdir(`${sb.kotor}/Override`)).length).toBe(0);
    expect(await predictTouched(ctx, instr("Move", { source: ["<<modDirectory>>/../x"], destination: "<<kotorDirectory>>" }))).toEqual([]);
    expect(await predictTouched(ctx, instr("Patcher", { source: ["<<modDirectory>>/m"] }))).toEqual([]);
  });
});

describe("splitArguments", () => {
  it("splits shell-style", () => {
    expect(splitArguments(`-e "a b" 'c d' e\\ f "q\\"x"`)).toEqual(["-e", "a b", "c d", "e f", 'q"x']);
    expect(splitArguments("")).toEqual([]);
    expect(splitArguments(undefined)).toEqual([]);
    expect(splitArguments("  one   two ")).toEqual(["one", "two"]);
  });
});
