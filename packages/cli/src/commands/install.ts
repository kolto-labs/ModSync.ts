/**
 * `modsync install` and `modsync dry-run`: run the Installer with a live
 * progress line per instruction and interactive prompts on the terminal.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  CheckpointStore,
  Installer,
  RealFileSystem,
  createLogger,
  createPatcher,
  type InstallEvent,
  type InstallSummary,
  type InstructionFile,
  type UserPrompt,
  type UserPromptAnswer,
  type UserSettings,
} from "@modsync/core";
import type { Command } from "commander";
import { join } from "node:path";
import { CliError, applySelectionFlags, formatDuration, printIssues, readInstructionFile, settingsFromFlags, type DirectoryFlags } from "./shared.js";
import { addDirectoryOptions, addSelectionOptions } from "./validate.js";

export interface InstallFlags extends DirectoryFlags {
  phase?: string;
  select?: string[];
  allEssential?: boolean;
  all?: boolean;
  yes?: boolean;
  choice?: string[];
  checkpoints?: boolean;
  json?: boolean;
  verbose?: boolean;
  logFile?: string;
}

/** Parse `--choice <instructionGuid>=<choiceId>` (repeatable). */
export function parseChoices(values: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of values ?? []) {
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new CliError(`--choice expects <instructionGuid>=<choiceId>, got "${raw}"`);
    const guid = raw.slice(0, eq).trim().replace(/^\{|\}$/g, "").toLowerCase();
    const choice = raw.slice(eq + 1).trim();
    if (!guid || !choice) throw new CliError("--choice requires a non-empty instruction GUID and answer");
    out.set(guid, choice);
  }
  return out;
}

/** Pick the answer for a prompt from scripted choices, `--yes` defaults, or the terminal. */
export async function answerPromptInteractively(
  prompt: UserPrompt,
  opts: { yes: boolean; choices: Map<string, string>; ask: (question: string) => Promise<string>; out: (line: string) => void },
): Promise<UserPromptAnswer> {
  const scripted = prompt.instructionGuid ? opts.choices.get(prompt.instructionGuid.toLowerCase()) : undefined;
  if (scripted !== undefined) {
    const byId = prompt.choices.find((c) => c.id === scripted || c.label.toLowerCase() === scripted.toLowerCase());
    if (prompt.kind === "confirm") {
      if (!/^(y|yes|true|1|n|no|false|0)$/i.test(scripted)) throw new CliError("--choice: confirmation answer must be yes or no");
      return { promptId: prompt.id, accepted: /^(y|yes|true|1)$/i.test(scripted) };
    }
    if (byId) return { promptId: prompt.id, choiceId: byId.id, accepted: true };
    if (prompt.allowNone && /^(none|skip)$/i.test(scripted)) return { promptId: prompt.id, accepted: true };
    throw new CliError(`--choice: "${scripted}" is not a valid choice for prompt "${prompt.title}" (${prompt.choices.map((c) => c.id).join(", ")})`);
  }
  const fallback = prompt.choices.find((c) => c.isDefault) ?? prompt.choices[0];
  if (opts.yes) return { promptId: prompt.id, choiceId: fallback?.id, accepted: true };

  opts.out("");
  opts.out(`? ${prompt.title}`);
  if (prompt.message) opts.out(`  ${prompt.message}`);
  if (prompt.kind === "confirm" || prompt.kind === "message") {
    const a = (await opts.ask(prompt.kind === "message" ? "  Press enter to continue: " : "  Continue? [Y/n] ")).trim();
    return { promptId: prompt.id, accepted: !/^(n|no)$/i.test(a) };
  }
  prompt.choices.forEach((c, i) => {
    opts.out(`  ${i + 1}) ${c.label}${c.isDefault ? " (default)" : ""}${c.description ? `  - ${c.description}` : ""}`);
  });
  if (prompt.allowNone) opts.out("  0) none of the above");
  for (;;) {
    const a = (await opts.ask(`  Choice [${fallback ? prompt.choices.indexOf(fallback) + 1 : 1}]: `)).trim();
    if (a === "" && fallback) return { promptId: prompt.id, choiceId: fallback.id, accepted: true };
    if (a === "0" && prompt.allowNone) return { promptId: prompt.id, accepted: true };
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= prompt.choices.length) return { promptId: prompt.id, choiceId: prompt.choices[n - 1].id, accepted: true };
    const byId = prompt.choices.find((c) => c.id === a || c.label.toLowerCase() === a.toLowerCase());
    if (byId) return { promptId: prompt.id, choiceId: byId.id, accepted: true };
    opts.out("  Please enter one of the numbers above.");
  }
}

export interface RunInstallOptions {
  dryRun: boolean;
  out?: (line: string) => void;
  ask?: (question: string) => Promise<string>;
}

