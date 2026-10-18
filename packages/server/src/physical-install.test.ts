import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { file, instr, makeSandbox, mod, writeText, writeZip, type Sandbox } from "../../core/src/engine/testing.js";
import { createModSyncServer, stateOf } from "./createServer.js";
import type { ModSyncServer } from "./types.js";

const ENV = "MODSYNC_CI_PHYSICAL_INSTALL";
const headers = { authorization: "Bearer secret" };

let sandbox: Sandbox;
let service: ModSyncServer;
let savedEnv: string | undefined;

beforeEach(async () => {
  savedEnv = process.env[ENV];
  delete process.env[ENV];
  sandbox = await makeSandbox("modsync-server-physical-");
  service = await createModSyncServer({ token: "secret", settingsPath: join(sandbox.root, "settings.json") });
  const state = stateOf(service.app);
  state.settings = { ...sandbox.settings, createCheckpoints: true, checkpointDirectory: `${sandbox.root}/checkpoints` };
  await writeZip(`${sandbox.mods}/Pack v1.zip`, { "Override/copy_me.txt": "copied" });
  await writeText(`${sandbox.kotor}/Override/keep.txt`, "keep");
  state.setFile(
    file([
      mod(1, {
        name: "Example Pack",
        instructions: [
          instr("Extract", { source: ["<<modDirectory>>/Pack*.zip"] }),
          instr("Copy", { source: ["<<modDirectory>>/Pack*/Override/copy_me.txt"], destination: "<<kotorDirectory>>/Override" }),
        ],
      }),
    ]),
    null,
  );
});

afterEach(async () => {
  await service.close();
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  await sandbox.cleanup();
});

async function runInstall(): Promise<void> {
  const state = stateOf(service.app);
  const start = await service.app.inject({ method: "POST", url: "/api/install", headers, payload: {} });
  expect(start.statusCode).toBe(202);
  for (let attempt = 0; attempt < 400 && state.installRunning; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(state.installRunning).toBe(false);
}

const locks = async (): Promise<string[]> => (await readdir(sandbox.root)).filter((name) => name.startsWith(".modsync-portable-lock-"));

describe("web server physical install opt-in", () => {
  it("keeps refusing a real install by default and writes nothing", async () => {
    const state = stateOf(service.app);
    await runInstall();
    expect(state.physicalInstallOptIn()).toBeUndefined();
    expect(state.lastSummary?.error).toMatch(/physical installation is unavailable/);
    expect(await readdir(`${sandbox.kotor}/Override`)).toEqual(["keep.txt"]);
    expect(await readdir(sandbox.mods)).toEqual(["Pack v1.zip"]);
    expect(await readdir(sandbox.root)).not.toContain("checkpoints");
    expect(await locks()).toEqual([]);
  });

  it("only treats the exact value 1 as the opt-in", async () => {
    const state = stateOf(service.app);
    for (const value of ["0", "true", "yes", " 1", ""]) {
      process.env[ENV] = value;
      expect(state.physicalInstallOptIn()).toBeUndefined();
    }
    process.env[ENV] = "1";
    expect(state.physicalInstallOptIn()).toEqual({ ownership: "portable-lockfile" });
  });

  it("keeps the default checkpoint capability and restore refusal", async () => {
    const capabilities = await service.app.inject({ method: "GET", url: "/api/checkpoints/capabilities", headers });
    expect(capabilities.json()).toEqual({ physicalRestore: false, reason: "Independent TypeScript checkpoint restoration is unavailable" });
    const restore = await service.app.inject({ method: "POST", url: "/api/checkpoints/session/checkpoint/restore", headers });
    expect(restore.statusCode).toBe(409);
    expect(restore.json().message ?? restore.json().error).toMatch(/restore is unavailable/);
  });

  it("with MODSYNC_CI_PHYSICAL_INSTALL=1 installs for real, checkpoints, frees locks, and restores", async () => {
    process.env[ENV] = "1";
    const state = stateOf(service.app);
    await runInstall();
    expect(state.lastSummary?.error).toBeUndefined();
    expect(state.lastSummary).toMatchObject({ succeeded: 1, failed: 0 });
    expect(await readFile(`${sandbox.kotor}/Override/copy_me.txt`, "utf8")).toBe("copied");
    expect(await locks()).toEqual([]);

    const capabilities = await service.app.inject({ method: "GET", url: "/api/checkpoints/capabilities", headers });
    expect(capabilities.json()).toMatchObject({ physicalRestore: true });

    const sessions = (await service.app.inject({ method: "GET", url: "/api/checkpoints", headers })).json() as Array<{ id: string; checkpoints: Array<{ id: string; index: number }> }>;
    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    expect(session.id).toBe(state.lastSummary?.checkpointSessionId);
    const baseline = session.checkpoints[0];

    const restore = await service.app.inject({ method: "POST", url: `/api/checkpoints/${session.id}/${baseline.id}/restore`, headers });
    expect(restore.statusCode).toBe(200);
    expect(await readdir(`${sandbox.kotor}/Override`)).toEqual(["keep.txt"]);
    expect(await locks()).toEqual([]);
  });

  it("refuses a physical restore while an install is running or into an unselected game directory", async () => {
    process.env[ENV] = "1";
    const state = stateOf(service.app);
    state.installRunning = true;
    expect((await service.app.inject({ method: "POST", url: "/api/checkpoints/s/c/restore", headers })).statusCode).toBe(409);
    state.installRunning = false;
    await runInstall();
    const [session] = (await service.app.inject({ method: "GET", url: "/api/checkpoints", headers })).json() as Array<{ id: string; checkpoints: Array<{ id: string }> }>;
    state.settings = { ...state.settings, kotorDirectory: `${sandbox.root}/other-game` };
    const wrongRoot = await service.app.inject({ method: "POST", url: `/api/checkpoints/${session.id}/${session.checkpoints[0].id}/restore`, headers });
    expect(wrongRoot.statusCode).toBe(409);
  });
});
