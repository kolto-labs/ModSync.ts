import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckpointStore, CheckpointError } from "../checkpoints/store.js";
import { RealFileSystem } from "../fs/realFileSystem.js";
import { acquirePortableRootOwnership, type PhysicalInstallOptIn } from "../fs/portableLock.js";
import { Installer } from "./installer.js";
import { file, instr, makeSandbox, mod, writeText, writeZip, type Sandbox } from "./testing.js";

const OPT_IN: PhysicalInstallOptIn = { ownership: "portable-lockfile" };

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox("modsync-physical-");
});
afterEach(async () => {
  await sb.cleanup();
});

const locks = async (): Promise<string[]> => (await readdir(sb.root)).filter((name) => name.startsWith(".modsync-portable-lock-"));
const text = (path: string): Promise<string> => readFile(path, "utf8");

function guide() {
  return file([
    mod(1, {
      name: "Example Pack",
      instructions: [
        instr("Extract", { source: ["<<modDirectory>>/Pack*.zip"] }),
        instr("Copy", { source: ["<<modDirectory>>/Pack*/Override/copy_me.txt"], destination: "<<kotorDirectory>>/Override/extra" }),
        instr("Move", { source: ["<<modDirectory>>/Pack*/Override/move_me.txt"], destination: "<<kotorDirectory>>/Override" }),
        instr("Rename", { source: ["<<kotorDirectory>>/Override/move_me.txt"], destination: "renamed.txt" }),
        instr("Delete", { source: ["<<kotorDirectory>>/Override/old.txt"] }),
      ],
    }),
  ]);
}

async function fixtures(): Promise<void> {
  await writeZip(`${sb.mods}/Pack v1.zip`, { "Override/copy_me.txt": "copied", "Override/move_me.txt": "moved" });
  await writeText(`${sb.kotor}/Override/old.txt`, "old");
  await writeText(`${sb.kotor}/Override/keep.txt`, "keep");
}

const store = (physicalRestore?: PhysicalInstallOptIn) =>
  new CheckpointStore({ rootDir: `${sb.root}/checkpoints`, kotorDirectory: sb.kotor, fs: new RealFileSystem(), physicalRestore });

