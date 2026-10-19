import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toPosix } from "../fs/paths.js";
import type { ArchiveEntry, ArchiveReader } from "../ports/archive.js";
import { findEntry, normalizeEntryPath, reconcileDirectoryEntries, zipAttributesMarkDirectory } from "./common.js";
import {
  ArchiveEntryNotFoundError,
  UnsupportedArchiveError,
  createArchiveOpener,
  detectArchiveFormat,
  detectArchiveFormatFromBytes,
  isArchiveExtension,
  openArchive,
} from "./index.js";
import { openRar } from "./rar.js";
import { SevenZipArchive, openSevenZip, parseSevenZipListing, runSevenZipWasm, sevenZipAttributesMarkDirectory } from "./sevenZip.js";
import { NotAnSfxArchiveError, findSevenZipSignature, openSfx } from "./sfx.js";
import { openZip } from "./zip.js";

let root: string;
const text = (s: string) => new TextEncoder().encode(s);

/** Files every generated fixture contains. */
const FIXTURE_FILES: Record<string, string> = {
  "readme.txt": "hello archive\n",
  "Override/Nested.TPC": "nested content",
  "Override/deep/leaf.2da": "leaf",
};

// ---- fixture builders -------------------------------------------------------

function buildZip(): Uint8Array {
  return zipSync({
    "readme.txt": text(FIXTURE_FILES["readme.txt"]),
    "Override/": new Uint8Array(0),
    "Override/Nested.TPC": text(FIXTURE_FILES["Override/Nested.TPC"]),
    "Override/deep/leaf.2da": text(FIXTURE_FILES["Override/deep/leaf.2da"]),
  });
}

/** Build a 7z archive with 7z-wasm itself (`a` command) from a directory tree. */
async function buildSevenZip(srcDir: string, outFile: string): Promise<void> {
  const result = await runSevenZipWasm(
    ["a", "-y", "-bd", "-bsp0", "/mnt/out/" + path.basename(outFile), "/mnt/src/readme.txt", "/mnt/src/Override"],
    [
      { host: srcDir, mountPoint: "/mnt/src" },
      { host: path.dirname(outFile), mountPoint: "/mnt/out" },
    ],
  );
  if (result.code !== 0) throw new Error(`7z a failed: ${result.stderr}`);
}

/**
 * Hand-craft a RAR 4.x archive with "Storing" method: marker block, main
 * header, one file block per entry (with CRC32 of the data), end block.
 * Header CRC is the low 16 bits of CRC32 over the header after the CRC field.
 */
function buildRar(files: Record<string, string>): Buffer {
  const block = (type: number, flags: number, body: Buffer): Buffer => {
    const b = Buffer.alloc(7 + body.length);
    b.writeUInt8(type, 2);
    b.writeUInt16LE(flags, 3);
    b.writeUInt16LE(b.length, 5);
    body.copy(b, 7);
    b.writeUInt16LE(zlib.crc32(b.subarray(2)) & 0xffff, 0);
    return b;
  };
  const fileBlock = (name: string, data: Buffer): Buffer => {
    const nameBuf = Buffer.from(name.replace(/\//g, "\\"), "latin1");
    const body = Buffer.alloc(25 + nameBuf.length);
    body.writeUInt32LE(data.length, 0); // PACK_SIZE
    body.writeUInt32LE(data.length, 4); // UNP_SIZE
    body.writeUInt8(2, 8); // HOST_OS = Win32
    body.writeUInt32LE(zlib.crc32(data) >>> 0, 9); // FILE_CRC
    body.writeUInt32LE(0, 13); // FTIME
    body.writeUInt8(20, 17); // UNP_VER
    body.writeUInt8(0x30, 18); // METHOD = storing
    body.writeUInt16LE(nameBuf.length, 19);
    body.writeUInt32LE(0x20, 21); // ATTR
    nameBuf.copy(body, 25);
    return Buffer.concat([block(0x74, 0x8000, body), data]);
  };
  const parts = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), block(0x73, 0, Buffer.alloc(6))];
  for (const [name, content] of Object.entries(files)) parts.push(fileBlock(name, Buffer.from(content)));
  parts.push(block(0x7b, 0x4000, Buffer.alloc(0)));
  return Buffer.concat(parts);
}

