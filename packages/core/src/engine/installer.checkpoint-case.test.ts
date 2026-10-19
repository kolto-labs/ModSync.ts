import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckpointStore } from "../checkpoints/store.js";
import { RealFileSystem } from "../fs/realFileSystem.js";
import type { PhysicalInstallOptIn } from "../fs/portableLock.js";
import { Installer } from "./installer.js";
import { file, instr, makeSandbox, mod, writeZip, type Sandbox } from "./testing.js";

const OPT_IN: PhysicalInstallOptIn = { ownership: "portable-lockfile" };

async function isCaseSensitive(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "modsync-case-probe-"));
  try {
    await writeFile(join(dir, "Probe.TMP"), "x");
    return await readFile(join(dir, "probe.tmp")).then(() => false, () => true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const caseSensitive = await isCaseSensitive();

describe.skipIf(!caseSensitive)("checkpointed install of loose files whose names differ only by case", () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await makeSandbox("modsync-case-");
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  const store = () => new CheckpointStore({ rootDir: `${sb.root}/checkpoints`, kotorDirectory: sb.kotor, fs: new RealFileSystem(), physicalRestore: OPT_IN });

  it("moves both packs into Override and records one tracked spelling per file", async () => {
    await writeZip(`${sb.mods}/Pack_One.zip`, { "Item_Alpha.tga": "from one", "Only_One.tga": "only one" });
    await writeZip(`${sb.mods}/Pack_Two.zip`, { "item_alpha.tga": "from two", "ONLY_TWO.tga": "only two" });
    const guide = file([
      mod(1, {
        name: "Example Pack One",
        instructions: [
          instr("Extract", { source: ["<<modDirectory>>/Pack_One*.zip"] }),
          instr("Move", { source: ["<<modDirectory>>/Pack_One*/*"], destination: "<<kotorDirectory>>/Override" }),
        ],
      }),
      mod(2, {
        name: "Example Pack Two",
        instructions: [
          instr("Extract", { source: ["<<modDirectory>>/Pack_Two*.zip"] }),
          instr("Move", { source: ["<<modDirectory>>/Pack_Two*/*"], destination: "<<kotorDirectory>>/Override" }),
        ],
      }),
    ]);

    const checkpoints = store();
    const summary = await new Installer(guide, sb.settings, { checkpoints }).run({ physical: OPT_IN });

    expect(summary.error).toBeUndefined();
    expect(summary.succeeded).toBe(2);
    expect((await readdir(`${sb.kotor}/Override`)).sort()).toEqual(["Item_Alpha.tga", "ONLY_TWO.tga", "Only_One.tga"]);
    expect(await readFile(`${sb.kotor}/Override/Item_Alpha.tga`, "utf8")).toBe("from two");

    const [session] = await checkpoints.list();
    expect(summary.checkpointSessionId).toBe(session.id);
    const state = await checkpoints.getState(session.id, session.checkpoints[session.checkpoints.length - 1].id);
    expect([...state.keys()].sort()).toEqual(["Override/Item_Alpha.tga", "Override/ONLY_TWO.tga", "Override/Only_One.tga"]);
    expect(session.pendingPublication).toBeUndefined();
  });
});
