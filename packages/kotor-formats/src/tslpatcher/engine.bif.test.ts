import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResourceTypes } from "../restypes.js";
import { TwoDA, read2da, write2da } from "../twoda.js";
import { parseChangesIni } from "./config.js";
import { TslPatcher } from "./engine.js";
import { NodePatcherFs } from "./nodeFs.js";

class PlaceholderNodeFs extends NodePatcherFs {
  readonly isVirtual = true;
}

function wholeFileFs(): NodePatcherFs {
  const fs = new NodePatcherFs();
  Reflect.set(fs, "readRange", undefined);
  return fs;
}

function put32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function ascii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i);
}

function buildBif(resources: { type: number; data: Uint8Array }[]): Uint8Array {
  const dataStart = 20 + resources.length * 16;
  const out = new Uint8Array(dataStart + resources.reduce((sum, r) => sum + r.data.length, 0));
  const view = new DataView(out.buffer);
  ascii(out, 0, "BIFFV1  ");
  put32(view, 8, resources.length);
  put32(view, 16, 20);
  let cursor = dataStart;
  resources.forEach((r, i) => {
    const at = 20 + i * 16;
    put32(view, at, i);
    put32(view, at + 4, cursor);
    put32(view, at + 8, r.data.length);
    put32(view, at + 12, r.type);
    out.set(r.data, cursor);
    cursor += r.data.length;
  });
  return out;
}

function buildKey(bif: string, keys: { resref: string; type: number; index: number }[]): Uint8Array {
  const names = 64 + 12;
  const keyTable = names + bif.length + 1;
  const out = new Uint8Array(keyTable + keys.length * 22);
  const view = new DataView(out.buffer);
  ascii(out, 0, "KEY V1  ");
  put32(view, 8, 1);
  put32(view, 12, keys.length);
  put32(view, 16, 64);
  put32(view, 20, keyTable);
  put32(view, 64 + 4, names);
  view.setUint16(64 + 8, bif.length + 1, true);
  ascii(out, names, bif);
  keys.forEach((k, i) => {
    const at = keyTable + i * 22;
    ascii(out, at, k.resref);
    view.setUint16(at + 16, k.type, true);
    put32(view, at + 18, k.index);
  });
  return out;
}

const INI = `[2DAList]\nTable0=appearance.2da\n[appearance.2da]\nChangeRow0=row_fix\n[row_fix]\nRowIndex=0\nlabel=patched`;

let tmp: string;
let gameDir: string;
let dataDir: string;

function table(label: string, extraColumn?: string): Uint8Array {
  const t = new TwoDA(extraColumn ? ["label", extraColumn] : ["label"]);
  t.addRow("0", { label, ...(extraColumn ? { [extraColumn]: "x" } : {}) });
  return write2da(t);
}

async function installBaseGame(): Promise<void> {
  await fsp.mkdir(path.join(gameDir, "data"), { recursive: true });
  await fsp.writeFile(path.join(gameDir, "data", "2da.bif"), buildBif([{ type: ResourceTypes.utc, data: Uint8Array.from([1]) }, { type: ResourceTypes["2da"], data: table("from_bif") }]));
  await fsp.writeFile(path.join(gameDir, "chitin.key"), buildKey("data\\2da.bif", [{ resref: "Appearance", type: ResourceTypes["2da"], index: 1 }]));
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "kotor-formats-bif-"));
  gameDir = path.join(tmp, "game");
  dataDir = path.join(tmp, "mod", "tslpatchdata");
  await fsp.mkdir(path.join(gameDir, "Override"), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const run = (fs: NodePatcherFs, dryRun = false) => new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs, dryRun }).apply(parseChangesIni(INI));
const outputColumns = async (): Promise<string[]> => read2da(await fsp.readFile(path.join(gameDir, "Override", "appearance.2da"))).columns;
const outputLabel = async (): Promise<string | undefined> => read2da(await fsp.readFile(path.join(gameDir, "Override", "appearance.2da"))).getCell(0, "label");

