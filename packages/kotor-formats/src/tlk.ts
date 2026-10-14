/**
 * TLK V3.0 (dialog.tlk) reader/writer. See docs/KOTOR_FORMATS.md section 3.
 *
 * Text encoding follows the header LanguageID: CP-1252 for 0-4 (English,
 * French, German, Italian, Spanish) and CP-1250 for 5 (Polish), both
 * implemented here with lookup tables. East Asian languages use iconv-lite's
 * Windows code pages. Unknown languages and unrepresentable text are rejected
 * instead of replacing text silently.
 */
import iconv from "iconv-lite";
import { BinaryReader, BinaryWriter, decodeCp1252, encodeCp1252 } from "./binary.js";

export class TlkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlkError";
  }
}

export interface TlkEntry {
  text: string;
  /** Original entry metadata preserved when patching existing files. */
  volumeVariance?: number;
  pitchVariance?: number;
  /** sound resref, "" when none */
  soundResRef: string;
  /** sound length in seconds (written as 0 when absent) */
  soundLength?: number;
}

export const TlkLanguage = {
  English: 0,
  French: 1,
  German: 2,
  Italian: 3,
  Spanish: 4,
  Polish: 5,
  Korean: 128,
  ChineseTraditional: 129,
  ChineseSimplified: 130,
  Japanese: 131,
} as const;

export class Tlk {
  language: number;
  entries: TlkEntry[] = [];

  constructor(language = 0) {
    this.language = language;
  }

  get length(): number {
    return this.entries.length;
  }

  get(index: number): TlkEntry | undefined {
    return this.entries[index];
  }

  /** Append an entry and return its index (= strref). */
  add(text: string, soundResRef = "", soundLength?: number): number {
    const entry: TlkEntry = { text, soundResRef };
    if (soundLength !== undefined) entry.soundLength = soundLength;
    this.entries.push(entry);
    return this.entries.length - 1;
  }

  /** Overwrite an existing entry (undefined parts are kept). */
  replace(index: number, text?: string, soundResRef?: string, soundLength?: number): void {
    const e = this.entries[index];
    if (!e) throw new TlkError(`strref ${index} out of range (${this.entries.length} entries)`);
    if (text !== undefined) e.text = text;
    if (soundResRef !== undefined) e.soundResRef = soundResRef;
    if (soundLength !== undefined) e.soundLength = soundLength;
  }
}

// CP-1250 (Central European) upper half, bytes 0x80-0xFF.
const CP1250_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0083, 0x201e, 0x2026, 0x2020, 0x2021, 0x0088, 0x2030, 0x0160, 0x2039, 0x015a, 0x0164, 0x017d, 0x0179,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x0098, 0x2122, 0x0161, 0x203a, 0x015b, 0x0165, 0x017e, 0x017a,
  0x00a0, 0x02c7, 0x02d8, 0x0141, 0x00a4, 0x0104, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x015e, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x017b,
  0x00b0, 0x00b1, 0x02db, 0x0142, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x0105, 0x015f, 0x00bb, 0x013d, 0x02dd, 0x013e, 0x017c,
  0x0154, 0x00c1, 0x00c2, 0x0102, 0x00c4, 0x0139, 0x0106, 0x00c7, 0x010c, 0x00c9, 0x0118, 0x00cb, 0x011a, 0x00cd, 0x00ce, 0x010e,
  0x0110, 0x0143, 0x0147, 0x00d3, 0x00d4, 0x0150, 0x00d6, 0x00d7, 0x0158, 0x016e, 0x00da, 0x0170, 0x00dc, 0x00dd, 0x0162, 0x00df,
  0x0155, 0x00e1, 0x00e2, 0x0103, 0x00e4, 0x013a, 0x0107, 0x00e7, 0x010d, 0x00e9, 0x0119, 0x00eb, 0x011b, 0x00ed, 0x00ee, 0x010f,
  0x0111, 0x0144, 0x0148, 0x00f3, 0x00f4, 0x0151, 0x00f6, 0x00f7, 0x0159, 0x016f, 0x00fa, 0x0171, 0x00fc, 0x00fd, 0x0163, 0x02d9,
];
const CP1250_REVERSE = new Map<number, number>();
for (let i = 0; i < CP1250_HIGH.length; i++) CP1250_REVERSE.set(CP1250_HIGH[i]!, 0x80 + i);

export function decodeCp1250(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += String.fromCharCode(b < 0x80 ? b : CP1250_HIGH[b - 0x80]!);
  }
  return out;
}

export function encodeCp1250(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) out[i] = c;
    else out[i] = CP1250_REVERSE.get(c) ?? 0x3f;
  }
  return out;
}

const EAST_ASIAN_ENCODINGS: Readonly<Record<number, string>> = {
  128: "cp949",
  129: "cp950",
  130: "cp936",
  131: "cp932",
};

