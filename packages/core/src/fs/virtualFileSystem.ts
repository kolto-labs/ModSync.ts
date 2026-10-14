/**
 * VirtualFileSystem: a copy-on-write overlay over another FileSystemPort.
 *
 * Used for dry-run validation: every instruction runs against the VFS and
 * nothing touches the disk. The base is read lazily (directory listings are
 * snapshotted on first access) and never written.
 *
 * Model:
 *   - `overlay`  maps a case-folded path to a node created or modified here.
 *   - `shadow`   is the set of case-folded paths whose *base* content is
 *                hidden (deleted or moved away), including everything below.
 *                Recreating a path after deleting it adds an overlay node; the
 *                shadow stays, so stale base children never reappear.
 *   - Lookups check the overlay first, then the shadow, then the base, and
 *     are case-insensitive over both layers so Windows-authored instruction
 *     files validate identically on every host.
 *
 * Correctness beats speed here: overlay scans are linear in the number of
 * mutated paths, which for a dry run is a few thousand at most.
 */

import { createHash } from "node:crypto";

import type { DirEntry, FileStat, FileSystemPort } from "../ports/filesystem.js";
import { baseName, comparePaths, joinPath, normalizePath, parentPath, splitPath } from "./paths.js";

export type VfsMutationKind = "write" | "delete" | "mkdir" | "move" | "copy";

export interface VfsMutation {
  kind: VfsMutationKind;
  /** Absolute POSIX-style path affected (the destination for move/copy). */
  path: string;
  /** Source path for move/copy. */
  from?: string;
}

export interface VirtualFileEntry {
  path: string;
  size: number;
}

interface OverlayNode {
  /** Canonical (display) path. */
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  /** In-memory content for files written through the VFS. */
  content?: Uint8Array;
  readContent?: () => Promise<Uint8Array>;
  /** Base path whose content this node mirrors (copies/moves of base files). */
  source?: string;
  /** Created by addVirtualFiles: reads as empty, size is tracked. */
  virtual: boolean;
}

interface Resolved {
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  /** Set when the entry comes from the overlay; otherwise the entry is base-backed. */
  node?: OverlayNode;
}

class VfsError extends Error {
  constructor(
    readonly code: "ENOENT" | "ENOTDIR" | "EISDIR",
    readonly path: string,
    message: string,
  ) {
    super(`${code}: ${message}, '${path}'`);
    this.name = "VfsError";
  }
}

function fold(p: string): string {
  return p.toLowerCase();
}

function isUnder(key: string, prefix: string): boolean {
  if (key === prefix) return true;
  return key.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}

export class VirtualFileSystem implements FileSystemPort {
  readonly isVirtual = true;

  private readonly overlay = new Map<string, OverlayNode>();
  private readonly shadow = new Set<string>();
  private readonly baseListings = new Map<string, Map<string, DirEntry> | null>();
  private readonly baseStats = new Map<string, FileStat | null>();
  private readonly mutations: VfsMutation[] = [];

  constructor(readonly base: FileSystemPort) {}

  getMutations(): VfsMutation[] {
    return this.mutations.map((m) => ({ ...m }));
  }

  /** Register files that "exist" without content (simulated Extract). */
  async addVirtualFiles(entries: readonly VirtualFileEntry[]): Promise<void> {
    for (const entry of entries) {
      const norm = normalizePath(entry.path);
      await this.mkdirp(parentPath(norm));
      const path = await this.canonicalChildPath(parentPath(norm), baseName(norm));
      const existing = await this.lookup(path);
      if (existing?.isDirectory) throw new VfsError("EISDIR", path, "illegal operation on a directory");
      this.setNode({ path, isDirectory: false, size: entry.size, mtimeMs: Date.now(), virtual: true });
      this.mutations.push({ kind: "write", path });
    }
  }

  /** Logical immutable input/member projection; reads lazily, never creates disk files. */
  async addReadOnlyFile(path: string, size: number, readContent: () => Promise<Uint8Array>): Promise<void> {
    const norm=normalizePath(path);await this.mkdirp(parentPath(norm));
    const target=await this.canonicalChildPath(parentPath(norm),baseName(norm));
    if((await this.lookup(target))?.isDirectory)throw new VfsError("EISDIR",target,"destination is a directory");
    this.setNode({path:target,isDirectory:false,size,mtimeMs:0,virtual:false,readContent});
    this.mutations.push({kind:"write",path:target});
  }

