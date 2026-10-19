/**
 * Minimal file-system abstraction used by the TSLPatcher engine so the API
 * boundary does not depend on node:fs. Paths are plain strings; callers pass
 * absolute paths. `NodePatcherFs` (nodeFs.ts) implements it over
 * node:fs/promises.
 */
export interface PatcherFs {
  /** True for an in-memory overlay where extracted files are zero-byte placeholders. */
  readonly isVirtual?: boolean;
  exists(p: string): Promise<boolean>;
  /** Resolve existing symbolic links. Native adapters must provide this for path containment. */
  realpath?(p: string): Promise<string>;
  isSymbolicLink?(p: string): Promise<boolean>;
  readFile(p: string): Promise<Uint8Array>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  /** Create a directory and all missing parents; no error when it exists. */
  mkdirp(p: string): Promise<void>;
  /** Entry names (not paths) of a directory; an empty list when it does not exist. */
  readDir(p: string): Promise<string[]>;
  copyFile(src: string, dest: string): Promise<void>;
  /** Optional: rename/move a file (used by `!OverrideType=rename`). */
  rename?(src: string, dest: string): Promise<void>;
  /** Optional: delete a file. */
  unlink?(p: string): Promise<void>;
}

export interface PatcherLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** A logger that discards everything. */
export const NullPatcherLogger: PatcherLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
