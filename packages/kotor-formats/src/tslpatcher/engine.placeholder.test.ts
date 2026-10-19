import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Encapsulated, writeErf } from "../erf.js";
import { GffFieldType, addField, createGffRoot, writeGff } from "../gff.js";
import { ResourceTypes } from "../restypes.js";
import { parseChangesIni } from "./config.js";
import { TslPatcher } from "./engine.js";
import { NodePatcherFs } from "./nodeFs.js";

class PlaceholderNodeFs extends NodePatcherFs {
  readonly isVirtual = true;
}

let tmp: string;
let gameDir: string;
let dataDir: string;

function smallGff(fileType: string, tag: string): Uint8Array {
  const root = createGffRoot(fileType);
  addField(root.root, "Tag", GffFieldType.String, tag);
  return writeGff(root);
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "kotor-formats-placeholder-"));
  gameDir = path.join(tmp, "game");
  dataDir = path.join(tmp, "mod", "tslpatchdata");
  await fsp.mkdir(path.join(gameDir, "Override"), { recursive: true });
  await fsp.mkdir(path.join(gameDir, "Modules"), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function run(ini: string, fs: NodePatcherFs, dryRun: boolean) {
  return new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs, dryRun, backupDir: path.join(tmp, "backup") }).apply(parseChangesIni(ini));
}

const SKIPPED_THEN_PATCHED = [
  "[GFFList]",
  "File0=step_a.git",
  "File1=area_a.git",
  "[step_a.git]",
  "!SourceFile=shipped_a.git",
  "!SaveAs=area_a.git",
  "!ReplaceFile=1",
  "Tag=replaced",
  "[area_a.git]",
  "Creature List\\1\\XPosition=5.0",
].join("\n");

const STEP_B_ONLY = ["[GFFList]", "File0=area_a.git", "[area_a.git]", "Creature List\\1\\XPosition=5.0"].join("\n");