  async exists(path: string): Promise<boolean> {
    return (await this.lookup(path)) !== undefined;
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const r = await this.lookup(path);
    if (!r) return undefined;
    return { path: r.path, isDirectory: r.isDirectory, size: r.size, mtimeMs: r.mtimeMs };
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const r = await this.lookup(path);
    if (!r) throw new VfsError("ENOENT", normalizePath(path), "no such file or directory");
    if (!r.isDirectory) throw new VfsError("ENOTDIR", r.path, "not a directory");
    const dirKey = fold(r.path);
    const merged = new Map<string, DirEntry>();

    if (!this.isShadowed(dirKey)) {
      const listing = await this.baseListing(r.path);
      if (listing) {
        for (const [nameKey, entry] of listing) {
          if (this.isShadowed(fold(entry.path))) continue;
          merged.set(nameKey, entry);
        }
      }
    }
    for (const node of this.overlay.values()) {
      if (fold(parentPath(node.path)) !== dirKey) continue;
      const name = baseName(node.path);
      merged.set(fold(name), { name, path: node.path, isDirectory: node.isDirectory });
    }
    return [...merged.values()].sort((a, b) => comparePaths(a.name, b.name));
  }

  async walk(path: string): Promise<string[]> {
    const r = await this.lookup(path);
    if (!r) return [];
    if (!r.isDirectory) return [r.path];
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      for (const entry of await this.readDir(dir)) {
        if (entry.isDirectory) await visit(entry.path);
        else out.push(entry.path);
      }
    };
    await visit(r.path);
    return out;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const r = await this.lookup(path);
    if (!r) throw new VfsError("ENOENT", normalizePath(path), "no such file or directory");
    if (r.isDirectory) throw new VfsError("EISDIR", r.path, "illegal operation on a directory");
    if (!r.node) return this.base.readFile(r.path);
    if (r.node.content) return r.node.content;
    if (r.node.readContent) { const bytes=await r.node.readContent();if(bytes.byteLength!==r.node.size)throw new Error("Immutable virtual content size changed");return bytes; }
    if (r.node.source !== undefined) return this.base.readFile(r.node.source);
    return new Uint8Array(0);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const norm = normalizePath(path);
    await this.mkdirp(parentPath(norm));
    const target = await this.canonicalChildPath(parentPath(norm), baseName(norm));
    const existing = await this.lookup(target);
    if (existing?.isDirectory) throw new VfsError("EISDIR", target, "illegal operation on a directory");
    this.setNode({ path: target, isDirectory: false, size: data.byteLength, mtimeMs: Date.now(), content: data, virtual: false });
    this.mutations.push({ kind: "write", path: target });
  }

  async inspectDirectoryEntries(path: string): Promise<DirEntry[]> {
    const entries=new Map<string,DirEntry>(); const basePath=await this.base.resolveCase(path);
    if(basePath&&!this.isShadowed(fold(basePath))) {
      if(!this.base.inspectDirectoryEntries)throw new Error("Base cannot preserve case collisions");
      for(const entry of await this.base.inspectDirectoryEntries(basePath))if(!this.isShadowed(fold(entry.path)))entries.set(entry.name,entry);
    }
    for(const node of this.overlay.values())if(fold(parentPath(node.path))===fold(path))entries.set(baseName(node.path),{name:baseName(node.path),path:node.path,isDirectory:node.isDirectory});
    return [...entries.values()];
  }

  async inspectPath(path: string): Promise<(FileStat & { isSymbolicLink: boolean }) | undefined> {
    const r = await this.lookup(path); if (!r) return undefined;
    if (r.node) return {path:r.path,isDirectory:r.isDirectory,size:r.size,mtimeMs:r.mtimeMs,isSymbolicLink:false};
    if (!this.base.inspectPath) throw new Error("Base filesystem cannot inspect symlink metadata");
    return this.base.inspectPath(r.path);
  }

  async projectDirectory(path: string): Promise<void> {
    const parent=await this.lookup(parentPath(path));
    if (!parent?.isDirectory) throw new VfsError("ENOTDIR",path,"directory parent does not exist");
    const target=joinPath(parent.path,baseName(path)); const existing=await this.lookup(target);
    if(existing) {if(!existing.isDirectory)throw new VfsError("ENOTDIR",target,"destination is a file");return;}
    this.setNode({path:target,isDirectory:true,size:0,mtimeMs:Date.now(),virtual:false});
    this.mutations.push({kind:"mkdir",path:target});
  }

  async mkdirp(path: string): Promise<void> {
    const { root, segments } = splitPath(path);
    if (root === "") throw new VfsError("ENOENT", path, "relative path");
    let current = root;
    for (const seg of segments) {
      const next = joinPath(current, seg);
      const r = await this.lookup(next);
      if (r) {
        if (!r.isDirectory) throw new VfsError("ENOTDIR", r.path, "not a directory");
        current = r.path;
        continue;
      }
      this.setNode({ path: next, isDirectory: true, size: 0, mtimeMs: Date.now(), virtual: false });
      this.mutations.push({ kind: "mkdir", path: next });
      current = next;
    }
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const s = await this.lookup(src);
    if (!s) throw new VfsError("ENOENT", normalizePath(src), "no such file or directory");
    if (s.isDirectory) throw new VfsError("EISDIR", s.path, "illegal operation on a directory");
    const target = await this.placeFileCopy(s, dest);
    this.mutations.push({ kind: "copy", path: target, from: s.path });
  }

  async move(src: string, dest: string): Promise<void> {
    const s = await this.lookup(src);
    if (!s) throw new VfsError("ENOENT", normalizePath(src), "no such file or directory");
    const destNorm = normalizePath(dest);
    if (fold(s.path) === fold(destNorm)) {
      this.mutations.push({ kind: "move", path: destNorm, from: s.path });
      return;
    }
    if (!s.isDirectory) {
      const target = await this.placeFileCopy(s, destNorm);
      this.hide(s.path);
      this.mutations.push({ kind: "move", path: target, from: s.path });
      return;
    }
    if (isUnder(fold(destNorm), fold(s.path))) {
      throw new VfsError("ENOENT", destNorm, "cannot move a directory into itself");
    }
    // Snapshot the whole subtree before hiding the source.
    const subtree = await this.enumerate(s.path);
    await this.mkdirp(destNorm);
    const targetRoot = (await this.lookup(destNorm))!.path;
    const prefixLen = s.path.length + 1;
    for (const entry of subtree) {
      const rel = entry.path.slice(prefixLen);
      const target = joinPath(targetRoot, rel);
      if (entry.isDirectory) {
        await this.mkdirp(target);
      } else {
        await this.placeFileCopy(entry, target);
      }
    }
    this.hide(s.path);
    this.mutations.push({ kind: "move", path: targetRoot, from: s.path });
  }

  async remove(path: string): Promise<void> {
    const r = await this.lookup(path);
    if (!r) return;
    this.hide(r.path);
    this.mutations.push({ kind: "delete", path: r.path });
  }

  async resolveCase(path: string): Promise<string | undefined> {
    return (await this.lookup(path))?.path;
  }

  async sha1(path: string): Promise<string> {
    const r = await this.lookup(path);
    if (!r) throw new VfsError("ENOENT", normalizePath(path), "no such file or directory");
    if (r.isDirectory) throw new VfsError("EISDIR", r.path, "illegal operation on a directory");
    if (!r.node) return this.base.sha1(r.path);
    if (r.node.content || r.node.readContent) return createHash("sha1").update(await this.readFile(r.path)).digest("hex");
    if (r.node.source !== undefined) return this.base.sha1(r.node.source);
    return createHash("sha1").update(new Uint8Array(0)).digest("hex");
  }

  // ---- internals -------------------------------------------------------

  /** Resolve a path against overlay then base, case-insensitively. */
  private async lookup(path: string): Promise<Resolved | undefined> {
    const norm = normalizePath(path);
    const key = fold(norm);
    const node = this.overlay.get(key);
    if (node) return { path: node.path, isDirectory: node.isDirectory, size: node.size, mtimeMs: node.mtimeMs, node };
    if (this.isShadowed(key)) return undefined;

    const { root, segments } = splitPath(norm);
    if (root === "") return undefined;
    if (segments.length === 0) {
      const st = await this.baseStat(root);
      return st ? { path: root, isDirectory: true, size: 0, mtimeMs: st.mtimeMs } : undefined;
    }
    let current = root;
    let entry: DirEntry | undefined;
    for (const seg of segments) {
      const listing = await this.baseListing(current);
      entry = listing?.get(fold(seg));
      if (!entry) return undefined;
      current = entry.path;
    }
    if (!entry) return undefined;
    if (entry.isDirectory) return { path: entry.path, isDirectory: true, size: 0, mtimeMs: 0 };
    const st = await this.baseStat(entry.path);
    return { path: entry.path, isDirectory: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 };
  }

  private isShadowed(key: string): boolean {
    for (const s of this.shadow) if (isUnder(key, s)) return true;
    return false;
  }

  private async baseListing(dir: string): Promise<Map<string, DirEntry> | null> {
    const key = fold(dir);
    const cached = this.baseListings.get(key);
    if (cached !== undefined) return cached;
    let listing: Map<string, DirEntry> | null;
    try {
      const entries = await this.base.readDir(dir);
      listing = new Map(entries.map((e) => [fold(e.name), { ...e, path: normalizePath(e.path) }]));
    } catch {
      listing = null;
    }
    this.baseListings.set(key, listing);
    return listing;
  }

  private async baseStat(path: string): Promise<FileStat | null> {
    const key = fold(path);
    const cached = this.baseStats.get(key);
    if (cached !== undefined) return cached;
    let st: FileStat | null;
    try {
      st = (await this.base.stat(path)) ?? null;
    } catch {
      st = null;
    }
    this.baseStats.set(key, st);
    return st;
  }

  private setNode(node: OverlayNode): void {
    this.overlay.set(fold(node.path), node);
  }

  /** Hide a path (and everything below it) from both layers. */
  private hide(canonical: string): void {
    const key = fold(canonical);
    for (const k of [...this.overlay.keys()]) {
      if (isUnder(k, key)) this.overlay.delete(k);
    }
    this.shadow.add(key);
  }

  /** Canonical path for a child of `parent`, reusing existing casing when present. */
  private async canonicalChildPath(parent: string, name: string): Promise<string> {
    const p = await this.lookup(parent);
    const parentCanonical = p?.path ?? normalizePath(parent);
    const candidate = joinPath(parentCanonical, name);
    const existing = await this.lookup(candidate);
    return existing?.path ?? candidate;
  }

  /** Create an overlay file at `dest` mirroring `s`; returns the canonical dest path. */
  private async placeFileCopy(s: Resolved, dest: string): Promise<string> {
    const destNorm = normalizePath(dest);
    await this.mkdirp(parentPath(destNorm));
    const target = await this.canonicalChildPath(parentPath(destNorm), baseName(destNorm));
    const existing = await this.lookup(target);
    if (existing?.isDirectory) throw new VfsError("EISDIR", target, "illegal operation on a directory");
    const node: OverlayNode = {
      path: target,
      isDirectory: false,
      size: s.size,
      mtimeMs: Date.now(),
      virtual: s.node?.virtual ?? false,
    };
    if (s.node) {
      if (s.node.content) node.content = s.node.content;
      else if (s.node.readContent) node.readContent = s.node.readContent;
      else if (s.node.source !== undefined) node.source = s.node.source;
    } else {
      node.source = s.path;
    }
    this.setNode(node);
    return target;
  }

  /** All entries (files and directories) below a directory, depth-first, parents before children. */
  private async enumerate(dir: string): Promise<Resolved[]> {
    const out: Resolved[] = [];
    const visit = async (d: string): Promise<void> => {
      for (const entry of await this.readDir(d)) {
        const r = await this.lookup(entry.path);
        if (!r) continue;
        out.push(r);
        if (r.isDirectory) await visit(r.path);
      }
    };
    await visit(dir);
    return out;
  }
}
