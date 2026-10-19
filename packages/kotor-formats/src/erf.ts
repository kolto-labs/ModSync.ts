/**
 * ERF/MOD/SAV/HAK (V1.0) and RIM (V1.0) reader/writer.
 * See docs/KOTOR_FORMATS.md section 5.
 */
import { BinaryReader, BinaryWriter, decodeCp1252, encodeCp1252 } from "./binary.js";

export class ErfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErfError";
  }
}

export interface EncapsulatedResource {
  resref: string;
  type: number;
  data: Uint8Array;
}

export type EncapsulatedFileType = "ERF " | "MOD " | "SAV " | "HAK " | "RIM ";

/** Resources held by an ERF-family or RIM archive. Resref matching is case-insensitive. */
export class Encapsulated {
  fileType: EncapsulatedFileType;
  resources: EncapsulatedResource[];

  constructor(fileType: EncapsulatedFileType = "ERF ", resources: EncapsulatedResource[] = []) {
    this.fileType = fileType;
    this.resources = resources;
  }

  private indexOf(resref: string, type: number): number {
    const lower = resref.toLowerCase();
    return this.resources.findIndex((r) => r.type === type && r.resref.toLowerCase() === lower);
  }

  get(resref: string, type: number): EncapsulatedResource | undefined {
    const i = this.indexOf(resref, type);
    return i < 0 ? undefined : this.resources[i];
  }

  has(resref: string, type: number): boolean {
    return this.indexOf(resref, type) >= 0;
  }

  /** Replace an existing resource's data or append a new one. */
  set(resref: string, type: number, data: Uint8Array): EncapsulatedResource {
    const i = this.indexOf(resref, type);
    if (i >= 0) {
      const r = this.resources[i]!;
      r.data = data;
      return r;
    }
    const r: EncapsulatedResource = { resref, type, data };
    this.resources.push(r);
    return r;
  }

  remove(resref: string, type: number): boolean {
    const i = this.indexOf(resref, type);
    if (i < 0) return false;
    this.resources.splice(i, 1);
    return true;
  }
}

const ERF_HEADER = 160;
const RIM_HEADER = 120;

const RESREF_MAX = 16;

/**
 * Aurora resrefs are 16 bytes. Like TSLPatcher, names longer than that are truncated
 * (case preserved) with a warning rather than rejected; a truncation that makes two
 * resources of the same type share a name is a hard error.
 */
function normalizeResrefs(enc: Encapsulated, warn: ((message: string) => void) | undefined): string[] {
  const report = warn ?? ((message: string) => console.warn(message));
  const seen = new Map<string, { original: string; truncated: boolean }>();
  return enc.resources.map((res) => {
    const bytes = encodeCp1252(res.resref);
    const truncated = bytes.length > RESREF_MAX;
    const name = truncated ? decodeCp1252(bytes.subarray(0, RESREF_MAX)) : res.resref;
    const key = `${res.type}:${name.toLowerCase()}`;
    const prior = seen.get(key);
    if (prior && (prior.truncated || truncated)) {
      throw new ErfError(`resref "${res.resref}" and "${prior.original}" both resolve to "${name}" (type ${res.type}) after truncation to ${RESREF_MAX} bytes`);
    }
    if (!prior) seen.set(key, { original: res.resref, truncated });
    if (truncated) report(`resref "${res.resref}" exceeds ${RESREF_MAX} bytes; truncated to "${name}" in ${enc.fileType.trim()} archive`);
    return name;
  });
}

export function readErf(bytes: Uint8Array): Encapsulated {
  if (bytes.length < ERF_HEADER) throw new ErfError(`ERF too small (${bytes.length} bytes)`);
  const r = new BinaryReader(bytes);
  const sig = r.string(4);
  const ver = r.string(4);
  if (!["ERF ", "MOD ", "SAV ", "HAK "].includes(sig)) throw new ErfError(`bad ERF signature "${sig}"`);
  if (ver !== "V1.0") throw new ErfError(`unsupported ERF version "${ver}"`);
  r.u32(); // language count
  r.u32(); // localized string size
  const count = r.u32();
  r.u32(); // offset to localized strings
  const keyOffset = r.u32();
  const resOffset = r.u32();
  if (keyOffset + count * 24 > bytes.length || resOffset + count * 8 > bytes.length) throw new ErfError("ERF tables exceed file size");

  const enc = new Encapsulated(sig as EncapsulatedFileType);
  for (let i = 0; i < count; i++) {
    r.seek(keyOffset + i * 24);
    const resref = r.fixedString(16);
    r.u32(); // res id
    const type = r.u16();
    r.u16();
    r.seek(resOffset + i * 8);
    const off = r.u32();
    const size = r.u32();
    if (off + size > bytes.length) throw new ErfError(`resource "${resref}" (${type}) exceeds file size`);
    enc.resources.push({ resref, type, data: bytes.slice(off, off + size) });
  }
  return enc;
}

