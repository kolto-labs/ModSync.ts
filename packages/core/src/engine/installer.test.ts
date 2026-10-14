import { readFile, readdir } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckpointStore } from "../checkpoints/store.js";
import { RealFileSystem } from "../fs/realFileSystem.js";
import { InMemoryTelemetry } from "../logging/telemetry.js";
import type { CheckpointMeta, CheckpointSession, InstallEvent } from "../model/types.js";
import { Installer, type CheckpointSink } from "./installer.js";
import { G, file, instr, makeSandbox, mod, option, writeText, writeZip, type Sandbox } from "./testing.js";

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox("modsync-install-");
});
afterEach(async () => {
  await sb.cleanup();
});

function collect(installer: Installer): InstallEvent[] {
  const events: InstallEvent[] = [];
  installer.on("event", (e) => events.push(e));
  return events;
}

function twoModFile() {
  return file([
    mod(1, {
      name: "Alpha",
      instructions: [
        instr("Extract", { source: ["<<modDirectory>>/Alpha*.zip"] }),
        instr("Move", { source: ["<<modDirectory>>/Alpha*/Override/*"], destination: "<<kotorDirectory>>/Override" }),
      ],
    }),
    mod(2, {
      name: "Beta",
      installAfter: [G(1)],
      options: [option(21, { name: "Extra", instructions: [instr("Copy", { source: ["<<modDirectory>>/Beta/extra.txt"], destination: "<<kotorDirectory>>/Override" })] })],
      instructions: [instr("Choose", { source: ["<<modDirectory>>/Beta/*"], destination: "<<kotorDirectory>>/Override" })],
    }),
  ]);
}

async function twoModFixtures(): Promise<void> {
  await writeZip(`${sb.mods}/Alpha v2.zip`, { "Override/alpha.tpc": "alpha", "readme.txt": "r" });
  await writeText(`${sb.mods}/Beta/Low/beta.tpc`, "low");
  await writeText(`${sb.mods}/Beta/High/beta.tpc`, "high");
  await writeText(`${sb.mods}/Beta/extra.txt`, "extra");
}

