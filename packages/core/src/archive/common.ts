/**
 * Helpers shared by the archive adapters.
 */

import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { PathEscapeError, comparePaths } from "../fs/paths.js";
import type { ArchiveEntry, ArchiveExtractOptions } from "../ports/archive.js";

export class ArchiveError extends Error {
  override readonly name: string = "ArchiveError";
  constructor(
    message: string,
    readonly archivePath: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class ArchiveEntryNotFoundError extends ArchiveError {
  override readonly name = "ArchiveEntryNotFoundError";
  constructor(archivePath: string, readonly entryPath: string) {
    super(`Entry "${entryPath}" not found in "${archivePath}"`, archivePath);
  }
}

/**
 * Normalize an entry name as stored in an archive to the ArchiveEntry
 * convention: forward slashes, no leading "./" or "/", no trailing slash,
 * no empty segments. Returns undefined for names that are empty or that
 * try to climb out with ".." (zip-slip); callers drop those entries.
 */
export function normalizeEntryPath(name: string): { path: string; isDirectory: boolean } | undefined {
  if (/[\0\r\n]/.test(name)) return undefined;
  const posix = name.replace(/\\/g, "/");
  const isDirectory = posix.endsWith("/");
  const segments: string[] = [];
  for (const seg of posix.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return undefined;
    segments.push(seg);
  }
  if (segments.length === 0) return undefined;
  // Windows drive prefixes ("C:") never belong in an entry name.
  if (/^[A-Za-z]:$/.test(segments[0])) segments.shift();
  if (segments.length === 0) return undefined;
  return { path: segments.join("/"), isDirectory };
}

/** Exact match first, then case-insensitive. */
export function findEntry<T extends ArchiveEntry>(entries: readonly T[], entryPath: string): T | undefined {
  const wanted = normalizeEntryPath(entryPath)?.path ?? entryPath;
  const exact = entries.find((e) => e.path === wanted);
  if (exact) return exact;
  const lower = wanted.toLowerCase();
  return entries.find((e) => e.path.toLowerCase() === lower);
}

/** Directory paths implied by a file path ("a/b/c.txt" -> ["a", "a/b"]). */
export function impliedDirectories(entryPath: string): string[] {
  const parts = entryPath.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Sort entries so parents come before children; stable for equal depth. */
export function sortEntries<T extends ArchiveEntry>(entries: T[]): T[] {
  return entries.sort((a, b) => comparePaths(a.path, b.path));
}

/** Check the I/O boundary again after any asynchronous operation. */
export async function beforeArchiveWrite(target: string, options: ArchiveExtractOptions, entry?: ArchiveEntry): Promise<void> {
  options.signal?.throwIfAborted();
  await options.beforeWrite?.(target, entry);
  options.signal?.throwIfAborted();
}

/** Reject existing (including dangling) symlinks outside the extraction root. */
export async function assertArchiveTarget(dest: string, target: string): Promise<void> {
  const root = await realpath(dest);
  let existing = target;
  for (;;) {
    try { await lstat(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  let canonical: string;
  try { canonical = await realpath(existing); }
  catch { throw new PathEscapeError(existing, root, "unresolvable archive destination link"); }
  const rel = relative(root, canonical);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new PathEscapeError(canonical, root, target);
}

export async function prepareArchiveTarget(dest: string, target: string, options: ArchiveExtractOptions, entry?: ArchiveEntry): Promise<void> {
  await beforeArchiveWrite(target, options, entry);
  await assertArchiveTarget(dest, target);
  await mkdir(entry?.isDirectory ? target : dirname(target), { recursive: true });
  await beforeArchiveWrite(target, options, entry);
  await assertArchiveTarget(dest, target);
}

export async function openArchiveOutput(target: string) {
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0));
  return handle.createWriteStream();
}

/** Native codecs stream to private disk staging; copy out with bounded memory.
 * Codecs never receive the install destination, so their implicit writes cannot
 * bypass per-file sandbox checks. No complete entry is read into a JS buffer.
 */
export async function extractThroughStaging(dest: string, entries: ArchiveEntry[], produce: (temp: string) => Promise<void>, options: ArchiveExtractOptions = {}): Promise<string[]> {
  for (const entry of entries) await beforeArchiveWrite(join(dest, entry.path), options, entry);
  const temp = await mkdtemp(join(tmpdir(), "modsync-extract-"));
  try {
    await produce(temp);
    options.signal?.throwIfAborted();
    await beforeArchiveWrite(dest, options);
    await mkdir(dest, { recursive: true });
    const written: string[] = [];
    for (const entry of entries) {
      const target = join(dest, entry.path).replace(/\\/g, "/");
      if (entry.isDirectory) { await prepareArchiveTarget(dest, target, options, entry); continue; }
      const source = join(temp, entry.path);
      const stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ArchiveError(`Archive entry is not a regular file: ${entry.path}`, "");
      await assertArchiveTarget(temp, source);
      await prepareArchiveTarget(dest, target, options, entry);
      await pipeline(createReadStream(source), await openArchiveOutput(target), { signal: options.signal });
      written.push(target);
    }
    return written;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