let zipPath: string;
let sevenZipPath: string;
let sfxPath: string;
let rarPath: string;
let plainPath: string;
let plainExePath: string;

beforeAll(async () => {
  root = toPosix(await mkdtemp(path.join(tmpdir(), "modsync-arc-")));
  const src = `${root}/src`;
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    await mkdir(path.dirname(`${src}/${rel}`), { recursive: true });
    await writeFile(`${src}/${rel}`, content);
  }
  zipPath = `${root}/Fixture.ZIP`;
  await writeFile(zipPath, buildZip());

  sevenZipPath = `${root}/fixture.7z`;
  await buildSevenZip(src, sevenZipPath);

  // Fake SFX: an "MZ" stub of a few KB of zeros followed by the 7z payload.
  sfxPath = `${root}/installer.exe`;
  const stub = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(3 * 1024 + 5)]);
  await writeFile(sfxPath, Buffer.concat([stub, await readFile(sevenZipPath)]));

  rarPath = `${root}/fixture.rar`;
  await writeFile(rarPath, buildRar(FIXTURE_FILES));

  plainPath = `${root}/notes.txt`;
  await writeFile(plainPath, "just text");
  plainExePath = `${root}/plain.exe`;
  await writeFile(plainExePath, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(2048, 1)]));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---- shared expectations ----------------------------------------------------

async function expectFixtureListing(reader: ArchiveReader): Promise<void> {
  const entries = await reader.list();
  const files = entries.filter((e) => !e.isDirectory);
  expect(files.map((e) => e.path).sort()).toEqual(Object.keys(FIXTURE_FILES).sort());
  for (const f of files) expect(f.size).toBe(FIXTURE_FILES[f.path].length);
  for (const e of entries) {
    expect(e.path.startsWith("/")).toBe(false);
    expect(e.path.endsWith("/")).toBe(false);
    expect(e.path).not.toContain("\\");
  }
}

async function expectFixtureExtraction(reader: ArchiveReader, dest: string): Promise<void> {
  const written = await reader.extract(dest);
  expect(written.sort()).toEqual(Object.keys(FIXTURE_FILES).map((p) => `${dest}/${p}`).sort());
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    expect((await readFile(`${dest}/${rel}`)).toString()).toBe(content);
  }
}

async function expectFilteredExtraction(reader: ArchiveReader, dest: string): Promise<void> {
  const written = await reader.extract(dest, (e: ArchiveEntry) => e.path.toLowerCase().endsWith(".tpc"));
  expect(written).toEqual([`${dest}/Override/Nested.TPC`]);
  expect((await readFile(`${dest}/Override/Nested.TPC`)).toString()).toBe(FIXTURE_FILES["Override/Nested.TPC"]);
  await expect(readFile(`${dest}/readme.txt`)).rejects.toThrow();
}

async function expectReadEntry(reader: ArchiveReader): Promise<void> {
  expect(new TextDecoder().decode(await reader.readEntry("Override/deep/leaf.2da"))).toBe("leaf");
  // Case-insensitive fallback and backslash tolerance.
  expect(new TextDecoder().decode(await reader.readEntry("override\\nested.tpc"))).toBe("nested content");
  await expect(reader.readEntry("missing.txt")).rejects.toThrow(ArchiveEntryNotFoundError);
}

// ---- tests ------------------------------------------------------------------

