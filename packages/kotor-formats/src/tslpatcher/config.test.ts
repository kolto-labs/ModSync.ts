import { describe, expect, it } from "vitest";
import { GffFieldType } from "../gff.js";
import { PatcherConfigError, parseChangesIni, parseNamespacesIni } from "./config.js";

const SAMPLE = `
[Settings]
WindowCaption=Sample
BackupFiles=0
LogLevel=4
Required=foo.2da, bar.utc
RequiredMsg=Install the base mod first
Required1=baz.dlg

[TLKList]
!SourceFile=custom.tlk
StrRef1=7
StrRef0=3
Replace0=tlk_fix
StrRef2/Text=Direct text
StrRef2/Sound=n_direct

[tlk_fix]
100=0

[InstallList]
install_folder1=Modules\\danm13.mod
install_folder0=Override

[Override]
File0=a.uti
Replace0=b.utc

[Modules\\danm13.mod]
File0=c.dlg

[c.dlg]
!SaveAs=d.dlg
!OverrideType=warn
!SourceFolder=extra

[2DAList]
Table0=spells.2da

[spells.2da]
!Destination=Override
AddColumn0=spells_col
ChangeRow0=spells_fix
AddRow0=spells_new
CopyRow0=spells_copy

[spells_new]
ExclusiveColumn=label
RowLabel=high()
label=my_spell
name=StrRef0
forbiditemmask=high()
2DAMEMORY0=RowIndex
2DAMEMORY1=label

[spells_fix]
LabelIndex=2DAMEMORY3
name=5

[spells_copy]
RowIndex=4
NewRowLabel=99
label=copied

[spells_col]
ColumnLabel=newcol
DefaultValue=****
I2=x
Lfoo=y
2DAMEMORY4=I2

[GFFList]
File0=p_bastila.utc

[p_bastila.utc]
!Destination=Modules\\danm13.mod
!ReplaceFile=1
!Filename=p_b.utc
FirstName(strref)=StrRef3
FirstName(lang0)=Bastila
ClassList/0/Class=5
Tag=NewTag
AddField0=add_feat
2DAMEMORY4=!FieldPath

[add_feat]
FieldType=Struct
Path=FeatList
Label=
TypeId=1
2DAMEMORY5=ListIndex
AddField0=add_feat_id
AddField1=add_name

[add_feat_id]
FieldType=Word
Label=Feat
Value=2DAMEMORY0

[add_name]
FieldType=ExoLocString
Label=Name
StrRef=StrRef0
lang0=Hello
lang1=Hi

[CompileList]
File0=myscript.nss

[HACKList]
File0=script.ncs

[script.ncs]
!Destination=Override
0x10=StrRef0
20=1234

[SSFList]
File0=p_bastila.ssf

[p_bastila.ssf]
Battlecry 1=StrRef0
Poisoned=2DAMEMORY0
`;

