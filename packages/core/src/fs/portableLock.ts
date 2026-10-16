/**
 * CI-only writer ownership fallback for plain directories.
 *
 * `writerOwnership.ts` needs a native flock addon that CI does not build. This
 * module is the explicit, opt-in substitute: an `O_CREAT|O_EXCL` lockfile per
 * install root, written as a sibling of the root. It is advisory and only
 * excludes other ModSync processes that use the same scheme. It does not
 * defend against hostile ancestor replacement, and a crashed process leaves its
 * lockfile behind: a stale lock is never stolen automatically, the operator must
 * inspect and delete it. Nothing here is a default; callers must pass a
 * `PhysicalInstallOptIn`.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export const PHYSICAL_INSTALL_ENV = "MODSYNC_CI_PHYSICAL_INSTALL";

/** Explicit acknowledgement that a physical write uses the portable CI lock, not native OS ownership. */
export interface PhysicalInstallOptIn {
  readonly ownership: "portable-lockfile";
}

export class PortableLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableLockError";
  }
}

/** Build the opt-in from a CLI flag or `MODSYNC_CI_PHYSICAL_INSTALL=1`; anything else keeps physical writes refused. */
export function physicalInstallOptIn(flag?: boolean, env: Record<string, string | undefined> = process.env): PhysicalInstallOptIn | undefined {
  return flag === true || env[PHYSICAL_INSTALL_ENV] === "1" ? { ownership: "portable-lockfile" } : undefined;
}

interface LockRecord {
  token: string;
  pid: number;
  host: string;
  root: string;
  acquiredAt: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

const openFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

async function describeHolder(path: string): Promise<string> {
  try {
    const held = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
    return `pid ${held.pid ?? "?"} on ${held.host ?? "?"} since ${held.acquiredAt ?? "?"}`;
  } catch {
    return "unreadable lock record";
  }
}

async function acquire(root: string): Promise<() => Promise<void>> {
  const digest = createHash("sha256").update(root, "utf8").digest("hex").slice(0, 16);
  const path = join(dirname(root), `.modsync-portable-lock-${digest}`);
  const record: LockRecord = { token: randomUUID(), pid: process.pid, host: hostname(), root, acquiredAt: new Date().toISOString() };
  let handle;
  try {
    handle = await open(path, openFlags, 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new PortableLockError(
        `Install root is locked (${await describeHolder(path)}): ${path}. If no ModSync process is running, a previous run crashed; verify that and delete the lockfile manually. It is never removed automatically.`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const identity = await lstat(path, { bigint: true });
  return async () => {
    const current = await lstat(path, { bigint: true });
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new PortableLockError(`Portable lock identity changed before release; leaving ${path} in place`);
    }
    const held = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
    if (held.token !== record.token) throw new PortableLockError(`Portable lock ownership changed before release; leaving ${path} in place`);
    await unlink(path);
  };
}

/** Locks held by this process; call `release` exactly when the guarded work is over. */
export interface PortableRootOwnership {
  readonly roots: readonly string[];
  release(): Promise<void>;
}

/**
 * Lock every distinct canonical root (acquired in byte order). A lock taken
 * earlier is released if a later one fails. Roots must exist as directories
 * and have a parent directory.
 */
export async function acquirePortableRootOwnership(roots: readonly string[]): Promise<PortableRootOwnership> {
  const canonical = [...new Set(await Promise.all(roots.map((root) => realpath(root))))].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  if (canonical.length === 0 || canonical.some((root) => dirname(root) === root)) throw new PortableLockError("Install roots must exist and have a parent directory");
  for (const root of canonical) if (!(await lstat(root)).isDirectory()) throw new PortableLockError(`Install root is not a directory: ${root}`);
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const root of canonical) releases.push(await acquire(root));
  } catch (error) {
    for (const release of releases.reverse()) await release().catch(() => undefined);
    throw error;
  }
  let released = false;
  return {
    roots: canonical,
    async release() {
      if (released) return;
      released = true;
      const errors: unknown[] = [];
      for (const release of [...releases].reverse()) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw errors[0];
    },
  };
}

/** Hold portable ownership of `roots` while `work` runs, then release it. */
export async function withPortableRootOwnership<T>(roots: readonly string[], work: () => Promise<T>): Promise<T> {
  const ownership = await acquirePortableRootOwnership(roots);
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await ownership.release().catch(() => undefined);
    throw error;
  }
  await ownership.release();
  return result;
}
