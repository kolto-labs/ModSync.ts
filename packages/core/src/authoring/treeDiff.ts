/** Read-only SHA256 comparison, ported from ModSync.rs editor/easy/diff.rs. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

interface FileIdentity { directory: boolean; bytes: number; sha256: string }
export interface TreeDiff {
  left: string; right: string;
  leftFiles: number; rightFiles: number;
  leftDirectories: number; rightDirectories: number;
  onlyLeft: string[]; onlyRight: string[]; changed: string[];
  exclusions: string[]; excludedLeft: string[]; excludedRight: string[];
  identical: boolean;
}

function exclusionPath(raw: string): string {
  const text = raw.replaceAll("\\", "/");
  if (text.startsWith("/")) throw new Error(`Absolute path is forbidden: ${raw}`);
  const parts = text.split("/").filter((p) => p !== "" && p !== ".");
  for (const part of parts) {
    if (part === ".." || /[:\0<>|"*?\[\]]/.test(part) || /[ .]$/.test(part)) {
      throw new Error(`Unsafe comparison exclusion: ${raw}`);
    }
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(part.split(".")[0]!)) {
      throw new Error(`Reserved filename: ${raw}`);
    }
  }
  if (!parts.length) throw new Error("Cannot exclude the entire comparison tree");
  return parts.join("/");
}
const order = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

async function inventory(input: string, exclusions: string[]): Promise<{
  root: string; entries: Map<string, FileIdentity>; excluded: string[];
}> {
  const rootInfo = await lstat(input);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Comparison root must be an ordinary directory");
  const root = await realpath(input);
  const entries = new Map<string, FileIdentity>();
  const excluded: string[] = [];
  let count = 1;
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    const names = (await readdir(path)).sort(order);
    const directories: string[] = [];
    for (const name of names) {
      if (++count > 1_000_000) throw new Error("Comparison tree exceeds one million entries");
      const child = join(path, name);
      const rel = relative(root, child).replaceAll("\\", "/");
      const info = await lstat(child);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`Comparison refuses special entry ${child}`);
      // Traverse excluded directories too: the Rust receipt lists every excluded entry.
      if (info.isDirectory()) directories.push(child);
      if (exclusions.some((prefix) => rel === prefix || rel.startsWith(prefix + "/"))) { excluded.push(rel); continue; }
      if (info.isDirectory()) { entries.set(rel, { directory: true, bytes: 0, sha256: "" }); continue; }
      const handle = await open(child, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) throw new Error(`Comparison refuses special entry ${child}`);
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let bytes = 0n;
        for (;;) {
          const read = await handle.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          bytes += BigInt(read.bytesRead);
          hash.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await handle.stat({ bigint: true });
        if (before.size !== bytes || after.size !== bytes || before.mtimeNs !== after.mtimeNs) throw new Error(`File changed during comparison: ${child}`);
        if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Comparison byte count exceeds TypeScript safe integer range");
        entries.set(rel, { directory: false, bytes: Number(bytes), sha256: hash.digest("hex") });
      } finally { await handle.close(); }
    }
    pending.push(...directories.reverse());
  }
  return { root, entries, excluded: excluded.sort(order) };
}

/** Exact paths, directories and bytes; no default exclusions. Does not mutate either tree. */
export async function compareInstallationTrees(left: string, right: string, exclusions: readonly string[] = []): Promise<TreeDiff> {
  const checked = exclusions.map(exclusionPath);
  const a = await inventory(left, checked);
  const b = await inventory(right, checked);
  if (a.root === b.root) throw new Error("Compare two distinct installation trees");
  const onlyLeft = [...a.entries.keys()].filter((p) => !b.entries.has(p)).sort(order);
  const onlyRight = [...b.entries.keys()].filter((p) => !a.entries.has(p)).sort(order);
  const changed = [...a.entries].filter(([p, v]) => {
    const other = b.entries.get(p);
    return other !== undefined && (v.directory !== other.directory || v.bytes !== other.bytes || v.sha256 !== other.sha256);
  }).map(([p]) => p).sort(order);
  const directories = (entries: Map<string, FileIdentity>): number => [...entries.values()].filter((v) => v.directory).length;
  const leftDirectories = directories(a.entries), rightDirectories = directories(b.entries);
  return { left: a.root, right: b.root, leftFiles: a.entries.size - leftDirectories, rightFiles: b.entries.size - rightDirectories,
    leftDirectories, rightDirectories, onlyLeft, onlyRight, changed, exclusions: checked,
    excludedLeft: a.excluded, excludedRight: b.excluded, identical: !onlyLeft.length && !onlyRight.length && !changed.length };
}
