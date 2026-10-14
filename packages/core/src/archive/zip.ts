/**
 * Zip adapter built on yauzl: lazy central-directory reads, streaming
 * extraction, zip64 support comes for free.
 */

import { mkdir } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import yauzl from "yauzl";

import { joinPath, normalizePath } from "../fs/paths.js";
import type { ArchiveEntry, ArchiveExtractOptions, ArchiveReader } from "../ports/archive.js";
import { ArchiveEntryNotFoundError, ArchiveError, beforeArchiveWrite, openArchiveOutput, prepareArchiveTarget, findEntry, normalizeEntryPath, sortEntries } from "./common.js";

interface ZipEntryRecord extends ArchiveEntry {
  raw: yauzl.Entry;
}

function openZipFile(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err || !zipfile) reject(new ArchiveError(`Cannot open zip "${path}": ${err?.message ?? "unknown"}`, path, { cause: err }));
      else resolve(zipfile);
    });
  });
}

function readAllEntries(zipfile: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zipfile.on("entry", (entry: yauzl.Entry) => {
      entries.push(entry);
      zipfile.readEntry();
    });
    zipfile.once("end", () => resolve(entries));
    zipfile.once("error", (err: Error) => reject(new ArchiveError(`Invalid zip entry: ${err.message}`, "", { cause: err })));
    zipfile.readEntry();
  });
}

function openReadStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error("no stream"));
      else resolve(stream);
    });
  });
}

async function streamToBytes(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export class ZipArchive implements ArchiveReader {
  readonly format = "zip" as const;
  private entriesPromise: Promise<ZipEntryRecord[]> | undefined;
  private closed = false;

  private constructor(
    readonly archivePath: string,
    private readonly zipfile: yauzl.ZipFile,
  ) {}

  static async open(path: string): Promise<ZipArchive> {
    const norm = normalizePath(path);
    return new ZipArchive(norm, await openZipFile(norm));
  }

  async list(): Promise<ArchiveEntry[]> {
    const records = await this.records();
    return records.map(({ path, isDirectory, size }) => ({ path, isDirectory, size }));
  }

  async extract(destDir: string, filter?: (entry: ArchiveEntry) => boolean, options: ArchiveExtractOptions = {}): Promise<string[]> {
    const dest = normalizePath(destDir);
    await beforeArchiveWrite(dest, options);
    await mkdir(dest, { recursive: true });
    const written: string[] = [];
    for (const record of await this.records()) {
      if (filter && !filter(record)) continue;
      const target = joinPath(dest, record.path);
      await prepareArchiveTarget(dest, target, options, record);
      if (record.isDirectory) continue;
      const stream = await openReadStream(this.zipfile, record.raw);
      await pipeline(stream, await openArchiveOutput(target), { signal: options.signal });
      written.push(target);
    }
    return written;
  }

  async readEntry(entryPath: string): Promise<Uint8Array> {
    const record = findEntry(await this.records(), entryPath);
    if (!record) throw new ArchiveEntryNotFoundError(this.archivePath, entryPath);
    if (record.isDirectory) throw new ArchiveError(`"${entryPath}" is a directory`, this.archivePath);
    return streamToBytes(await openReadStream(this.zipfile, record.raw));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.zipfile.close();
  }

  private records(): Promise<ZipEntryRecord[]> {
    this.entriesPromise ??= readAllEntries(this.zipfile).catch((err: ArchiveError) => {
      throw new ArchiveError(err.message, this.archivePath, { cause: err.cause });
    }).then((raws) => {
      const seen = new Set<string>();
      const out: ZipEntryRecord[] = [];
      for (const raw of raws) {
        const normalized = normalizeEntryPath(raw.fileName);
        if (!normalized) continue;
        const key = normalized.path.toLowerCase() + (normalized.isDirectory ? "/" : "");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          path: normalized.path,
          isDirectory: normalized.isDirectory,
          size: normalized.isDirectory ? 0 : raw.uncompressedSize,
          raw,
        });
      }
      return sortEntries(out);
    });
    return this.entriesPromise;
  }
}

export function openZip(path: string): Promise<ArchiveReader> {
  return ZipArchive.open(path);
}
