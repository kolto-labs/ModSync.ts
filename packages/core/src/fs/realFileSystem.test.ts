import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Toggle to simulate a cross-device rename (EXDEV) for the move fallback test.
const renameState = vi.hoisted(() => ({ failWithExdev: false, calls: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameState.failWithExdev) {
        renameState.calls++;
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      }
      return actual.rename(from, to);
    },
  };
});

import { toPosix } from "./paths.js";
import { RealFileSystem } from "./realFileSystem.js";

let root: string;
const fs = new RealFileSystem();

beforeEach(async () => {
  root = toPosix(await mkdtemp(path.join(tmpdir(), "modsync-rfs-")));
  await mkdir(`${root}/Mods/Sub Dir`, { recursive: true });
  await writeFile(`${root}/Mods/Alpha.TXT`, "alpha");
  await writeFile(`${root}/Mods/Sub Dir/beta.txt`, "beta");
  await mkdir(`${root}/Empty`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("RealFileSystem", () => {
  it("walk rejects symbolic links pointing outside its root", async () => {
    await symlink(`${root}/Empty`, `${root}/Mods/outside`, "dir");
    await expect(fs.walk(`${root}/Mods`)).rejects.toThrow(/outside root/);
  });

  it("walk terminates cycles while retaining internal linked directories", async () => {
    await symlink(`${root}/Mods`, `${root}/Mods/Sub Dir/cycle`, "dir");
    await symlink(`${root}/Mods/Sub Dir`, `${root}/Mods/linked`, "dir");
    const files = await fs.walk(`${root}/Mods`);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith("beta.txt"))).toBe(true);
  });

  it("is not virtual", () => {
    expect(fs.isVirtual).toBe(false);
  });

  it("exists/stat are case-insensitive", async () => {
    expect(await fs.exists(`${root}/mods/alpha.txt`)).toBe(true);
    expect(await fs.exists(`${root}/mods/nope.txt`)).toBe(false);
    const st = await fs.stat(`${root}/MODS/sub dir/BETA.TXT`);
    expect(st?.path).toBe(`${root}/Mods/Sub Dir/beta.txt`);
    expect(st?.isDirectory).toBe(false);
    expect(st?.size).toBe(4);
    expect((await fs.stat(`${root}/mods`))?.isDirectory).toBe(true);
  });

  it("resolveCase returns on-disk spelling, deepest existing ancestor first", async () => {
    expect(await fs.resolveCase(`${root}/MODS/SUB DIR/BETA.TXT`)).toBe(`${root}/Mods/Sub Dir/beta.txt`);
    expect(await fs.resolveCase(`${root}/Mods/Alpha.TXT`)).toBe(`${root}/Mods/Alpha.TXT`);
    expect(await fs.resolveCase(`${root}/mods/missing/x`)).toBeUndefined();
    expect(await fs.resolveCase(`${root}/Mods/Alpha.TXT/x`)).toBeUndefined();
    expect(await fs.resolveCase("/definitely/not/here/xyz")).toBeUndefined();
  });

  it("readDir returns sorted entries with posix paths", async () => {
    const entries = await fs.readDir(`${root}/mods`);
    expect(entries.map((e) => [e.name, e.isDirectory])).toEqual([
      ["Alpha.TXT", false],
      ["Sub Dir", true],
    ]);
    expect(entries[1].path).toBe(`${root}/Mods/Sub Dir`);
    await expect(fs.readDir(`${root}/nope`)).rejects.toThrow();
  });

  it("walk returns files only, recursively; missing dir yields []", async () => {
    expect((await fs.walk(`${root}/MODS`)).sort()).toEqual([`${root}/Mods/Alpha.TXT`, `${root}/Mods/Sub Dir/beta.txt`]);
    expect(await fs.walk(`${root}/Empty`)).toEqual([]);
    expect(await fs.walk(`${root}/missing`)).toEqual([]);
    expect(await fs.walk(`${root}/Mods/alpha.txt`)).toEqual([`${root}/Mods/Alpha.TXT`]);
  });

  it("readFile/writeFile with parent creation and case fallback", async () => {
    expect(Buffer.from(await fs.readFile(`${root}/mods/ALPHA.txt`)).toString()).toBe("alpha");
    await fs.writeFile(`${root}/new/deep/file.bin`, new Uint8Array([1, 2, 3]));
    expect(await readFile(`${root}/new/deep/file.bin`)).toEqual(Buffer.from([1, 2, 3]));
    // Overwriting through a different casing hits the existing file.
    await fs.writeFile(`${root}/mods/alpha.txt`, Buffer.from("ALPHA2"));
    expect((await readFile(`${root}/Mods/Alpha.TXT`)).toString()).toBe("ALPHA2");
  });

  it("mkdirp, copyFile, move (file and directory), remove", async () => {
    await fs.mkdirp(`${root}/a/b/c`);
    expect((await fs.stat(`${root}/a/b/c`))?.isDirectory).toBe(true);

    await fs.copyFile(`${root}/mods/alpha.txt`, `${root}/copy/alpha-copy.txt`);
    expect((await readFile(`${root}/copy/alpha-copy.txt`)).toString()).toBe("alpha");
    expect(await fs.exists(`${root}/Mods/Alpha.TXT`)).toBe(true);

    await fs.move(`${root}/copy/alpha-copy.txt`, `${root}/moved/renamed.txt`);
    expect(await fs.exists(`${root}/copy/alpha-copy.txt`)).toBe(false);
    expect((await readFile(`${root}/moved/renamed.txt`)).toString()).toBe("alpha");

    await fs.move(`${root}/mods/sub dir`, `${root}/moved/dir`);
    expect(await fs.exists(`${root}/Mods/Sub Dir`)).toBe(false);
    expect((await readFile(`${root}/moved/dir/beta.txt`)).toString()).toBe("beta");

    await fs.remove(`${root}/moved`);
    expect(await fs.exists(`${root}/moved`)).toBe(false);
    await expect(fs.remove(`${root}/moved`)).resolves.toBeUndefined();
  });

  it("creates, writes, copies and moves into an existing directory whatever the casing", async () => {
    await mkdir(`${root}/Game/override`, { recursive: true });
    await fs.mkdirp(`${root}/Game/Override/Sub/Deep`);
    expect((await readdir(`${root}/Game`)).sort()).toEqual(["override"]);
    expect((await readdir(`${root}/Game/override`)).sort()).toEqual(["Sub"]);

    await fs.writeFile(`${root}/GAME/OVERRIDE/Written.txt`, Buffer.from("w"));
    await fs.copyFile(`${root}/Mods/Alpha.TXT`, `${root}/game/Override/Copied.txt`);
    await fs.move(`${root}/Mods/Sub Dir/beta.txt`, `${root}/Game/OverRide/sub/Moved.txt`);
    expect((await readdir(`${root}/Game`)).sort()).toEqual(["override"]);
    expect((await readdir(`${root}/Game/override`)).sort()).toEqual(["Copied.txt", "Sub", "Written.txt"]);
    expect((await readdir(`${root}/Game/override/Sub`)).sort()).toEqual(["Deep", "Moved.txt"]);
  });

  it("keeps the requested spelling of the final segment when moving", async () => {
    await fs.move(`${root}/Mods/Alpha.TXT`, `${root}/Mods/ALPHA-renamed.TXT`);
    expect((await readdir(`${root}/Mods`)).sort()).toEqual(["ALPHA-renamed.TXT", "Sub Dir"]);
  });

  it("mkdirp reports ENOTDIR when a file blocks the path", async () => {
    await expect(fs.mkdirp(`${root}/Mods/Alpha.TXT/inner`)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("move falls back to copy+delete on EXDEV", async () => {
    renameState.failWithExdev = true;
    try {
      await fs.move(`${root}/Mods/Sub Dir`, `${root}/xdev/dir`);
      await fs.move(`${root}/Mods/Alpha.TXT`, `${root}/xdev/alpha.txt`);
    } finally {
      renameState.failWithExdev = false;
    }
    expect(renameState.calls).toBe(2);
    expect((await readFile(`${root}/xdev/dir/beta.txt`)).toString()).toBe("beta");
    expect((await readFile(`${root}/xdev/alpha.txt`)).toString()).toBe("alpha");
    expect(await fs.exists(`${root}/Mods/Sub Dir`)).toBe(false);
    expect(await fs.exists(`${root}/Mods/Alpha.TXT`)).toBe(false);
  });

  it("sha1 streams the file", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    await writeFile(`${root}/big.bin`, big);
    expect(await fs.sha1(`${root}/BIG.BIN`)).toBe(createHash("sha1").update(big).digest("hex"));
  });
});
