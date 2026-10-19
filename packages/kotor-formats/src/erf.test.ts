import { describe, expect, it } from "vitest";
import { Encapsulated, encapsulatedFileTypeFromPath, isEncapsulatedPath, readEncapsulated, readErf, readRim, writeEncapsulated, writeErf, writeRim } from "./erf.js";
import { ResourceTypes } from "./restypes.js";

function sample(type: "MOD " | "RIM "): Encapsulated {
  const e = new Encapsulated(type);
  e.set("p_test", ResourceTypes.utc, Uint8Array.from([1, 2, 3]));
  e.set("area", ResourceTypes.are, new Uint8Array(0));
  e.set("sixteencharacter", ResourceTypes.ncs, Uint8Array.from([9]));
  return e;
}

describe("erf/rim", () => {
  it("round-trips ERF/MOD", () => {
    const e = sample("MOD ");
    const bytes = writeErf(e, { buildYear: 124, buildDay: 10 });
    expect(bytes.length).toBe(160 + 24 * 3 + 8 * 3 + 4);
    const back = readErf(bytes);
    expect(back.fileType).toBe("MOD ");
    expect(back.resources.map((r) => [r.resref, r.type, Array.from(r.data)])).toEqual([
      ["p_test", 2027, [1, 2, 3]],
      ["area", 2012, []],
      ["sixteencharacter", 2010, [9]],
    ]);
    expect(writeErf(back, { buildYear: 124, buildDay: 10 })).toEqual(bytes);
    expect(readEncapsulated(bytes).fileType).toBe("MOD ");
  });
  it("round-trips RIM", () => {
    const e = sample("RIM ");
    const bytes = writeRim(e);
    expect(bytes.length).toBe(120 + 32 * 3 + 4);
    const back = readRim(bytes);
    expect(back.fileType).toBe("RIM ");
    expect(back.get("P_TEST", 2027)?.data).toEqual(Uint8Array.from([1, 2, 3]));
    expect(writeEncapsulated(back)).toEqual(bytes);
    expect(readEncapsulated(bytes).resources).toHaveLength(3);
  });
  it("set replaces, remove removes", () => {
    const e = sample("MOD ");
    e.set("P_Test", 2027, Uint8Array.from([7]));
    expect(e.resources).toHaveLength(3);
    expect(e.get("p_test", 2027)?.data).toEqual(Uint8Array.from([7]));
    expect(e.remove("area", 2012)).toBe(true);
    expect(e.remove("area", 2012)).toBe(false);
    expect(e.has("area", 2012)).toBe(false);
  });
  it("truncates over-long resrefs to 16 bytes with a warning, preserving case", () => {
    const longName = "a_very_Long_resource_name_x";
    for (const kind of ["MOD ", "RIM "] as const) {
      const e = new Encapsulated(kind, [{ resref: longName, type: ResourceTypes.ncs, data: Uint8Array.from([5]) }]);
      const warnings: string[] = [];
      const bytes = writeEncapsulated(e, { warn: (m) => warnings.push(m) });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(longName);
      expect(warnings[0]).toContain("a_very_Long_reso");
      const back = readEncapsulated(bytes);
      expect(back.resources.map((r) => r.resref)).toEqual(["a_very_Long_reso"]);
      expect(Array.from(back.get("A_VERY_LONG_RESO", ResourceTypes.ncs)!.data)).toEqual([5]);
    }
    const rim = new Encapsulated("RIM ", [{ resref: longName, type: 1, data: new Uint8Array(0) }]);
    const rimWarnings: string[] = [];
    writeRim(rim, { warn: (m) => rimWarnings.push(m) });
    expect(rimWarnings).toHaveLength(1);
  });
  it("does not warn when resrefs fit in 16 bytes", () => {
    const warnings: string[] = [];
    writeErf(sample("MOD "), { warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });
  it("fails when truncation makes two resources collide", () => {
    const first = "a_very_long_resource_name_x";
    const second = "A_VERY_LONG_RESOURCE_NAME_y";
    const collide = new Encapsulated("ERF ", [
      { resref: first, type: 1, data: new Uint8Array(0) },
      { resref: second, type: 1, data: new Uint8Array(0) },
    ]);
    expect(() => writeErf(collide, { warn: () => {} })).toThrow(new RegExp(`${second}.*${first}`));
    const exact = new Encapsulated("RIM ", [
      { resref: "a_very_long_reso", type: 1, data: new Uint8Array(0) },
      { resref: first, type: 1, data: new Uint8Array(0) },
    ]);
    expect(() => writeRim(exact, { warn: () => {} })).toThrow(/a_very_long_reso/);
    const differentType = new Encapsulated("ERF ", [
      { resref: first, type: 1, data: new Uint8Array(0) },
      { resref: second, type: 2, data: new Uint8Array(0) },
    ]);
    expect(() => writeErf(differentType, { warn: () => {} })).not.toThrow();
  });
  it("detects archive paths", () => {
    expect(isEncapsulatedPath("Modules\\danm13.mod")).toBe(true);
    expect(isEncapsulatedPath("Override")).toBe(false);
    expect(encapsulatedFileTypeFromPath("saves/x.SAV")).toBe("SAV ");
    expect(encapsulatedFileTypeFromPath("a.rim")).toBe("RIM ");
  });
});