describe("parseChangesIni", () => {
  const cfg = parseChangesIni(SAMPLE);

  it("parses settings", () => {
    expect(cfg.settings.windowCaption).toBe("Sample");
    expect(cfg.settings.backupFiles).toBe(false);
    expect(cfg.settings.logLevel).toBe(4);
    expect(cfg.settings.required).toEqual([{ files: ["foo.2da", "bar.utc"], message: "Install the base mod first" }, { files: ["baz.dlg"] }]);
  });

  it("parses TLKList in numeric order", () => {
    expect(cfg.tlk.sourceFile).toBe("custom.tlk");
    // numbered keys are ordered by suffix across families (ties keep file order)
    expect(cfg.tlk.modifiers).toEqual([
      { kind: "append", token: 0, sourceIndex: 3 },
      { kind: "replace", dialogIndex: 100, sourceIndex: 0, sourceFile: "tlk_fix" },
      { kind: "append", token: 1, sourceIndex: 7 },
      { kind: "direct", token: 2, text: "Direct text", sound: "n_direct" },
    ]);
  });

  it("parses InstallList folders and per-file overrides", () => {
    expect(cfg.install.map((f) => f.destination)).toEqual(["Override", "Modules/danm13.mod"]);
    expect(cfg.install[0]!.files).toEqual([
      { filename: "a.uti", replaceExisting: false, overrideType: "ignore" },
      { filename: "b.utc", replaceExisting: true, overrideType: "ignore" },
    ]);
    expect(cfg.install[1]!.files[0]).toEqual({ filename: "c.dlg", replaceExisting: false, overrideType: "warn", saveAs: "d.dlg", sourceFolder: "extra" });
  });

  describe("InstallList section lookup", () => {
    const keyed = [
      "[InstallList]",
      "install_folder0=Override",
      "install_folder1=Modules\\sample.mod",
      "install_folder2=StreamVoice\\100\\SPEAKER",
      "",
      "[install_folder0]",
      "File0=a.uti",
      "Replace1=b.utc",
      "",
      "[install_folder1]",
      "File0=c.dlg",
      "",
      "[install_folder2]",
      "",
    ].join("\r\n");

    it("reads files from the [install_folderN] section and uses the value as destination", () => {
      for (const text of [keyed, `\ufeff${keyed}`]) {
        const { install } = parseChangesIni(text);
        expect(install.map((f) => f.destination)).toEqual(["Override", "Modules/sample.mod", "StreamVoice/100/SPEAKER"]);
        expect(install.map((f) => f.files.map((x) => x.filename))).toEqual([["a.uti", "b.utc"], ["c.dlg"], []]);
        expect(install[0]!.files[1]!.replaceExisting).toBe(true);
      }
    });

    it("matches the key section case-insensitively and prefers it over a value-named section", () => {
      const { install } = parseChangesIni("[InstallList]\nInstall_Folder0=Override\n[INSTALL_FOLDER0]\nFile0=key.uti\n[Override]\nFile0=value.uti\n");
      expect(install[0]!.files.map((x) => x.filename)).toEqual(["key.uti"]);
    });

    it("falls back to a section named after the value", () => {
      const { install } = parseChangesIni("[InstallList]\ninstall_folder0=Override\n[Override]\nFile0=a.uti\n");
      expect(install[0]!.files.map((x) => x.filename)).toEqual(["a.uti"]);
    });

    it("reports the missing [install_folderN] section", () => {
      expect(() => parseChangesIni("[InstallList]\ninstall_folder3=Override\n")).toThrow(/\[install_folder3\].*does not exist/);
    });
  });

  it("parses 2DAList modifiers sorted by suffix", () => {
    const t = cfg.twoda[0]!;
    expect(t.filename).toBe("spells.2da");
    expect(t.destination).toBe("Override");
    expect(t.modifiers.map((m) => m.kind)).toEqual(["addColumn", "changeRow", "addRow", "copyRow"]);
    const add = t.modifiers[2]!;
    if (add.kind !== "addRow") throw new Error("expected addRow");
    expect(add.exclusiveColumn).toBe("label");
    expect(add.rowLabel).toEqual({ kind: "high" });
    expect([...add.cells.entries()]).toEqual([
      ["label", { kind: "constant", value: "my_spell" }],
      ["name", { kind: "strref", token: 0 }],
      ["forbiditemmask", { kind: "high" }],
    ]);
    expect(add.stores).toEqual([
      { pool: "2damemory", token: 0, source: { kind: "rowIndex" } },
      { pool: "2damemory", token: 1, source: { kind: "column", column: "label" } },
    ]);
    const fix = t.modifiers[1]!;
    if (fix.kind !== "changeRow") throw new Error("expected changeRow");
    expect(fix.target).toEqual({ kind: "labelIndex", value: { kind: "2damemory", token: 3 } });
    const copy = t.modifiers[3]!;
    if (copy.kind !== "copyRow") throw new Error("expected copyRow");
    expect(copy.target).toEqual({ kind: "rowIndex", value: { kind: "constant", value: "4" } });
    expect(copy.newRowLabel).toEqual({ kind: "constant", value: "99" });
    const col = t.modifiers[0]!;
    if (col.kind !== "addColumn") throw new Error("expected addColumn");
    expect(col.columnLabel).toBe("newcol");
    expect(col.defaultValue).toBe("****");
    expect(col.indexInserts).toEqual([{ index: 2, value: { kind: "constant", value: "x" } }]);
    expect(col.labelInserts).toEqual([{ label: "foo", value: { kind: "constant", value: "y" } }]);
    expect(col.stores).toEqual([{ pool: "2damemory", token: 4, source: { kind: "index", index: 2 } }]);
  });

  it("parses GFFList modifications and nested AddFields", () => {
    const g = cfg.gff[0]!;
    expect(g.destination).toBe("Modules/danm13.mod");
    expect(g.replaceFile).toBe(true);
    expect(g.saveAs).toBe("p_b.utc");
    expect(g.modifiers[0]).toEqual({ kind: "modify", path: "FirstName", part: { kind: "strref" }, value: { kind: "strref", token: 3 } });
    expect(g.modifiers[1]).toEqual({ kind: "modify", path: "FirstName", part: { kind: "lang", id: 0 }, value: { kind: "constant", value: "Bastila" } });
    expect(g.modifiers[2]).toEqual({ kind: "modify", path: "ClassList/0/Class", value: { kind: "constant", value: "5" } });
    expect(g.modifiers[3]).toEqual({ kind: "modify", path: "Tag", value: { kind: "constant", value: "NewTag" } });
    const add = g.modifiers[4]!;
    if (add.kind !== "add") throw new Error("expected add");
    expect(add.fieldType).toBe(GffFieldType.Struct);
    expect(add.path).toBe("FeatList");
    expect(add.typeId).toBe(1);
    expect(add.storeListIndex).toEqual([5]);
    expect(add.children).toHaveLength(2);
    expect(add.children[0]!.fieldType).toBe(GffFieldType.Word);
    expect(add.children[0]!.label).toBe("Feat");
    expect(add.children[0]!.value).toEqual({ kind: "2damemory", token: 0 });
    const name = add.children[1]!;
    expect(name.fieldType).toBe(GffFieldType.LocString);
    expect(name.locString?.strref).toEqual({ kind: "strref", token: 0 });
    expect([...name.locString!.substrings.entries()]).toEqual([
      [0, { kind: "constant", value: "Hello" }],
      [1, { kind: "constant", value: "Hi" }],
    ]);
    expect(g.modifiers[5]).toEqual({ kind: "storePath", token: 4 });
  });

  it("parses CompileList, HACKList and SSFList", () => {
    expect(cfg.compile[0]).toEqual({ filename: "myscript.nss", destination: "Override", replaceFile: false, overrideType: "ignore" });
    expect(cfg.hack[0]!.edits).toEqual([
      { offset: 16, value: { kind: "strref", token: 0 } },
      { offset: 20, value: { kind: "constant", value: "1234" } },
    ]);
    expect(cfg.ssf[0]!.sounds).toEqual([
      { name: "Battlecry 1", index: 0, value: { kind: "strref", token: 0 } },
      { name: "Poisoned", index: 27, value: { kind: "2damemory", token: 0 } },
    ]);
  });

  it("returns empty lists for an empty ini", () => {
    const empty = parseChangesIni("");
    expect(empty.tlk.modifiers).toEqual([]);
    expect(empty.install).toEqual([]);
    expect(empty.twoda).toEqual([]);
    expect(empty.gff).toEqual([]);
  });

  it("fails closed on malformed input with section/key context", () => {
    expect(() => parseChangesIni("[2DAList]\nTable0=spells.2da\n")).toThrow(PatcherConfigError);
    expect(() => parseChangesIni("[2DAList]\nTable0=spells.2da\n")).toThrow(/\[2DAList\] Table0/);
    expect(() => parseChangesIni("[2DAList]\nTable0=spells.2da\n[spells.2da]\nAddRow0=missing\n")).toThrow(/\[spells.2da\] AddRow0/);
    expect(() => parseChangesIni("[2DAList]\nTable0=s.2da\n[s.2da]\nChangeRow0=c\n[c]\nname=1\n")).toThrow(/selector/);
    expect(() => parseChangesIni("[GFFList]\nFile0=a.utc\n[a.utc]\nAddField0=f\n[f]\nLabel=X\nValue=1\n")).toThrow(/FieldType/);
    expect(() => parseChangesIni("[GFFList]\nFile0=a.utc\n[a.utc]\nAddField0=f\n[f]\nFieldType=Blah\nLabel=X\n")).toThrow(/unknown FieldType/);
    expect(() => parseChangesIni("[SSFList]\nFile0=a.ssf\n[a.ssf]\nBogus sound=1\n")).toThrow(/unknown sound name/);
    expect(() => parseChangesIni("[HACKList]\nFile0=a.ncs\n[a.ncs]\nabc=1\n")).toThrow(/integer/);
    expect(() => parseChangesIni("[Settings]\nBackupFiles=maybe\n")).toThrow(/boolean/);
    expect(() => parseChangesIni("[TLKList]\nStrRef0=abc\n")).toThrow(/\[TLKList\] StrRef0/);
    expect(() => parseChangesIni("[InstallList]\ninstall_folder0=Override\n")).toThrow(/does not exist/);
    try {
      parseChangesIni("[2DAList]\nTable0=spells.2da\n");
    } catch (err) {
      expect(err).toBeInstanceOf(PatcherConfigError);
      expect((err as PatcherConfigError).section).toBe("2DAList");
      expect((err as PatcherConfigError).key).toBe("Table0");
    }
  });
});

