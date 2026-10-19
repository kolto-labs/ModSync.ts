import { describe, expect, it } from "vitest";
import { KeyBifError, bifSourceFromBytes, parseKey, readBifResource } from "./keybif.js";

function put32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function ascii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i);
}

function buildBif(resources: { type: number; data: number[] }[]): Uint8Array {
  const tableOffset = 20;
  const dataStart = tableOffset + resources.length * 16;
  const total = dataStart + resources.reduce((sum, r) => sum + r.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  ascii(out, 0, "BIFFV1  ");
  put32(view, 8, resources.length);
  put32(view, 12, 0);
  put32(view, 16, tableOffset);
  let cursor = dataStart;
  resources.forEach((r, i) => {
    const at = tableOffset + i * 16;
    put32(view, at, i);
    put32(view, at + 4, cursor);
    put32(view, at + 8, r.data.length);
    put32(view, at + 12, r.type);
    out.set(r.data, cursor);
    cursor += r.data.length;
  });
  return out;
}

function buildKey(bifs: string[], keys: { resref: string; type: number; bif: number; index: number }[]): Uint8Array {
  const fileTable = 64;
  const names = fileTable + bifs.length * 12;
  const nameBytes = bifs.map((b) => b.length + 1);
  const keyTable = names + nameBytes.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(keyTable + keys.length * 22);
  const view = new DataView(out.buffer);
  ascii(out, 0, "KEY V1  ");
  put32(view, 8, bifs.length);
  put32(view, 12, keys.length);
  put32(view, 16, fileTable);
  put32(view, 20, keyTable);
  let nameAt = names;
  bifs.forEach((name, i) => {
    const at = fileTable + i * 12;
    put32(view, at, 1000 + i);
    put32(view, at + 4, nameAt);
    view.setUint16(at + 8, name.length + 1, true);
    ascii(out, nameAt, name);
    nameAt += name.length + 1;
  });
  keys.forEach((k, i) => {
    const at = keyTable + i * 22;
    ascii(out, at, k.resref);
    view.setUint16(at + 16, k.type, true);
    put32(view, at + 18, (k.bif << 20) | k.index);
  });
  return out;
}

describe("KEY/BIF reader", () => {
  const key = buildKey(
    ["data\\first.bif", "data\\second.bif"],
    [
      { resref: "alpha", type: 2017, bif: 0, index: 1 },
      { resref: "Beta", type: 2027, bif: 1, index: 0 },
    ],
  );

  it("parses the BIF list and resolves resources case-insensitively by resref and type", () => {
    const parsed = parseKey(key);
    expect(parsed.bifs.map((b) => b.filename)).toEqual(["data\\first.bif", "data\\second.bif"]);
    expect(parsed.bifs[1]!.fileSize).toBe(1001);
    expect(parsed.resourceCount).toBe(2);
    expect(parsed.find("ALPHA", 2017)).toEqual({ bifIndex: 0, resourceIndex: 1 });
    expect(parsed.find("beta", 2027)).toEqual({ bifIndex: 1, resourceIndex: 0 });
    expect(parsed.find("alpha", 2027)).toBeUndefined();
    expect(parsed.find("gamma", 2017)).toBeUndefined();
  });

  it("splits the resource id into BIF index (id >> 20) and resource index (id & 0xFFFFF)", () => {
    const wide = buildKey(["a.bif", "b.bif", "c.bif"], [{ resref: "wide", type: 2017, bif: 2, index: 0x12345 }]);
    expect(parseKey(wide).find("wide", 2017)).toEqual({ bifIndex: 2, resourceIndex: 0x12345 });
  });

  it("extracts variable resources from a BIF by index and checks the type", async () => {
    const bif = bifSourceFromBytes(
      buildBif([
        { type: 2027, data: [1, 2, 3] },
        { type: 2017, data: [9, 8, 7, 6] },
      ]),
    );
    expect(Array.from(await readBifResource(bif, 1, 2017))).toEqual([9, 8, 7, 6]);
    expect(Array.from(await readBifResource(bif, 0))).toEqual([1, 2, 3]);
    await expect(readBifResource(bif, 1, 2027)).rejects.toThrow(/type 2017, expected 2027/);
    await expect(readBifResource(bif, 2)).rejects.toThrow(/out of range/);
  });

  it("rejects malformed input", async () => {
    expect(() => parseKey(new Uint8Array(10))).toThrow(KeyBifError);
    const bad = key.slice();
    bad[0] = 0x58;
    expect(() => parseKey(bad)).toThrow(/not a KEY V1/);
    const truncated = key.slice(0, key.length - 5);
    expect(() => parseKey(truncated)).toThrow(/resource table exceeds/);
    await expect(readBifResource(bifSourceFromBytes(new Uint8Array(4)), 0)).rejects.toThrow(/exceeds the file/);
    const notBif = buildBif([{ type: 1, data: [1] }]);
    notBif[0] = 0x58;
    await expect(readBifResource(bifSourceFromBytes(notBif), 0)).rejects.toThrow(/not a BIF V1/);
    const shortData = buildBif([{ type: 1, data: [1, 2, 3, 4] }]);
    await expect(readBifResource(bifSourceFromBytes(shortData.slice(0, shortData.length - 2)), 0)).rejects.toThrow(/exceeds the file/);
  });
});
