/**
 * FileSystemPort: the single abstraction every action runs against.
 *
 * Two implementations exist in core:
 *   - RealFileSystem: node:fs backed, used during a real install.
 *   - VirtualFileSystem: an overlay (disk snapshot + recorded mutations),
 *     used for dry-run validation. It can also "see inside" archives via the
 *     ArchiveReader port so Extract can be simulated without inflating.
 *
 * All paths handed to a port are absolute and already sandbox-checked by the
 * PathResolver. Ports never resolve placeholders. Separators are always "/"
 * inside core; the real adapter converts on Windows.
 */

export interface FileStat {
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FileSystemPort {
  withInstallRootOwnership?<T>(modDirectory: string, gameDirectory: string, work: () => Promise<T>): Promise<T>;
  /** Non-following metadata required for directory authoring safety; omitted ports fail closed. */
  /** Preserve case-collision entries for strict directory authoring checks. */
  inspectDirectoryEntries?(path: string): Promise<DirEntry[]>;
  inspectPath?(path: string): Promise<(FileStat & { isSymbolicLink: boolean }) | undefined>;
  /** Single-leaf virtual projection only. Real execution needs durable directory ownership. */
  projectDirectory?(path: string): Promise<void>;
  /** True if a file or directory exists at the path (case-insensitive lookup allowed). */
  exists(path: string): Promise<boolean>;
  /** Canonical path after resolving symbolic links, when supported by the adapter. */
  realpath?(path: string): Promise<string>;
  /** Detect links even when their target does not exist. */
  isSymbolicLink?(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | undefined>;
  /** Non-recursive listing. */
  readDir(path: string): Promise<DirEntry[]>;
  /** Recursive listing of files (not directories) under a root, absolute paths. */
  walk(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdirp(path: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  move(src: string, dest: string): Promise<void>;
  /** Remove a file, or a directory recursively. */
  remove(path: string): Promise<void>;
  /**
   * Resolve the on-disk spelling of a path whose case may differ from the
   * real one (Windows-authored instruction files on Linux). Returns undefined
   * when nothing matches.
   */
  resolveCase(path: string): Promise<string | undefined>;
  /** Compute SHA1 hex of a file. */
  sha1(path: string): Promise<string>;
  /** Whether mutations are actually persisted (false for the VFS). */
  readonly isVirtual: boolean;
}
