/**
 * ArchiveReader: per-format adapters (zip, rar, 7z, 7z SFX exe) behind one
 * interface. Listing is separate from extraction so validation never inflates.
 */

export type ArchiveFormat = "zip" | "rar" | "7z" | "7z-sfx";

export interface ArchiveEntry {
  /** Normalized: forward slashes, no leading "./" or "/". Directories end without slash. */
  path: string;
  isDirectory: boolean;
  size: number;
}

export interface ArchiveExtractOptions {
  /** Called before destination directories/files are created or written. */
  beforeWrite?: (absolutePath: string, entry?: ArchiveEntry) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ArchiveReader {
  readonly format: ArchiveFormat;
  readonly archivePath: string;
  list(): Promise<ArchiveEntry[]>;
  /**
   * Extract every entry (or those matching the filter) into destDir,
   * preserving relative paths. Returns the absolute paths written.
   */
  extract(destDir: string, filter?: (entry: ArchiveEntry) => boolean, options?: ArchiveExtractOptions): Promise<string[]>;
  /** Read one entry fully into memory. */
  readEntry(entryPath: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface ArchiveOpener {
  /** Detect the format from magic bytes (not just the extension). */
  detect(path: string): Promise<ArchiveFormat | undefined>;
  open(path: string): Promise<ArchiveReader>;
}
