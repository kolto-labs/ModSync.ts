import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import * as nfs from "node:fs/promises";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DirEntry, FileStat, FileSystemPort } from "../ports/filesystem.js";
import { RealFileSystem } from "../fs/realFileSystem.js";
import { CheckpointStore, CheckpointError, type CheckpointManifest, type CheckpointState } from "./store.js";

/** Minimal FileSystemPort over node:fs for tests (RealFileSystem is written elsewhere). */
class NodeFs implements FileSystemPort {
  readonly isVirtual = false;
  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== undefined;
  }
  async stat(path: string): Promise<FileStat | undefined> {
    try {
      const s = await nfs.stat(path);
      return { path, isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return undefined;
    }
  }
  async readDir(path: string): Promise<DirEntry[]> {
    const entries = await nfs.readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, path: join(path, e.name), isDirectory: e.isDirectory() }));
  }
  async walk(path: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await this.readDir(path)) {
      if (e.isDirectory) out.push(...(await this.walk(e.path)));
      else out.push(e.path);
    }
    return out;
  }
  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await nfs.readFile(path));
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await nfs.writeFile(path, data);
  }
  async mkdirp(path: string): Promise<void> {
    await nfs.mkdir(path, { recursive: true });
  }
  async copyFile(src: string, dest: string): Promise<void> {
    await nfs.copyFile(src, dest);
  }
  async move(src: string, dest: string): Promise<void> {
    await nfs.rename(src, dest);
  }
  async remove(path: string): Promise<void> {
    await nfs.rm(path, { recursive: true, force: true });
  }
  async resolveCase(path: string): Promise<string | undefined> {
    return (await this.exists(path)) ? path : undefined;
  }
  async sha1(path: string): Promise<string> {
    return createHash("sha1").update(await nfs.readFile(path)).digest("hex");
  }
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

interface Env {
  root: string;
  game: string;
  store: Store;
  fs: NodeFs;
}
type Store = CheckpointStore;

async function makeEnv(anchorInterval = 10): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), "modsync-cp-"));
  const game = join(dir, "kotor");
  await nfs.mkdir(join(game, "Override"), { recursive: true });
  const fs = new NodeFs();
  const store = new CheckpointStore({ rootDir: join(dir, "store"), kotorDirectory: game, fs, anchorInterval });
  return { root: dir, game, store, fs };
}

async function readManifest(env: Env, sessionId: string, index: number): Promise<CheckpointManifest> {
  return JSON.parse(await readFile(join(env.root, "store", "sessions", sessionId, `${index}.json`), "utf8"));
}

/** Compare the on-disk Override dir with the expected relative-path -> content map. */
async function expectDisk(env: Env, expected: Map<string, string>): Promise<void> {
  const files = (await env.fs.walk(env.game)).map((p) => p.slice(env.game.length + 1)).sort();
  expect(files).toEqual([...expected.keys()].sort());
  for (const [rel, content] of expected) {
    expect(await readFile(join(env.game, rel), "utf8")).toBe(content);
  }
}

function stateOf(expected: Map<string, string>, tracked: Iterable<string>): CheckpointState {
  const s: CheckpointState = new Map();
  for (const p of tracked) s.set(p, expected.has(p) ? sha1(expected.get(p)!) : undefined);
  return s;
}

