import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Encapsulated, readEncapsulated, writeErf, writeRim } from "../erf.js";
import { GffFieldType, type GffLocString, type GffStruct, addField, createGffRoot, createGffStruct, createLocString, getFieldByPath, getStructByPath, readGff, writeGff } from "../gff.js";
import { ResourceTypes } from "../restypes.js";
import { createSsf, readSsf, writeSsf } from "../ssf.js";
import { Tlk, readTlk, writeTlk } from "../tlk.js";
import { TwoDA, read2da, write2da } from "../twoda.js";
import { PatcherConfigError, parseChangesIni } from "./config.js";
import { REMOVE_FILES_LIST, TslPatcher } from "./engine.js";
import { NodePatcherFs } from "./nodeFs.js";

const CHANGES = `
[Settings]
WindowCaption=Engine test
BackupFiles=1

[TLKList]
StrRef0=0
StrRef1=1

[InstallList]
install_folder0=Override
install_folder1=Modules\\test.mod

[Override]
File0=new_item.uti

[Modules\\test.mod]
Replace0=m_area.are

[2DAList]
Table0=spells.2da

[spells.2da]
AddRow0=spells_new
ChangeRow0=spells_fix
AddColumn0=spells_col

[spells_new]
ExclusiveColumn=label
label=FORCE_NEW
name=StrRef1
forbiditemmask=high()
2DAMEMORY0=RowIndex

[spells_fix]
LabelIndex=FORCE_PUSH
name=StrRef0

[spells_col]
ColumnLabel=newcol
DefaultValue=****
I0=5
L1=6
2DAMEMORY1=I0

[GFFList]
File0=p_test.utc

[p_test.utc]
!SaveAs=p_test_new.utc
FirstName(strref)=StrRef1
FirstName(lang0)=Renamed
AddField0=add_feat

[add_feat]
FieldType=Struct
Path=FeatList
Label=
TypeId=1
2DAMEMORY2=ListIndex
AddField0=add_feat_id

[add_feat_id]
FieldType=Word
Label=Feat
Value=2DAMEMORY0

[CompileList]
File0=present.nss

[HACKList]
File0=hack.ncs

[hack.ncs]
8=StrRef0

[SSFList]
File0=p_test.ssf

[p_test.ssf]
Battlecry 1=StrRef0
`;

let tmp: string;
let gameDir: string;
let modDir: string;
let dataDir: string;

function smallGff(fileType: string, tag: string): Uint8Array {
  const root = createGffRoot(fileType);
  addField(root.root, "Tag", GffFieldType.String, tag);
  return writeGff(root);
}

async function buildFixture(): Promise<void> {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "kotor-formats-engine-"));
  gameDir = path.join(tmp, "game");
  modDir = path.join(tmp, "mod");
  dataDir = path.join(modDir, "tslpatchdata");
  await fsp.mkdir(path.join(gameDir, "Override"), { recursive: true });
  await fsp.mkdir(path.join(gameDir, "Modules"), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });

  const dialog = new Tlk(0);
  dialog.add("Zero");
  dialog.add("One");
  dialog.add("Two");
  await fsp.writeFile(path.join(gameDir, "dialog.tlk"), writeTlk(dialog));

  const spells = new TwoDA(["label", "name", "forbiditemmask"]);
  spells.addRow("0", { label: "FORCE_PUSH", name: "100", forbiditemmask: "3" });
  spells.addRow("1", { label: "FORCE_WAVE", name: "101", forbiditemmask: "5" });
  await fsp.writeFile(path.join(gameDir, "Override", "spells.2da"), write2da(spells));

  const utc = createGffRoot("UTC");
  addField(utc.root, "FirstName", GffFieldType.LocString, createLocString(5, [[0, "Test"]]));
  const feat = createGffStruct(1);
  addField(feat, "Feat", GffFieldType.Word, 1);
  addField(utc.root, "FeatList", GffFieldType.List, [feat]);
  addField(utc.root, "Tag", GffFieldType.String, "p_test");
  await fsp.writeFile(path.join(gameDir, "Override", "p_test.utc"), writeGff(utc));

  const mod = new Encapsulated("MOD ");
  mod.set("m_area", ResourceTypes.are, smallGff("ARE", "original"));
  mod.set("other", ResourceTypes.git, smallGff("GIT", "keep"));
  await fsp.writeFile(path.join(gameDir, "Modules", "test.mod"), writeErf(mod));

  const append = new Tlk(0);
  append.add("New Zero");
  append.add("New One", "n_new_001", 2.5);
  await fsp.writeFile(path.join(dataDir, "append.tlk"), writeTlk(append));
  await fsp.writeFile(path.join(dataDir, "new_item.uti"), smallGff("UTI", "new_item"));
  await fsp.writeFile(path.join(dataDir, "m_area.are"), smallGff("ARE", "replaced"));
  await fsp.writeFile(path.join(dataDir, "p_test.ssf"), writeSsf(createSsf()));
  await fsp.writeFile(path.join(dataDir, "hack.ncs"), Uint8Array.from([0x4e, 0x43, 0x53, 0x20, 0x56, 0x31, 0x2e, 0x30, 0x42, 0x00, 0x00, 0x00, 0x10]));
  await fsp.writeFile(path.join(dataDir, "present.ncs"), Uint8Array.from([1, 2, 3]));
  await fsp.writeFile(path.join(dataDir, "changes.ini"), CHANGES);
}

