import { request } from "node:http";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Installer, InstallEvent } from "@modsync/core";
import { file, instr, makeSandbox, mod, writeText } from "../../core/src/engine/testing.js";
import { createModSyncServer, stateOf } from "./createServer.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("shutdown with previously admitted work", () => {
  it("cancels and drains an install whose request body completes after the first state drain", async () => {
    const sandbox = await makeSandbox("modsync-shutdown-race-");
    const admitted = deferred();
    const firstDrain = deferred();
    const events: InstallEvent[] = [];
    let lateInstaller: Installer | null = null;
    const service = await createModSyncServer({
      token: "secret",
      settingsPath: join(sandbox.root, "settings.json"),
      onShutdownStage: (stage) => { if (stage === "state-drained") firstDrain.resolve(); },
    });
    const state = stateOf(service.app);
    state.settings = sandbox.settings;
    await writeText(join(sandbox.mods, "Choices/First/chosen.txt"), "first");
    await writeText(join(sandbox.mods, "Choices/Second/chosen.txt"), "second");
    state.setFile(file([mod(1, { instructions: [instr("Choose", {
      source: ["<<modDirectory>>/Choices/*"], destination: "<<kotorDirectory>>/Override",
    })] })]), null);
    const startInstall = state.startInstall.bind(state);
    const start = vi.spyOn(state, "startInstall").mockImplementation((options) => {
      const result = startInstall(options);
      lateInstaller = state.installer;
      lateInstaller?.on("event", (event) => events.push(event));
      return result;
    });
    service.app.addHook("onRequest", async (incoming) => {
      if (incoming.url === "/api/install") admitted.resolve();
    });
    const base = await service.listen(0, "127.0.0.1");
    let resolveResponse!: (status: number) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<number>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const client = request(new URL("/api/install", base), {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json", "content-length": "2", connection: "close" },
    }, (reply) => {
      reply.resume();
      reply.once("end", () => resolveResponse(reply.statusCode ?? 0));
    });
    client.once("error", rejectResponse);
    try {
      client.flushHeaders();
      await admitted.promise;
      // The real HTTP request is active, but its body has deliberately not
      // arrived. The initial drain cannot yet observe its background install.
      const shutdown = service.close();
      await firstDrain.promise;
      expect(start).not.toHaveBeenCalled();
      client.end("{}");
      expect(await response).toBe(202);
      await shutdown;
      expect(start).toHaveBeenCalledOnce();
      expect(lateInstaller).not.toBeNull();
      expect(state.installRunning).toBe(false);
      expect(state.installer).toBeNull();
      expect(state.lastSummary?.failed).toBe(1);
      expect(events.some((event) => event.type === "install-cancelled")).toBe(true);
      expect(events.at(-1)?.type).toBe("install-finished");
      expect(await readdir(join(sandbox.kotor, "Override"))).toEqual([]);
    } finally {
      client.destroy();
      state.cancelInstall();
      await state.close();
      await service.close();
      start.mockRestore();
      await sandbox.cleanup();
    }
  }, 10_000);
});