describe("base-game BIF fallback", () => {
  it("patches a 2DA that exists only in a BIF listed by chitin.key", async () => {
    await installBaseGame();
    const log = await run(new NodePatcherFs());
    expect(log.errors).toEqual([]);
    expect(log.unverified).toEqual([]);
    expect(await outputLabel()).toBe("patched");
  });

  it("works with a file system that cannot read byte ranges", async () => {
    await installBaseGame();
    const log = await run(wholeFileFs());
    expect(log.errors).toEqual([]);
    expect(await outputLabel()).toBe("patched");
  });

  it("prefers Override, then tslpatchdata, over the BIF copy", async () => {
    await installBaseGame();
    await fsp.writeFile(path.join(gameDir, "Override", "appearance.2da"), table("from_override", "col_override"));
    await fsp.writeFile(path.join(dataDir, "appearance.2da"), table("from_tslpatchdata", "col_tslpatchdata"));
    const overrideLog = await run(new NodePatcherFs());
    expect(overrideLog.errors).toEqual([]);
    expect(await outputColumns()).toEqual(["label", "col_override"]);

    await fsp.rm(path.join(gameDir, "Override", "appearance.2da"));
    const dataLog = await run(new NodePatcherFs());
    expect(dataLog.errors).toEqual([]);
    expect(await outputColumns()).toEqual(["label", "col_tslpatchdata"]);

    await fsp.rm(path.join(gameDir, "Override", "appearance.2da"));
    await fsp.rm(path.join(dataDir, "appearance.2da"));
    const bifLog = await run(new NodePatcherFs());
    expect(bifLog.errors).toEqual([]);
    expect(await outputColumns()).toEqual(["label"]);
  });

  it("works in a virtual dry run when chitin.key and the BIF are real", async () => {
    await installBaseGame();
    const log = await run(new PlaceholderNodeFs(), true);
    expect(log.errors).toEqual([]);
    expect(log.unverified).toEqual([]);
    expect(log.filesWritten).toEqual([path.join(gameDir, "Override", "appearance.2da")]);
  });

  it("reports unverified in a virtual dry run when chitin.key is a zero-byte placeholder", async () => {
    await fsp.writeFile(path.join(gameDir, "chitin.key"), new Uint8Array(0));
    const log = await run(new PlaceholderNodeFs(), true);
    expect(log.errors).toEqual([]);
    expect(log.unverified).toHaveLength(1);
    expect(log.unverified[0]).toMatch(/appearance\.2da.*chitin\.key is a zero-byte virtual placeholder/);
  });

  it("reports unverified in a virtual dry run when chitin.key is absent or the BIF is a placeholder", async () => {
    const absent = await run(new PlaceholderNodeFs(), true);
    expect(absent.errors).toEqual([]);
    expect(absent.unverified[0]).toMatch(/chitin\.key is absent from the virtual game/);

    await installBaseGame();
    await fsp.writeFile(path.join(gameDir, "data", "2da.bif"), new Uint8Array(0));
    const placeholder = await run(new PlaceholderNodeFs(), true);
    expect(placeholder.errors).toEqual([]);
    expect(placeholder.unverified[0]).toMatch(/data\/2da\.bif, a zero-byte virtual placeholder/);
  });

  it("stays a hard error in a real run when the resource is found nowhere", async () => {
    const noKey = await run(new NodePatcherFs());
    expect(noKey.errors.join("\n")).toMatch(/appearance\.2da not found in .*Override.* nor in tslpatchdata nor in the base game's chitin\.key\/BIF archives \(chitin\.key not found/);

    await installBaseGame();
    await fsp.writeFile(path.join(gameDir, "chitin.key"), buildKey("data\\2da.bif", []));
    const unlisted = await run(new NodePatcherFs());
    expect(unlisted.errors.join("\n")).toMatch(/not listed in chitin\.key/);
    expect(unlisted.unverified).toEqual([]);

    const virtualUnlisted = await run(new PlaceholderNodeFs(), true);
    expect(virtualUnlisted.errors.join("\n")).toMatch(/not listed in chitin\.key/);
  });

  it("is a hard error in a real run when the BIF is missing or chitin.key is empty", async () => {
    await installBaseGame();
    await fsp.rm(path.join(gameDir, "data", "2da.bif"));
    const missing = await run(new NodePatcherFs());
    expect(missing.errors.join("\n")).toMatch(/places it in data\/2da\.bif, which is missing/);

    await fsp.writeFile(path.join(gameDir, "chitin.key"), new Uint8Array(0));
    const empty = await run(new NodePatcherFs());
    expect(empty.errors.join("\n")).toMatch(/chitin\.key is empty \(0 bytes\)/);

    await fsp.writeFile(path.join(gameDir, "chitin.key"), Uint8Array.from([1, 2, 3]));
    const corrupt = await run(new NodePatcherFs());
    expect(corrupt.errors.join("\n")).toMatch(/cannot read .*chitin\.key: KEY too small/);
  });
});
