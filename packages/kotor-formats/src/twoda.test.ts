import { describe, expect, it } from "vitest";
import { TwoDA, read2da, write2da } from "./twoda.js";

function sample(): TwoDA {
  const t = new TwoDA(["label", "name", "forbiditemmask"]);
  t.addRow("0", { label: "FORCE_PUSH", name: "123", forbiditemmask: "****" });
  t.addRow("1", { label: "FORCE_WAVE", name: "124", forbiditemmask: "7" });
  return t;
}

describe("2da", () => {
  it("round-trips through the binary format", () => {
    const t = sample();
    t.addRow("2", { label: "", name: "****", forbiditemmask: "7" });
    const bytes = write2da(t);
    expect(new TextDecoder("latin1").decode(bytes.subarray(0, 9))).toBe("2DA V2.b\n");
    const back = read2da(bytes);
    expect(back.columns).toEqual(t.columns);
    expect(back.rows.map((r) => r.label)).toEqual(["0", "1", "2"]);
    expect(back.getCell(1, "name")).toBe("124");
    expect(back.getCell(0, "forbiditemmask")).toBe("****");
    expect(back.getCell(2, "label")).toBe("");
    expect(write2da(back)).toEqual(bytes);
  });

  it("deduplicates identical cell strings on write", () => {
    const t = new TwoDA(["a", "b"]);
    for (let i = 0; i < 50; i++) t.addRow(undefined, { a: "same", b: "same" });
    const bytes = write2da(t);
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    // data block size is stored right before the data: locate it by walking the header
    const offsetsStart = 9 + "a\tb\t\0".length + 4 + "0\t".length * 10 + "10\t".length * 40;
    const dataSize = dv.getUint16(offsetsStart + 100 * 2, true);
    expect(dataSize).toBe("same\0".length);
  });

  it("looks up columns case-insensitively", () => {
    const t = sample();
    expect(t.getCell(0, "LABEL")).toBe("FORCE_PUSH");
    t.setCell(0, "Name", "5");
    expect(t.getCell(0, "name")).toBe("5");
    expect(t.hasColumn("ForbidItemMask")).toBe(true);
    expect(() => t.setCell(0, "missing", "x")).toThrow(/unknown column/);
  });

  it("finds rows, copies rows and adds columns", () => {
    const t = sample();
    expect(t.getRowByLabel("1")?.index).toBe(1);
    expect(t.findRow("label", "FORCE_WAVE")?.index).toBe(1);
    expect(t.findRow("label", "nope")).toBeUndefined();
    const idx = t.copyRow(1, "77", { name: "999" });
    expect(idx).toBe(2);
    expect(t.rows[2]!.label).toBe("77");
    expect(t.getCell(2, "label")).toBe("FORCE_WAVE");
    expect(t.getCell(2, "name")).toBe("999");
    expect(t.getCell(1, "name")).toBe("124");
    t.addColumn("newcol", "****");
    expect(t.columns).toEqual(["label", "name", "forbiditemmask", "newcol"]);
    expect(t.getCell(0, "newcol")).toBe("****");
    expect(() => t.addColumn("NAME")).toThrow(/already exists/);
    const auto = t.addRow();
    expect(t.rows[auto]!.label).toBe(String(auto));
    expect(t.getCell(auto, "newcol")).toBe("");
  });

  it("computes max integer for high()", () => {
    const t = sample();
    expect(t.maxIntInColumn("forbiditemmask")).toBe(7);
    expect(t.maxIntInColumn("name")).toBe(124);
    expect(t.maxIntInColumn("label")).toBe(-1);
    expect(t.maxIntRowLabel()).toBe(1);
  });

  it("rejects cell offsets outside the declared data block", () => {
    const t = new TwoDA(["a"]);
    t.addRow("0", { a: "value" });
    const bytes = write2da(t);
    // Nine-byte signature, three-byte column list, count, row label.
    new DataView(bytes.buffer).setUint16(18, 6, true);
    expect(() => read2da(bytes)).toThrow(/outside the data block/);
  });

  it("rejects cell strings terminated only after the declared data block", () => {
    const t = new TwoDA(["a"]);
    t.addRow("0", { a: "value" });
    const bytes = write2da(t);
    new DataView(bytes.buffer).setUint16(20, 5, true);
    expect(() => read2da(bytes)).toThrow();
  });

  it("rejects an oversized data block", () => {
    const t = new TwoDA(["a"]);
    for (let i = 0; i < 20000; i++) t.addRow(undefined, { a: `value${i}` });
    expect(() => write2da(t)).toThrow(/65535/);
  });
});