describe("CheckpointStore", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv(10);
  });

  it("tracks 25 checkpoints with anchors every 10 and restores any of them", async () => {
    const { store, game } = env;
    // initial game files
    const expected = new Map<string, string>();
    for (let i = 0; i < 6; i++) {
      expected.set(`Override/f${i}.txt`, `orig${i}`);
      await writeFile(join(game, `Override/f${i}.txt`), `orig${i}`);
    }
    expected.set("dialog.tlk", "tlk-orig");
    await writeFile(join(game, "dialog.tlk"), "tlk-orig");
    await expectDisk(env, expected);

    const session = await store.startSession("test build");
    expect(session.checkpoints).toHaveLength(1);
    expect(session.checkpoints[0].isAnchor).toBe(true);

    const snapshots: Array<Map<string, string>> = [new Map(expected)];
    const tracked = new Set<string>();
    const trackedAt: Array<Set<string>> = [new Set()];

    for (let i = 1; i <= 25; i++) {
      const touched: string[] = [];
      const plan: Array<() => Promise<void>> = [];
      const upd = (rel: string, content: string) => {
        touched.push(join(game, rel));
        plan.push(async () => {
          await nfs.mkdir(dirname(join(game, rel)), { recursive: true });
          await writeFile(join(game, rel), content);
          expected.set(rel, content);
        });
      };
      const del = (rel: string) => {
        touched.push(join(game, rel));
        plan.push(async () => {
          await nfs.rm(join(game, rel), { force: true });
          expected.delete(rel);
        });
      };
      upd(`Override/f${i % 6}.txt`, `v${i}`);
      if (i % 3 === 0) upd(`Override/new${i}.txt`, `new${i}`);
      if (i % 5 === 0) del(`Override/f${(i + 1) % 6}.txt`);
      if (i % 7 === 0) del(`Override/new${i - 4}.txt`); // may or may not exist
      if (i === 4) upd("Override/dup.txt", "orig0"); // same content as f0 originally => dedup
      if (i === 12) upd("dialog.tlk", "tlk-modded");
      if (i === 18) upd("Override/sub/deep/x.mdl", "deep");
      if (i === 21) del("Override/sub/deep/x.mdl");

      // the installer protocol: beforeTouch, run the instruction, create
      await store.beforeTouch(session, touched);
      for (const step of plan) await step();
      for (const t of touched) tracked.add(t.slice(game.length + 1));
      const meta = await store.create(session, { label: `step ${i}`, modGuid: "m", instructionGuid: `i${i}`, touched });
      expect(meta.index).toBe(i);
      expect(meta.isAnchor).toBe(i % 10 === 0);
      expect(session.checkpoints).toHaveLength(i + 1);
      snapshots.push(new Map(expected));
      trackedAt.push(new Set(tracked));

      // recorded state matches what is on disk right now
      const state = await store.getState(session.id, meta.id);
      expect(state).toEqual(stateOf(expected, tracked));
    }

    // Anchors are full manifests of everything tracked so far, non-anchors are deltas.
    for (const idx of [10, 20]) {
      const m = await readManifest(env, session.id, idx);
      expect(m.isAnchor).toBe(true);
      expect(new Set(m.entries.map((e) => e.path))).toEqual(trackedAt[idx]);
      expect(trackedAt[idx].size).toBeGreaterThan(session.checkpoints[idx].changedCount);
    }
    for (const idx of [1, 3, 11, 17, 25]) {
      const m = await readManifest(env, session.id, idx);
      expect(m.isAnchor).toBe(false);
      expect(m.entries.length).toBeLessThan(tracked.size);
      expect(m.entries.length).toBe(session.checkpoints[idx].changedCount);
      expect(m.entries.length).toBeGreaterThan(0);
    }
    // baseline manifest lists every tracked path with its original content
    const baseline = await readManifest(env, session.id, 0);
    expect(new Set(baseline.entries.map((e) => e.path))).toEqual(tracked);
    expect(baseline.entries.find((e) => e.path === "Override/f0.txt")?.sha1).toBe(sha1("orig0"));
    expect(baseline.entries.find((e) => e.path === "Override/new3.txt")?.sha1).toBeUndefined();

    // Restore to 17, 10, 3, 25, 0 and compare the game dir with the snapshot.
    for (const target of [17, 10, 3, 25, 0, 24]) {
      const cp = session.checkpoints[target];
      const progress: Array<[number, number]> = [];
      await store.restore(session.id, cp.id, (d, t) => progress.push([d, t]));
      await expectDisk(env, snapshots[target]);
      expect(progress[0]).toEqual([0, tracked.size]);
      expect(progress[progress.length - 1]).toEqual([tracked.size, tracked.size]);
      expect(progress.length).toBe(tracked.size + 1);
    }

    // restore by index string also works, unknown ids throw
    await store.restore(session.id, "5");
    await expectDisk(env, snapshots[5]);
    await expect(store.restore(session.id, "nope")).rejects.toBeInstanceOf(CheckpointError);
    await expect(store.restore("nope", "0")).rejects.toBeInstanceOf(CheckpointError);

    // dedup: identical content is stored once
    const stats = await store.stats(session.id);
    const distinctContents = new Set<string>();
    for (const snap of snapshots) for (const c of snap.values()) distinctContents.add(c);
    // only tracked paths' contents count (untracked originals such as f-files never touched still get tracked here)
    expect(stats.blobCount).toBe(distinctContents.size);
    expect(stats.trackedCount).toBe(tracked.size);
    expect(stats.checkpointCount).toBe(26);
    let bytes = 0;
    for (const c of distinctContents) bytes += Buffer.byteLength(c);
    expect(stats.bytes).toBe(bytes);
    const global = await store.stats();
    expect(global.blobCount).toBe(distinctContents.size);
    expect(global.bytes).toBe(bytes);

    // blobs live at cas/ab/abcdef...
    const h = sha1("orig0");
    const blob = join(env.root, "store", "cas", h.slice(0, 2), h);
    expect(await readFile(blob, "utf8")).toBe("orig0");

    // list() returns the persisted session
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(session.id);
    expect(listed[0].checkpoints).toHaveLength(26);
    expect(listed[0].anchorInterval).toBe(10);
  });

  it("stores identical content once and reports storedBytes per checkpoint", async () => {
    const { store, game } = env;
    await writeFile(join(game, "Override/a.txt"), "same");
    await writeFile(join(game, "Override/b.txt"), "same");
    const session = await store.startSession("dedup");
    const paths = [join(game, "Override/a.txt"), join(game, "Override/b.txt")];
    await store.beforeTouch(session, paths);
    expect(session.checkpoints[0].storedBytes).toBe(4);
    expect(session.checkpoints[0].changedCount).toBe(2);
    await writeFile(join(game, "Override/a.txt"), "same");
    await writeFile(join(game, "Override/b.txt"), "other");
    const cp1 = await store.create(session, { label: "one", touched: paths });
    expect(cp1.changedCount).toBe(1);
    expect(cp1.storedBytes).toBe(5);
    const cp2 = await store.create(session, { label: "noop", touched: paths });
    expect(cp2.changedCount).toBe(0);
    expect(cp2.storedBytes).toBe(0);
    expect((await store.stats(session.id)).blobCount).toBe(2);
    // second beforeTouch on already tracked paths is a no-op
    expect(await store.beforeTouch(session, paths)).toBe(0);
  });

  it("records absent baselines, walks directories and ignores paths outside the game dir", async () => {
    const { store, game, root } = env;
    const session = await store.startSession("absent");
    const newFile = join(game, "Override/created.txt");
    const outside = join(root, "mods", "archive.zip");
    await nfs.mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, "zip");
    expect(await store.beforeTouch(session, [newFile, outside, join(game, "Override")])).toBe(1);
    const baseline = await readManifest(env, session.id, 0);
    expect(baseline.entries).toEqual([{ path: "Override/created.txt" }]);

    await nfs.mkdir(join(game, "Override/pack"), { recursive: true });
    await writeFile(newFile, "hello");
    await writeFile(join(game, "Override/pack/a.tpc"), "A");
    await writeFile(join(game, "Override/pack/b.tpc"), "B");
    // directory touched: walked; untracked files created by the instruction get an absent baseline
    const cp = await store.create(session, { label: "extract", touched: [join(game, "Override")] });
    expect(cp.changedCount).toBe(3);
    const state = await store.getState(session.id, cp.id);
    expect([...state.keys()].sort()).toEqual(["Override/created.txt", "Override/pack/a.tpc", "Override/pack/b.tpc"]);

    await store.restore(session.id, session.checkpoints[0].id);
    expect(await env.fs.exists(newFile)).toBe(false);
    expect(await env.fs.exists(join(game, "Override/pack/a.tpc"))).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("zip");
    await store.restore(session.id, cp.id);
    expect(await readFile(join(game, "Override/pack/b.tpc"), "utf8")).toBe("B");
  });

  it("restores paths tracked after an anchor correctly", async () => {
    const e = await makeEnv(3);
    const { store, game } = e;
    await writeFile(join(game, "late.txt"), "original");
    const session = await store.startSession("late");
    const other = join(game, "Override/o.txt");
    for (let i = 1; i <= 3; i++) {
      await store.beforeTouch(session, [other]);
      await writeFile(other, `o${i}`);
      await store.create(session, { label: `o${i}`, touched: [other] });
    }
    // checkpoint 3 is an anchor without late.txt; late.txt is first seen at 4 but unchanged, changed at 5
    const late = join(game, "late.txt");
    await store.beforeTouch(session, [late]);
    await store.create(session, { label: "touch-no-change", touched: [late] });
    await store.beforeTouch(session, [late]);
    await writeFile(late, "modded");
    await store.create(session, { label: "change", touched: [late] });
    expect(session.checkpoints[3].isAnchor).toBe(true);
    expect((await readManifest(e, session.id, 3)).entries.map((x) => x.path)).toEqual(["Override/o.txt"]);
    expect((await readManifest(e, session.id, 4)).entries).toEqual([]);
    expect((await store.getState(session.id, session.checkpoints[4].id)).get("late.txt")).toBe(sha1("original"));
    await store.restore(session.id, session.checkpoints[4].id);
    expect(await readFile(late, "utf8")).toBe("original");
    expect(await readFile(other, "utf8")).toBe("o3");
    await store.restore(session.id, session.checkpoints[5].id);
    expect(await readFile(late, "utf8")).toBe("modded");
  });

  it("records recursively deleted directories and reopens sessions with their original anchor interval", async () => {
    const e = await makeEnv(2);
    const path = join(e.game, "Override/pack/a.txt");
    await e.fs.mkdirp(dirname(path));
    await writeFile(path, "original");
    const session = await e.store.startSession("directory");
    const directory = dirname(path);
    await e.store.beforeTouch(session, [directory]);
    await e.fs.remove(directory);
    const deleted = await e.store.create(session, { label: "delete", touched: [directory] });
    expect((await e.store.getState(session.id, deleted.id)).get("Override/pack/a.txt")).toBeUndefined();
    await e.store.restore(session.id, session.checkpoints[0].id);
    expect(await readFile(path, "utf8")).toBe("original");
    await e.store.restore(session.id, deleted.id);
    expect(await e.fs.exists(path)).toBe(false);
    const reopened = new CheckpointStore({ rootDir: e.store.rootDir, kotorDirectory: e.game, fs: e.fs, anchorInterval: 10 });
    await writeFile(join(e.game, "other.txt"), "second");
    const anchor = await reopened.create(session, { label: "second", touched: [join(e.game, "other.txt")] });
    expect(anchor.isAnchor).toBe(true);
    expect((await reopened.getState(session.id, anchor.id)).get("other.txt")).toBe(sha1("second"));
  });

  it("delete removes the session and gc drops unreferenced blobs", async () => {
    const { store, game, root } = env;
    await writeFile(join(game, "a.txt"), "keep");
    const s1 = await store.startSession("one");
    const s2 = await store.startSession("two");
    await store.beforeTouch(s1, [join(game, "a.txt")]);
    await writeFile(join(game, "a.txt"), "only-in-s1");
    await store.create(s1, { label: "x", touched: [join(game, "a.txt")] });
    await store.beforeTouch(s2, [join(game, "a.txt")]);
    expect((await store.list()).map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect((await store.stats()).blobCount).toBe(2);
    await store.delete(s1.id);
    expect((await store.list()).map((s) => s.id)).toEqual([s2.id]);
    expect(await store.gc()).toBe(1);
    expect((await store.stats()).blobCount).toBe(1);
    const blobs = await readdir(join(root, "store", "cas"), { recursive: true });
    expect(blobs.map((b) => basename(b)).filter((b) => b.length === 40)).toEqual([sha1("only-in-s1")]);
    await expect(store.getSession(s1.id)).rejects.toBeInstanceOf(CheckpointError);
  });

  it("rejects unsafe session IDs and manifest paths before touching game files", async () => {
    const { store, game, root } = env;
    await expect(store.delete("../..")).rejects.toBeInstanceOf(CheckpointError);
    const path = join(game, "a.txt");
    await writeFile(path, "original");
    const session = await store.startSession("safe");
    await store.beforeTouch(session, [path]);
    await writeFile(path, "installed");
    await store.create(session, { label: "step", touched: [path] });
    const manifestPath = join(root, "store/sessions", session.id, "0.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.entries.push({ path: "../escaped.txt" });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(store.restore(session.id, session.checkpoints[0].id)).rejects.toBeInstanceOf(CheckpointError);
    expect(await readFile(path, "utf8")).toBe("installed");
  });

  it("preflights all blobs so corruption cannot partially restore files", async () => {
    const { store, game, root } = env;
    const a = join(game, "a.txt");
    const b = join(game, "b.txt");
    await writeFile(a, "first");
    await writeFile(b, "second");
    const session = await store.startSession("integrity");
    await store.beforeTouch(session, [a, b]);
    await writeFile(a, "installed-a");
    await writeFile(b, "installed-b");
    await store.create(session, { label: "step", touched: [a, b] });
    const hash = sha1("second");
    await writeFile(join(root, "store/cas", hash.slice(0, 2), hash), "corrupt");
    await expect(store.restore(session.id, session.checkpoints[0].id)).rejects.toThrow("integrity");
    expect(await readFile(a, "utf8")).toBe("installed-a");
    expect(await readFile(b, "utf8")).toBe("installed-b");
  });

  it("refuses destinations redirected outside the game by symlinks", async () => {
    if (process.platform === "win32") return;
    const { game, root } = env;
    const fs = new RealFileSystem();
    const store = new CheckpointStore({ rootDir: join(root, "secure-store"), kotorDirectory: game, fs });
    const path = join(game, "Override/a.txt");
    await writeFile(path, "original");
    const session = await store.startSession("symlink");
    await store.beforeTouch(session, [path]);
    await writeFile(path, "installed");
    await store.create(session, { label: "step", touched: [path] });
    await nfs.rm(join(game, "Override"), { recursive: true });
    const outside = join(root, "outside");
    await nfs.mkdir(outside);
    await writeFile(join(outside, "a.txt"), "external");
    await nfs.symlink(outside, join(game, "Override"));
    await expect(store.restore(session.id, session.checkpoints[0].id)).rejects.toThrow("escapes");
    expect(await readFile(join(outside, "a.txt"), "utf8")).toBe("external");
  });

  it("refuses a dangling symlink that would redirect a restored file outside the game", async () => {
    if (process.platform === "win32") return;
    const { game, root } = env;
    const fs = new RealFileSystem();
    const store = new CheckpointStore({ rootDir: join(root, "dangling-store"), kotorDirectory: game, fs });
    const path = join(game, "Override/a.txt");
    await writeFile(path, "original");
    const session = await store.startSession("dangling");
    await store.beforeTouch(session, [path]);
    await writeFile(path, "installed");
    await store.create(session, { label: "step", touched: [path] });
    await nfs.rm(path);
    const outside = join(root, "outside-missing.txt");
    await nfs.symlink(outside, path);
    await expect(store.restore(session.id, session.checkpoints[0].id)).rejects.toBeInstanceOf(CheckpointError);
    expect(await fs.exists(outside)).toBe(false);
  });

  it("requires a FileSystemPort and handles backslash roots", () => {
    expect(() => new CheckpointStore({ rootDir: "/x", kotorDirectory: "/y", fs: undefined as unknown as NodeFs })).toThrow(CheckpointError);
    const s = new CheckpointStore({ rootDir: "/x", kotorDirectory: "C:\\Games\\KOTOR\\", fs: env.fs });
    expect(s.relativePath("C:\\Games\\KOTOR\\Override\\a.tpc")).toBe("Override/a.tpc");
    expect(s.relativePath("c:/games/kotor/Override/a.tpc")).toBe("Override/a.tpc");
    expect(s.relativePath("C:/Games/KOTOR")).toBeUndefined();
    expect(s.relativePath("C:/Games/KOTOR/../x")).toBeUndefined();
    expect(s.relativePath("C:/Games/KOTOR2/a")).toBeUndefined();
  });
});
