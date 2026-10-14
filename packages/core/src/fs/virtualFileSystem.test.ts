import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toPosix } from "./paths.js";
import { RealFileSystem } from "./realFileSystem.js";
import { VirtualFileSystem } from "./virtualFileSystem.js";
import { resolveWildcards } from "./wildcards.js";

let root: string;
let vfs: VirtualFileSystem;
const real = new RealFileSystem();

beforeEach(async () => {
  root = toPosix(await mkdtemp(path.join(tmpdir(), "modsync-vfs-")));
  await mkdir(`${root}/Mods/Pack/tslpatchdata`, { recursive: true });
  await mkdir(`${root}/Game/Override`, { recursive: true });
  await writeFile(`${root}/Mods/Pack/README.txt`, "readme");
  await writeFile(`${root}/Mods/Pack/tslpatchdata/changes.ini`, "[Settings]");
  await writeFile(`${root}/Mods/Loose.tpc`, "tpc");
  await writeFile(`${root}/Game/Override/old.tga`, "tga");
  vfs = new VirtualFileSystem(real);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function diskUntouched(): Promise<void> {
  expect((await real.walk(root)).sort()).toEqual(
    [
      `${root}/Game/Override/old.tga`,
      `${root}/Mods/Loose.tpc`,
      `${root}/Mods/Pack/README.txt`,
      `${root}/Mods/Pack/tslpatchdata/changes.ini`,
    ].sort(),
  );
}

describe("VirtualFileSystem", () => {
  it("canonicalizes symlink ancestors of virtual files", async () => {
    await symlink(`${root}/Mods/Pack`, `${root}/Game/linked`, "dir");
    await vfs.mkdirp(`${root}/Game/linked/new`);
    await vfs.writeFile(`${root}/Game/linked/new/file.txt`, new TextEncoder().encode("virtual"));
    expect(await vfs.realpath(`${root}/Game/linked/new/file.txt`)).toBe(`${root}/Mods/Pack/new/file.txt`);
  });

  it("is virtual and reads through to the base", async () => {
    expect(vfs.isVirtual).toBe(true);
    expect(await vfs.exists(`${root}/Mods/Pack/README.txt`)).toBe(true);
    expect(Buffer.from(await vfs.readFile(`${root}/Mods/Pack/README.txt`)).toString()).toBe("readme");
    expect((await vfs.stat(`${root}/Mods/Loose.tpc`))?.size).toBe(3);
    expect(vfs.getMutations()).toEqual([]);
  });

  it("looks up base paths case-insensitively and reports on-disk casing", async () => {
    expect(await vfs.exists(`${root}/mods/pack/readme.TXT`)).toBe(true);
    expect(await vfs.resolveCase(`${root}/MODS/pack/TSLPATCHDATA/Changes.INI`)).toBe(`${root}/Mods/Pack/tslpatchdata/changes.ini`);
    expect((await vfs.stat(`${root}/mods/PACK`))?.path).toBe(`${root}/Mods/Pack`);
    expect(await vfs.resolveCase(`${root}/mods/nothing`)).toBeUndefined();
    const names = (await vfs.readDir(`${root}/MODS`)).map((e) => e.name);
    expect(names).toEqual(["Loose.tpc", "Pack"]);
  });

  it("writes stay in memory, are visible case-insensitively and never hit disk", async () => {
    await vfs.writeFile(`${root}/Game/Override/new.tpc`, new Uint8Array([1, 2]));
    expect(await vfs.exists(`${root}/game/override/NEW.TPC`)).toBe(true);
    expect(await vfs.readFile(`${root}/GAME/Override/new.tpc`)).toEqual(new Uint8Array([1, 2]));
    expect((await vfs.stat(`${root}/Game/Override/new.tpc`))?.size).toBe(2);
    expect((await vfs.readDir(`${root}/Game/Override`)).map((e) => e.name)).toEqual(["new.tpc", "old.tga"]);
    expect(vfs.getMutations()).toEqual([{ kind: "write", path: `${root}/Game/Override/new.tpc` }]);
    await diskUntouched();
  });

  it("overwriting a base file through another casing keeps the base spelling", async () => {
    await vfs.writeFile(`${root}/game/override/OLD.TGA`, Buffer.from("new"));
    expect((await vfs.readDir(`${root}/Game/Override`)).map((e) => e.name)).toEqual(["old.tga"]);
    expect(Buffer.from(await vfs.readFile(`${root}/Game/Override/old.tga`)).toString()).toBe("new");
    expect((await readFile(`${root}/Game/Override/old.tga`)).toString()).toBe("tga");
  });

  it("mkdirp creates missing ancestors only and records them", async () => {
    await vfs.mkdirp(`${root}/Game/Override/sub/deep`);
    expect((await vfs.stat(`${root}/game/override/SUB/deep`))?.isDirectory).toBe(true);
    expect(vfs.getMutations()).toEqual([
      { kind: "mkdir", path: `${root}/Game/Override/sub` },
      { kind: "mkdir", path: `${root}/Game/Override/sub/deep` },
    ]);
    await expect(vfs.mkdirp(`${root}/Mods/Loose.tpc/x`)).rejects.toThrow(/ENOTDIR/);
    await diskUntouched();
  });

  it("delete hides base files and directories, including case-insensitive lookups", async () => {
    await vfs.remove(`${root}/game/override/OLD.tga`);
    expect(await vfs.exists(`${root}/Game/Override/old.tga`)).toBe(false);
    expect(await vfs.readDir(`${root}/Game/Override`)).toEqual([]);
    expect(vfs.getMutations()).toEqual([{ kind: "delete", path: `${root}/Game/Override/old.tga` }]);

    await vfs.remove(`${root}/Mods/pack`);
    expect(await vfs.exists(`${root}/Mods/Pack`)).toBe(false);
    expect(await vfs.exists(`${root}/Mods/Pack/tslpatchdata/changes.ini`)).toBe(false);
    expect(await vfs.resolveCase(`${root}/mods/pack/readme.txt`)).toBeUndefined();
    expect(await vfs.walk(`${root}/Mods`)).toEqual([`${root}/Mods/Loose.tpc`]);
    expect(await vfs.walk(`${root}/Mods/Pack`)).toEqual([]);
    await expect(vfs.readFile(`${root}/Mods/Pack/README.txt`)).rejects.toThrow(/ENOENT/);
    await diskUntouched();
  });

  it("deleting a missing path is a no-op without a mutation", async () => {
    await vfs.remove(`${root}/nope`);
    expect(vfs.getMutations()).toEqual([]);
  });

  it("recreating a deleted directory does not resurrect its old base children", async () => {
    await vfs.remove(`${root}/Mods/Pack`);
    await vfs.writeFile(`${root}/Mods/Pack/fresh.txt`, Buffer.from("x"));
    expect((await vfs.readDir(`${root}/Mods/Pack`)).map((e) => e.name)).toEqual(["fresh.txt"]);
    expect(await vfs.exists(`${root}/Mods/Pack/README.txt`)).toBe(false);
    expect(await vfs.walk(`${root}/Mods/Pack`)).toEqual([`${root}/Mods/Pack/fresh.txt`]);
    await vfs.remove(`${root}/Mods/Pack`);
    expect(await vfs.exists(`${root}/Mods/Pack/fresh.txt`)).toBe(false);
    expect(await vfs.exists(`${root}/Mods/Pack`)).toBe(false);
  });

  it("deleting an overlay file after writing it hides it", async () => {
    await vfs.writeFile(`${root}/Game/Override/a.txt`, Buffer.from("a"));
    await vfs.remove(`${root}/Game/Override/A.TXT`);
    expect(await vfs.exists(`${root}/Game/Override/a.txt`)).toBe(false);
    expect(vfs.getMutations().map((m) => m.kind)).toEqual(["write", "delete"]);
  });

  it("copyFile mirrors base content lazily and records the copy", async () => {
    await vfs.copyFile(`${root}/mods/loose.tpc`, `${root}/Game/Override/Loose.tpc`);
    expect(Buffer.from(await vfs.readFile(`${root}/game/override/loose.TPC`)).toString()).toBe("tpc");
    expect(await vfs.sha1(`${root}/Game/Override/Loose.tpc`)).toBe(createHash("sha1").update("tpc").digest("hex"));
    expect(vfs.getMutations()).toEqual([
      { kind: "copy", path: `${root}/Game/Override/Loose.tpc`, from: `${root}/Mods/Loose.tpc` },
    ]);
    await expect(vfs.copyFile(`${root}/Mods/nope`, `${root}/x`)).rejects.toThrow(/ENOENT/);
    await expect(vfs.copyFile(`${root}/Mods/Pack`, `${root}/x`)).rejects.toThrow(/EISDIR/);
    await diskUntouched();
  });

  it("move renames a file and hides the source", async () => {
    await vfs.move(`${root}/Mods/LOOSE.tpc`, `${root}/Game/Override/loose.tpc`);
    expect(await vfs.exists(`${root}/Mods/Loose.tpc`)).toBe(false);
    expect(Buffer.from(await vfs.readFile(`${root}/Game/Override/loose.tpc`)).toString()).toBe("tpc");
    expect(vfs.getMutations()).toEqual([
      { kind: "move", path: `${root}/Game/Override/loose.tpc`, from: `${root}/Mods/Loose.tpc` },
    ]);
    await diskUntouched();
  });

  it("move relocates a whole directory tree (base + overlay) and hides the old tree", async () => {
    await vfs.writeFile(`${root}/Mods/Pack/extra/new.txt`, Buffer.from("new"));
    await vfs.move(`${root}/mods/pack`, `${root}/Game/Pack`);
    expect(await vfs.exists(`${root}/Mods/Pack`)).toBe(false);
    expect(await vfs.exists(`${root}/Mods/Pack/README.txt`)).toBe(false);
    expect((await vfs.walk(`${root}/Game/Pack`)).sort()).toEqual([
      `${root}/Game/Pack/README.txt`,
      `${root}/Game/Pack/extra/new.txt`,
      `${root}/Game/Pack/tslpatchdata/changes.ini`,
    ]);
    expect(Buffer.from(await vfs.readFile(`${root}/game/pack/TSLPATCHDATA/changes.ini`)).toString()).toBe("[Settings]");
    expect(Buffer.from(await vfs.readFile(`${root}/Game/Pack/extra/new.txt`)).toString()).toBe("new");
    expect(vfs.getMutations().at(-1)).toEqual({ kind: "move", path: `${root}/Game/Pack`, from: `${root}/Mods/Pack` });
    await expect(vfs.move(`${root}/Game/Pack`, `${root}/Game/Pack/inner`)).rejects.toThrow();
    await diskUntouched();
  });

  it("addVirtualFiles are visible to exists/stat/readDir/walk, read as empty, track size", async () => {
    await vfs.addVirtualFiles([
      { path: `${root}/Mods/Pack/Extracted/Override/big.mod`, size: 1234 },
      { path: `${root}/Mods/Pack/Extracted/readme.txt`, size: 10 },
    ]);
    expect(await vfs.exists(`${root}/mods/pack/extracted/override/BIG.MOD`)).toBe(true);
    expect((await vfs.stat(`${root}/Mods/Pack/Extracted/Override/big.mod`))?.size).toBe(1234);
    expect(await vfs.readFile(`${root}/Mods/Pack/Extracted/Override/big.mod`)).toEqual(new Uint8Array(0));
    expect((await vfs.walk(`${root}/Mods/Pack/Extracted`)).sort()).toEqual([
      `${root}/Mods/Pack/Extracted/Override/big.mod`,
      `${root}/Mods/Pack/Extracted/readme.txt`,
    ]);
    expect((await vfs.readDir(`${root}/Mods/Pack/Extracted`)).map((e) => [e.name, e.isDirectory])).toEqual([
      ["Override", true],
      ["readme.txt", false],
    ]);
    expect(await vfs.sha1(`${root}/Mods/Pack/Extracted/readme.txt`)).toBe(createHash("sha1").update("").digest("hex"));
    expect(vfs.getMutations().map((m) => m.kind)).toEqual(["mkdir", "mkdir", "write", "write"]);
    await diskUntouched();
  });

  it("virtual files participate in wildcard resolution", async () => {
    await vfs.addVirtualFiles([{ path: `${root}/Mods/Pack/Extracted/Override/big.mod`, size: 1 }]);
    expect(await resolveWildcards(vfs, `${root}/mods/pack/extracted/override/*.MOD`)).toEqual([
      `${root}/Mods/Pack/Extracted/Override/big.mod`,
    ]);
    expect(await resolveWildcards(vfs, `${root}/Mods/**/*.mod`)).toEqual([`${root}/Mods/Pack/Extracted/Override/big.mod`]);
    await vfs.remove(`${root}/Mods/Pack/Extracted`);
    expect(await resolveWildcards(vfs, `${root}/Mods/**/*.mod`)).toEqual([]);
  });

  it("copying a virtual file keeps it virtual (empty content, tracked size)", async () => {
    await vfs.addVirtualFiles([{ path: `${root}/Mods/v.txt`, size: 5 }]);
    await vfs.copyFile(`${root}/Mods/v.txt`, `${root}/Game/Override/v.txt`);
    expect((await vfs.stat(`${root}/Game/Override/v.txt`))?.size).toBe(5);
    expect(await vfs.readFile(`${root}/Game/Override/v.txt`)).toEqual(new Uint8Array(0));
  });

  it("snapshots base listings lazily: later disk changes are not observed", async () => {
    expect((await vfs.readDir(`${root}/Game/Override`)).length).toBe(1);
    await writeFile(`${root}/Game/Override/late.txt`, "late");
    expect((await vfs.readDir(`${root}/Game/Override`)).length).toBe(1);
    expect(await vfs.exists(`${root}/Game/Override/late.txt`)).toBe(false);
  });

  it("readDir on a file or missing path throws with a code", async () => {
    await expect(vfs.readDir(`${root}/Mods/Loose.tpc`)).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(vfs.readDir(`${root}/nope`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(vfs.readFile(`${root}/Mods`)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("stat of the filesystem root works", async () => {
    expect((await vfs.stat("/"))?.isDirectory).toBe(true);
  });
});
