import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RealFileSystem } from "../fs/realFileSystem.js";
import { VirtualFileSystem } from "../fs/virtualFileSystem.js";
import type { FileSystemPort } from "../ports/filesystem.js";
import { NullLogger } from "../logging/logger.js";
import { createPatcher, decodeIni, listNamespaces, patcherFsFromPort } from "./patcherPort.js";
import { makeSandbox, writeText, type Sandbox } from "./testing.js";

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox("modsync-patcher-");
});
afterEach(async () => {
  await sb.cleanup();
});

describe("patcher port", () => {
  it("lists namespaces from the tslpatchdata dir or its parent", async () => {
    const fs = new RealFileSystem();
    expect(await listNamespaces(`${sb.mods}/none/tslpatchdata`, fs)).toBeUndefined();
    await writeText(`${sb.mods}/a/tslpatchdata/changes.ini`, "");
    await writeText(`${sb.mods}/a/Namespaces.INI`, "[Namespaces]\nNamespace0=x\n\n[x]\nName=Only\n");
    const ns = await listNamespaces(`${sb.mods}/a/tslpatchdata`, fs);
    expect(ns?.map((n) => [n.name, n.iniName])).toEqual([["Only", "changes.ini"]]);
  });

  it("treats a namespaces.ini without [Namespaces] as no namespaces", async () => {
    const fs = new RealFileSystem();
    await writeText(`${sb.mods}/e/tslpatchdata/changes.ini`, "");
    await writeText(`${sb.mods}/e/tslpatchdata/namespaces.ini`, "[Unrelated]\nKey=1\n");
    expect(await listNamespaces(`${sb.mods}/e/tslpatchdata`, fs)).toBeUndefined();
    await writeText(`${sb.mods}/e/tslpatchdata/namespaces.ini`, "[Namespaces]\n");
    expect(await listNamespaces(`${sb.mods}/e/tslpatchdata`, fs)).toBeUndefined();
    await writeText(`${sb.mods}/m/tslpatchdata/namespaces.ini`, "[Namespaces]\nNamespace0=gone\n");
    await expect(listNamespaces(`${sb.mods}/m/tslpatchdata`, fs)).rejects.toThrow();
  });

  it("native engine falls back to changes.ini for namespace 0 when namespaces.ini lists none", async () => {
    await writeText(`${sb.mods}/f/tslpatchdata/changes.ini`, "[InstallList]\ninstall_folder0=Override\n\n[Override]\nFile0=a.txt\n");
    await writeText(`${sb.mods}/f/tslpatchdata/a.txt`, "a");
    await writeText(`${sb.mods}/f/tslpatchdata/namespaces.ini`, "[Unrelated]\nKey=1\n");
    const patcher = createPatcher({ ...sb.settings, patcherEngine: "Native" }, NullLogger);
    const r = await patcher.install({ tslpatchdataDir: `${sb.mods}/f/tslpatchdata`, gameDir: sb.kotor, namespaceIndex: 0, dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.filesWritten).toEqual([`${sb.kotor}/Override/a.txt`]);
  });

  it("lists the available inis when the changes ini is missing", async () => {
    await writeText(`${sb.mods}/q/tslpatchdata/other.ini`, "[InstallList]\n");
    await writeText(`${sb.mods}/q/tslpatchdata/changes_b.ini`, "[InstallList]\n");
    await writeText(`${sb.mods}/q/tslpatchdata/a.txt`, "a");
    for (const engine of ["Native", "HoloPatcher"] as const) {
      const patcher = createPatcher({ ...sb.settings, patcherEngine: engine }, NullLogger);
      const r = await patcher.install({ tslpatchdataDir: `${sb.mods}/q/tslpatchdata`, gameDir: sb.kotor, dryRun: true, fs: new RealFileSystem() });
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain(`changes ini not found: ${sb.mods}/q/tslpatchdata/changes.ini`);
      expect(r.errors[0]).toContain("changes_b.ini, other.ini");
      expect(r.errors[0]).not.toContain("a.txt");
    }
    await writeText(`${sb.mods}/r/tslpatchdata/a.txt`, "a");
    const patcher = createPatcher({ ...sb.settings, patcherEngine: "Native" }, NullLogger);
    const none = await patcher.install({ tslpatchdataDir: `${sb.mods}/r/tslpatchdata`, gameDir: sb.kotor, dryRun: true, fs: new RealFileSystem() });
    expect(none.errors[0]).toMatch(/changes ini not found.*none/);
  });

  it("treats a missing data dir as empty but surfaces other readDir failures", async () => {
    const patcher = createPatcher({ ...sb.settings, patcherEngine: "Native" }, NullLogger);
    const missing = await patcher.install({ tslpatchdataDir: `${sb.mods}/absent/tslpatchdata`, gameDir: sb.kotor, dryRun: true, fs: new RealFileSystem() });
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toContain("changes ini not found");
    expect(missing.errors[0]).not.toContain("cannot list");
    const denied: FileSystemPort = Object.assign(Object.create(new RealFileSystem()) as FileSystemPort, {
      readDir: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    const blocked = await patcher.install({ tslpatchdataDir: `${sb.mods}/q/tslpatchdata`, gameDir: sb.kotor, dryRun: true, fs: denied });
    expect(blocked.ok).toBe(false);
    expect(blocked.errors[0]).toContain("cannot list directory");
    expect(blocked.errors[0]).toContain("permission denied");
  });

  describe("namespace data folders and ini precedence", () => {
    const installIni = (file: string) => `[InstallList]\ninstall_folder0=Override\n\n[Override]\nFile0=${file}\n`;
    const namespacesIni = (body: string) => `[Namespaces]\nNamespace0=first\n\n[first]\nName=First\n${body}`;
    const dryRun = (dir: string, extra: { iniName?: string; namespaceIndex?: number } = { namespaceIndex: 0 }) =>
      createPatcher({ ...sb.settings, patcherEngine: "Native" }, NullLogger).install({
        tslpatchdataDir: `${sb.mods}/${dir}/tslpatchdata`,
        gameDir: sb.kotor,
        dryRun: true,
        ...extra,
      });

    it("descends into the DataPath folder of the selected namespace", async () => {
      const base = `${sb.mods}/dp/tslpatchdata`;
      await writeText(`${base}/namespaces.ini`, namespacesIni("IniName=changes_1.ini\nDataPath=Variant_One\n"));
      await writeText(`${base}/variant_one/changes_1.ini`, installIni("one.txt"));
      await writeText(`${base}/variant_one/one.txt`, "1");
      const r = await dryRun("dp");
      expect(r.errors).toEqual([]);
      expect(r.filesWritten).toEqual([`${sb.kotor}/Override/one.txt`]);
    });

    it("accepts nested DataPath values with backslash separators", async () => {
      const base = `${sb.mods}/nested/tslpatchdata`;
      await writeText(`${base}/namespaces.ini`, namespacesIni("IniName=full.ini\nDataPath=outer\\inner\n"));
      await writeText(`${base}/outer/inner/full.ini`, installIni("deep.txt"));
      await writeText(`${base}/outer/inner/deep.txt`, "d");
      const r = await dryRun("nested");
      expect(r.errors).toEqual([]);
      expect(r.filesWritten).toEqual([`${sb.kotor}/Override/deep.txt`]);
    });

    it("still honors the legacy DataFolderName key, with DataPath preferred", async () => {
      const base = `${sb.mods}/legacy/tslpatchdata`;
      await writeText(`${base}/namespaces.ini`, namespacesIni("IniName=a.ini\nDataFolderName=old\n"));
      await writeText(`${base}/old/a.ini`, installIni("old.txt"));
      await writeText(`${base}/old/old.txt`, "o");
      expect((await dryRun("legacy")).filesWritten).toEqual([`${sb.kotor}/Override/old.txt`]);
      await writeText(`${base}/namespaces.ini`, namespacesIni("IniName=a.ini\nDataFolderName=old\nDataPath=new\n"));
      await writeText(`${base}/new/a.ini`, installIni("new.txt"));
      await writeText(`${base}/new/new.txt`, "n");
      expect((await dryRun("legacy")).filesWritten).toEqual([`${sb.kotor}/Override/new.txt`]);
    });

    it("stays on the tslpatchdata root when DataPath is missing or escapes it", async () => {
      const base = `${sb.mods}/fallback/tslpatchdata`;
      await writeText(`${base}/changes.ini`, installIni("root.txt"));
      await writeText(`${base}/root.txt`, "r");
      for (const dataPath of ["absent", "..\\elsewhere", "."]) {
        await writeText(`${base}/namespaces.ini`, namespacesIni(`IniName=changes.ini\nDataPath=${dataPath}\n`));
        const r = await dryRun("fallback");
        expect(r.errors, dataPath).toEqual([]);
        expect(r.filesWritten, dataPath).toEqual([`${sb.kotor}/Override/root.txt`]);
      }
    });

    it("uses the namespace ini when the requested ini does not exist", async () => {
      const base = `${sb.mods}/guess/tslpatchdata`;
      await writeText(`${base}/namespaces.ini`, namespacesIni("IniName=changes_b.ini\n"));
      await writeText(`${base}/changes_b.ini`, installIni("b.txt"));
      await writeText(`${base}/b.txt`, "b");
      const r = await dryRun("guess", { namespaceIndex: 0, iniName: "changes_a.ini" });
      expect(r.errors).toEqual([]);
      expect(r.filesWritten).toEqual([`${sb.kotor}/Override/b.txt`]);
    });

    it("keeps the requested ini when it exists, even with a namespace selected", async () => {
      const base = `${sb.mods}/explicit/tslpatchdata`;
      await writeText(`${base}/namespaces.ini`, namespacesIni("IniName=changes_b.ini\n"));
      await writeText(`${base}/changes_a.ini`, installIni("a.txt"));
      await writeText(`${base}/changes_b.ini`, installIni("b.txt"));
      await writeText(`${base}/a.txt`, "a");
      await writeText(`${base}/b.txt`, "b");
      const r = await dryRun("explicit", { namespaceIndex: 0, iniName: "changes_a.ini" });
      expect(r.filesWritten).toEqual([`${sb.kotor}/Override/a.txt`]);
    });

    it("reports the namespace ini as missing when neither ini exists", async () => {
      const base = `${sb.mods}/none/tslpatchdata`;
      await writeText(`${base}/namespaces.ini`, namespacesIni("IniName=changes_b.ini\n"));
      const r = await dryRun("none", { namespaceIndex: 0, iniName: "changes_a.ini" });
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain(`changes ini not found: ${base}/changes_b.ini`);
    });
  });

  it("decodes windows-1252 and UTF-8 BOM inis", () => {
    expect(decodeIni(new Uint8Array([0x4e, 0xe9]))).toBe("Né");
    expect(decodeIni(new Uint8Array([0xef, 0xbb, 0xbf, 0x4e, 0xc3, 0xa9]))).toBe("Né");
  });

  it("native engine fails closed on a malformed ini and reports files in dry run", async () => {
    await writeText(`${sb.mods}/p/tslpatchdata/changes.ini`, "[InstallList]\ninstall_folder0=Override\n\n[Override]\nFile0=a.txt\n");
    await writeText(`${sb.mods}/p/tslpatchdata/a.txt`, "a");
    const patcher = createPatcher({ ...sb.settings, patcherEngine: "Native" }, NullLogger);
    const dry = await patcher.install({ tslpatchdataDir: `${sb.mods}/p/tslpatchdata`, gameDir: sb.kotor, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.filesWritten).toEqual([`${sb.kotor}/Override/a.txt`]);
    await writeText(`${sb.mods}/bad/tslpatchdata/changes.ini`, "[InstallList]\ninstall_folder0=Override\n\n[Override]\nBogus=1\n");
    const bad = await patcher.install({ tslpatchdataDir: `${sb.mods}/bad/tslpatchdata`, gameDir: sb.kotor, dryRun: true });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.errors[0]).toMatch(/not found/);
    expect(bad.filesWritten).toEqual([]);
    await writeText(`${sb.mods}/nosection/tslpatchdata/changes.ini`, "[InstallList]\ninstall_folder0=Override\n");
    const noSection = await patcher.install({ tslpatchdataDir: `${sb.mods}/nosection/tslpatchdata`, gameDir: sb.kotor, dryRun: true });
    expect(noSection.ok).toBe(false);
    expect(noSection.errors[0]).toMatch(/references section \[install_folder0\] which does not exist/);
    await writeText(`${sb.mods}/emptyname/tslpatchdata/changes.ini`, "[InstallList]\ninstall_folder0=Override\n\n[Override]\nFile0=\n");
    const emptyName = await patcher.install({ tslpatchdataDir: `${sb.mods}/emptyname/tslpatchdata`, gameDir: sb.kotor, dryRun: true });
    expect(emptyName.ok).toBe(false);
    expect(emptyName.errors[0]).toMatch(/empty file name/);
    const missing = await patcher.install({ tslpatchdataDir: `${sb.mods}/nope`, gameDir: sb.kotor, dryRun: false });
    expect(missing.ok).toBe(false);
  });

  it("native dry run over a virtual fs reports zero-byte placeholders as unverified while real runs still fail", async () => {
    const ini = "[2DAList]\nTable0=table_a.2da\n\n[table_a.2da]\nChangeRow0=row_fix\n\n[row_fix]\nRowIndex=0\nlabel=changed\n";
    const patcher = createPatcher({ ...sb.settings, patcherEngine: "Native" }, NullLogger);

    const vfs = new VirtualFileSystem(new RealFileSystem());
    const virtualDir = `${sb.mods}/v/tslpatchdata`;
    await vfs.mkdirp(virtualDir);
    await vfs.writeFile(`${virtualDir}/changes.ini`, new TextEncoder().encode(ini));
    await vfs.addVirtualFiles([{ path: `${virtualDir}/table_a.2da`, size: 120 }]);
    const dry = await patcher.install({ tslpatchdataDir: virtualDir, gameDir: sb.kotor, dryRun: true, fs: vfs });
    expect(dry.errors).toEqual([]);
    expect(dry.ok).toBe(true);
    expect(dry.unverified).toHaveLength(1);
    expect(dry.unverified?.[0]).toContain("table_a.2da");

    await writeText(`${sb.mods}/r2/tslpatchdata/changes.ini`, ini);
    await writeText(`${sb.mods}/r2/tslpatchdata/table_a.2da`, "");
    for (const dryRun of [true, false]) {
      const real = await patcher.install({ tslpatchdataDir: `${sb.mods}/r2/tslpatchdata`, gameDir: sb.kotor, dryRun, fs: new RealFileSystem() });
      expect(real.ok).toBe(false);
      expect(real.errors.join("\n")).toMatch(/table_a\.2da.*is empty \(0 bytes\)/);
      expect(real.unverified).toEqual([]);
    }
  });

  it("native engine names the missing 2DA when it is in neither the game dir nor tslpatchdata", async () => {
    await writeText(`${sb.mods}/m2/tslpatchdata/changes.ini`, "[2DAList]\nTable0=table_b.2da\n\n[table_b.2da]\nChangeRow0=row_fix\n\n[row_fix]\nRowIndex=0\nlabel=changed\n");
    const patcher = createPatcher({ ...sb.settings, patcherEngine: "Native" }, NullLogger);
    const r = await patcher.install({ tslpatchdataDir: `${sb.mods}/m2/tslpatchdata`, gameDir: sb.kotor, dryRun: false, fs: new RealFileSystem() });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("table_b.2da not found in");
    expect(r.errors.join("\n")).toContain(`${sb.kotor}/Override/table_b.2da`);
  });

  it("external engines only parse the ini during a dry run and fail without a path otherwise", async () => {
    await writeText(`${sb.mods}/p/tslpatchdata/changes.ini`, "[InstallList]\n");
    const holo = createPatcher({ ...sb.settings, patcherEngine: "HoloPatcher" }, NullLogger);
    const dry = await holo.install({ tslpatchdataDir: `${sb.mods}/p/tslpatchdata`, gameDir: sb.kotor, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.warnings[0]).toContain("dry run");
    const real = await holo.install({ tslpatchdataDir: `${sb.mods}/p/tslpatchdata`, gameDir: sb.kotor, dryRun: false });
    expect(real.ok).toBe(false);
    expect(real.errors[0]).toContain("holoPatcherPath");
    const legacy = createPatcher({ ...sb.settings, patcherEngine: "TSLPatcher" }, NullLogger);
    const real2 = await legacy.install({ tslpatchdataDir: `${sb.mods}/p/tslpatchdata`, gameDir: sb.kotor, dryRun: false });
    expect(real2.ok).toBe(false);
    expect(real2.errors[0]).toContain("TSLPatcher.exe");
  });

  it("HoloPatcher spawns the configured executable with the documented arguments", async () => {
    if (process.platform === "win32") return;
    await writeText(`${sb.mods}/p/tslpatchdata/changes.ini`, "[InstallList]\n");
    const script = `${sb.root}/holo.sh`;
    await writeText(script, `#!/bin/sh\necho "$@" > "${sb.root}/args.txt"\necho installed\nexit 0\n`);
    const { chmod, readFile } = await import("node:fs/promises");
    await chmod(script, 0o755);
    const holo = createPatcher({ ...sb.settings, patcherEngine: "HoloPatcher", holoPatcherPath: script }, NullLogger);
    const r = await holo.install({ tslpatchdataDir: `${sb.mods}/p/tslpatchdata`, gameDir: sb.kotor, namespaceIndex: 2, dryRun: false });
    expect(r.ok).toBe(true);
    expect(r.log).toContain("installed");
    expect(await readFile(`${sb.root}/args.txt`, "utf8")).toBe(
      `--install --game-dir ${sb.kotor} --tslpatchdata ${sb.mods}/p/tslpatchdata --namespace-option-index 2 --console\n`,
    );
    await writeText(script, "#!/bin/sh\nexit 2\n");
    const fail = await holo.install({ tslpatchdataDir: `${sb.mods}/p/tslpatchdata`, gameDir: sb.kotor, dryRun: false });
    expect(fail.ok).toBe(false);
    expect(fail.errors[0]).toContain("code 2");
  });
});

describe("patcherFsFromPort range reads", () => {
  it("forwards readRange and fileSize when the port can read ranges", async () => {
    const fs = new RealFileSystem();
    await writeText(`${sb.mods}/big.bin`, "0123456789");
    const adapted = patcherFsFromPort(fs);
    expect(await adapted.fileSize!(`${sb.mods}/big.bin`)).toBe(10);
    expect(new TextDecoder().decode(await adapted.readRange!(`${sb.mods}/big.bin`, 3, 4))).toBe("3456");
    expect((await adapted.readRange!(`${sb.mods}/big.bin`, 8, 10)).length).toBe(2);
  });

  it("omits range reads for ports without them", () => {
    const adapted = patcherFsFromPort(new VirtualFileSystem(new RealFileSystem()));
    expect(adapted.readRange).toBeUndefined();
    expect(adapted.fileSize).toBeUndefined();
  });

  it("reports a missing file as ENOENT from fileSize", async () => {
    const adapted = patcherFsFromPort(new RealFileSystem());
    await expect(adapted.fileSize!(`${sb.mods}/absent.bin`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
