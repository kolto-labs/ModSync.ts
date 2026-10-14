import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication } from "playwright";

export async function withDeadline<T>(task: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${stage} timed out after ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Terminate only the launched test application's descendants, never the runner. */
function killApplicationTree(pid: number): void {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [child, parent] of rows) {
      if (descendants.has(parent) && !descendants.has(child)) { descendants.add(child); changed = true; }
    }
  }
  for (const child of [...descendants].reverse()) {
    try { process.kill(child, "SIGKILL"); } catch { /* already exited */ }
  }
}

/** A stuck shutdown fails the lane after retaining diagnostics and killing its processes. */
export async function closeElectron(
  desktop: Pick<ElectronApplication, "close" | "process">,
  output: string,
  timeoutMs = 15_000,
): Promise<void> {
  const taskProcess = desktop.process();
  const started = Date.now();
  const exit = taskProcess.exitCode !== null || taskProcess.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => taskProcess.once("exit", () => resolve()));
  let failure: string | undefined;
  let forced = false;
  try {
    await withDeadline(desktop.close().then(() => exit), timeoutMs, "Graceful Electron shutdown");
    if (taskProcess.exitCode !== 0 || taskProcess.signalCode !== null) {
      throw new Error(`Electron exited without graceful success (code=${taskProcess.exitCode}, signal=${taskProcess.signalCode})`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    forced = taskProcess.exitCode === null && taskProcess.signalCode === null;
    if (forced && taskProcess.pid) {
      try { killApplicationTree(taskProcess.pid); } catch { taskProcess.kill("SIGKILL"); }
      await withDeadline(exit, 5_000, "Forced Electron exit").catch(() => undefined);
    }
    throw new Error(failure, { cause: error });
  } finally {
    await writeFile(join(output, "shutdown.json"), JSON.stringify({
      status: failure ? "failed" : "passed", elapsedMs: Date.now() - started,
      exitCode: taskProcess.exitCode, signal: taskProcess.signalCode, forced, failure,
    }, null, 2));
  }
}