describe("Installer", () => {
  it("runs two mods in order, answers a prompt programmatically and writes the game files", async () => {
    await twoModFixtures();
    const f = twoModFile();
    const telemetry = new InMemoryTelemetry();
    const installer = new Installer(f, sb.settings, { telemetry });
    const events = collect(installer);
    installer.on("event", (e) => {
      if (e.type === "prompt") {
        expect(installer.pendingPrompt?.id).toBe(e.prompt.id);
        const high = e.prompt.choices.find((c) => c.label === "High")!;
        setTimeout(() => installer.answerPrompt({ promptId: e.prompt.id, choiceId: high.id }), 0);
      }
    });
    const summary = await installer.run();
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.mods.map((m) => [m.modGuid, m.state])).toEqual([
      [G(1), "Installed"],
      [G(2), "Installed"],
    ]);
    expect(summary.mods[1].instructionResults.map((r) => [r.action, r.code, r.optionGuid])).toEqual([
      ["Choose", "Success", undefined],
      ["Copy", "Success", G(21)],
    ]);

    const types = events.map((e) => e.type).filter((t) => t !== "log");
    expect(types).toEqual([
      "install-started",
      "mod-started",
      "instruction-started",
      "instruction-finished",
      "instruction-started",
      "instruction-finished",
      "mod-finished",
      "mod-started",
      "instruction-started",
      "prompt",
      "instruction-finished",
      "instruction-started",
      "instruction-finished",
      "mod-finished",
      "install-finished",
    ]);
    const started = events.find((e) => e.type === "install-started");
    expect(started && started.type === "install-started" && started.order).toEqual([G(1), G(2)]);
    expect((await readdir(`${sb.kotor}/Override`)).sort()).toEqual(["alpha.tpc", "beta.tpc", "extra.txt"]);
    expect(await readFile(`${sb.kotor}/Override/beta.tpc`, "utf8")).toBe("high");
    expect(await readFile(`${sb.mods}/Alpha v2/readme.txt`, "utf8")).toBe("r");
    expect(f.mods.map((m) => m.installState)).toEqual(["Installed", "Installed"]);
    expect(telemetry.events().map((e) => e.operation)).toEqual(["instruction:Extract", "instruction:Move", "instruction:Choose", "instruction:Copy"]);
    expect(telemetry.events().every((e) => e.success)).toBe(true);
  });

  it("simulates Extract then Move against virtual files without changing either content root", async () => {
    await writeZip(`${sb.mods}/Dry.zip`, { "Override/a.txt": "new" });
    await writeText(`${sb.kotor}/Override/a.txt`, "original");
    const installer = new Installer(file([mod(1, { instructions: [
      instr("Extract", { source: ["<<modDirectory>>/Dry.zip"] }),
      instr("Move", { source: ["<<modDirectory>>/Dry/Override/*"], destination: "<<kotorDirectory>>/Override" }),
    ] })]), sb.settings);
    const summary = await installer.run({ dryRun: true });
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.mods[0].instructionResults.map((result) => result.code)).toEqual(["Success", "Success"]);
    expect(await readFile(`${sb.kotor}/Override/a.txt`, "utf8")).toBe("original");
    expect(await new RealFileSystem().exists(`${sb.mods}/Dry`)).toBe(false);
    expect((await readdir(sb.mods)).sort()).toEqual(["Dry.zip"]);
  });

  it("fails fast on constraint errors and skips mods whose runtime dependencies are unknown", async () => {
    const bad = file([mod(1, { dependencies: [G(2)] }), mod(2, { isSelected: false })]);
    const installer = new Installer(bad, sb.settings);
    const events = collect(installer);
    const summary = await installer.run();
    expect(events.map((e) => e.type)).toEqual(["install-error", "install-finished"]);
    expect(summary.mods).toEqual([]);

    const skip = file([mod(1, { dependencies: [G(99)], instructions: [instr("Delete", { source: ["<<kotorDirectory>>/x"] })] }), mod(2)]);
    const installer2 = new Installer(skip, sb.settings);
    const events2 = collect(installer2);
    const summary2 = await installer2.run();
    expect(summary2.skipped).toBe(1);
    expect(summary2.succeeded).toBe(1);
    expect(summary2.mods[0].state).toBe("Skipped");
    expect(events2.filter((e) => e.type === "mod-started")).toHaveLength(1);
  });

  it("stops the guide at the first failed mod without executing later mods", async () => {
    const f = file([
      mod(1, {
        instructions: [
          instr("Extract", { source: ["<<modDirectory>>/missing.zip"] }),
          instr("Delete", { guid: G(90), source: ["<<kotorDirectory>>/never.txt"] }),
        ],
      }),
      mod(2, { instructions: [instr("Delete", { source: ["<<kotorDirectory>>/nothing.txt"] })] }),
    ]);
    const installer = new Installer(f, sb.settings);
    const summary = await installer.run();
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.mods).toHaveLength(1);
    expect(summary.mods[0].instructionResults.map((r) => r.code)).toEqual(["FileNotFoundPre"]);
  });

  it("filters by phase and by modGuids", async () => {
    const f = file([mod(1, { instructions: [instr("Delete", { source: ["<<kotorDirectory>>/a"] })] }), mod(2, { isWidescreen: true }), mod(3)]);
    const base = await new Installer(f, sb.settings).run();
    expect(base.mods.map((m) => m.modGuid)).toEqual([G(1), G(3)]);
    const ws = await new Installer(f, sb.settings).run({ phase: "widescreen" });
    expect(ws.mods.map((m) => m.modGuid)).toEqual([G(2)]);
    const only = await new Installer(f, sb.settings).run({ modGuids: [G(3)] });
    expect(only.mods.map((m) => m.modGuid)).toEqual([G(3)]);
  });

  it("cancels while waiting on a prompt", async () => {
    await twoModFixtures();
    const installer = new Installer(twoModFile(), sb.settings);
    const events = collect(installer);
    installer.on("event", (e) => {
      if (e.type === "prompt") setTimeout(() => installer.cancel(), 0);
    });
    const summary = await installer.run();
    const types = events.map((e) => e.type);
    expect(types).toContain("install-cancelled");
    expect(types.indexOf("install-cancelled")).toBeLessThan(types.indexOf("install-finished"));
    expect(summary.mods[0].state).toBe("Installed");
    expect(summary.mods[1].state).toBe("Failed");
    expect(summary.mods[1].instructionResults[0].code).toBe("UserCancelled");
    expect(installer.running).toBe(false);
    expect((await readdir(`${sb.kotor}/Override`)).sort()).toEqual(["alpha.tpc"]);
  });

  it("cancels a running external program and stops before the next mod", async () => {
    if (process.platform === "win32") return;
    const { mkdir, copyFile } = await import("node:fs/promises");
    await mkdir(`${sb.mods}/tool`, { recursive: true });
    await copyFile(process.execPath, `${sb.mods}/tool/node`);
    const f = file([
      mod(1, { instructions: [instr("Execute", { source: ["<<modDirectory>>/tool/node"], arguments: `-e "setTimeout(() => {}, 20000)"` })] }),
      mod(2, { instructions: [instr("Delete", { source: ["<<kotorDirectory>>/x"] })] }),
    ]);
    const installer = new Installer(f, sb.settings);
    const events = collect(installer);
    installer.on("event", (e) => {
      if (e.type === "instruction-started") setTimeout(() => installer.cancel(), 200);
    });
    const started = Date.now();
    const summary = await installer.run();
    expect(Date.now() - started).toBeLessThan(15000);
    expect(summary.mods).toHaveLength(1);
    expect(summary.mods[0].instructionResults[0].code).toBe("UserCancelled");
    expect(events.map((e) => e.type)).toContain("install-cancelled");
  });

  it("snapshots files before each instruction and creates a checkpoint after it", async () => {
    await writeText(`${sb.kotor}/Override/alpha.tpc`, "original");
    await writeZip(`${sb.mods}/Alpha v2.zip`, { "Override/alpha.tpc": "alpha" });
    const f = file([
      mod(1, {
        instructions: [
          instr("Extract", { source: ["<<modDirectory>>/Alpha*.zip"] }),
          instr("Move", { source: ["<<modDirectory>>/Alpha*/Override/*"], destination: "<<kotorDirectory>>/Override" }),
        ],
      }),
    ]);
    const calls: Array<{ kind: string; paths: string[] }> = [];
    const session: CheckpointSession = { id: "s1", kotorDirectory: sb.kotor, createdAt: "", anchorInterval: 10, checkpoints: [] };
    let index = 0;
    const sink: CheckpointSink = {
      startSession: async () => session,
      beforeTouch: async (_s, paths) => {
        calls.push({ kind: "before", paths });
        return paths.length;
      },
      create: async (_s, meta) => {
        calls.push({ kind: "create", paths: meta.touched });
        index++;
        const m: CheckpointMeta = { id: `s1-${index}`, sessionId: "s1", index, isAnchor: index % 10 === 0, createdAt: "", label: meta.label, changedCount: 0, storedBytes: 0 };
        return m;
      },
    };
    const installer = new Installer(f, sb.settings, { checkpoints: sink });
    const events = collect(installer);
    const summary = await installer.run();
    expect(summary.checkpointSessionId).toBe("s1");
    expect(calls.map((c) => c.kind)).toEqual(["before", "create", "before", "create"]);
    expect(calls[2].paths).toContain(`${sb.kotor}/Override/alpha.tpc`);
    expect(calls[3].paths).toContain(`${sb.kotor}/Override/alpha.tpc`);
    expect(events.filter((e) => e.type === "checkpoint-created")).toHaveLength(2);
    expect(summary.mods[0].instructionResults.map((r) => r.checkpointId)).toEqual(["s1-1", "s1-2"]);
  });

  it("reports preflight failure through a failed summary and terminal events", async () => {
    const installer = new Installer(file([mod(1, { dependencies: [G(2)] }), mod(2, { isSelected: false })]), sb.settings);
    const events = collect(installer);
    const summary = await installer.run();
    expect(summary.failed).toBeGreaterThan(0);
    expect(summary.succeeded).toBe(0);
    expect(events.map((event) => event.type)).toContain("install-error");
    expect(events.at(-1)?.type).toBe("install-finished");
    expect(installer.running).toBe(false);
  });

  it("refuses to install when the requested checkpoint session cannot be created", async () => {
    const path = `${sb.kotor}/Override/keep.txt`;
    await writeText(path, "original");
    const installer = new Installer(file([mod(1, { instructions: [instr("Delete", { source: ["<<kotorDirectory>>/Override/keep.txt"] })] })]), sb.settings, {
      checkpoints: {
        startSession: async () => { throw new Error("disk full"); },
        beforeTouch: async () => { throw new Error("unexpected beforeTouch"); },
        create: async () => { throw new Error("unexpected create"); },
      },
    });
    const events = collect(installer);
    expect((await installer.run()).failed).toBe(1);
    expect(await readFile(path, "utf8")).toBe("original");
    expect(events.some((event) => event.type === "install-error" && event.message.includes("session creation failed"))).toBe(true);
    expect(events.at(-1)?.type).toBe("install-finished");
  });

  it("stops subsequent instructions and mods when checkpoint persistence fails", async () => {
    const first = `${sb.kotor}/Override/first.txt`;
    const second = `${sb.kotor}/Override/second.txt`;
    const third = `${sb.kotor}/Override/third.txt`;
    for (const path of [first, second, third]) await writeText(path, "original");
    const session: CheckpointSession = { id: "session", kotorDirectory: sb.kotor, createdAt: "", anchorInterval: 10, checkpoints: [] };
    const installer = new Installer(file([
      mod(1, { instructions: [instr("Delete", { source: ["<<kotorDirectory>>/Override/first.txt"] }), instr("Delete", { source: ["<<kotorDirectory>>/Override/second.txt"] })] }),
      mod(2, { instructions: [instr("Delete", { source: ["<<kotorDirectory>>/Override/third.txt"] })] }),
    ]), sb.settings, { checkpoints: {
      startSession: async () => session,
      beforeTouch: async () => 1,
      create: async () => { throw new Error("disk full"); },
    } });
    const events = collect(installer);
    const summary = await installer.run();
    expect(summary.failed).toBe(1);
    expect(summary.mods).toHaveLength(1);
    expect(summary.mods[0].instructionResults[0].message).toContain("persistence failed");
    expect(await new RealFileSystem().exists(first)).toBe(false);
    expect(await readFile(second, "utf8")).toBe("original");
    expect(await readFile(third, "utf8")).toBe("original");
    expect(events.map((event) => event.type)).toContain("install-error");
    expect(events.at(-1)?.type).toBe("install-finished");
  });

  it("does not execute an instruction when its checkpoint baseline cannot be captured", async () => {
    const path = `${sb.kotor}/Override/keep.txt`;
    await writeText(path, "original");
    const session: CheckpointSession = { id: "session", kotorDirectory: sb.kotor, createdAt: "", anchorInterval: 10, checkpoints: [] };
    const installer = new Installer(file([mod(1, { instructions: [instr("Delete", { source: ["<<kotorDirectory>>/Override/keep.txt"] })] })]), sb.settings, {
      checkpoints: {
        startSession: async () => session,
        beforeTouch: async () => { throw new Error("disk full"); },
        create: async () => { throw new Error("must not create a checkpoint"); },
      },
    });
    const summary = await installer.run();
    expect(summary.failed).toBe(1);
    expect(summary.mods[0].instructionResults[0].message).toContain("not executed");
    expect(await readFile(path, "utf8")).toBe("original");
  });

  it("restores opaque patcher changes including overwritten, deleted, and new files", async () => {
    await writeText(`${sb.mods}/patch/tslpatchdata/changes.ini`, "[Settings]");
    await writeText(`${sb.kotor}/Override/old.txt`, "original");
    await writeText(`${sb.kotor}/Override/deleted.txt`, "keep");
    const fs = new RealFileSystem();
    const store = new CheckpointStore({ rootDir: `${sb.root}/checkpoints`, kotorDirectory: sb.kotor, fs });
    const installer = new Installer(file([mod(1, { instructions: [instr("Patcher", { source: ["<<modDirectory>>/patch"] })] })]), sb.settings, {
      fs,
      checkpoints: store,
      patcher: { install: async () => {
        await writeText(`${sb.kotor}/Override/old.txt`, "patched");
        await fs.remove(`${sb.kotor}/Override/deleted.txt`);
        await writeText(`${sb.kotor}/Override/new.txt`, "new");
        return { ok: true, warnings: [], errors: [], filesWritten: [`${sb.kotor}/Override/old.txt`, `${sb.kotor}/Override/new.txt`] };
      } },
    });
    expect((await installer.run()).succeeded).toBe(1);
    const [session] = await store.list();
    await store.restore(session.id, session.checkpoints[0].id);
    expect(await readFile(`${sb.kotor}/Override/old.txt`, "utf8")).toBe("original");
    expect(await readFile(`${sb.kotor}/Override/deleted.txt`, "utf8")).toBe("keep");
    expect(await fs.exists(`${sb.kotor}/Override/new.txt`)).toBe(false);
    await store.restore(session.id, session.checkpoints[1].id);
    expect(await readFile(`${sb.kotor}/Override/old.txt`, "utf8")).toBe("patched");
    expect(await fs.exists(`${sb.kotor}/Override/deleted.txt`)).toBe(false);
    expect(await readFile(`${sb.kotor}/Override/new.txt`, "utf8")).toBe("new");
  });

  it("can roll back a cancelled extraction including newly created partial files", async () => {
    await writeZip(`${sb.mods}/Partial.zip`, { "new.txt": "archive value" });
    const fs = new RealFileSystem();
    const store = new CheckpointStore({ rootDir: `${sb.root}/checkpoints`, kotorDirectory: sb.kotor, fs });
    const open = await import("../archive/index.js");
    const installer = new Installer(file([mod(1, { instructions: [instr("Extract", {
      source: ["<<modDirectory>>/Partial.zip"], destination: "<<kotorDirectory>>/Override",
    })] })]), sb.settings, { fs, checkpoints: store, openArchive: async (path, options) => {
      const reader = await open.openArchive(path, options);
      reader.extract = async (dest) => {
        await writeText(`${dest}/new.txt`, "partial");
        installer.cancel();
        throw new DOMException("Cancelled", "AbortError");
      };
      return reader;
    } });
    const summary = await installer.run();
    expect(summary.failed).toBe(1);
    expect(await readFile(`${sb.kotor}/Override/new.txt`, "utf8")).toBe("partial");
    const [session] = await store.list();
    await store.restore(session.id, session.checkpoints[0].id);
    expect(await fs.exists(`${sb.kotor}/Override/new.txt`)).toBe(false);
  });

  it("works with the real CheckpointStore", async () => {
    await writeText(`${sb.kotor}/Override/keep.tpc`, "original");
    await writeText(`${sb.mods}/m/keep.tpc`, "replaced");
    const f = file([mod(1, { instructions: [instr("Move", { source: ["<<modDirectory>>/m/*"], destination: "<<kotorDirectory>>/Override" })] })]);
    const store = new CheckpointStore({ rootDir: `${sb.root}/checkpoints`, kotorDirectory: sb.kotor, fs: new RealFileSystem() });
    const installer = new Installer(f, sb.settings, { checkpoints: store });
    const summary = await installer.run();
    expect(summary.succeeded).toBe(1);
    expect(await readFile(`${sb.kotor}/Override/keep.tpc`, "utf8")).toBe("replaced");
    const sessions = await store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].checkpoints).toHaveLength(2);
    await store.restore(sessions[0].id, sessions[0].checkpoints[0].id);
    expect(await readFile(`${sb.kotor}/Override/keep.tpc`, "utf8")).toBe("original");
  });
});