describe("common helpers", () => {
  it("normalizeEntryPath cleans names and rejects escapes", () => {
    expect(normalizeEntryPath("./a/b.txt")).toEqual({ path: "a/b.txt", isDirectory: false });
    expect(normalizeEntryPath("/a\\b/")).toEqual({ path: "a/b", isDirectory: true });
    expect(normalizeEntryPath("a//b")).toEqual({ path: "a/b", isDirectory: false });
    expect(normalizeEntryPath("C:\\x\\y")).toEqual({ path: "x/y", isDirectory: false });
    expect(normalizeEntryPath("../evil")).toBeUndefined();
    expect(normalizeEntryPath("a/../../evil")).toBeUndefined();
    expect(normalizeEntryPath("")).toBeUndefined();
    expect(normalizeEntryPath("./")).toBeUndefined();
    expect(normalizeEntryPath("safe\nother")).toBeUndefined();
  });

  it("findEntry prefers exact then case-insensitive matches", () => {
    const entries = [
      { path: "a/B.txt", isDirectory: false, size: 1 },
      { path: "a/b.txt", isDirectory: false, size: 2 },
    ];
    expect(findEntry(entries, "a/b.txt")?.size).toBe(2);
    expect(findEntry(entries, "A/B.TXT")?.size).toBe(1);
    expect(findEntry(entries, "nope")).toBeUndefined();
  });
});

describe("streaming extraction guards", () => {
  it("applies beforeWrite denial for every native adapter before any file writes", async () => {
    for (const [index, archive] of [zipPath, rarPath, sevenZipPath, sfxPath].entries()) {
      const reader = await openArchive(archive);
      const dest = `${root}/deny-${index}`;
      const checked: string[] = [];
      try {
        await expect(reader.extract(dest, undefined, { beforeWrite: (target, entry) => {
          checked.push(target);
          if (entry && !entry.isDirectory) throw new Error("denied destination");
        } })).rejects.toThrow("denied destination");
        expect(checked.some((target) => target.endsWith("Nested.TPC"))).toBe(true);
        await expect(readFile(`${dest}/Override/Nested.TPC`)).rejects.toThrow();
        await expect(readFile(`${dest}/readme.txt`)).rejects.toThrow();
      } finally { await reader.close(); }
    }
  });

  it("rejects archive links before native 7z extraction", () => {
    expect(() => parseSevenZipListing("Path = redirect\nSize = 0\nSymbolic Link = /outside\nAttributes = A_ lrwxrwxrwx\n")).toThrow("links are not supported");
  });

  it("rechecks containment after a callback changes a parent into a symlink", async () => {
    if (process.platform === "win32") return;
    const dest = `${root}/callback-destination`;
    const outside = `${root}/callback-outside`;
    await mkdir(outside);
    await writeFile(`${outside}/Nested.TPC`, "untouched");
    const reader = await openZip(zipPath);
    let redirected = false;
    try {
      await expect(reader.extract(dest, undefined, { beforeWrite: async (target, entry) => {
        if (!redirected && entry?.path === "Override/Nested.TPC") {
          redirected = true;
          await rm(`${dest}/Override`, { recursive: true, force: true });
          await symlink(outside, `${dest}/Override`);
        }
      } })).rejects.toThrow(/outside|escape/i);
      expect(await readFile(`${outside}/Nested.TPC`, "utf8")).toBe("untouched");
    } finally { await reader.close(); }
  });

  it("cancels streaming extraction and does not start subsequent entries", async () => {
    const large = `${root}/large.zip`;
    await writeFile(large, zipSync({ "large.bin": new Uint8Array(16 * 1024 * 1024).fill(65), "z-next.txt": text("must not start") }));
    const reader = await openZip(large);
    const controller = new AbortController();
    let scheduled = false;
    try {
      await expect(reader.extract(`${root}/cancelled`, undefined, { signal: controller.signal, beforeWrite: (_target, entry) => {
        if (!scheduled && entry?.path === "large.bin") {
          scheduled = true;
          setTimeout(() => controller.abort(), 5);
        }
      } })).rejects.toMatchObject({ name: "AbortError" });
      await expect(readFile(`${root}/cancelled/z-next.txt`)).rejects.toThrow();
    } finally { await reader.close(); }
  });
});