describe("placeholder-dependent content patches in a dry run", () => {
  describe("a field missing from a real game file whose replacement was skipped as a zero-byte placeholder", () => {
    beforeEach(async () => {
      await fsp.writeFile(path.join(gameDir, "Override", "area_a.git"), smallGff("GIT", "vanilla"));
      await fsp.writeFile(path.join(dataDir, "shipped_a.git"), new Uint8Array(0));
    });

    it("is unverified on a virtual dry run", async () => {
      const log = await run(SKIPPED_THEN_PATCHED, new PlaceholderNodeFs(), true);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(2);
      expect(log.unverified[0]).toMatch(/GFFList step_a\.git.*zero-byte virtual placeholder/);
      expect(log.unverified[1]).toMatch(/GFFList area_a\.git.*field "Creature List\/1\/XPosition" not found.*earlier step that could not be verified/);
      expect(log.filesWritten).toEqual([]);
    });

    it("still errors on a real-fs dry run", async () => {
      const log = await run(SKIPPED_THEN_PATCHED, new NodePatcherFs(), true);
      expect(log.unverified).toEqual([]);
      expect(log.errors.join("\n")).toMatch(/step_a\.git.*is empty \(0 bytes\)/);
      expect(log.errors.join("\n")).toMatch(/area_a\.git: field "Creature List\/1\/XPosition" not found/);
    });

    it("still errors on a real run", async () => {
      const log = await run(SKIPPED_THEN_PATCHED, new PlaceholderNodeFs(), false);
      expect(log.unverified).toEqual([]);
      expect(log.errors.join("\n")).toMatch(/area_a\.git: field "Creature List\/1\/XPosition" not found/);
    });
  });

  it("still errors for a genuinely missing field in a real file when nothing was skipped", async () => {
    await fsp.writeFile(path.join(gameDir, "Override", "area_a.git"), smallGff("GIT", "vanilla"));
    const log = await run(STEP_B_ONLY, new PlaceholderNodeFs(), true);
    expect(log.unverified).toEqual([]);
    expect(log.errors.join("\n")).toMatch(/area_a\.git: field "Creature List\/1\/XPosition" not found/);
  });

  it("still errors for a missing field in a real file when only an unrelated target was skipped", async () => {
    await fsp.writeFile(path.join(gameDir, "Override", "area_a.git"), smallGff("GIT", "vanilla"));
    await fsp.writeFile(path.join(gameDir, "Override", "other_a.git"), new Uint8Array(0));
    const ini = ["[GFFList]", "File0=other_a.git", "File1=area_a.git", "[other_a.git]", "Tag=x", "[area_a.git]", "Creature List\\1\\XPosition=5.0"].join("\n");
    const log = await run(ini, new PlaceholderNodeFs(), true);
    expect(log.unverified).toHaveLength(1);
    expect(log.errors.join("\n")).toMatch(/area_a\.git: field "Creature List\/1\/XPosition" not found/);
  });

  describe("a member missing from an archive", () => {
    const MEMBER_INI = [
      "[GFFList]",
      "File0=step_a.utc",
      "File1=npc_a.utc",
      "[step_a.utc]",
      "!Destination=Modules\\mod_a.mod",
      "!SourceFile=shipped_a.utc",
      "!SaveAs=npc_a.utc",
      "!ReplaceFile=1",
      "Tag=replaced",
      "[npc_a.utc]",
      "!Destination=Modules\\mod_a.mod",
      "Tag=patched",
    ].join("\n");

    beforeEach(async () => {
      const mod = new Encapsulated("MOD ");
      mod.set("area_a", ResourceTypes.are, smallGff("ARE", "area"));
      await fsp.writeFile(path.join(gameDir, "Modules", "mod_a.mod"), writeErf(mod));
      await fsp.writeFile(path.join(dataDir, "shipped_a.utc"), new Uint8Array(0));
    });

    it("is unverified when the member's creation was skipped as a zero-byte placeholder", async () => {
      const log = await run(MEMBER_INI, new PlaceholderNodeFs(), true);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(2);
      expect(log.unverified[1]).toMatch(/GFFList npc_a\.utc.*npc_a\.utc not found in .*mod_a\.mod/);
    });

    it("still errors on a real-fs dry run", async () => {
      const log = await run(MEMBER_INI, new NodePatcherFs(), true);
      expect(log.unverified).toEqual([]);
      expect(log.errors.join("\n")).toMatch(/npc_a\.utc not found in .*mod_a\.mod nor in tslpatchdata/);
    });

    it("still errors when the member is genuinely absent and nothing was skipped", async () => {
      const log = await run("[GFFList]\nFile0=npc_a.utc\n[npc_a.utc]\n!Destination=Modules\\mod_a.mod\nTag=patched", new PlaceholderNodeFs(), true);
      expect(log.unverified).toEqual([]);
      expect(log.errors.join("\n")).toMatch(/npc_a\.utc not found in .*mod_a\.mod nor in tslpatchdata/);
    });
  });

  describe("an archive absent from the virtual game that an earlier step creates", () => {
    const INI = [
      "[InstallList]",
      "install_folder0=Modules\\mod_a.mod",
      "[Modules\\mod_a.mod]",
      "File0=new_item.uti",
      "[GFFList]",
      "File0=npc_a.utc",
      "[npc_a.utc]",
      "!Destination=Modules\\mod_a.mod",
      "Tag=patched",
    ].join("\n");

    beforeEach(async () => {
      await fsp.writeFile(path.join(dataDir, "new_item.uti"), smallGff("UTI", "new_item"));
    });

    it("reports a member that cannot be checked as unverified on a virtual dry run", async () => {
      const log = await run(INI, new PlaceholderNodeFs(), true);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(2);
      expect(log.unverified[0]).toMatch(/mod_a\.mod.*absent from the virtual game/);
      expect(log.unverified[1]).toMatch(/npc_a\.utc cannot be read from Modules\/mod_a\.mod/);
    });

    it("keeps resources installed earlier in the same run visible", async () => {
      const ini = INI.replace("File0=npc_a.utc\n[npc_a.utc]", "File0=new_item.uti\n[new_item.uti]");
      const log = await run(ini, new PlaceholderNodeFs(), true);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(1);
    });

    it("keeps the empty-container warning and the error on a real-fs dry run", async () => {
      const log = await run(INI, new NodePatcherFs(), true);
      expect(log.unverified).toEqual([]);
      expect(log.warnings.join("\n")).toMatch(/mod_a\.mod does not exist; creating an empty MOD/);
      expect(log.errors.join("\n")).toMatch(/npc_a\.utc not found in .*mod_a\.mod nor in tslpatchdata/);
    });
  });
});
