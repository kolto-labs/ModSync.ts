import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createModSyncServer, stateOf } from "./createServer.js";
import type { ModSyncServer } from "./types.js";
import { createInstructionFile } from "@modsync/core";
import type { CheckpointStore, Installer } from "@modsync/core";

const servers: ModSyncServer[] = [];
const dirs: string[] = [];
async function server() {
  const dir = await mkdtemp(join(tmpdir(), "modsync-api-"));
  dirs.push(dir);
  const result = await createModSyncServer({ settingsPath: join(dir, "settings.json"), token: "secret" });
  servers.push(result);
  return result;
}
const headers = { authorization: "Bearer secret" };
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("server lifecycle and mutation guards", () => {
  it("closes within a bounded interval when a WebSocket peer never acknowledges shutdown", async () => {
    const service = await server();
    const base = new URL(await service.listen(0, "127.0.0.1"));
    const peer = connect(Number(base.port), "127.0.0.1");
    try {
      const upgraded = new Promise<void>((resolve, reject) => {
        peer.once("error", reject);
        peer.once("data", (response) => response.toString().includes("101 Switching Protocols") ? resolve() : reject(new Error("WebSocket upgrade failed")));
      });
      peer.write(`GET /ws?token=secret HTTP/1.1\r\nHost: ${base.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      await upgraded;
      const started = performance.now();
      await service.close();
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally {
      peer.destroy();
    }
  });
  it("requires authentication for API access", async () => {
    const { app } = await server();
    expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/settings", headers })).statusCode).toBe(200);
  });
  it("persists simultaneous settings patches without losing changes", async () => {
    const { app } = await server();
    const replies = await Promise.all([
      app.inject({ method: "PUT", url: "/api/settings", headers, payload: { theme: "light" } }),
      app.inject({ method: "PUT", url: "/api/settings", headers, payload: { spoilerFree: true } }),
    ]);
    expect(replies.map((r) => r.statusCode)).toEqual([200, 200]);
    const settings = (await app.inject({ url: "/api/settings", headers })).json();
    expect(settings).toMatchObject({ theme: "light", spoilerFree: true });
  });
  it("does not change live settings if persistence fails", async () => {
    const { app } = await server();
    const state = stateOf(app);
    const original = state.settings.theme;
    Object.defineProperty(state, "settingsPath", { value: "/dev/null/settings.json" });
    expect((await app.inject({ method: "PUT", url: "/api/settings", headers, payload: { theme: "light" } })).statusCode).toBe(500);
    expect(state.settings.theme).toBe(original);
  });
  it("rejects settings and checkpoint deletion during installation", async () => {
    const { app } = await server();
    stateOf(app).installRunning = true;
    expect((await app.inject({ method: "PUT", url: "/api/settings", headers, payload: { kotorDirectory: "/different" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: "/api/checkpoints/session", headers })).statusCode).toBe(409);
  });
  it("clears completed install status and replay when a new document is loaded", async () => {
    const { app } = await server();
    const state = stateOf(app);
    state.installSessionId = "old-session";
    state.installPhase = "widescreen";
    state.installOrder = ["old-mod"];
    state.lastSummary = { startedAt: "", finishedAt: "", mods: [], succeeded: 1, failed: 0, skipped: 0 };
    state.publish({ type: "install-finished", summary: state.lastSummary });
    const previousSeq = state.events.lastSeq;
    state.setFile(createInstructionFile(), null);
    expect(state.installStatus()).toMatchObject({ running: false, summary: undefined, phase: undefined, order: undefined, sessionId: undefined });
    expect(state.replay(0)).toEqual([]);
    expect(state.events.lastSeq).toBe(previousSeq);
  });
  it("refuses to restore a checkpoint into its unselected recorded directory", async () => {
    const { app } = await server();
    const state = stateOf(app);
    state.settings.kotorDirectory = "/selected-game";
    let restored = false;
    state.createCheckpointStore = () => ({
      kotorDirectory: "/selected-game",
      getSession: async () => ({ kotorDirectory: "/other-game" }),
      restore: async () => { restored = true; },
    }) as unknown as CheckpointStore;
    const response = await app.inject({ method: "POST", url: "/api/checkpoints/session/checkpoint/restore", headers });
    expect(response.statusCode).toBe(409);
    expect(restored).toBe(false);
  });
  it("rejects stale or invalid prompt answers without consuming the prompt", async () => {
    const { app } = await server();
    const state = stateOf(app);
    state.installer = { answerPrompt: () => true, cancel: () => undefined } as unknown as Installer;
    state.pendingPrompt = { id: "pending", kind: "choose-option", title: "Choose", message: "", choices: [{ id: "one", label: "One" }] };
    for (const payload of [{ promptId: "old", choiceId: "one" }, { promptId: "pending", choiceId: "bad" }, { promptId: "pending" }, { promptId: "pending", accepted: "yes" }]) {
      const response = await app.inject({ method: "POST", url: "/api/install/answer", headers, payload });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(state.pendingPrompt?.id).toBe("pending");
    }
    expect((await app.inject({ method: "POST", url: "/api/install/answer", headers, payload: { promptId: "pending", choiceId: "one" } })).statusCode).toBe(200);
    expect(state.pendingPrompt).toBeUndefined();
  });
});