describe("physical install gate", () => {
  it("still refuses a real run by default and writes nothing", async () => {
    await fixtures();
    const summary = await new Installer(guide(), sb.settings, { checkpoints: store() }).run();
    expect(summary.error).toMatch(/physical installation is unavailable/);
    expect(summary.succeeded).toBe(0);
    expect(await readdir(`${sb.kotor}/Override`)).toEqual(["keep.txt", "old.txt"]);
    expect(await readdir(sb.mods)).toEqual(["Pack v1.zip"]);
    expect(await locks()).toEqual([]);
    expect(await readdir(sb.root)).not.toContain("checkpoints");
  });

  it("rejects an opt-in combined with a dry run or with an unknown ownership kind", async () => {
    await fixtures();
    const dry = await new Installer(guide(), sb.settings).run({ dryRun: true, physical: OPT_IN });
    expect(dry.error).toMatch(/real run/);
    const unknown = await new Installer(guide(), sb.settings).run({ physical: { ownership: "native" } as unknown as PhysicalInstallOptIn });
    expect(unknown.error).toMatch(/portable-lockfile/);
    expect(await readdir(`${sb.kotor}/Override`)).toEqual(["keep.txt", "old.txt"]);
    expect(await locks()).toEqual([]);
  });

  it("opt-in performs real extract, copy, move, rename and delete, then frees its locks", async () => {
    await fixtures();
    const events: string[] = [];
    const installer = new Installer(guide(), sb.settings, { checkpoints: store(OPT_IN) });
    installer.on("event", (event) => {
      if (event.type === "log" && event.level === "warn") events.push(event.message);
    });
    const summary = await installer.run({ physical: OPT_IN });
    expect(summary.error).toBeUndefined();
    expect(summary.succeeded).toBe(1);
    expect(summary.mods[0].instructionResults.map((r) => r.code)).toEqual(Array(5).fill("Success"));

    expect(await text(`${sb.mods}/Pack v1/Override/copy_me.txt`)).toBe("copied");
    expect(await text(`${sb.kotor}/Override/extra/copy_me.txt`)).toBe("copied");
    expect(await text(`${sb.kotor}/Override/renamed.txt`)).toBe("moved");
    expect((await readdir(`${sb.kotor}/Override`)).sort()).toEqual(["extra", "keep.txt", "renamed.txt"]);
    expect(await locks()).toEqual([]);
    const [session] = await store(OPT_IN).list();
    expect(session.checkpoints).toHaveLength(6);
    expect(summary.checkpointSessionId).toBe(session.id);
  });

  it("keeps CreateDirectory refused under the opt-in because empty directories have no rollback", async () => {
    const summary = await new Installer(file([mod(1, { instructions: [instr("CreateDirectory", { destination: "<<kotorDirectory>>/Override/empty" })] })]), sb.settings, { checkpoints: store(OPT_IN) }).run({ physical: OPT_IN });
    expect(summary.error).toBeDefined();
    expect(summary.succeeded).toBe(0);
    expect(await readdir(`${sb.kotor}/Override`)).toEqual([]);
    expect(await locks()).toEqual([]);
  });

  it("refuses to start while another process holds the root and leaves the disk untouched", async () => {
    await fixtures();
    const holder = await acquirePortableRootOwnership([sb.kotor]);
    try {
      const summary = await new Installer(guide(), sb.settings, { checkpoints: store(OPT_IN) }).run({ physical: OPT_IN });
      expect(summary.error).toMatch(/locked/);
      expect(summary.succeeded).toBe(0);
      expect(await readdir(`${sb.kotor}/Override`)).toEqual(["keep.txt", "old.txt"]);
      expect(await readdir(sb.mods)).toEqual(["Pack v1.zip"]);
    } finally {
      await holder.release();
    }
    expect(await locks()).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("stops at a failed instruction with recovery pending, then rolls back to the snapshot taken before it", async () => {
    await fixtures();
    const opted = store(OPT_IN);
    await mkdir(`${sb.kotor}/Override/locked`);
    await chmod(`${sb.kotor}/Override/locked`, 0o555);
    const failing = file([mod(1, { instructions: [instr("Delete", { source: ["<<kotorDirectory>>/Override/old.txt"] }), instr("Copy", { source: ["<<kotorDirectory>>/Override/keep.txt"], destination: "<<kotorDirectory>>/Override/locked" })] })]);
    let summary;
    try {
      summary = await new Installer(failing, sb.settings, { checkpoints: opted }).run({ physical: OPT_IN });
    } finally {
      await chmod(`${sb.kotor}/Override/locked`, 0o755);
    }
    expect(summary.error).toMatch(/failed/);
    expect(summary.recoveryPending).toBe(true);
    expect(await locks()).toEqual([]);
    await expect(readFile(`${sb.kotor}/Override/old.txt`)).rejects.toThrow();

    await expect(opted.startSession("next run")).rejects.toThrow(/requires recovery/);
    const [session] = await opted.list();
    await expect(opted.restore(session.id, session.checkpoints[0].id)).rejects.toThrow(/just before it/);
    await opted.restore(session.id, session.checkpoints[1].id);
    expect(await text(`${sb.kotor}/Override/keep.txt`)).toBe("keep");
    await expect(opted.startSession("next run")).resolves.toBeDefined();
  });
});

describe("physical checkpoint restore", () => {
  it("is refused by default, even for a store that recorded a physical install", async () => {
    await fixtures();
    await new Installer(guide(), sb.settings, { checkpoints: store(OPT_IN) }).run({ physical: OPT_IN });
    const plain = store();
    const [session] = await plain.list();
    await expect(plain.restore(session.id, session.checkpoints[0].id)).rejects.toThrow(/physical checkpoint restore is unavailable/);
    expect(await text(`${sb.kotor}/Override/renamed.txt`)).toBe("moved");
  });

  it("round-trips to the pre-install and post-install states with a verified, cleared restore intent", async () => {
    await fixtures();
    const opted = store(OPT_IN);
    await new Installer(guide(), sb.settings, { checkpoints: opted }).run({ physical: OPT_IN });
    const [session] = await opted.list();

    await opted.restore(session.id, session.checkpoints[0].id);
    expect(await text(`${sb.kotor}/Override/old.txt`)).toBe("old");
    expect(await text(`${sb.kotor}/Override/keep.txt`)).toBe("keep");
    await expect(readFile(`${sb.kotor}/Override/renamed.txt`)).rejects.toThrow();
    await expect(readFile(`${sb.kotor}/Override/extra/copy_me.txt`)).rejects.toThrow();
    expect(await opted.getRestoreIntent(session.id)).toBeUndefined();
    expect(await locks()).toEqual([]);

    await opted.restore(session.id, session.checkpoints[5].id);
    expect(await text(`${sb.kotor}/Override/renamed.txt`)).toBe("moved");
    expect(await text(`${sb.kotor}/Override/extra/copy_me.txt`)).toBe("copied");
    await expect(readFile(`${sb.kotor}/Override/old.txt`)).rejects.toThrow();
    expect(await opted.getRestoreIntent(session.id)).toBeUndefined();
  });

  it("restores a state that was modified outside the installer", async () => {
    await fixtures();
    const opted = store(OPT_IN);
    await new Installer(guide(), sb.settings, { checkpoints: opted }).run({ physical: OPT_IN });
    const [session] = await opted.list();
    await writeFile(`${sb.kotor}/Override/renamed.txt`, "tampered");
    await opted.restore(session.id, session.checkpoints[5].id);
    expect(await text(`${sb.kotor}/Override/renamed.txt`)).toBe("moved");
  });

  it("does not treat a failed patcher step as recoverable from checkpoints", async () => {
    await mkdir(`${sb.mods}/patch/tslpatchdata`, { recursive: true });
    await writeText(`${sb.mods}/patch/tslpatchdata/changes.ini`, "[Settings]");
    await writeText(`${sb.kotor}/Override/patched.txt`, "original");
    const opted = store(OPT_IN);
    const patcher = {
      install: async () => {
        await writeText(`${sb.kotor}/Override/patched.txt`, "half-patched");
        return { ok: false, warnings: [], errors: ["patch failed"], filesWritten: [`${sb.kotor}/Override/patched.txt`] };
      },
    };
    const summary = await new Installer(file([mod(1, { instructions: [instr("Patcher", { source: ["<<modDirectory>>/patch"] })] })]), sb.settings, { fs: new RealFileSystem(), checkpoints: opted, patcher }).run({ physical: OPT_IN });
    expect(summary.recoveryPending).toBe(true);
    const [session] = await opted.list();
    await expect(opted.restore(session.id, session.checkpoints[0].id)).rejects.toThrow(/no predicted paths/);
    await expect(opted.startSession("next run")).rejects.toThrow(/requires recovery/);
  });

  it("refuses restore past a patcher step whose pre-mutation files were never captured", async () => {
    await mkdir(`${sb.mods}/patch/tslpatchdata`, { recursive: true });
    await writeText(`${sb.mods}/patch/tslpatchdata/changes.ini`, "[Settings]");
    await writeText(`${sb.kotor}/Override/patched.txt`, "original");
    const fs = new RealFileSystem();
    const opted = store(OPT_IN);
    const patcher = {
      install: async () => {
        await writeText(`${sb.kotor}/Override/patched.txt`, "patched");
        return { ok: true, warnings: [], errors: [], filesWritten: [`${sb.kotor}/Override/patched.txt`] };
      },
    };
    const summary = await new Installer(file([mod(1, { instructions: [instr("Patcher", { source: ["<<modDirectory>>/patch"] })] })]), sb.settings, { fs, checkpoints: opted, patcher }).run({ physical: OPT_IN });
    expect(summary.succeeded).toBe(1);
    const [session] = await opted.list();
    await expect(opted.restore(session.id, session.checkpoints[0].id)).rejects.toThrow(/never captured/);
    await expect(opted.restore(session.id, session.checkpoints[0].id)).rejects.toBeInstanceOf(CheckpointError);
    expect(await text(`${sb.kotor}/Override/patched.txt`)).toBe("patched");
    expect(await opted.getRestoreIntent(session.id)).toBeUndefined();
  });
});
