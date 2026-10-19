import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RealFileSystem } from "../fs/realFileSystem.js";
import type { CheckpointSession } from "../model/types.js";
import { CheckpointStore } from "./store.js";

async function isCaseSensitive(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "modsync-cp-probe-"));
  try {
    await writeFile(join(dir, "Probe.TMP"), "x");
    return await readFile(join(dir, "probe.tmp")).then(() => false, () => true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const caseSensitive = await isCaseSensitive();
const sha1 = (value: string): string => createHash("sha1").update(value).digest("hex");

describe.skipIf(!caseSensitive)("CheckpointStore case spelling on a case-sensitive filesystem", () => {
  let root: string;
  let game: string;
  let store: CheckpointStore;
  let session: CheckpointSession;

  const keys = async (index = 0): Promise<string[]> => [...(await store.getState(session.id, session.checkpoints[index].id)).keys()].sort();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "modsync-cp-case-"));
    game = join(root, "game");
    await mkdir(join(game, "Override"), { recursive: true });
    store = new CheckpointStore({ rootDir: join(root, "store"), kotorDirectory: game, fs: new RealFileSystem() });
    session = await store.startSession("case spelling");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("tracks a later spelling of an already tracked file under its first spelling", async () => {
    await writeFile(join(game, "Override", "Item_Alpha.TGA"), "alpha");
    expect(await store.beforeTouch(session, [`${game}/Override/Item_Alpha.TGA`])).toBe(1);
    expect(await store.beforeTouch(session, [`${game}/Override/item_alpha.tga`])).toBe(0);
    expect(await keys()).toEqual(["Override/Item_Alpha.TGA"]);
  });

  it("collapses spellings that differ only by case inside one instruction", async () => {
    expect(await store.beforeTouch(session, [`${game}/Override/New_One.tga`, `${game}/Override/new_one.TGA`, `${game}/override/NEW_ONE.tga`])).toBe(1);
    expect(await keys()).toEqual(["Override/New_One.tga"]);
  });

  it("records the on-disk spelling for an untracked file requested with other casing", async () => {
    await writeFile(join(game, "Override", "Item_Alpha.TGA"), "alpha");
    expect(await store.beforeTouch(session, [`${game}/override/item_alpha.tga`])).toBe(1);
    expect(await keys()).toEqual(["Override/Item_Alpha.TGA"]);
    const state = await store.getState(session.id, session.checkpoints[0].id);
    expect(state.get("Override/Item_Alpha.TGA")).toBe(sha1("alpha"));
  });

  it("keeps the tracked spelling when a directory is expanded after a differently cased request", async () => {
    await mkdir(join(game, "Override", "Sub_Dir"), { recursive: true });
    await writeFile(join(game, "Override", "Sub_Dir", "Item_Beta.tga"), "beta");
    await store.beforeTouch(session, [`${game}/Override/sub_dir/item_beta.tga`]);
    expect(await store.beforeTouch(session, [`${game}/Override/Sub_Dir`])).toBe(0);
    expect(await keys()).toEqual(["Override/Sub_Dir/Item_Beta.tga"]);
  });

  it("records a checkpoint for a touched path spelled differently from the baseline entry", async () => {
    await writeFile(join(game, "Override", "Item_Alpha.TGA"), "alpha");
    await store.beforeTouch(session, [`${game}/Override/Item_Alpha.TGA`]);
    await writeFile(join(game, "Override", "Item_Alpha.TGA"), "alpha two");
    const checkpoint = await store.create(session, { label: "second spelling", touched: [`${game}/Override/ITEM_ALPHA.tga`] });
    const state = await store.getState(session.id, checkpoint.id);
    expect([...state.keys()]).toEqual(["Override/Item_Alpha.TGA"]);
    expect(state.get("Override/Item_Alpha.TGA")).toBe(sha1("alpha two"));
    expect(await keys()).toEqual(["Override/Item_Alpha.TGA"]);
  });

  it("canonicalizes unpredicted paths together with touched paths", async () => {
    const checkpoint = await store.create(session, {
      label: "created",
      touched: [`${game}/Override/Made_Here.tga`, `${game}/Override/made_here.TGA`],
      unpredicted: [`${game}/Override/MADE_HERE.tga`],
    });
    expect(Object.keys(Object.fromEntries(await store.getState(session.id, checkpoint.id)))).toEqual(["Override/Made_Here.tga"]);
  });

  it("still rejects a saved history that mixes spellings and names both of them", async () => {
    await writeFile(join(game, "Override", "Item_Alpha.TGA"), "alpha");
    await store.beforeTouch(session, [`${game}/Override/Item_Alpha.TGA`]);
    await writeFile(join(game, "Override", "Item_Alpha.TGA"), "alpha two");
    const checkpoint = await store.create(session, { label: "changed", touched: [`${game}/Override/Item_Alpha.TGA`] });
    const manifestFile = join(root, "store", "sessions", session.id, `${checkpoint.index}.json`);
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { entries: Array<{ path: string }> };
    manifest.entries[0].path = "Override/item_alpha.tga";
    await writeFile(manifestFile, JSON.stringify(manifest));
    await expect(store.getState(session.id, checkpoint.id)).rejects.toThrow(/inconsistent case spelling: "Override\/Item_Alpha\.TGA" vs "Override\/item_alpha\.tga"/);
  });
});