describe("parseNamespacesIni", () => {
  it("parses namespaces", () => {
    const ns = parseNamespacesIni("[Namespaces]\nNamespace1=b\nNamespace0=a\n[a]\nName=Full\nDescription=Everything\nIniName=changes.ini\nInfoName=info.rtf\nDataFolderName=tslpatchdata\n[b]\nName=Lite\nIniName=lite.ini\n");
    expect(ns).toEqual([
      { key: "a", name: "Full", description: "Everything", iniName: "changes.ini", infoName: "info.rtf", dataFolderName: "tslpatchdata" },
      { key: "b", name: "Lite", iniName: "lite.ini" },
    ]);
  });
  it("reads the data folder from DataPath, preferring it over the legacy DataFolderName", () => {
    const text = "[Namespaces]\nNamespace0=a\nNamespace1=b\nNamespace2=c\n[a]\nIniName=a.ini\nDataPath=sub\\inner\n[b]\nIniName=b.ini\nDataFolderName=old\n[c]\nIniName=c.ini\nDataFolderName=old\nDataPath=new\n";
    expect(parseNamespacesIni(text).map((n) => n.dataFolderName)).toEqual(["sub\\inner", "old", "new"]);
  });
  it("fails on a listed namespace whose section is missing", () => {
    expect(() => parseNamespacesIni("[Namespaces]\nNamespace0=a\n")).toThrow(PatcherConfigError);
  });
  it("yields no namespaces when [Namespaces] is absent or empty", () => {
    expect(parseNamespacesIni("")).toEqual([]);
    expect(parseNamespacesIni("[Other]\nKey=1\n")).toEqual([]);
    expect(parseNamespacesIni("[Namespaces]\n")).toEqual([]);
    expect(parseNamespacesIni("; only a comment\n[Variant]\nName=Orphan\n")).toEqual([]);
  });
});