/** True when the language's Windows code page is available. */
export function isTlkLanguageSupported(language: number): boolean {
  return Number.isInteger(language) && ((language >= 0 && language <= 5) || EAST_ASIAN_ENCODINGS[language] !== undefined);
}

function checkLanguage(language: number): void {
  if (!isTlkLanguageSupported(language)) throw new TlkError(`unsupported TLK language ${language}`);
}

export function tlkDecoder(language: number): (b: Uint8Array) => string {
  checkLanguage(language);
  const encoding = EAST_ASIAN_ENCODINGS[language];
  if (!encoding) return language === 5 ? decodeCp1250 : decodeCp1252;
  return (bytes) => {
    const text = iconv.decode(Buffer.from(bytes), encoding);
    // Reject malformed byte sequences instead of introducing replacement text.
    if (text.includes("\ufffd")) throw new TlkError(`invalid ${encoding} TLK string data`);
    return text;
  };
}
export function tlkEncoder(language: number): (s: string) => Uint8Array {
  checkLanguage(language);
  const encoding = EAST_ASIAN_ENCODINGS[language];
  const encode = encoding ? (text: string) => new Uint8Array(iconv.encode(text, encoding)) : language === 5 ? encodeCp1250 : encodeCp1252;
  const decode = tlkDecoder(language);
  return (text) => {
    const bytes = encode(text);
    if (decode(bytes) !== text) throw new TlkError(`text cannot be represented in TLK language ${language}`);
    return bytes;
  };
}

export interface TlkCodecOptions {
  /** Optional codec diagnostics callback. Unsupported languages throw TlkError. */
  warn?: (message: string) => void;
}

const HEADER_SIZE = 20;
const ENTRY_SIZE = 40;
const FLAG_TEXT = 0x1;
const FLAG_SOUND = 0x2;
const FLAG_SOUND_LENGTH = 0x4;

export function readTlk(bytes: Uint8Array, _opts: TlkCodecOptions = {}): Tlk {
  if (bytes.length < HEADER_SIZE) throw new TlkError(`TLK too small (${bytes.length} bytes)`);
  const r = new BinaryReader(bytes);
  const sig = r.string(4);
  const ver = r.string(4);
  if (sig !== "TLK " || ver !== "V3.0") throw new TlkError(`bad TLK signature "${sig}${ver}"`);
  const language = r.u32();
  const count = r.u32();
  const entriesOffset = r.u32();
  checkLanguage(language);
  const decode = tlkDecoder(language);
  if (HEADER_SIZE + count * ENTRY_SIZE > bytes.length) throw new TlkError("TLK entry table exceeds file size");

  if (entriesOffset < HEADER_SIZE + count * ENTRY_SIZE || entriesOffset > bytes.length) throw new TlkError("TLK string data offset overlaps the entry table or exceeds file size");

  const tlk = new Tlk(language);
  for (let i = 0; i < count; i++) {
    r.seek(HEADER_SIZE + i * ENTRY_SIZE);
    const flags = r.u32();
    const sound = r.fixedString(16);
    const volumeVariance = r.u32();
    const pitchVariance = r.u32();
    const off = r.u32();
    const size = r.u32();
    const soundLength = r.f32();
    let text = "";
    if (flags & FLAG_TEXT && size > 0) {
      const start = entriesOffset + off;
      if (start + size > bytes.length) throw new TlkError(`TLK entry ${i} string data exceeds file size`);
      text = decode(bytes.subarray(start, start + size));
    }
    const entry: TlkEntry = { text, soundResRef: flags & FLAG_SOUND ? sound : "" };
    if (volumeVariance !== 0) entry.volumeVariance = volumeVariance;
    if (pitchVariance !== 0) entry.pitchVariance = pitchVariance;
    if (flags & FLAG_SOUND_LENGTH) entry.soundLength = soundLength;
    tlk.entries.push(entry);
  }
  return tlk;
}

export function writeTlk(tlk: Tlk, _opts: TlkCodecOptions = {}): Uint8Array {
  checkLanguage(tlk.language);
  const encode = tlkEncoder(tlk.language);
  const count = tlk.entries.length;
  const entriesOffset = HEADER_SIZE + count * ENTRY_SIZE;
  const w = new BinaryWriter(entriesOffset + count * 32);
  w.string("TLK ").string("V3.0").u32(tlk.language).u32(count).u32(entriesOffset);
  const data = new BinaryWriter();
  for (const e of tlk.entries) {
    const enc = encode(e.text);
    const hasSound = e.soundResRef.length > 0;
    const flags = FLAG_TEXT | (hasSound ? FLAG_SOUND | FLAG_SOUND_LENGTH : 0);
    w.u32(flags);
    w.fixedString(hasSound ? e.soundResRef : "", 16);
    w.u32(e.volumeVariance ?? 0).u32(e.pitchVariance ?? 0);
    w.u32(data.length).u32(enc.length);
    w.f32(hasSound ? (e.soundLength ?? 0) : 0);
    data.bytes(enc);
  }
  w.bytes(data.toUint8Array());
  return w.toUint8Array();
}
