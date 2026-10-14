/**
 * RealFileSystem: node:fs/promises behind the FileSystemPort.
 *
 * Paths in and out are POSIX-style (see fs/paths.ts). Node accepts forward
 * slashes on Windows, so no separator conversion is needed for calls, and
 * every path we hand back is rebuilt from our own POSIX-style inputs.
 *
 * Lookups are case-insensitive: when an exact path does not exist, the
 * on-disk spelling is searched segment by segment (resolveCase) so
 * instruction files written on Windows keep working on Linux and macOS.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import type { DirEntry, FileStat, FileSystemPort } from "../ports/filesystem.js";
import { comparePaths, joinPath, normalizePath, parentPath, splitPath } from "./paths.js";

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function isMissing(err: unknown): boolean {
  const code = errorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

export class RealFileSystem implements FileSystemPort {
  readonly isVirtual = false;

  inspectDirectoryEntries(path: string): Promise<DirEntry[]> { return this.readDir(path); }

  async inspectPath(path: string): Promise<(FileStat & { isSymbolicLink: boolean }) | undefined> {
    try { const st = await fsp.lstat(normalizePath(path)); return { path: normalizePath(path), isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(), size: st.size, mtimeMs: st.mtimeMs }; }
    catch (err) { if (isMissing(err)) return undefined; throw err; }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.resolveExisting(path)) !== undefined;
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const actual = await this.resolveExisting(path);
    if (actual === undefined) return undefined;
    try {
      const st = await fsp.stat(actual);
      return { path: actual, isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw err;
    }
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const actual = (await this.resolveExisting(path)) ?? normalizePath(path);
    const dirents = await fsp.readdir(actual, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      let isDirectory = d.isDirectory();
      if (d.isSymbolicLink()) {
        try {
          isDirectory = (await fsp.stat(joinPath(actual, d.name))).isDirectory();
        } catch {
          continue; // dangling symlink
        }
      }
      entries.push({ name: d.name, path: joinPath(actual, d.name), isDirectory });
    }
    entries.sort((a, b) => comparePaths(a.name, b.name));
    return entries;
  }

  async walk(path: string): Promise<string[]> {
    const actual = await this.resolveExisting(path);
    if (actual === undefined) return [];
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      for (const entry of await this.readDir(dir)) {
        if (entry.isDirectory) await visit(entry.path);
        else out.push(entry.path);
      }
    };
    const st = await fsp.stat(actual);
    if (!st.isDirectory()) return [actual];
    await visit(actual);
    return out;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const actual = (await this.resolveExisting(path)) ?? normalizePath(path);
    const buf = await fsp.readFile(actual);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const target = (await this.resolveExisting(path)) ?? normalizePath(path);
    await this.mkdirp(parentPath(target));
    await fsp.writeFile(target, data);
  }

  async mkdirp(path: string): Promise<void> {
    await fsp.mkdir(normalizePath(path), { recursive: true });
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const from = (await this.resolveExisting(src)) ?? normalizePath(src);
    const to = (await this.resolveExisting(dest)) ?? normalizePath(dest);
    await this.mkdirp(parentPath(to));
    await fsp.copyFile(from, to);
  }

  async move(src: string, dest: string): Promise<void> {
    const from = (await this.resolveExisting(src)) ?? normalizePath(src);
    const to = normalizePath(dest);
    await this.mkdirp(parentPath(to));
    try {
      await fsp.rename(from, to);
    } catch (err) {
      if (errorCode(err) !== "EXDEV") throw err;
      // Across devices: copy then delete.
      const st = await fsp.stat(from);
      if (st.isDirectory()) {
        await fsp.cp(from, to, { recursive: true, force: true, errorOnExist: false });
      } else {
        await fsp.copyFile(from, to);
      }
      await fsp.rm(from, { recursive: true, force: true });
    }
  }

  async remove(path: string): Promise<void> {
    const actual = await this.resolveExisting(path);
    if (actual === undefined) return;
    await fsp.rm(actual, { recursive: true, force: true });
  }

  /**
   * Find the on-disk spelling of `path`. The deepest ancestor that exists
   * with the given spelling is kept; each remaining segment is matched
   * case-insensitively against its parent's listing.
   */
  async resolveCase(path: string): Promise<string | undefined> {
    const norm = normalizePath(path);
    if (await pathExists(norm)) return norm;
    const { root, segments } = splitPath(norm);
    if (root === "") return undefined;

    // Deepest existing ancestor with exact spelling.
    let depth = segments.length - 1;
    let current = root;
    while (depth > 0) {
      const candidate = root + segments.slice(0, depth).join("/");
      if (await pathExists(candidate)) {
        current = candidate;
        break;
      }
      depth--;
    }
    if (depth === 0 && !(await pathExists(root))) return undefined;

    for (let i = depth; i < segments.length; i++) {
      const wanted = segments[i].toLowerCase();
      let names: string[];
      try {
        names = await fsp.readdir(current);
      } catch (err) {
        if (isMissing(err) || errorCode(err) === "ENOTDIR") return undefined;
        throw err;
      }
      const exact = names.find((n) => n === segments[i]);
      const match = exact ?? names.find((n) => n.toLowerCase() === wanted);
      if (match === undefined) return undefined;
      current = joinPath(current, match);
    }
    return current;
  }

  async sha1(path: string): Promise<string> {
    const actual = (await this.resolveExisting(path)) ?? normalizePath(path);
    const hash = createHash("sha1");
    await pipeline(createReadStream(actual), hash);
    return hash.digest("hex");
  }

  private async resolveExisting(path: string): Promise<string | undefined> {
    return this.resolveCase(path);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}
