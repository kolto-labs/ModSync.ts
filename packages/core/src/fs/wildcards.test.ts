import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toPosix } from "./paths.js";
import { RealFileSystem } from "./realFileSystem.js";
import { resolveWildcards, splitWildcardPrefix } from "./wildcards.js";

let root: string;
const fs = new RealFileSystem();

beforeAll(async () => {
  root = toPosix(await mkdtemp(path.join(tmpdir(), "modsync-wild-")));
  await mkdir(`${root}/Mods/[K1] Foo (v1.2)/tslpatchdata`, { recursive: true });
  await mkdir(`${root}/Mods/Bar/Override`, { recursive: true });
  await mkdir(`${root}/Mods/.hidden`, { recursive: true });
  await writeFile(`${root}/Mods/[K1] Foo (v1.2)/foo.zip`, "");
  await writeFile(`${root}/Mods/[K1] Foo (v1.2)/tslpatchdata/changes.ini`, "");
  await writeFile(`${root}/Mods/Bar/bar.ZIP`, "");
  await writeFile(`${root}/Mods/Bar/Override/a.tpc`, "");
  await writeFile(`${root}/Mods/Bar/Override/b.TGA`, "");
  await writeFile(`${root}/Mods/.hidden/h.zip`, "");
  await writeFile(`${root}/Mods/top.7z`, "");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("splitWildcardPrefix", () => {
  it("splits at the first wildcard segment", () => {
    expect(splitWildcardPrefix("/a/b/*.zip")).toEqual({ dir: "/a/b", rest: "*.zip" });
    expect(splitWildcardPrefix("/a/**/x/*.tpc")).toEqual({ dir: "/a", rest: "**/x/*.tpc" });
    expect(splitWildcardPrefix("/a/b")).toEqual({ dir: "/a/b", rest: "" });
    expect(splitWildcardPrefix("C:\\Mods\\*")).toEqual({ dir: "C:/Mods", rest: "*" });
    expect(splitWildcardPrefix("/*")).toEqual({ dir: "/", rest: "*" });
    expect(splitWildcardPrefix("/a/b?c/d")).toEqual({ dir: "/a", rest: "b?c/d" });
  });
});

describe("resolveWildcards", () => {
  it("terminates recursive wildcard traversal through symbolic-link cycles", async () => {
    const dir = `${root}/Cycle`;
    await mkdir(dir);
    await writeFile(`${dir}/file.txt`, "safe");
    await symlink(dir, `${dir}/again`, "dir");
    expect(await resolveWildcards(fs, `${dir}/**/*.txt`)).toEqual([`${dir}/file.txt`]);
  });

  it("returns the case-resolved path for non-wildcard input, or []", async () => {
    expect(await resolveWildcards(fs, `${root}/mods/bar/BAR.zip`)).toEqual([`${root}/Mods/Bar/bar.ZIP`]);
    expect(await resolveWildcards(fs, `${root}/mods/missing.zip`)).toEqual([]);
  });

  it("matches * within one level, case-insensitively, including dot entries", async () => {
    expect(await resolveWildcards(fs, `${root}/Mods/*/*.zip`)).toEqual([
      `${root}/Mods/.hidden/h.zip`,
      `${root}/Mods/Bar/bar.ZIP`,
      `${root}/Mods/[K1] Foo (v1.2)/foo.zip`,
    ]);
    expect(await resolveWildcards(fs, `${root}/MODS/*.7Z`)).toEqual([`${root}/Mods/top.7z`]);
  });

  it("* does not cross directories; ** does", async () => {
    expect(await resolveWildcards(fs, `${root}/Mods/*.tpc`)).toEqual([]);
    expect(await resolveWildcards(fs, `${root}/Mods/**/*.tpc`)).toEqual([`${root}/Mods/Bar/Override/a.tpc`]);
    expect(await resolveWildcards(fs, `${root}/Mods/**/changes.ini`)).toEqual([
      `${root}/Mods/[K1] Foo (v1.2)/tslpatchdata/changes.ini`,
    ]);
  });

  it("matches directories too, and treats brackets/parens literally", async () => {
    expect(await resolveWildcards(fs, `${root}/Mods/[k1] foo (V1.2)/*`)).toEqual([
      `${root}/Mods/[K1] Foo (v1.2)/foo.zip`,
      `${root}/Mods/[K1] Foo (v1.2)/tslpatchdata`,
    ]);
    expect(await resolveWildcards(fs, `${root}/Mods/*/tslpatch*`)).toEqual([`${root}/Mods/[K1] Foo (v1.2)/tslpatchdata`]);
    expect(await resolveWildcards(fs, `${root}/Mods/[K1] Foo (v1.2)/foo.*`)).toEqual([`${root}/Mods/[K1] Foo (v1.2)/foo.zip`]);
  });

  it("? matches exactly one character", async () => {
    expect(await resolveWildcards(fs, `${root}/Mods/Bar/Override/?.tpc`)).toEqual([`${root}/Mods/Bar/Override/a.tpc`]);
    expect(await resolveWildcards(fs, `${root}/Mods/Bar/Override/??.tpc`)).toEqual([]);
  });

  it("returns [] when the wildcard-free prefix does not exist", async () => {
    expect(await resolveWildcards(fs, `${root}/Nope/*.zip`)).toEqual([]);
    expect(await resolveWildcards(fs, `${root}/Mods/top.7z/*`)).toEqual([]);
  });
});