describe("directory entry classification", () => {
  const isDirectory = async (file: string): Promise<boolean> => (await stat(file)).isDirectory();

  it("reconcileDirectoryEntries turns parents of other entries into directories and merges duplicates", () => {
    const entries = [
      { path: "Override", isDirectory: false, size: 0 },
      { path: "override", isDirectory: true, size: 0 },
      { path: "Override/a.tpc", isDirectory: false, size: 3 },
      { path: "tslpatchdata", isDirectory: false, size: 0 },
      { path: "tslpatchdata/changes.ini", isDirectory: false, size: 7 },
      { path: "Pack1.2", isDirectory: false, size: 9 },
      { path: "readme.txt", isDirectory: false, size: 1 },
    ];
    expect(reconcileDirectoryEntries(entries)).toEqual([
      { path: "Override", isDirectory: true, size: 0 },
      { path: "Override/a.tpc", isDirectory: false, size: 3 },
      { path: "tslpatchdata", isDirectory: true, size: 0 },
      { path: "tslpatchdata/changes.ini", isDirectory: false, size: 7 },
      { path: "Pack1.2", isDirectory: false, size: 9 },
      { path: "readme.txt", isDirectory: false, size: 1 },
    ]);
  });

  it("recognises 7z directory attributes whatever other flags are set", () => {
    for (const attributes of ["D", "D drwxr-xr-x", "RD", "HD drwxr-xr-x", "HSD", "DA", "D_ drwxr-xr-x", " drwxr-xr-x"]) {
      expect(sevenZipAttributesMarkDirectory(attributes), attributes).toBe(true);
    }
    for (const attributes of ["", "A", "A -rw-r--r--", " -rw-r--r--", "RHSA", "A_ -rwxr-xr-x"]) {
      expect(sevenZipAttributesMarkDirectory(attributes), attributes).toBe(false);
    }
  });

  it("parseSevenZipListing lists read-only and hidden folders and attribute-less parents as directories", () => {
    const listing = [
      "Path = Override",
      "Size = 0",
      "Attributes = RD",
      "",
      "Path = tslpatchdata",
      "Size = 0",
      "Attributes = HD drwxr-xr-x",
      "",
      "Path = Pack1.2",
      "Size = 0",
      "Attributes = A",
      "",
      "Path = Pack1.2\\notes.txt",
      "Size = 4",
      "Attributes = A",
      "",
    ].join("\n");
    expect(parseSevenZipListing(listing)).toEqual([
      { path: "Override", isDirectory: true, size: 0 },
      { path: "Pack1.2", isDirectory: true, size: 0 },
      { path: "Pack1.2/notes.txt", isDirectory: false, size: 4 },
      { path: "tslpatchdata", isDirectory: true, size: 0 },
    ]);
  });

  it("recognises zip DOS and Unix directory attributes", () => {
    expect(zipAttributesMarkDirectory(0x10)).toBe(true);
    expect(zipAttributesMarkDirectory((0o040755 << 16) >>> 0)).toBe(true);
    expect(zipAttributesMarkDirectory(0x20)).toBe(false);
    expect(zipAttributesMarkDirectory((0o100644 << 16) >>> 0)).toBe(false);
  });

  it("extracts zip folders stored without a trailing slash", async () => {
    const file = `${root}/slashless.zip`;
    await writeFile(file, zipSync({
      Override: [new Uint8Array(0), { attrs: 0x10 }],
      tslpatchdata: [new Uint8Array(0), { os: 3, attrs: (0o040755 << 16) >>> 0 }],
      "Pack1.2": new Uint8Array(0),
      "Override/Nested.TPC": text("nested"),
      "tslpatchdata/changes.ini": text("[Settings]"),
      "Pack1.2/readme.txt": text("hello"),
    }));
    const reader = await openZip(file);
    try {
      const entries = await reader.list();
      for (const name of ["Override", "tslpatchdata", "Pack1.2"]) {
        expect(entries.find((e) => e.path === name), name).toMatchObject({ isDirectory: true, size: 0 });
      }
      const dest = `${root}/out-slashless`;
      await reader.extract(dest);
      for (const name of ["Override", "tslpatchdata", "Pack1.2"]) expect(await isDirectory(`${dest}/${name}`), name).toBe(true);
      expect(await readFile(`${dest}/Override/Nested.TPC`, "utf8")).toBe("nested");
      expect(await readFile(`${dest}/Pack1.2/readme.txt`, "utf8")).toBe("hello");
    } finally { await reader.close(); }
  });

  it("replaces a stale file left where the archive needs a folder", async () => {
    const dest = `${root}/out-stale`;
    await mkdir(dest, { recursive: true });
    await writeFile(`${dest}/Override`, "stale file from an earlier run");
    const reader = await openZip(zipPath);
    try {
      await reader.extract(dest);
      expect(await isDirectory(`${dest}/Override`)).toBe(true);
      expect(await readFile(`${dest}/Override/Nested.TPC`, "utf8")).toBe(FIXTURE_FILES["Override/Nested.TPC"]);
    } finally { await reader.close(); }
  });

  it("extracts rar folders that are recorded like files", async () => {
    const file = `${root}/folder-as-file.rar`;
    await writeFile(file, buildRar({ Override: "", "Override/Nested.TPC": "nested" }));
    const reader = await openRar(file);
    try {
      expect(await reader.list()).toEqual([
        { path: "Override", isDirectory: true, size: 0 },
        { path: "Override/Nested.TPC", isDirectory: false, size: 6 },
      ]);
      const dest = `${root}/out-rar-folder`;
      await reader.extract(dest);
      expect(await isDirectory(`${dest}/Override`)).toBe(true);
      expect(await readFile(`${dest}/Override/Nested.TPC`, "utf8")).toBe("nested");
    } finally { await reader.close(); }
  });
});

