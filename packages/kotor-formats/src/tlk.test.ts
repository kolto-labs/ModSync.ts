import { describe, expect, it } from "vitest";
import { Tlk, decodeCp1250, encodeCp1250, readTlk, writeTlk } from "./tlk.js";

describe("tlk", () => {
  it("round-trips an empty file", () => {
    const bytes = writeTlk(new Tlk(0));
    expect(bytes.length).toBe(20);
    const back = readTlk(bytes);
    expect(back.language).toBe(0);
    expect(back.entries).toEqual([]);
  });

  it("round-trips multiple entries with sounds", () => {
    const t = new Tlk(2);
    t.add("Hello");
    t.add("With sound", "n_bast_001", 1.25);
    t.add("");
    t.add("Ünïcödé €");
    const bytes = writeTlk(t);
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(12, true)).toBe(4);
    expect(dv.getUint32(16, true)).toBe(20 + 40 * 4);
    expect(dv.getUint32(20, true)).toBe(1); // flags: text only
    expect(dv.getUint32(60, true)).toBe(7); // text | sound | length
    const back = readTlk(bytes);
    expect(back.language).toBe(2);
    expect(back.entries.map((e) => e.text)).toEqual(["Hello", "With sound", "", "Ünïcödé €"]);
    expect(back.entries[1]!.soundResRef).toBe("n_bast_001");
    expect(back.entries[1]!.soundLength).toBeCloseTo(1.25);
    expect(back.entries[0]!.soundResRef).toBe("");
    expect(back.entries[0]!.soundLength).toBeUndefined();
    expect(writeTlk(back)).toEqual(bytes);
  });

  it("add/replace maintain indices", () => {
    const t = new Tlk();
    expect(t.add("a")).toBe(0);
    expect(t.add("b")).toBe(1);
    t.replace(0, "c", "snd");
    expect(t.entries[0]).toEqual({ text: "c", soundResRef: "snd" });
    expect(() => t.replace(5, "x")).toThrow(/out of range/);
  });

  it("preserves nonzero volume and pitch variance when adding entries", () => {
    const t = new Tlk();
    t.entries.push({ text: "original", soundResRef: "sound", volumeVariance: 7, pitchVariance: 9 });
    const back = readTlk(writeTlk(t));
    back.add("appended");
    const result = readTlk(writeTlk(back));
    expect(result.entries[0]!.volumeVariance).toBe(7);
    expect(result.entries[0]!.pitchVariance).toBe(9);
  });

  it("rejects a string data offset overlapping its entry table", () => {
    const t = new Tlk();
    t.add("test");
    const bytes = writeTlk(t);
    new DataView(bytes.buffer).setUint32(16, 20, true);
    expect(() => readTlk(bytes)).toThrow(/overlaps/);
  });

  it("uses cp1250 for Polish", () => {
    const t = new Tlk(5);
    t.add("Zażółć gęślą jaźń");
    const bytes = writeTlk(t);
    expect(readTlk(bytes).entries[0]!.text).toBe("Zażółć gęślą jaźń");
    expect(Array.from(encodeCp1250("ł"))).toEqual([0xb3]);
    expect(decodeCp1250(Uint8Array.from([0xa5]))).toBe("Ą");
  });

  it.each([
    [128, "한국어", [0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee]],
    [129, "中文", [0xa4, 0xa4, 0xa4, 0xe5]],
    [130, "中文", [0xd6, 0xd0, 0xce, 0xc4]],
    [131, "日本語", [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]],
  ] as const)("round-trips language %i with its Windows encoding", (language, text, expected) => {
    const t = new Tlk(language);
    t.add(text);
    const bytes = writeTlk(t);
    expect(Array.from(bytes.subarray(60))).toEqual(expected);
    expect(readTlk(bytes).entries[0]!.text).toBe(text);
    expect(writeTlk(readTlk(bytes))).toEqual(bytes);
  });

  it("rejects unknown code pages and unrepresentable text", () => {
    expect(() => writeTlk(new Tlk(999))).toThrow(/unsupported TLK language/);
    const t = new Tlk(0);
    t.add("한국어");
    expect(() => writeTlk(t)).toThrow(/cannot be represented/);
  });

  it("rejects malformed East Asian string data", () => {
    const t = new Tlk(131);
    t.add("a");
    const bytes = writeTlk(t);
    bytes[60] = 0x82; // Incomplete Shift-JIS lead byte.
    expect(() => readTlk(bytes)).toThrow(/invalid cp932/);
  });
});