/** Run the installer and print progress. Returns the exit code. */
export async function runInstall(filePath: string, flags: InstallFlags, run: RunInstallOptions): Promise<number> {
  const out = run.out ?? ((l: string) => console.log(l));
  const loaded = await readInstructionFile(filePath);
  const file: InstructionFile = loaded.file;
  applySelectionFlags(file, flags);
  const settings: UserSettings = await settingsFromFlags(flags);
  const phase = flags.phase ?? "base";
  if (phase !== "base" && phase !== "widescreen") throw new CliError("--phase must be base or widescreen");
  const choices = parseChoices(flags.choice);
  const yes = Boolean(flags.yes) || !stdin.isTTY;

  const logger = createLogger({
    level: flags.verbose ? "debug" : "info",
    file: flags.logFile,
    sink: flags.verbose ? (line) => out(line) : undefined,
  });
  const fs = new RealFileSystem();
  const useCheckpoints = !run.dryRun && (flags.checkpoints ?? settings.createCheckpoints);
  const checkpoints = useCheckpoints
    ? new CheckpointStore({
        rootDir: settings.checkpointDirectory?.trim() || join(settings.kotorDirectory, ".modsync", "checkpoints"),
        kotorDirectory: settings.kotorDirectory,
        fs,
      })
    : undefined;
  const installer = new Installer(file, settings, { fs, logger, patcher: createPatcher(settings, logger), checkpoints });

  const plan = installer.plan({ phase, modGuids: undefined });
  const errors = plan.issues.filter((i) => i.severity === "error");
  if (errors.length) {
    out("Selection problems:");
    printIssues(plan.issues, file, out);
    return 1;
  }
  if (plan.mods.length === 0) {
    out(`Nothing to ${run.dryRun ? "simulate" : "install"}: no selected ${phase} mods.`);
    return 0;
  }
  out(`${run.dryRun ? "Dry run" : "Installing"}: ${plan.mods.length} mod(s), phase ${phase}`);
  out(`  mods:  ${settings.modDirectory}`);
  out(`  kotor: ${settings.kotorDirectory}`);
  if (checkpoints) out(`  checkpoints: ${checkpoints.rootDir}`);

  let rl: ReturnType<typeof createInterface> | undefined;
  const ask =
    run.ask ??
    (async (q: string) => {
      rl ??= createInterface({ input: stdin, output: stdout });
      return rl.question(q);
    });

  const names = new Map(file.mods.map((m) => [m.guid, m.name]));
  let summary: InstallSummary | undefined;
  let cancelled = false;
  let promptFailed = false;
  let installError = false;
  let modIndex = 0;
  let modTotal = plan.mods.length;
  const stepCounter = new Map<string, number>();

  const onEvent = (e: InstallEvent): void => {
    switch (e.type) {
      case "install-started":
        modTotal = e.total;
        break;
      case "mod-started":
        modIndex = e.index + 1;
        out(`[${modIndex}/${modTotal}] ${e.name}`);
        break;
      case "instruction-started": {
        const n = (stepCounter.get(e.modGuid) ?? 0) + 1;
        stepCounter.set(e.modGuid, n);
        out(`  ${n}. ${e.action}: ${e.description}`);
        break;
      }
      case "instruction-finished": {
        const r = e.result;
        const ok = r.code === "Success" || r.code === "Skipped" || r.code === "DependencyNotSelected" || r.code === "RestrictionSelected";
        out(`     ${ok ? "ok" : "FAIL"} ${r.code}${r.message ? ` - ${r.message}` : ""} (${formatDuration(r.durationMs)})${r.checkpointId ? ` [checkpoint ${r.checkpointId}]` : ""}`);
        break;
      }
      case "mod-finished":
        out(`  -> ${e.result.state} (${formatDuration(e.result.durationMs)})`);
        break;
      case "log":
        if (e.level === "warn" || e.level === "error") out(`  ${e.level}: ${e.message}`);
        else if (flags.verbose) out(`  ${e.message}`);
        break;
      case "prompt":
        void answerPromptInteractively(e.prompt, { yes, choices, ask, out })
          .then((answer) => installer.answerPrompt(answer))
          .catch((err) => {
            out(`prompt failed: ${err instanceof Error ? err.message : String(err)}`);
            promptFailed = true;
            installer.cancel();
          });
        break;
      case "install-error":
        installError = true;
        out(`ERROR: ${e.message}`);
        break;
      case "install-cancelled":
        cancelled = true;
        out("Cancelled.");
        break;
      case "install-finished":
        summary = e.summary;
        break;
      default:
        break;
    }
  };
  installer.on("event", onEvent);

  const onSigint = (): void => {
    cancelled = true;
    out("\nCancelling...");
    installer.cancel();
  };
  process.once("SIGINT", onSigint);
  try {
    summary = await installer.run({ phase, dryRun: run.dryRun });
  } finally {
    process.off("SIGINT", onSigint);
    rl?.close();
    installer.off("event", onEvent);
    await logger.flush();
  }

  if (flags.json) {
    out(JSON.stringify(summary, null, 2));
  } else {
    out("");
    out(`${run.dryRun ? "Dry run" : "Install"} finished: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.skipped} skipped`);
    for (const m of summary.mods) if (m.state === "Failed") out(`  failed: ${names.get(m.modGuid) ?? m.modGuid}`);
    if (summary.checkpointSessionId) out(`Checkpoint session: ${summary.checkpointSessionId}`);
  }
  return promptFailed || installError ? 1 : cancelled ? 130 : summary.failed > 0 ? 1 : 0;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function addInstallOptions(cmd: Command): Command {
  addDirectoryOptions(cmd);
  addSelectionOptions(cmd);
  return cmd
    .option("--phase <phase>", "base or widescreen", "base")
    .option("-y, --yes", "answer every prompt with its default")
    .option("--choice <guid=choiceId>", "scripted answer for the prompt of an instruction (repeatable)", collect)
    .option("--json", "print the summary as JSON")
    .option("-v, --verbose", "print debug log lines")
    .option("--log-file <path>", "append the log to this file");
}

export function registerInstall(program: Command): void {
  const install = program.command("install <file>").description("install the selected mods into the KOTOR directory");
  addInstallOptions(install).option("--no-checkpoints", "do not record checkpoints");
  install.action(async (file: string, flags: InstallFlags) => {
    process.exitCode = await runInstall(file, flags, { dryRun: false });
  });

  const dry = program.command("dry-run <file>").description("simulate the installation without writing anything");
  addInstallOptions(dry);
  dry.action(async (file: string, flags: InstallFlags) => {
    process.exitCode = await runInstall(file, flags, { dryRun: true });
  });
}