describe("detection", () => {
  it("isArchiveExtension", () => {
    expect(isArchiveExtension("Mod.ZIP")).toBe(true);
    expect(isArchiveExtension("mod.rar")).toBe(true);
    expect(isArchiveExtension("mod.7z")).toBe(true);
    expect(isArchiveExtension("Setup.exe")).toBe(true);
    expect(isArchiveExtension("mod.tar.gz")).toBe(false);
    expect(isArchiveExtension("readme.txt")).toBe(false);
  });

  it("detectArchiveFormatFromBytes recognises every magic", () => {
    expect(detectArchiveFormatFromBytes(text("PK\x03\x04xxxx"))).toBe("zip");
    expect(detectArchiveFormatFromBytes(text("PK\x05\x06"))).toBe("zip");
    expect(detectArchiveFormatFromBytes(Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe("rar");
    expect(detectArchiveFormatFromBytes(Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))).toBe("rar");
    expect(detectArchiveFormatFromBytes(Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]))).toBe("7z");
    expect(detectArchiveFormatFromBytes(text("MZ\x90\x00"))).toBe("mz");
    expect(detectArchiveFormatFromBytes(text("hello"))).toBeUndefined();
    expect(detectArchiveFormatFromBytes(new Uint8Array(0))).toBeUndefined();
  });

  it("detectArchiveFormat reads magic bytes from disk, ignoring the extension", async () => {
    expect(await detectArchiveFormat(zipPath)).toBe("zip");
    expect(await detectArchiveFormat(sevenZipPath)).toBe("7z");
    expect(await detectArchiveFormat(rarPath)).toBe("rar");
    expect(await detectArchiveFormat(sfxPath)).toBe("7z-sfx");
    expect(await detectArchiveFormat(plainExePath)).toBeUndefined();
    expect(await detectArchiveFormat(plainPath)).toBeUndefined();
    const misnamed = `${root}/actually-a-zip.7z`;
    await writeFile(misnamed, buildZip());
    expect(await detectArchiveFormat(misnamed)).toBe("zip");
    await expect(detectArchiveFormat(`${root}/missing.zip`)).rejects.toThrow();
  });

  it("openArchive dispatches by content and rejects unknown files", async () => {
    for (const p of [zipPath, sevenZipPath, sfxPath, rarPath]) {
      const reader = await openArchive(p);
      await expectFixtureListing(reader);
      await reader.close();
    }
    const formats = await Promise.all([zipPath, sevenZipPath, sfxPath, rarPath].map(async (p) => (await openArchive(p)).format));
    expect(formats).toEqual(["zip", "7z", "7z-sfx", "rar"]);
    await expect(openArchive(plainPath)).rejects.toThrow(UnsupportedArchiveError);
    const opener = createArchiveOpener();
    expect(await opener.detect(zipPath)).toBe("zip");
    expect((await opener.open(zipPath)).archivePath).toBe(zipPath);
  });
});

