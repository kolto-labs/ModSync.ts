import { join, resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import { CheckpointStore, RealFileSystem, loadSettings } from "@modsync/core";
import { CliError, formatDuration } from "./shared.js";

interface CheckpointFlags {
  kotor?: string;
  root?: string;
  settings?: string;
  json?: boolean;
}

async function storeFromFlags(flags: CheckpointFlags): Promise<CheckpointStore> {
  const settings = await loadSettings(flags.settings ? resolvePath(flags.settings) : undefined);
  const kotor = flags.kotor ? resolvePath(flags.kotor) : settings.kotorDirectory;
  if (!kotor) throw new CliError("KOTOR directory is not set: pass --kotor <dir>");
  const root = flags.root ? resolvePath(flags.root) : settings.checkpointDirectory?.trim() || join(kotor, ".modsync", "checkpoints");
  return new CheckpointStore({ rootDir: root, kotorDirectory: kotor, fs: new RealFileSystem() });
}

export async function runCheckpointsList(flags: CheckpointFlags): Promise<number> {
  const store = await storeFromFlags(flags);
  const sessions = await store.list();
  if (flags.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return 0;
  }
  if (sessions.length === 0) {
    console.log(`No checkpoint sessions under ${store.rootDir}`);
    return 0;
  }
  for (const s of sessions) {
    console.log(`${s.id}  ${s.createdAt}  ${s.checkpoints.length} checkpoints  (${s.kotorDirectory})`);
    for (const c of s.checkpoints) {
      const size = c.storedBytes >= 1024 * 1024 ? `${(c.storedBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(c.storedBytes / 1024)} KB`;
      console.log(`   ${String(c.index).padStart(4)}  ${c.id}  ${c.isAnchor ? "anchor" : "delta "}  ${c.label}  (${c.changedCount} files, ${size})`);
    }
  }
  return 0;
}

export async function runCheckpointsRestore(session: string, checkpoint: string, flags: CheckpointFlags): Promise<number> {
  const store = await storeFromFlags(flags);
  const recorded = await store.getSession(session);
  if (resolvePath(recorded.kotorDirectory) !== resolvePath(store.kotorDirectory)) {
    throw new CliError("Checkpoint belongs to a different game directory; pass its directory explicitly with --kotor");
  }
  const started = performance.now();
  let last = -1;
  await store.restore(session, checkpoint, (done, total) => {
    if (total === 0) return;
    const pct = Math.floor((done / total) * 10);
    if (pct !== last) {
      last = pct;
      console.log(`  ${done}/${total} files`);
    }
  });
  console.log(`Restored checkpoint ${checkpoint} of session ${session} in ${formatDuration(performance.now() - started)}`);
  return 0;
}

export function registerCheckpoints(program: Command): void {
  const cmd = program.command("checkpoints").description("list or restore install checkpoints");
  const addFlags = (c: Command): Command =>
    c
      .option("--kotor <dir>", "KOTOR installation directory")
      .option("--root <dir>", "checkpoint store directory (default <kotor>/.modsync/checkpoints)")
      .option("--settings <path>", "settings file");
  addFlags(cmd.command("list").description("list checkpoint sessions").option("--json", "JSON output")).action(async (flags: CheckpointFlags) => {
    process.exitCode = await runCheckpointsList(flags);
  });
  addFlags(cmd.command("restore <session> <checkpoint>").description("restore the game directory to a checkpoint (id or index)")).action(
    async (session: string, checkpoint: string, flags: CheckpointFlags) => {
      process.exitCode = await runCheckpointsRestore(session, checkpoint, flags);
    },
  );
}
