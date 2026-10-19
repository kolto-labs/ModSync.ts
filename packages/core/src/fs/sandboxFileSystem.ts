import * as nodePath from "node:path";
import type { Directories } from "../model/types.js";
import type { DirEntry, FileStat, FileSystemPort } from "../ports/filesystem.js";
import { isInsideRoot, joinPath, normalizePath, parentPath, PathEscapeError, PathResolver, baseName } from "./paths.js";
import { VirtualFileSystem, type VirtualFileEntry, type VfsMutation } from "./virtualFileSystem.js";

/** Enforce root containment at the I/O boundary, including symbolic links. */
export class SandboxFileSystem implements FileSystemPort {
  private readonly roots: string[];
  constructor(readonly base: FileSystemPort, dirs: Directories) {
    const resolver = new PathResolver(dirs);
    this.roots = [resolver.modDirectory, resolver.kotorDirectory];
    const baseRange = base.readRange?.bind(base);
    if (baseRange) this.readRange = async (path, offset, length) => { await this.assertPath(path); return baseRange(path, offset, length); };
  }
  readonly readRange?: (path: string, offset: number, length: number) => Promise<Uint8Array>;
  get isVirtual(): boolean { return this.base.isVirtual; }

  private async canonical(path: string): Promise<string> {
    const norm = normalizePath(path);
    if (!this.base.realpath) return (await this.base.resolveCase(norm)) ?? norm;
    if (await this.base.exists(norm)) {
      try { return normalizePath(await this.base.realpath(norm)); }
      catch (err) {
        if (await this.base.isSymbolicLink?.(norm)) throw new PathEscapeError(norm, this.roots.join(" or "), `unresolvable symbolic link ${path}`);
        throw err;
      }
    }
    if (await this.base.isSymbolicLink?.(norm)) throw new PathEscapeError(norm, this.roots.join(" or "), `dangling symbolic link ${path}`);
    const parent = parentPath(norm);
    if (parent === norm) return norm;
    return joinPath(await this.canonical(parent), baseName(norm));
  }

  async assertPath(path: string): Promise<void> {
    const norm = normalizePath(path);
    const roots = this.roots.filter((root) => isInsideRoot(root, norm));
    if (!roots.length) throw new PathEscapeError(norm, this.roots.join(" or "));
    const canonical = await this.canonical(norm);
    for (const root of roots) {
      // Canonical paths describe actual native filesystem entries. Do not apply
      // Windows-authored instruction spelling rules to POSIX inode locations.
      const relative = nodePath.relative(await this.canonical(root), canonical);
      if (relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative)) return;
    }
    throw new PathEscapeError(canonical, roots.join(" or "), path);
  }

  async isSymbolicLink(path: string): Promise<boolean> { await this.assertPath(path); return this.base.isSymbolicLink ? this.base.isSymbolicLink(path) : false; }
  async realpath(path: string): Promise<string> { await this.assertPath(path); return this.canonical(path); }
  async exists(path: string): Promise<boolean> { await this.assertPath(path); return this.base.exists(path); }
  async stat(path: string): Promise<FileStat | undefined> { await this.assertPath(path); return this.base.stat(path); }
  async readDir(path: string): Promise<DirEntry[]> {
    await this.assertPath(path);
    const entries = await this.base.readDir(path);
    return entries;
  }
  async walk(path: string): Promise<string[]> {
    await this.assertPath(path);
    const stat = await this.base.stat(path);
    if (!stat) return [];
    if (!stat.isDirectory) return [stat.path];
    const files: string[] = [];
    const visited = new Set<string>();
    const visit = async (dir: string): Promise<void> => {
      await this.assertPath(dir);
      const canonical = await this.canonical(dir);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      for (const entry of await this.base.readDir(dir)) {
        await this.assertPath(entry.path);
        if (entry.isDirectory) await visit(entry.path);
        else files.push(entry.path);
      }
    };
    await visit(stat.path);
    return files;
  }
  async readFile(path: string): Promise<Uint8Array> { await this.assertPath(path); return this.base.readFile(path); }
  async writeFile(path: string, data: Uint8Array): Promise<void> { await this.assertPath(path); return this.base.writeFile(path, data); }
  async mkdirp(path: string): Promise<void> { await this.assertPath(path); return this.base.mkdirp(path); }
  async copyFile(src: string, dest: string): Promise<void> { await this.assertPath(src); await this.assertPath(dest); return this.base.copyFile(src, dest); }
  async move(src: string, dest: string): Promise<void> { await this.assertPath(src); await this.assertPath(dest); return this.base.move(src, dest); }
  async remove(path: string): Promise<void> { await this.assertPath(path); return this.base.remove(path); }
  async resolveCase(path: string): Promise<string | undefined> { await this.assertPath(path); return this.base.resolveCase(path); }
  async sha1(path: string): Promise<string> { await this.assertPath(path); return this.base.sha1(path); }

  async addVirtualFiles(entries: readonly VirtualFileEntry[]): Promise<void> {
    if (!(this.base instanceof VirtualFileSystem)) throw new Error("Virtual files require a virtual file system");
    for (const entry of entries) await this.assertPath(entry.path);
    await this.base.addVirtualFiles(entries);
  }
  getMutations(): VfsMutation[] { return this.base instanceof VirtualFileSystem ? this.base.getMutations() : []; }
}