describe("zip", () => {
  it("lists, extracts, filters and reads entries", async () => {
    const reader = await openZip(zipPath);
    expect(reader.format).toBe("zip");
    await expectFixtureListing(reader);
    expect((await reader.list()).find((e) => e.path === "Override")?.isDirectory).toBe(true);
    await expectFixtureExtraction(reader, `${root}/out-zip`);
    await expectFilteredExtraction(reader, `${root}/out-zip-filtered`);
    await expectReadEntry(reader);
    await reader.close();
    await reader.close(); // idempotent
  });

  it("rejects zip-slip entries and corrupt files", async () => {
    const evil = `${root}/evil.zip`;
    await writeFile(evil, zipSync({ "../escape.txt": text("x"), "ok.txt": text("y") }));
    const reader = await openZip(evil);
    await expect(reader.list()).rejects.toThrow(/Invalid zip entry/);
    await reader.close();
    const corrupt = `${root}/corrupt.zip`;
    await writeFile(corrupt, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(64, 9)]));
    await expect(openZip(corrupt)).rejects.toThrow();
  });
});

describe("7z", () => {
  it("parseSevenZipListing handles -slt blocks", () => {
    const listing = [
      "Path = sub",
      "Size = 0",
      "Attributes = D drwxr-xr-x",
      "",
      "Path = sub\\B.TXT",
      "Size = 6",
      "Packed Size = ",
      "Attributes = A -rw-r--r--",
      "",
      "Path = archive.7z",
      "Type = 7z",
      "Physical Size = 191",
      "",
    ].join("\r\n");
    expect(parseSevenZipListing(listing)).toEqual([
      { path: "sub", isDirectory: true, size: 0 },
      { path: "sub/B.TXT", isDirectory: false, size: 6 },
    ]);
  });

  it("lists, extracts, filters and reads entries via 7z-wasm", async () => {
    const reader = await openSevenZip(sevenZipPath);
    expect(reader.format).toBe("7z");
    await expectFixtureListing(reader);
    expect((await reader.list()).find((e) => e.path === "Override")?.isDirectory).toBe(true);
    await expectFixtureExtraction(reader, `${root}/out-7z`);
    await expectFilteredExtraction(reader, `${root}/out-7z-filtered`);
    await expectReadEntry(reader);
    await reader.close();
  });

  it("supports a byte offset into the file and cleans up its temp slice", async () => {
    const offset = await findSevenZipSignature(sfxPath);
    expect(offset).toBe(2 + 3 * 1024 + 5);
    const reader = await SevenZipArchive.open({ path: sfxPath, offset: offset! }, { format: "7z-sfx" });
    expect(reader.format).toBe("7z-sfx");
    expect(reader.offset).toBe(offset);
    await expectFixtureListing(reader);
    await expectFixtureExtraction(reader, `${root}/out-offset`);
    await reader.close();
  });

  it("fails clearly on corrupt and missing archives, and keeps working afterwards", async () => {
    const corrupt = `${root}/corrupt.7z`;
    await writeFile(corrupt, Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(40, 7)]));
    await expect(openSevenZip(corrupt)).rejects.toThrow(/7z-wasm exited with code/);
    await expect(openSevenZip(`${root}/missing.7z`)).rejects.toThrow();
    const reader = await openSevenZip(sevenZipPath);
    await expectFixtureListing(reader);
    await reader.close();
  });

  it("uses the CLI fallback when configured and the wasm run fails", async () => {
    // A fake "7z" CLI that only knows how to answer `l` with a canned listing.
    const fake = `${root}/fake7z.sh`;
    await writeFile(
      fake,
      '#!/bin/sh\ncase "$1" in\n  l) printf "Path = cli.txt\\nSize = 3\\nAttributes = A\\n\\n"; exit 0;;\n  *) exit 1;;\nesac\n',
      { mode: 0o755 },
    );
    const corrupt = `${root}/corrupt2.7z`;
    await writeFile(corrupt, Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(40, 3)]));
    if (process.platform === "win32") return;
    const reader = await openSevenZip(corrupt, { sevenZipPath: fake });
    expect(await reader.list()).toEqual([{ path: "cli.txt", isDirectory: false, size: 3 }]);
    await expect(reader.extract(`${root}/out-cli`)).rejects.toThrow(/CLI fallback/);
    await reader.close();
    // Without the fallback the same archive is a hard error.
    await expect(openSevenZip(corrupt)).rejects.toThrow();
  });
});

