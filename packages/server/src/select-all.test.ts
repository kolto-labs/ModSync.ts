import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstructionFile, createMod, createOption } from "@modsync/core";
import { createModSyncServer, stateOf } from "./createServer.js";
import type { ModSyncServer } from "./types.js";

const servers: ModSyncServer[] = [];
const directories: string[] = [];
const headers = { authorization: "Bearer select-all-test" };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "modsync-select-all-"));
  directories.push(directory);
  const service = await createModSyncServer({ settingsPath: join(directory, "settings.json"), token: "select-all-test" });
  servers.push(service);
  return { app: service.app, state: stateOf(service.app) };
}
afterEach(async () => {
  for (const service of servers.splice(0)) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("selects all tiers, preserves option decisions, and returns the native graph result", async () => {
  const { app, state } = await setup();
  const option = createOption({ isSelected: false });
  const required = createMod({ name: "Required", tier: "Essential", options: [option] });
  const unknown = createMod({ name: "Unknown tier", dependencies: [option.guid] });
  const widescreen = createMod({ name: "Widescreen", isWidescreen: true });
  state.setFile(createInstructionFile({ mods: [required, unknown, widescreen] }), null);
  const response = await app.inject({ method: "POST", url: "/api/mods/select-all", headers, payload: {} });
  expect(response.statusCode).toBe(200);
  expect(state.requireFile().mods.every(mod => mod.isSelected)).toBe(true);
  expect(option.isSelected).toBe(false);
  expect(response.json().selectedGuids).toEqual(expect.arrayContaining([required.guid, unknown.guid, widescreen.guid]));
  expect(response.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "dependency-missing", modGuid: unknown.guid })]));
  const second = await app.inject({ method: "POST", url: "/api/mods/select-all", headers, payload: {} });
  expect(second.json().changed).toEqual([]);
});

it("retains authentication and active-install mutation guards", async () => {
  const { app, state } = await setup();
  const mod = createMod();
  state.setFile(createInstructionFile({ mods: [mod] }), null);
  expect((await app.inject({ method: "POST", url: "/api/mods/select-all", payload: {} })).statusCode).toBe(401);
  state.installRunning = true;
  expect((await app.inject({ method: "POST", url: "/api/mods/select-all", headers, payload: {} })).statusCode).toBe(409);
  expect(mod.isSelected).toBe(false);
});

it("does not bypass reviewed authoring selection decisions", async () => {
  const { app, state } = await setup();
  const mod = createMod();
  const file = createInstructionFile({ mods: [mod] });
  file.rustAuthoringGuide = {} as NonNullable<typeof file.rustAuthoringGuide>;
  state.setFile(file, null);
  expect((await app.inject({ method: "POST", url: "/api/mods/select-all", headers, payload: {} })).statusCode).toBe(409);
  expect(mod.isSelected).toBe(false);
});
