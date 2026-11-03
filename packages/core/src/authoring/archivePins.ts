/** Immutable authoring input verification, adapted from Rust easy/inputs.rs. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ArchivePin { sha256: string; bytes: number }
export const AUTHORING_INPUTS_KEY = "ModSyncAuthoringInputs";

function checkedName(name: string): void {
  if (!name || /[\\/:\0<>|"*?[\]]/.test(name) || name === "." || name === ".." || /[ .]$/.test(name)) throw new Error("Archive input needs an ordinary filename");
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name.split(".")[0]!)) throw new Error("Reserved archive input filename");
  if (!/\.(zip|7z|rar|tar|gz|tgz|exe)$/i.test(name)) throw new Error("Unsupported archive input filename");
}

/** Reject malformed input metadata rather than silently accepting rounded byte counts. */
export function readArchivePins(metadata: Record<string, unknown>): Record<string, ArchivePin> {
  const value = metadata[AUTHORING_INPUTS_KEY];
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid authoring inputs");
  const entries = Object.entries(value);
  if (entries.length > 4096) throw new Error("Too many authoring inputs");
  const names = new Set<string>();
  const result: Record<string, ArchivePin> = Object.create(null);
  for (const [name, pin] of entries) {
    checkedName(name);
    // Full ordinal Unicode identity port is still pending; non-ASCII names fail closed.
    if (/[^\x20-\x7e]/.test(name)) throw new Error("Non-ASCII archive input identity is not yet supported");
    if (names.has(name.toLowerCase())) throw new Error("Case-colliding authoring inputs");
    names.add(name.toLowerCase());
    if (pin === null || typeof pin !== "object" || Array.isArray(pin)) throw new Error("Invalid archive input");
    const record = pin as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256) || typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes < 0) throw new Error("Invalid archive input identity");
    result[name] = { sha256: record.sha256, bytes: record.bytes };
  }
  return result;
}

/** Hash only the private input object; never extract or modify an install tree. */
export async function verifyArchivePin(sessionDirectory: string, pin: ArchivePin, signal?: AbortSignal): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.bytes) || pin.bytes < 0) throw new Error("Invalid archive input identity");
  const path = join(resolve(sessionDirectory), "inputs", pin.sha256);
  for (let ancestor = dirname(path);; ancestor = dirname(ancestor)) {
    const info = await lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Archive input path is unsafe");
    if (dirname(ancestor) === ancestor) break;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Archive input object is missing or unsafe");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(pin.bytes)) throw new Error("Archive input size changed");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(65536);
    let bytes = 0n;
    for (;;) {
      signal?.throwIfAborted();
      const read = await file.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += BigInt(read.bytesRead);
      if (bytes > BigInt(pin.bytes)) throw new Error("Archive input grew");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await file.stat({ bigint: true });
    if (bytes !== BigInt(pin.bytes) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || hash.digest("hex") !== pin.sha256) throw new Error("Archive input bytes differ from the saved revision");
  } finally { await file.close(); }
}