describe("sfx", () => {
  it("findSevenZipSignature scans in chunks, across chunk boundaries", async () => {
    const expected = 2 + 3 * 1024 + 5;
    expect(await findSevenZipSignature(sfxPath)).toBe(expected);
    expect(await findSevenZipSignature(sfxPath, { chunkSize: 7 })).toBe(expected);
    expect(await findSevenZipSignature(sfxPath, { chunkSize: 1024 })).toBe(expected);
    expect(await findSevenZipSignature(sfxPath, { chunkSize: expected - 3 })).toBe(expected);
    expect(await findSevenZipSignature(sfxPath, { start: 2, chunkSize: 1000 })).toBe(expected);
    expect(await findSevenZipSignature(sfxPath, { maxBytes: 100 })).toBeUndefined();
    expect(await findSevenZipSignature(plainExePath)).toBeUndefined();
    expect(await findSevenZipSignature(sevenZipPath)).toBe(0);
  });

  it("openSfx hands the payload to the 7z adapter", async () => {
    const reader = await openSfx(sfxPath);
    expect(reader.format).toBe("7z-sfx");
    expect(reader.archivePath).toBe(sfxPath);
    await expectFixtureListing(reader);
    await expectFixtureExtraction(reader, `${root}/out-sfx`);
    await expectFilteredExtraction(reader, `${root}/out-sfx-filtered`);
    await expectReadEntry(reader);
    await reader.close();
    await expect(openSfx(plainExePath)).rejects.toThrow(NotAnSfxArchiveError);
  });
});

describe("rar", () => {
  it("lists, extracts, filters and reads entries from a stored RAR4 archive", async () => {
    const reader = await openRar(rarPath);
    expect(reader.format).toBe("rar");
    await expectFixtureListing(reader);
    await expectFixtureExtraction(reader, `${root}/out-rar`);
    await expectFilteredExtraction(reader, `${root}/out-rar-filtered`);
    await expectReadEntry(reader);
    await reader.close();
  });

  it("rejects corrupt rar files", async () => {
    const corrupt = `${root}/corrupt.rar`;
    await writeFile(corrupt, Buffer.concat([Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), Buffer.alloc(30, 5)]));
    await expect(openRar(corrupt)).rejects.toThrow();
  });
});
