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

  describe("binary layout robustness", () => {
    function dataSizeOffset(bytes: Uint8Array, cellCount: number): number {
      let pos = 9;
      while (bytes[pos] !== 0) pos++;
      pos++;
      const rowCount = new DataView(bytes.buffer, bytes.byteOffset).getUint32(pos, true);
      pos += 4;
      for (let i = 0; i < rowCount; i++) {
        while (bytes[pos] !== 0x09) pos++;
        pos++;
      }
      return pos + cellCount * 2;
    }

    function wideTable(): TwoDA {
      const columns = Array.from({ length: 40 }, (_, i) => `col${i}`);
      const t = new TwoDA(columns);
      for (let r = 0; r < 12; r++) {
        const cells: Record<string, string> = {};
        columns.forEach((c, i) => {
          if (i === 3) cells[c] = "";
          else if (i % 5 === 0) cells[c] = "shared";
          else if (i % 7 === 0) cells[c] = "****";
          else cells[c] = `v${r}_${i}`;
        });
        t.addRow(r % 4 === 3 ? "" : String(r), cells);
      }
      return t;
    }

    function cellsOf(t: TwoDA): string[][] {
      return t.rows.map((r) => [r.label, ...t.columns.map((c) => r.cells.get(c) ?? "")]);
    }

    it("round-trips wide tables with empty, duplicate and all-empty columns", () => {
      const t = wideTable();
      const bytes = write2da(t);
      expect(bytes.length).toBeGreaterThan(1000);
      const back = read2da(bytes);
      expect(back.columns).toEqual(t.columns);
      expect(cellsOf(back)).toEqual(cellsOf(t));
      expect(write2da(back)).toEqual(bytes);
    });

    it("round-trips a table whose cells are all empty strings", () => {
      const t = new TwoDA(["a", "b", "c"]);
      for (let i = 0; i < 5; i++) t.addRow(undefined, { a: "", b: "", c: "" });
      const bytes = write2da(t);
      const back = read2da(bytes);
      expect(cellsOf(back)).toEqual(cellsOf(t));
      expect(write2da(back)).toEqual(bytes);
    });

    it("round-trips tables without rows or without columns", () => {
      const noRows = new TwoDA(["a", "b"]);
      expect(read2da(write2da(noRows)).columns).toEqual(["a", "b"]);
      const noColumns = new TwoDA([]);
      noColumns.addRow("0");
      const back = read2da(write2da(noColumns));
      expect(back.columns).toEqual([]);
      expect(back.rows.map((r) => r.label)).toEqual(["0"]);
    });

    it("reads files whose DataSize field is zero", () => {
      const t = wideTable();
      const bytes = write2da(t);
      const patched = bytes.slice();
      new DataView(patched.buffer).setUint16(dataSizeOffset(patched, t.width * t.height), 0, true);
      const back = read2da(patched);
      expect(cellsOf(back)).toEqual(cellsOf(t));
      expect(write2da(back)).toEqual(bytes);
    });

    it("still rejects offsets beyond a zero DataSize block", () => {
      const t = new TwoDA(["a"]);
      t.addRow("0", { a: "value" });
      const patched = write2da(t);
      const view = new DataView(patched.buffer);
      const sizeAt = dataSizeOffset(patched, 1);
      view.setUint16(sizeAt, 0, true);
      view.setUint16(sizeAt - 2, 500, true);
      expect(() => read2da(patched)).toThrow(/outside the data block/);
    });
  });

  describe("text layout", () => {
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

    it("reads a 2DA V2.0 file", () => {
      const t = read2da(encode('2DA V2.0\r\n\r\n  label  name   value\r\n0  FORCE_PUSH  "two words"  ****\r\n1  FORCE_WAVE  ""  7\r\n'));
      expect(t.columns).toEqual(["label", "name", "value"]);
      expect(t.rows.map((r) => r.label)).toEqual(["0", "1"]);
      expect(t.getCell(0, "label")).toBe("FORCE_PUSH");
      expect(t.getCell(0, "name")).toBe("two words");
      expect(t.getCell(0, "value")).toBe("****");
      expect(t.getCell(1, "name")).toBe("");
      expect(t.getCell(1, "value")).toBe("7");
      expect(read2da(write2da(t)).getCell(0, "name")).toBe("two words");
    });

    it("reads a 2DA V2.0 file with a DEFAULT line and short rows", () => {
      const t = read2da(encode("2DA V2.0\nDEFAULT: ****\na b c\n0 x\n1 y z\n"));
      expect(t.columns).toEqual(["a", "b", "c"]);
      expect(t.getCell(0, "b")).toBe("");
      expect(t.getCell(1, "c")).toBe("");
    });

    it("rejects text rows with more cells than columns", () => {
      expect(() => read2da(encode("2DA V2.0\n\na b\n0 x y z\n"))).toThrow(/cells for 2 columns/);
    });
  });
});
