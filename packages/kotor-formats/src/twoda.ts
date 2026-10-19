/**
 * 2DA V2.b reader/writer. See docs/KOTOR_FORMATS.md section 2.
 *
 * Cell semantics: the literal `****` is KOTOR's "no value" marker and is
 * stored verbatim (that is what the shipped game files contain). Column
 * lookups are case-insensitive; the stored column labels keep their original
 * case.
 */
import { BinaryReader, BinaryWriter, decodeCp1252, encodeCp1252 } from "./binary.js";

export const TWODA_EMPTY = "****";
const SIGNATURE = "2DA V2.b";

export class TwoDAError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwoDAError";
  }
}

export interface TwoDARow {
  label: string;
  /** keyed by canonical column label */
  cells: Map<string, string>;
}

export interface TwoDARowMatch {
  index: number;
  row: TwoDARow;
}

export class TwoDA {
  columns: string[];
  rows: TwoDARow[] = [];

  constructor(columns: string[] = []) {
    this.columns = [...columns];
  }

  get width(): number {
    return this.columns.length;
  }
  get height(): number {
    return this.rows.length;
  }

  /** Canonical column label for a case-insensitive name, or undefined. */
  resolveColumn(name: string): string | undefined {
    const exact = this.columns.find((c) => c === name);
    if (exact !== undefined) return exact;
    const lower = name.toLowerCase();
    return this.columns.find((c) => c.toLowerCase() === lower);
  }

  hasColumn(name: string): boolean {
    return this.resolveColumn(name) !== undefined;
  }

  private column(name: string): string {
    const c = this.resolveColumn(name);
    if (c === undefined) throw new TwoDAError(`unknown column "${name}"`);
    return c;
  }

  getRow(index: number): TwoDARow | undefined {
    return this.rows[index];
  }

  getRowByLabel(label: string): TwoDARowMatch | undefined {
    const index = this.rows.findIndex((r) => r.label === label);
    return index < 0 ? undefined : { index, row: this.rows[index]! };
  }

  getCell(rowIndex: number, column: string): string | undefined {
    const row = this.rows[rowIndex];
    if (!row) return undefined;
    const c = this.resolveColumn(column);
    if (c === undefined) return undefined;
    return row.cells.get(c) ?? "";
  }

  setCell(rowIndex: number, column: string, value: string): void {
    const row = this.rows[rowIndex];
    if (!row) throw new TwoDAError(`row index ${rowIndex} out of range (${this.rows.length})`);
    row.cells.set(this.column(column), value);
  }

  /** First row whose cell in `column` equals `value` (exact match). */
  findRow(column: string, value: string): TwoDARowMatch | undefined {
    const c = this.column(column);
    const index = this.rows.findIndex((r) => (r.cells.get(c) ?? "") === value);
    return index < 0 ? undefined : { index, row: this.rows[index]! };
  }

  /**
   * Append a row. `label` defaults to the new row index. Unspecified cells are
   * empty strings. Returns the new row index.
   */
  addRow(label?: string, cells?: Record<string, string> | Map<string, string>): number {
    const index = this.rows.length;
    const row: TwoDARow = { label: label ?? String(index), cells: new Map() };
    for (const c of this.columns) row.cells.set(c, "");
    this.rows.push(row);
    if (cells) {
      const entries = cells instanceof Map ? cells.entries() : Object.entries(cells);
      for (const [k, v] of entries) row.cells.set(this.column(k), v);
    }
    return index;
  }

  /** Copy a row to the end of the table and return the new index. */
  copyRow(sourceIndex: number, label?: string, overrides?: Record<string, string> | Map<string, string>): number {
    const src = this.rows[sourceIndex];
    if (!src) throw new TwoDAError(`row index ${sourceIndex} out of range (${this.rows.length})`);
    const index = this.addRow(label, src.cells);
    if (overrides) {
      const row = this.rows[index]!;
      const entries = overrides instanceof Map ? overrides.entries() : Object.entries(overrides);
      for (const [k, v] of entries) row.cells.set(this.column(k), v);
    }
    return index;
  }

  /** Add a column filled with `defaultValue`. Throws if it already exists. */
  addColumn(label: string, defaultValue = TWODA_EMPTY): void {
    if (this.resolveColumn(label) !== undefined) throw new TwoDAError(`column "${label}" already exists`);
    this.columns.push(label);
    for (const r of this.rows) r.cells.set(label, defaultValue);
  }

  /** Largest integer value in the column (-1 when no cell is an integer). Used for `high()`. */
  maxIntInColumn(column: string): number {
    const c = this.column(column);
    let max = -1;
    for (const r of this.rows) {
      const v = r.cells.get(c);
      if (v !== undefined && /^-?\d+$/.test(v.trim())) max = Math.max(max, Number(v));
    }
    return max;
  }

  /** Largest integer row label (-1 when none). */
  maxIntRowLabel(): number {
    let max = -1;
    for (const r of this.rows) if (/^-?\d+$/.test(r.label.trim())) max = Math.max(max, Number(r.label));
    return max;
  }

  /** Column values as an array (one per row). */
  columnValues(column: string): string[] {
    const c = this.column(column);
    return this.rows.map((r) => r.cells.get(c) ?? "");
  }
}

const TEXT_SIGNATURE = "2DA V2.0";

