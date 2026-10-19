/**
 * Read-only KEY V1 (chitin.key) and BIF V1 support: enough to locate a base
 * game resource by resref + type and extract its bytes.
 * KEY header (64 bytes): sig, version, bifCount, keyCount, fileTableOffset,
 * keyTableOffset, buildYear, buildDay, 32 reserved. File table entries are 12
 * bytes (size, filename offset, filename size u16, drives u16); key table
 * entries are 22 bytes (resref[16], type u16, resource id u32). A resource id
 * packs the BIF index in bits 20+ and the resource index in the low 20 bits.
 * BIF header (20 bytes): sig, version, variableCount, fixedCount,
 * variableTableOffset; variable table entries are 16 bytes (id, offset, size,
 * type).
 */
import { BinaryReader } from "./binary.js";

export class KeyBifError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyBifError";
  }
}

const KEY_HEADER = 64;
const KEY_FILE_ENTRY = 12;
const KEY_RESOURCE_ENTRY = 22;
const BIF_HEADER = 20;
const BIF_VAR_ENTRY = 16;

export interface KeyBifEntry {
  /** BIF path as stored in the key, relative to the game directory (separators as written) */
  filename: string;
  fileSize: number;
}

export interface KeyResource {
  bifIndex: number;
  resourceIndex: number;
}

export interface KeyFile {
  bifs: KeyBifEntry[];
  /** number of resource entries in the key table */
  resourceCount: number;
  /** locate a resource; resref matching is case-insensitive */
  find(resref: string, type: number): KeyResource | undefined;
}

export function parseKey(bytes: Uint8Array): KeyFile {
  if (bytes.length < KEY_HEADER) throw new KeyBifError(`KEY too small (${bytes.length} bytes)`);
  const r = new BinaryReader(bytes);
  const sig = r.string(4);
  const ver = r.string(4);
  if (sig !== "KEY " || ver !== "V1  ") throw new KeyBifError(`not a KEY V1 file (signature "${sig}${ver}")`);
  const bifCount = r.u32();
  const keyCount = r.u32();
  const fileTableOffset = r.u32();
  const keyTableOffset = r.u32();
  if (fileTableOffset + bifCount * KEY_FILE_ENTRY > bytes.length) throw new KeyBifError("KEY file table exceeds the file");
  if (keyTableOffset + keyCount * KEY_RESOURCE_ENTRY > bytes.length) throw new KeyBifError("KEY resource table exceeds the file");

  const bifs: KeyBifEntry[] = [];
  r.seek(fileTableOffset);
  for (let i = 0; i < bifCount; i++) {
    const fileSize = r.u32();
    const nameOffset = r.u32();
    const nameSize = r.u16();
    r.u16();
    if (nameOffset + nameSize > bytes.length) throw new KeyBifError(`KEY filename ${i} exceeds the file`);
    const name = new BinaryReader(bytes, nameOffset).fixedString(nameSize);
    bifs.push({ filename: name, fileSize });
  }

  const index = new Map<string, KeyResource>();
  r.seek(keyTableOffset);
  for (let i = 0; i < keyCount; i++) {
    const resref = r.fixedString(16).toLowerCase();
    const type = r.u16();
    const id = r.u32();
    const key = `${type}:${resref}`;
    if (!index.has(key)) index.set(key, { bifIndex: id >>> 20, resourceIndex: id & 0xfffff });
  }
  return {
    bifs,
    resourceCount: keyCount,
    find: (resref, type) => index.get(`${type}:${resref.toLowerCase()}`),
  };
}

/** Random-access byte source, so a large BIF need not be read whole. */
export interface BifByteSource {
  readonly length: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bifSourceFromBytes(bytes: Uint8Array): BifByteSource {
  return {
    length: bytes.length,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

async function readExact(source: BifByteSource, offset: number, length: number, what: string): Promise<Uint8Array> {
  if (offset < 0 || length < 0 || offset + length > source.length) throw new KeyBifError(`BIF ${what} (offset ${offset}, ${length} bytes) exceeds the file (${source.length} bytes)`);
  const out = await source.read(offset, length);
  if (out.length !== length) throw new KeyBifError(`BIF ${what}: short read (${out.length} of ${length} bytes)`);
  return out;
}

/**
 * Extract one variable resource from a BIF V1 by its resource index. When
 * `expectedType` is given, the entry's stored type must match.
 */
export async function readBifResource(source: BifByteSource, resourceIndex: number, expectedType?: number): Promise<Uint8Array> {
  const header = new BinaryReader(await readExact(source, 0, BIF_HEADER, "header"));
  const sig = header.string(4);
  const ver = header.string(4);
  if (sig !== "BIFF" || ver !== "V1  ") throw new KeyBifError(`not a BIF V1 file (signature "${sig}${ver}")`);
  const varCount = header.u32();
  header.u32();
  const tableOffset = header.u32();
  if (resourceIndex < 0 || resourceIndex >= varCount) throw new KeyBifError(`BIF resource index ${resourceIndex} out of range (${varCount} variable resources)`);
  const entry = new BinaryReader(await readExact(source, tableOffset + resourceIndex * BIF_VAR_ENTRY, BIF_VAR_ENTRY, "variable resource entry"));
  entry.u32();
  const offset = entry.u32();
  const size = entry.u32();
  const type = entry.u32();
  if (expectedType !== undefined && type !== expectedType) throw new KeyBifError(`BIF resource ${resourceIndex} has type ${type}, expected ${expectedType}`);
  return readExact(source, offset, size, `resource ${resourceIndex} data`);
}
