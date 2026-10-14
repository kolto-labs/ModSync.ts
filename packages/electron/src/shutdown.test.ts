import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeElectron } from "../../../tools/electron-shutdown.js";
const dirs: string[] = [];
async function output() {
  const dir = await mkdtemp(join(tmpdir(), "modsync-shutdown-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe("desktop shutdown watchdog", () => {
  it("requires graceful process exit and records its proof", async () => {
    const dir = await output();
    const child = spawn(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { stdio: ["pipe", "ignore", "ignore"] });
    await closeElectron({ process: () => child, close: async () => { child.stdin!.end(); } }, dir, 2_000);
    expect(JSON.parse(await readFile(join(dir, "shutdown.json"), "utf8"))).toMatchObject({ status: "passed", forced: false, exitCode: 0, signal: null });
  });
  it("fails a stuck shutdown, kills the launched process, and preserves diagnostics", async () => {
    const dir = await output();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await expect(closeElectron({ process: () => child, close: () => new Promise<void>(() => undefined) }, dir, 100)).rejects.toThrow("Graceful Electron shutdown timed out");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "shutdown.json"), "utf8"))).toMatchObject({ status: "failed", forced: true });
  });
});