/**
 * Reads a 2DA table. Both the binary "2DA V2.b" layout and the text
 * "2DA V2.0" layout are accepted.
 *
 * In the binary layout the `DataSize` field is advisory: some third-party
 * tools write 0 for it. A table with at least one cell always has a data block
 * of at least one byte, so `DataSize == 0` is treated as "unset" and the block
 * is taken to extend to the end of the file. A non-zero value is still
 * enforced.
 */
export function read2da(bytes: Uint8Array): TwoDA {
  if (startsWithSignature(bytes, TEXT_SIGNATURE)) return readText2da(bytes);
  const r = new BinaryReader(bytes);
  const sig = r.string(SIGNATURE.length);
  if (sig !== SIGNATURE) throw new TwoDAError(`bad 2DA signature "${sig}"`);
  // The signature is followed by a newline (some files use \r\n).
  while (r.remaining > 0 && (r.peekU8() === 0x0a || r.peekU8() === 0x0d)) r.skip(1);

  const columns: string[] = [];
  while (true) {
    if (r.remaining === 0) throw new TwoDAError("unterminated column label list");
    if (r.peekU8() === 0) {
      r.skip(1);
      break;
    }
    columns.push(r.stringUntil(0x09));
  }
  const rowCount = r.u32();
  const rowLabels: string[] = [];
  for (let i = 0; i < rowCount; i++) rowLabels.push(r.stringUntil(0x09));

  const cellCount = rowCount * columns.length;
  const offsets: number[] = [];
  for (let i = 0; i < cellCount; i++) offsets.push(r.u16());
  const declaredSize = r.u16();
  const dataStart = r.position;
  const dataSize = declaredSize === 0 && cellCount > 0 ? bytes.length - dataStart : declaredSize;
  if (dataStart + dataSize > bytes.length) throw new TwoDAError("2DA data block exceeds file size");

  const table = new TwoDA(columns);
  const cache = new Map<number, string>();
  const block = bytes.subarray(dataStart, dataStart + dataSize);
  const cell = (off: number): string => {
    let s = cache.get(off);
    if (s === undefined) {
      if (off >= dataSize) throw new TwoDAError(`2DA cell offset ${off} is outside the data block (${dataSize} bytes)`);
      if (block.indexOf(0, off) < 0) throw new TwoDAError(`unterminated 2DA cell at offset ${off}`);
      const sub = new BinaryReader(block, off);
      s = sub.cstring();
      cache.set(off, s);
    }
    return s;
  };
  for (let i = 0; i < rowCount; i++) {
    const row: TwoDARow = { label: rowLabels[i]!, cells: new Map() };
    for (let c = 0; c < columns.length; c++) row.cells.set(columns[c]!, cell(offsets[i * columns.length + c]!));
    table.rows.push(row);
  }
  return table;
}

function startsWithSignature(bytes: Uint8Array, signature: string): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[i] !== signature.charCodeAt(i)) return false;
  return true;
}

function splitTextTokens(line: string, lineNumber: number): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === '"') {
      const end = line.indexOf('"', i + 1);
      if (end < 0) throw new TwoDAError(`unterminated quoted cell on 2DA line ${lineNumber}`);
      tokens.push(line.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let end = i;
    while (end < line.length && line[end] !== " " && line[end] !== "\t") end++;
    tokens.push(line.slice(i, end));
    i = end;
  }
  return tokens;
}

function readText2da(bytes: Uint8Array): TwoDA {
  const lines = decodeCp1252(bytes).split(/\r\n|\n|\r/);
  let next = 1;
  const second = lines[next];
  if (second !== undefined && (second.trim() === "" || /^\s*default\s*:/i.test(second))) next++;
  while (next < lines.length && lines[next]!.trim() === "") next++;
  if (next >= lines.length) throw new TwoDAError("text 2DA has no column header line");
  const table = new TwoDA(splitTextTokens(lines[next]!, next + 1));
  for (next++; next < lines.length; next++) {
    const line = lines[next]!;
    if (line.trim() === "") continue;
    const tokens = splitTextTokens(line, next + 1);
    const cells = tokens.slice(1);
    if (cells.length > table.columns.length) {
      throw new TwoDAError(`2DA line ${next + 1} has ${cells.length} cells for ${table.columns.length} columns`);
    }
    const row: TwoDARow = { label: tokens[0]!, cells: new Map() };
    for (let c = 0; c < table.columns.length; c++) row.cells.set(table.columns[c]!, cells[c] ?? "");
    table.rows.push(row);
  }
  return table;
}

export function write2da(table: TwoDA): Uint8Array {
  const w = new BinaryWriter();
  w.string(SIGNATURE).u8(0x0a);
  for (const c of table.columns) w.string(c).u8(0x09);
  w.u8(0);
  w.u32(table.rows.length);
  for (const r of table.rows) w.string(r.label).u8(0x09);

  const data = new BinaryWriter();
  const offsetOf = new Map<string, number>();
  const offsets: number[] = [];
  for (const r of table.rows) {
    for (const c of table.columns) {
      const v = r.cells.get(c) ?? "";
      let off = offsetOf.get(v);
      if (off === undefined) {
        off = data.length;
        data.bytes(encodeCp1252(v)).u8(0);
        offsetOf.set(v, off);
      }
      offsets.push(off);
    }
  }
  if (data.length > 0xffff) throw new TwoDAError(`2DA data block is ${data.length} bytes; the format allows at most 65535`);
  for (const o of offsets) w.u16(o);
  w.u16(data.length);
  w.bytes(data.toUint8Array());
  return w.toUint8Array();
}