export interface ErfWriteOptions {
  /** years since 1900; defaults to the current date */
  buildYear?: number;
  buildDay?: number;
  descriptionStrRef?: number;
  /** receives a diagnostic for each resref truncated to 16 bytes; defaults to console.warn */
  warn?: (message: string) => void;
}

export function writeErf(enc: Encapsulated, opts: ErfWriteOptions = {}): Uint8Array {
  const fileType = enc.fileType === "RIM " ? "ERF " : enc.fileType;
  const now = new Date();
  const year = opts.buildYear ?? now.getFullYear() - 1900;
  const day = opts.buildDay ?? Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86_400_000);
  const count = enc.resources.length;
  const keyOffset = ERF_HEADER;
  const resOffset = keyOffset + 24 * count;
  const dataOffset = resOffset + 8 * count;
  let total = dataOffset;
  for (const res of enc.resources) total += res.data.length;

  const w = new BinaryWriter(total);
  w.string(fileType).string("V1.0");
  w.u32(0).u32(0).u32(count).u32(ERF_HEADER).u32(keyOffset).u32(resOffset);
  w.u32(year).u32(day).u32(opts.descriptionStrRef ?? 0xffffffff);
  w.zeros(116);
  const names = normalizeResrefs(enc, opts.warn);
  enc.resources.forEach((res, i) => {
    w.fixedString(names[i]!, 16).u32(i).u16(res.type).u16(0);
  });
  let off = dataOffset;
  for (const res of enc.resources) {
    w.u32(off).u32(res.data.length);
    off += res.data.length;
  }
  for (const res of enc.resources) w.bytes(res.data);
  return w.toUint8Array();
}

export function readRim(bytes: Uint8Array): Encapsulated {
  if (bytes.length < RIM_HEADER) throw new ErfError(`RIM too small (${bytes.length} bytes)`);
  const r = new BinaryReader(bytes);
  const sig = r.string(4);
  const ver = r.string(4);
  if (sig !== "RIM ") throw new ErfError(`bad RIM signature "${sig}"`);
  if (ver !== "V1.0") throw new ErfError(`unsupported RIM version "${ver}"`);
  r.u32(); // reserved
  const count = r.u32();
  const entriesOffset = r.u32();
  if (entriesOffset + count * 32 > bytes.length) throw new ErfError("RIM entry table exceeds file size");
  const enc = new Encapsulated("RIM ");
  for (let i = 0; i < count; i++) {
    r.seek(entriesOffset + i * 32);
    const resref = r.fixedString(16);
    const type = r.u32();
    r.u32(); // res id
    const off = r.u32();
    const size = r.u32();
    if (off + size > bytes.length) throw new ErfError(`resource "${resref}" (${type}) exceeds file size`);
    enc.resources.push({ resref, type, data: bytes.slice(off, off + size) });
  }
  return enc;
}

export function writeRim(enc: Encapsulated, opts: ErfWriteOptions = {}): Uint8Array {
  const count = enc.resources.length;
  const dataOffset = RIM_HEADER + 32 * count;
  let total = dataOffset;
  for (const res of enc.resources) total += res.data.length;
  const w = new BinaryWriter(total);
  w.string("RIM ").string("V1.0").u32(0).u32(count).u32(RIM_HEADER).zeros(100);
  let off = dataOffset;
  const names = normalizeResrefs(enc, opts.warn);
  enc.resources.forEach((res, i) => {
    w.fixedString(names[i]!, 16).u32(res.type).u32(i).u32(off).u32(res.data.length);
    off += res.data.length;
  });
  for (const res of enc.resources) w.bytes(res.data);
  return w.toUint8Array();
}

/** Read an ERF-family or RIM archive, dispatching on the signature. */
export function readEncapsulated(bytes: Uint8Array): Encapsulated {
  if (bytes.length < 4) throw new ErfError("archive too small");
  const sig = new BinaryReader(bytes).string(4);
  return sig === "RIM " ? readRim(bytes) : readErf(bytes);
}

/** Write an archive according to its `fileType`. */
export function writeEncapsulated(enc: Encapsulated, opts?: ErfWriteOptions): Uint8Array {
  return enc.fileType === "RIM " ? writeRim(enc, opts) : writeErf(enc, opts);
}

const ARCHIVE_TYPES: Record<string, EncapsulatedFileType> = { mod: "MOD ", erf: "ERF ", sav: "SAV ", hak: "HAK ", rim: "RIM " };

/** True for .mod/.erf/.sav/.hak/.rim paths. */
export function isEncapsulatedPath(p: string): boolean {
  return encapsulatedFileTypeFromPath(p) !== undefined;
}

export function encapsulatedFileTypeFromPath(p: string): EncapsulatedFileType | undefined {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? ARCHIVE_TYPES[m[1]!.toLowerCase()] : undefined;
}