beforeEach(buildFixture);
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

class PlaceholderNodeFs extends NodePatcherFs {
  readonly isVirtual = true;
}

describe("TslPatcher", () => {
  it("applies every list section to a synthetic game directory", async () => {
    const backupDir = path.join(modDir, "backup", "run1");
    const patcher = new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), backupDir });
    const log = await patcher.apply(parseChangesIni(CHANGES));
    expect(log.errors).toEqual([]);

    // TLK
    const dialog = readTlk(await fsp.readFile(path.join(gameDir, "dialog.tlk")));
    expect(dialog.entries.map((e) => e.text)).toEqual(["Zero", "One", "Two", "New Zero", "New One"]);
    expect(dialog.entries[4]!.soundResRef).toBe("n_new_001");
    expect(dialog.entries[4]!.soundLength).toBe(2.5);
    expect(patcher.memory.getStrRef(0)).toBe(3);
    expect(patcher.memory.getStrRef(1)).toBe(4);

    // InstallList
    const uti = readGff(await fsp.readFile(path.join(gameDir, "Override", "new_item.uti")));
    expect(getFieldByPath(uti, "Tag")?.value).toBe("new_item");
    const mod = readEncapsulated(await fsp.readFile(path.join(gameDir, "Modules", "test.mod")));
    expect(mod.fileType).toBe("MOD ");
    expect(mod.resources).toHaveLength(2);
    expect(getFieldByPath(readGff(mod.get("m_area", ResourceTypes.are)!.data), "Tag")?.value).toBe("replaced");
    expect(getFieldByPath(readGff(mod.get("other", ResourceTypes.git)!.data), "Tag")?.value).toBe("keep");

    // 2DA
    const spells = read2da(await fsp.readFile(path.join(gameDir, "Override", "spells.2da")));
    expect(spells.columns).toEqual(["label", "name", "forbiditemmask", "newcol"]);
    expect(spells.height).toBe(3);
    expect(spells.rows[2]!.label).toBe("2");
    expect(spells.getCell(2, "label")).toBe("FORCE_NEW");
    expect(spells.getCell(2, "name")).toBe("4");
    expect(spells.getCell(2, "forbiditemmask")).toBe("6");
    expect(spells.getCell(0, "name")).toBe("3");
    expect(spells.getCell(0, "newcol")).toBe("5");
    expect(spells.getCell(1, "newcol")).toBe("6");
    expect(spells.getCell(2, "newcol")).toBe("****");
    expect(patcher.memory.get2da(0)).toBe("2");
    expect(patcher.memory.get2da(1)).toBe("5");

    // GFF (saved under !SaveAs, original untouched)
    const utc = readGff(await fsp.readFile(path.join(gameDir, "Override", "p_test_new.utc")));
    const name = getFieldByPath(utc, "FirstName")!.value as GffLocString;
    expect(name.strref).toBe(4);
    expect(name.substrings.get(0)).toBe("Renamed");
    const feats = getFieldByPath(utc, "FeatList")!.value as GffStruct[];
    expect(feats).toHaveLength(2);
    expect(feats[1]!.id).toBe(1);
    expect(getFieldByPath(utc, "FeatList/1/Feat")).toEqual({ type: GffFieldType.Word, value: 2 });
    expect(patcher.memory.get2da(2)).toBe("1");
    const original = readGff(await fsp.readFile(path.join(gameDir, "Override", "p_test.utc")));
    expect((getFieldByPath(original, "FirstName")!.value as GffLocString).strref).toBe(5);

    // CompileList

    expect(log.warnings.some((w) => /compiled from precompiled ncs/.test(w) && /present\.nss/.test(w))).toBe(true);
    expect(Array.from(await fsp.readFile(path.join(gameDir, "Override", "present.ncs")))).toEqual([1, 2, 3]);

    // HACKList: u16 big-endian StrRef0 (=3) at offset 8
    const ncs = await fsp.readFile(path.join(gameDir, "Override", "hack.ncs"));
    expect(Array.from(ncs.subarray(8, 10))).toEqual([0x00, 0x03]);
    expect(ncs[12]).toBe(0x10);

    // SSF
    const ssf = readSsf(await fsp.readFile(path.join(gameDir, "Override", "p_test.ssf")));
    expect(ssf.sounds[0]).toBe(3);
    expect(ssf.sounds[1]).toBe(-1);

    // Backups
    expect(log.backupDir).toBe(backupDir);
    expect(log.filesBackedUp.sort()).toEqual(
      [path.join(gameDir, "dialog.tlk"), path.join(gameDir, "Modules", "test.mod"), path.join(gameDir, "Override", "spells.2da")].sort(),
    );
    const backedTlk = readTlk(await fsp.readFile(path.join(backupDir, "dialog.tlk")));
    expect(backedTlk.entries).toHaveLength(3);
    const backed2da = read2da(await fsp.readFile(path.join(backupDir, "Override", "spells.2da")));
    expect(backed2da.height).toBe(2);
    const removeList = (await fsp.readFile(path.join(backupDir, REMOVE_FILES_LIST), "latin1")).trim().split("\n").sort();
    expect(removeList).toEqual(
      [
        path.join(gameDir, "Override", "new_item.uti"),
        path.join(gameDir, "Override", "p_test_new.utc"),
        path.join(gameDir, "Override", "present.ncs"),
        path.join(gameDir, "Override", "hack.ncs"),
        path.join(gameDir, "Override", "p_test.ssf"),
      ].sort(),
    );
    expect(log.filesWritten).toHaveLength(8);
  });

  it("is idempotent for ExclusiveColumn rows and skips existing File<N> installs", async () => {
    const fs = new NodePatcherFs();
    await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs, backupDir: path.join(modDir, "b1") }).apply(parseChangesIni(CHANGES));
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs, backupDir: path.join(modDir, "b2") }).apply(parseChangesIni(CHANGES));
    expect(log.errors).toEqual([]);
    expect(log.warnings.some((w) => /new_item\.uti already exists/.test(w))).toBe(true);
    expect(log.warnings.some((w) => /column "newcol" already exists/.test(w))).toBe(true);
    const spells = read2da(await fsp.readFile(path.join(gameDir, "Override", "spells.2da")));
    expect(spells.height).toBe(3);
    expect(spells.getCell(2, "name")).toBe("6"); // StrRef1 of the second run
    expect(log.errors.length).toBe(0);
  });

  it("resolves game paths case-insensitively", async () => {
    await fsp.rename(path.join(gameDir, "Override"), path.join(gameDir, "override"));
    await fsp.rename(path.join(gameDir, "dialog.tlk"), path.join(gameDir, "DIALOG.TLK"));
    const patcher = new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), backupDir: path.join(modDir, "b") });
    const log = await patcher.apply(parseChangesIni(CHANGES));
    expect(log.errors).toEqual([]);
    expect(await fsp.readdir(gameDir)).not.toContain("Override");
    expect(await fsp.readdir(path.join(gameDir, "override"))).toContain("p_test_new.utc");
    expect(readTlk(await fsp.readFile(path.join(gameDir, "DIALOG.TLK"))).entries).toHaveLength(5);
  });

  it.each(["../outside", "/outside", "C:\\outside", "Modules/../../outside"])("rejects destination escaping the game: %s", async (destination) => {
    const config = parseChangesIni(`[InstallList]\ninstall_folder0=${destination}\n[${destination}]\nReplace0=new_item.uti`);
    const patcher = new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() });
    const log = await patcher.apply(config);
    expect(log.errors.join("\n")).toMatch(/must stay within/);
    expect(log.filesWritten).toEqual([]);
  });

  it("rejects a destination directory symlink outside the game", async () => {
    await fsp.symlink(modDir, path.join(gameDir, "linked"), "dir");
    const config = parseChangesIni(`[InstallList]\ninstall_folder0=linked\n[linked]\nReplace0=new_item.uti`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(config);
    expect(log.errors.join("\n")).toMatch(/symbolic link/);
    expect(log.filesWritten).toEqual([]);
    expect(await new NodePatcherFs().exists(path.join(modDir, "new_item.uti"))).toBe(false);
  });

  it("rejects a destination file symlink outside the game", async () => {
    const outside = path.join(modDir, "outside.uti");
    await fsp.writeFile(outside, "untouched");
    await fsp.symlink(outside, path.join(gameDir, "Override", "new_item.uti"));
    const config = parseChangesIni(`[InstallList]\ninstall_folder0=Override\n[Override]\nReplace0=new_item.uti`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(config);
    expect(log.errors.join("\n")).toMatch(/symbolic link/);
    expect(await fsp.readFile(outside, "utf8")).toBe("untouched");
  });

  it("rejects a source file symlink outside tslpatchdata", async () => {
    await fsp.symlink(path.join(gameDir, "dialog.tlk"), path.join(dataDir, "linked.tlk"));
    const config = parseChangesIni(`[InstallList]\ninstall_folder0=Override\n[Override]\nReplace0=linked.tlk`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(config);
    expect(log.errors.join("\n")).toMatch(/symbolic link/);
    expect(log.filesWritten).toEqual([]);
  });

  it("rejects a source folder escaping tslpatchdata", async () => {
    const config = parseChangesIni(`[InstallList]\ninstall_folder0=Override\n[Override]\nReplace0=new_item.uti\n[new_item.uti]\n!SourceFolder=..`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(config);
    expect(log.errors.join("\n")).toMatch(/must stay within/);
    expect(log.filesWritten).toEqual([]);
  });

  it("dry run resolves new files case-insensitively across sections", async () => {
    const config = parseChangesIni(`[InstallList]\ninstall_folder0=NewFolder\n[NewFolder]\nReplace0=new_item.uti\n[GFFList]\nFile0=NEW_ITEM.UTI\n[NEW_ITEM.UTI]\n!Destination=NewFolder\nTag=patched`);
    config.gff[0]!.destination = "newfolder";
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), dryRun: true }).apply(config);
    expect(log.errors).toEqual([]);
    expect(log.filesWritten).toEqual([path.join(gameDir, "NewFolder", "new_item.uti")]);
    expect(await new NodePatcherFs().exists(path.join(gameDir, "NewFolder"))).toBe(false);
  });

  it("reports unavailable source compilation as an error", async () => {
    const config = parseChangesIni(`[CompileList]\nFile0=missing.nss`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(config);
    expect(log.errors.join("\n")).toMatch(/requires a compiler or precompiled/);
    expect(log.filesWritten).toEqual([]);
  });

  it("dry run records a source script without a compiler or precompiled binary as unverified", async () => {
    await fsp.writeFile(path.join(dataDir, "uncompiled.nss"), "void main() { }");
    const config = parseChangesIni(`[CompileList]\nFile0=uncompiled.nss`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), dryRun: true }).apply(config);
    expect(log.errors).toEqual([]);
    expect(log.unverified).toHaveLength(1);
    expect(log.unverified[0]).toMatch(/uncompiled\.nss.*compilation not verified/);
    expect(log.infos.some((line) => /uncompiled\.nss/.test(line))).toBe(true);
    expect(log.filesWritten).toEqual([]);
  });

  it("real run still fails on a source script without a compiler or precompiled binary", async () => {
    await fsp.writeFile(path.join(dataDir, "uncompiled.nss"), "void main() { }");
    const config = parseChangesIni(`[CompileList]\nFile0=uncompiled.nss`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(config);
    expect(log.errors.join("\n")).toMatch(/script compilation unavailable: uncompiled\.nss/);
    expect(log.unverified).toEqual([]);
    expect(log.filesWritten).toEqual([]);
  });

  it("dry run still errors when neither a script source nor a precompiled binary exists", async () => {
    const config = parseChangesIni(`[CompileList]\nFile0=missing.nss`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), dryRun: true }).apply(config);
    expect(log.errors.join("\n")).toMatch(/requires a compiler or precompiled/);
  });

  it("rejects a precompiled binary when source memory substitutions require compilation", async () => {
    await fsp.writeFile(path.join(dataDir, "present.nss"), "void main() { int ref = #StrRef0#; }");
    const config = parseChangesIni(`[CompileList]\nFile0=present.nss`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(config);
    expect(log.errors.join("\n")).toMatch(/requiring source compilation/);
    expect(log.filesWritten).toEqual([]);
  });

  it("keeps existing precompiled scripts unless replacement is requested", async () => {
    const target = path.join(gameDir, "Override", "present.ncs");
    await fsp.writeFile(target, Uint8Array.from([9, 8, 7]));
    const config = parseChangesIni(`[CompileList]\nFile0=present.nss`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(config);
    expect(log.errors).toEqual([]);
    expect(Array.from(await fsp.readFile(target))).toEqual([9, 8, 7]);
    expect(log.filesWritten).toEqual([]);
    config.compile[0]!.replaceFile = true;
    await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(config);
    expect(Array.from(await fsp.readFile(target))).toEqual([1, 2, 3]);
  });

  it("dry run reads and resolves everything but writes nothing", async () => {
    const before = await snapshot(tmp);
    const patcher = new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), dryRun: true, backupDir: path.join(modDir, "backup") });
    const log = await patcher.apply(parseChangesIni(CHANGES));
    expect(log.errors).toEqual([]);
    expect(log.filesWritten).toHaveLength(8);
    expect(log.filesBackedUp).toEqual([]);
    expect(log.backupDir).toBeUndefined();
    expect(patcher.memory.getStrRef(1)).toBe(4);
    expect(patcher.memory.get2da(0)).toBe("2");
    expect(await snapshot(tmp)).toEqual(before);
  });

  it("copies and assigns 2DAMEMORY tokens inside GFF and 2DA sections", async () => {
    const ini = [
      "[2DAList]",
      "File0=spells.2da",
      "[spells.2da]",
      "ChangeRow0=c",
      "[c]",
      "RowIndex=0",
      "2DAMEMORY21=RowIndex",
      "2DAMEMORY22=2DAMEMORY21",
      "[GFFList]",
      "File0=p_test.utc",
      "[p_test.utc]",
      "AddField0=src",
      "AddField1=dst",
      "AddField2=item",
      "2DAMEMORY2=2DAMEMORY1",
      "2DAMEMORY3=2DAMEMORY1",
      "2DAMEMORY9=2DAMEMORY8",
      "2DAMEMORY1=9",
      "[src]",
      "FieldType=Word",
      "Label=SrcVal",
      "Value=7",
      "2DAMEMORY1=!FieldPath",
      "[dst]",
      "FieldType=Word",
      "Label=DstVal",
      "Value=0",
      "2DAMEMORY2=!FieldPath",
      "[item]",
      "FieldType=Struct",
      "Path=FeatList",
      "Label=",
      "TypeId=ListIndex",
      "2DAMEMORY8=ListIndex",
      "",
    ].join("\n");
    const patcher = new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), backupDir: path.join(modDir, "b") });
    const log = await patcher.apply(parseChangesIni(ini));
    expect(log.errors).toEqual([]);

    expect(patcher.memory.get2da(22)).toBe("0");
    expect(patcher.memory.isFieldPath(22)).toBe(false);

    const utc = readGff(await fsp.readFile(path.join(gameDir, "Override", "p_test.utc")));
    expect(getFieldByPath(utc, "DstVal")?.value).toBe(7);
    expect(getFieldByPath(utc, "SrcVal")?.value).toBe(9);
    expect(getStructByPath(utc, "FeatList/1")?.id).toBe(1);
    expect(patcher.memory.get2da(3)).toBe("SrcVal");
    expect(patcher.memory.isFieldPath(3)).toBe(true);
    expect(patcher.memory.get2da(9)).toBe("1");
    expect(patcher.memory.isFieldPath(9)).toBe(false);
  });

  it("fails a memory assignment whose stored field path or source is unusable", async () => {
    const run = async (name: string, body: string): Promise<string[]> => {
      const ini = `[GFFList]\nFile0=p_test.utc\n[p_test.utc]\n${body}\n`;
      const patcher = new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), backupDir: path.join(modDir, name) });
      return (await patcher.apply(parseChangesIni(ini))).errors;
    };
    expect(await run("unset", "2DAMEMORY2=2DAMEMORY1")).toEqual([expect.stringMatching(/2DAMEMORY1 was never assigned/)]);
    expect(await run("root", "2DAMEMORY1=!FieldPath\n2DAMEMORY2=!FieldPath\n2DAMEMORY1=2DAMEMORY2")).toEqual([expect.stringMatching(/does not point to a GFF field/)]);
  });

  it("reports unresolved tokens and missing files as errors without aborting other files", async () => {
    const ini = "[2DAList]\nTable0=spells.2da\nTable1=nothere.2da\n[spells.2da]\nChangeRow0=fix\n[fix]\nRowLabel=0\nname=StrRef9\n[nothere.2da]\n[SSFList]\nFile0=p_test.ssf\n[p_test.ssf]\nDeath=42\n";
    const patcher = new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), backupDir: path.join(modDir, "b") });
    const log = await patcher.apply(parseChangesIni(ini));
    expect(log.errors).toHaveLength(2);
    expect(log.errors[0]).toMatch(/StrRef9/);
    expect(log.errors[1]).toMatch(/nothere\.2da/);
    expect(readSsf(await fsp.readFile(path.join(gameDir, "Override", "p_test.ssf"))).sounds[15]).toBe(42);
    const spells = read2da(await fsp.readFile(path.join(gameDir, "Override", "spells.2da")));
    expect(spells.getCell(0, "name")).toBe("100");
  });

  describe("zero-byte sources", () => {
    const TABLE_INI = `[2DAList]\nTable0=table_a.2da\n[table_a.2da]\nChangeRow0=row_fix\n[row_fix]\nRowIndex=0\nlabel=changed`;

    it("dry run over a virtual fs reports a zero-byte tslpatchdata 2DA as unverified instead of an error", async () => {
      await fsp.writeFile(path.join(dataDir, "table_a.2da"), new Uint8Array(0));
      const config = parseChangesIni(TABLE_INI);
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(config);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(1);
      expect(log.unverified[0]).toMatch(/table_a\.2da.*zero-byte virtual placeholder/);
      expect(log.filesWritten).toEqual([]);
    });

    const TOKEN_INI = (assign: string): string =>
      `[2DAList]\nTable0=table_a.2da\nTable1=spells.2da\n[table_a.2da]\nChangeRow0=row_fix\n[row_fix]\nRowIndex=0\nlabel=changed\n${assign}\n[spells.2da]\nChangeRow0=spell_fix\n[spell_fix]\nRowIndex=0\nname=2DAMEMORY1`;

    it("dry run reports a token read as unverified when the step that assigns it was an unverified placeholder", async () => {
      await fsp.writeFile(path.join(dataDir, "table_a.2da"), new Uint8Array(0));
      const patcher = new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true });
      const log = await patcher.apply(parseChangesIni(TOKEN_INI("2DAMEMORY1=RowIndex")));
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(2);
      expect(log.unverified[0]).toMatch(/table_a\.2da.*zero-byte virtual placeholder/);
      expect(log.unverified[1]).toMatch(/2DAList spells\.2da: 2DAMEMORY1 is assigned by an earlier step that could not be verified/);
      expect(log.filesWritten).toEqual([]);
    });

    it("still fails a token that no step assigns, and a real run over a placeholder fails the assigning file", async () => {
      await fsp.writeFile(path.join(dataDir, "table_a.2da"), new Uint8Array(0));
      const unassigned = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(parseChangesIni(TOKEN_INI("")));
      expect(unassigned.errors).toEqual([expect.stringMatching(/2DAList spells\.2da: 2DAMEMORY1 was never assigned/)]);
      const real = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs() }).apply(parseChangesIni(TOKEN_INI("2DAMEMORY1=RowIndex")));
      expect(real.unverified).toEqual([]);
      expect(real.errors.join("\n")).toMatch(/table_a\.2da.*is empty \(0 bytes\)/);
      expect(real.errors.join("\n")).toMatch(/2DAMEMORY1 was never assigned/);
    });

    it("dry run reports a zero-byte game copy of GFF, SSF and HACK targets as unverified", async () => {
      await fsp.writeFile(path.join(gameDir, "Override", "gff_a.utc"), new Uint8Array(0));
      await fsp.writeFile(path.join(gameDir, "Override", "ssf_a.ssf"), new Uint8Array(0));
      await fsp.writeFile(path.join(gameDir, "Override", "hack_a.ncs"), new Uint8Array(0));
      const config = parseChangesIni(
        `[GFFList]\nFile0=gff_a.utc\n[gff_a.utc]\nTag=x\n[SSFList]\nFile0=ssf_a.ssf\n[ssf_a.ssf]\nBattlecry 1=1\n[HACKList]\nFile0=hack_a.ncs\n[hack_a.ncs]\n0=1`,
      );
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(config);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(3);
    });

    it("dry run on a real fs still fails on a zero-byte 2DA", async () => {
      await fsp.writeFile(path.join(dataDir, "table_a.2da"), new Uint8Array(0));
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), dryRun: true }).apply(parseChangesIni(TABLE_INI));
      expect(log.unverified).toEqual([]);
      expect(log.errors.join("\n")).toMatch(/2DAList table_a\.2da: table_a\.2da: tslpatchdata is empty \(0 bytes\)/);
    });

    it("real run fails hard on a zero-byte 2DA and names the file", async () => {
      await fsp.writeFile(path.join(dataDir, "table_a.2da"), new Uint8Array(0));
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs() }).apply(parseChangesIni(TABLE_INI));
      expect(log.unverified).toEqual([]);
      expect(log.errors.join("\n")).toMatch(/table_a\.2da.*is empty \(0 bytes\)/);
      expect(log.errors.join("\n")).not.toMatch(/RangeError/);
      expect(log.filesWritten).toEqual([]);
    });

    it("dry run installs into a zero-byte virtual placeholder archive as an empty container", async () => {
      const archive = path.join(gameDir, "Modules", "placeholder_a.mod");
      await fsp.writeFile(archive, new Uint8Array(0));
      const config = parseChangesIni(`[InstallList]\ninstall_folder0=Modules\\placeholder_a.mod\n[Modules\\placeholder_a.mod]\nFile0=new_item.uti`);
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(config);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(1);
      expect(log.unverified[0]).toMatch(/placeholder_a\.mod.*zero-byte virtual placeholder archive.*empty MOD/);
      expect(log.filesWritten).toEqual([archive]);
      expect((await fsp.stat(archive)).size).toBe(0);
    });

    it("dry run reports a patch target inside a zero-byte virtual placeholder archive as unverified", async () => {
      await fsp.writeFile(path.join(gameDir, "Modules", "placeholder_a.mod"), new Uint8Array(0));
      const config = parseChangesIni(`[2DAList]\nTable0=table_a.2da\n[table_a.2da]\n!Destination=Modules\\placeholder_a.mod\nChangeRow0=row_fix\n[row_fix]\nRowIndex=0\nlabel=changed`);
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(config);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(2);
      expect(log.unverified.join("\n")).toMatch(/table_a\.2da cannot be read from Modules\/placeholder_a\.mod/);
      expect(log.filesWritten).toEqual([]);
    });

    it("dry run keeps resources installed earlier in the same run visible inside a placeholder archive", async () => {
      await fsp.writeFile(path.join(gameDir, "Modules", "placeholder_a.mod"), new Uint8Array(0));
      const config = parseChangesIni(
        `[InstallList]\ninstall_folder0=Modules\\placeholder_a.mod\n[Modules\\placeholder_a.mod]\nFile0=new_item.uti\n[GFFList]\nFile0=new_item.uti\n[new_item.uti]\n!Destination=Modules\\placeholder_a.mod\nTag=patched`,
      );
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(config);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(1);
    });

    it("real run and real-fs dry run fail hard on a zero-byte archive and name the file", async () => {
      await fsp.writeFile(path.join(gameDir, "Modules", "placeholder_a.mod"), new Uint8Array(0));
      const config = parseChangesIni(`[InstallList]\ninstall_folder0=Modules\\placeholder_a.mod\n[Modules\\placeholder_a.mod]\nFile0=new_item.uti`);
      for (const [fs, dryRun] of [
        [new PlaceholderNodeFs(), false],
        [new NodePatcherFs(), true],
      ] as const) {
        const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs, dryRun, backupDir: path.join(modDir, "backup", "zero") }).apply(config);
        expect(log.unverified).toEqual([]);
        expect(log.errors.join("\n")).toMatch(/placeholder_a\.mod: archive is empty \(0 bytes\)/);
        expect(log.errors.join("\n")).not.toMatch(/ErfError|archive too small/);
      }
    });

    it("dry run reports a zero-byte tslpatchdata TLK source as unverified and keeps StrRef numbering", async () => {
      await fsp.writeFile(path.join(dataDir, "append.tlk"), new Uint8Array(0));
      const config = parseChangesIni(`[TLKList]\nStrRef0=0\nStrRef1=1\n[2DAList]\nTable0=spells.2da\n[spells.2da]\nChangeRow0=fix\n[fix]\nRowIndex=0\nname=StrRef1`);
      const patcher = new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true });
      const log = await patcher.apply(config);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(1);
      expect(log.unverified[0]).toMatch(/append\.tlk.*zero-byte virtual placeholder/);
      expect(patcher.memory.getStrRef(0)).toBe(3);
      expect(patcher.memory.getStrRef(1)).toBe(4);
    });

    it("real run and real-fs dry run fail hard on a zero-byte tslpatchdata TLK source", async () => {
      await fsp.writeFile(path.join(dataDir, "append.tlk"), new Uint8Array(0));
      for (const [fs, dryRun] of [
        [new PlaceholderNodeFs(), false],
        [new NodePatcherFs(), true],
      ] as const) {
        const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs, dryRun, backupDir: path.join(modDir, "backup", "zero") }).apply(parseChangesIni(`[TLKList]\nStrRef0=0\n`));
        expect(log.unverified).toEqual([]);
        expect(log.errors.join("\n")).toMatch(/append\.tlk: tslpatchdata is empty \(0 bytes\)/);
        expect(log.errors.join("\n")).not.toMatch(/TLK too small/);
      }
    });

    it("dry run flags a zero-byte script source whose memory substitutions cannot be checked", async () => {
      await fsp.writeFile(path.join(dataDir, "present.nss"), new Uint8Array(0));
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(parseChangesIni(`[CompileList]\nFile0=present.nss\n`));
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(1);
      expect(log.unverified[0]).toMatch(/present\.nss.*zero-byte virtual placeholder/);
    });

    it("real run fails on a zero-byte game dialog.tlk", async () => {
      await fsp.writeFile(path.join(gameDir, "dialog.tlk"), new Uint8Array(0));
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(parseChangesIni(`[TLKList]\nStrRef0=0\n`));
      expect(log.errors.join("\n")).toMatch(/TLKList: dialog\.tlk: .*dialog\.tlk is empty \(0 bytes\)/);
    });
  });

  it("names the missing file, the looked-up game path and the BIF caveat when a 2DA is absent", async () => {
    const config = parseChangesIni(`[2DAList]\nTable0=table_missing.2da\n[table_missing.2da]\nChangeRow0=row_fix\n[row_fix]\nRowIndex=0\nlabel=x`);
    const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(config);
    const message = log.errors.join("\n");
    expect(message).toContain("2DAList table_missing.2da: table_missing.2da not found in");
    expect(message).toContain(path.join(gameDir, "Override", "table_missing.2da"));
    expect(message).toMatch(/BIF/);
  });

  describe("module .rim fallback", () => {
    const GFF_INI = `[GFFList]\nFile0=gff_a.utc\n[gff_a.utc]\n!Destination=Modules\\mod_a.mod\nTag=patched`;

    async function writeSiblingRim(name: string, resources: Record<string, [number, Uint8Array]>): Promise<void> {
      const rim = new Encapsulated("RIM ");
      for (const [resref, [type, data]] of Object.entries(resources)) rim.set(resref, type, data);
      await fsp.writeFile(path.join(gameDir, "Modules", name), writeRim(rim));
    }

    it("real run patches a resource of an absent .mod from its _s.rim sibling and builds the .mod from the siblings", async () => {
      await writeSiblingRim("mod_a.rim", { area_a: [ResourceTypes.are, smallGff("ARE", "area")] });
      await writeSiblingRim("mod_a_s.rim", { gff_a: [ResourceTypes.utc, smallGff("UTC", "original")] });
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(parseChangesIni(GFF_INI));
      expect(log.errors).toEqual([]);
      expect(log.unverified).toEqual([]);
      const mod = readEncapsulated(await fsp.readFile(path.join(gameDir, "Modules", "mod_a.mod")));
      expect(mod.fileType).toBe("MOD ");
      expect(getFieldByPath(readGff(mod.get("gff_a", ResourceTypes.utc)!.data), "Tag")?.value).toBe("patched");
      expect(getFieldByPath(readGff(mod.get("area_a", ResourceTypes.are)!.data), "Tag")?.value).toBe("area");
    });

    it("matches sibling names case-insensitively", async () => {
      await writeSiblingRim("MOD_A_S.RIM", { gff_a: [ResourceTypes.utc, smallGff("UTC", "original")] });
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), dryRun: true }).apply(parseChangesIni(GFF_INI));
      expect(log.errors).toEqual([]);
    });

    it("real run still fails when neither the .mod nor any sibling exists", async () => {
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs() }).apply(parseChangesIni(GFF_INI));
      expect(log.unverified).toEqual([]);
      expect(log.errors.join("\n")).toMatch(/gff_a\.utc not found in .*mod_a\.mod nor in tslpatchdata/);
    });

    it("real-fs dry run still fails when the siblings are absent", async () => {
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), dryRun: true }).apply(parseChangesIni(GFF_INI));
      expect(log.unverified).toEqual([]);
      expect(log.errors.join("\n")).toMatch(/nor in tslpatchdata/);
    });

    it("virtual dry run reports unverified when the siblings are zero-byte placeholders", async () => {
      await fsp.writeFile(path.join(gameDir, "Modules", "mod_a.rim"), new Uint8Array(0));
      await fsp.writeFile(path.join(gameDir, "Modules", "mod_a_s.rim"), new Uint8Array(0));
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(parseChangesIni(GFF_INI));
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(1);
      expect(log.unverified[0]).toMatch(/gff_a\.utc.*mod_a\.mod.*zero-byte virtual placeholders \(mod_a\.rim, mod_a_s\.rim\)/);
    });

    it("virtual dry run reports unverified when the siblings are absent from the virtual game", async () => {
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(parseChangesIni(GFF_INI));
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(1);
      expect(log.unverified[0]).toMatch(/gff_a\.utc.*absent from the virtual game/);
    });

    it("virtual dry run still fails when readable siblings do not hold the resource", async () => {
      await writeSiblingRim("mod_a.rim", { area_a: [ResourceTypes.are, smallGff("ARE", "area")] });
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(parseChangesIni(GFF_INI));
      expect(log.unverified).toEqual([]);
      expect(log.errors.join("\n")).toMatch(/gff_a\.utc not found in .*mod_a\.mod nor in tslpatchdata/);
    });

    it("virtual dry run installing into an absent .mod with placeholder siblings reports the contents as unverified", async () => {
      await fsp.writeFile(path.join(gameDir, "Modules", "mod_a.rim"), new Uint8Array(0));
      const config = parseChangesIni(`[InstallList]\ninstall_folder0=Modules\\mod_a.mod\n[Modules\\mod_a.mod]\nFile0=new_item.uti`);
      const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new PlaceholderNodeFs(), dryRun: true }).apply(config);
      expect(log.errors).toEqual([]);
      expect(log.unverified).toHaveLength(1);
      expect(log.unverified[0]).toMatch(/mod_a\.mod does not exist.*mod_a\.rim/);
      expect(log.warnings).toEqual([]);
    });
  });

  it("throws PatcherConfigError for a malformed ini", () => {
    expect(() => parseChangesIni("[GFFList]\nFile0=p_test.utc\n")).toThrow(PatcherConfigError);
    expect(() => parseChangesIni("[2DAList]\nTable0=spells.2da\n[spells.2da]\nAddRow0=nope\n")).toThrow(PatcherConfigError);
  });
});

async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out.set(path.relative(root, p), Buffer.from(await fsp.readFile(p)).toString("base64"));
    }
  };
  await walk(root);
  return out;
}
