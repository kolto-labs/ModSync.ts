import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PHYSICAL_INSTALL_ENV, PortableLockError, acquirePortableRootOwnership, physicalInstallOptIn, withPortableRootOwnership } from "./portableLock.js";

let base: string;
let root: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "modsync-lock-"));
  root = join(base, "root");
  await mkdir(root);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const locksIn = async (): Promise<string[]> => (await readdir(base)).filter((name) => name.startsWith(".modsync-portable-lock-"));

describe("portable CI writer lock", () => {
  it("is only enabled by an explicit flag or MODSYNC_CI_PHYSICAL_INSTALL=1", () => {
    expect(physicalInstallOptIn(undefined, {})).toBeUndefined();
    expect(physicalInstallOptIn(false, { [PHYSICAL_INSTALL_ENV]: "true" })).toBeUndefined();
    expect(physicalInstallOptIn(false, { [PHYSICAL_INSTALL_ENV]: "0" })).toBeUndefined();
    expect(physicalInstallOptIn(true, {})).toEqual({ ownership: "portable-lockfile" });
    expect(physicalInstallOptIn(undefined, { [PHYSICAL_INSTALL_ENV]: "1" })).toEqual({ ownership: "portable-lockfile" });
  });

  it("creates an exclusive sibling lockfile, rejects a second holder and removes it on release", async () => {
    const held = await acquirePortableRootOwnership([root]);
    expect(await locksIn()).toHaveLength(1);
    await expect(acquirePortableRootOwnership([root])).rejects.toThrow(/locked/);
    expect(await readdir(root)).toEqual([]);
    await held.release();
    await held.release();
    expect(await locksIn()).toEqual([]);
    await (await acquirePortableRootOwnership([root])).release();
  });

  it("releases the lock when the guarded work throws", async () => {
    await expect(withPortableRootOwnership([root], async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await locksIn()).toEqual([]);
  });

  it("never steals a leftover lock from a crashed process", async () => {
    const held = await acquirePortableRootOwnership([root]);
    const [name] = await locksIn();
    await held.release();
    await writeFile(join(base, name), JSON.stringify({ token: "other", pid: 1, host: "elsewhere", acquiredAt: "then" }));
    await expect(acquirePortableRootOwnership([root])).rejects.toThrow(/pid 1 on elsewhere.*delete the lockfile manually/s);
    expect(await locksIn()).toEqual([name]);
  });

  it("releases earlier locks when a later root is already locked", async () => {
    const second = join(base, "second");
    await mkdir(second);
    const holder = await acquirePortableRootOwnership([second]);
    await expect(acquirePortableRootOwnership([root, second])).rejects.toBeInstanceOf(PortableLockError);
    expect(await locksIn()).toHaveLength(1);
    await holder.release();
    expect(await locksIn()).toEqual([]);
  });

  it("refuses roots that do not exist", async () => {
    await expect(acquirePortableRootOwnership([join(base, "missing")])).rejects.toThrow();
  });
});
