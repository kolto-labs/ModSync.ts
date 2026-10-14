/**
 * Installer: runs the selected mods of an instruction file in computed order
 * against the real disk, streaming `InstallEvent`s, asking the UI questions
 * through prompts, taking a checkpoint after every instruction when a
 * CheckpointStore is provided, and stopping cleanly on `cancel()`.
 */

import { EventEmitter } from "node:events";

import type { openArchive } from "../archive/index.js";
import type { CheckpointStore } from "../checkpoints/store.js";
import { NullLogger } from "../logging/logger.js";
import type {
  CheckpointSession,
  Guid,
  InstallEvent,
  InstallSummary,
  Instruction,
  InstructionResult,
  Logger,
  ModComponent,
  ModOption,
  ModResult,
  TelemetrySink,
  UserPrompt,
  UserPromptAnswer,
  UserSettings,
  InstructionFile,
} from "../model/types.js";
import type { FileSystemPort } from "../ports/filesystem.js";
import { executeInstruction, gateInstruction, predictTouched } from "./actions/index.js";
import { CancelledError } from "./actions/common.js";
import { createInstallContext, type InstallContext } from "./context.js";
import { computeInstallOrder } from "./order.js";
import type { PatcherPort } from "./patcherPort.js";
import { checkSelectionConstraints, computeSelection, type SelectionSet } from "./selection.js";

/** The three CheckpointStore methods the installer relies on. */
export type CheckpointSink = Pick<CheckpointStore, "startSession" | "beforeTouch" | "create">;

export interface InstallerDeps {
  fs?: FileSystemPort;
  logger?: Logger;
  patcher?: PatcherPort;
  checkpoints?: CheckpointSink;
  telemetry?: TelemetrySink;
  openArchive?: typeof openArchive;
}

export interface RunOptions {
  /** "base" runs non-widescreen mods, "widescreen" the widescreen ones. Default "base". */
  phase?: "base" | "widescreen";
  /** Restrict the run to these mods (still in computed order). */
  modGuids?: Guid[];
  /** Simulate instead of touching the disk. */
  dryRun?: boolean;
}

export type InstallEventListener = (event: InstallEvent) => void;

interface PendingPrompt {
  prompt: UserPrompt;
  resolve: (answer: UserPromptAnswer) => void;
  reject: (err: Error) => void;
}

export class Installer extends EventEmitter {
  private controller: AbortController | undefined;
  private pending: PendingPrompt | undefined;
  private active = false;
  private currentModGuid: Guid | undefined;
  private lastSummary: InstallSummary | undefined;

  constructor(
    readonly file: InstructionFile,
    readonly settings: UserSettings,
    private readonly deps: InstallerDeps = {},
  ) {
    super();
  }

  override on(event: "event", listener: InstallEventListener): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override once(event: "event", listener: InstallEventListener): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  override off(event: "event", listener: InstallEventListener): this;
  override off(event: string | symbol, listener: (...args: any[]) => void): this;
  override off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }

  get running(): boolean {
    return this.active;
  }

  get currentMod(): Guid | undefined {
    return this.currentModGuid;
  }

  get pendingPrompt(): UserPrompt | undefined {
    return this.pending?.prompt;
  }

  get summary(): InstallSummary | undefined {
    return this.lastSummary;
  }

  private emitEvent(event: InstallEvent): void {
    this.emit("event", event);
  }

  /** Answer the prompt currently waiting. Ignored when nothing is pending or the id does not match. */
  answerPrompt(answer: UserPromptAnswer): boolean {
    const pending = this.pending;
    if (!pending || pending.prompt.id !== answer.promptId) return false;
    this.pending = undefined;
    pending.resolve(answer);
    return true;
  }

  /** Abort the run. The current instruction finishes (or fails with UserCancelled) and no further mod starts. */
  cancel(): void {
    if (!this.controller || this.controller.signal.aborted) return;
    this.controller.abort(new CancelledError());
    const pending = this.pending;
    if (pending) {
      this.pending = undefined;
      pending.reject(new CancelledError("cancelled while waiting for an answer"));
    }
  }

  /** Mods that will run for the given options, in order. */
  plan(opts: RunOptions = {}): { selection: SelectionSet; order: Guid[]; mods: ModComponent[]; issues: ReturnType<typeof checkSelectionConstraints> } {
    const selection = computeSelection(this.file, this.settings);
    const issues = checkSelectionConstraints(this.file, selection, this.settings.compatibilityLevel);
    const orderResult = computeInstallOrder(this.file, selection);
    issues.push(...orderResult.issues);
    const phase = opts.phase ?? "base";
    const filter = opts.modGuids ? new Set(opts.modGuids) : undefined;
    const byGuid = new Map(this.file.mods.map((m) => [m.guid, m]));
    const mods = orderResult.order
      .map((g) => byGuid.get(g)!)
      .filter((m) => (phase === "widescreen" ? m.isWidescreen : !m.isWidescreen))
      .filter((m) => !filter || filter.has(m.guid));
    return { selection, order: orderResult.order, mods, issues };
  }

  async run(opts: RunOptions = {}): Promise<InstallSummary> {
    if (this.active) throw new Error("an installation is already running");
    this.active = true;
    const controller = new AbortController();
    this.controller = controller;
    const logger = this.deps.logger ?? NullLogger;
    const startedAt = new Date().toISOString();
    const summary: InstallSummary = { startedAt, finishedAt: startedAt, mods: [], succeeded: 0, failed: 0, skipped: 0 };
    this.lastSummary = summary;

    try {
      const { selection, mods, issues } = this.plan(opts);
      const errors = issues.filter((i) => i.severity === "error");
      if (errors.length) throw new Error(errors.map((e) => e.message).join("\n"));
      for (const w of issues) this.emitEvent({ type: "log", level: "warn", message: w.message });

      const ctx: InstallContext = createInstallContext({
        settings: this.settings,
        selection,
        fs: this.deps.fs,
        logger,
        patcher: this.deps.patcher,
        telemetry: this.deps.telemetry,
        openArchive: this.deps.openArchive,
        dryRun: opts.dryRun ?? false,
        signal: controller.signal,
        prompt: (prompt) =>
          new Promise<UserPromptAnswer>((resolve, reject) => {
            if (controller.signal.aborted) {
              reject(new CancelledError());
              return;
            }
            this.pending = { prompt, resolve, reject };
            this.emitEvent({ type: "prompt", prompt });
          }),
      });

      let session: CheckpointSession | undefined;
      const store = this.deps.checkpoints;
      if (store && !ctx.dryRun) {
        try {
          session = await store.startSession(`${this.file.config.name ?? "ModSync"} ${startedAt}`);
          summary.checkpointSessionId = session.id;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`checkpoint session creation failed; installation was not started: ${message}`, { cause: err });
        }
      }

      this.emitEvent({ type: "install-started", total: mods.length, order: mods.map((m) => m.guid) });

      for (let index = 0; index < mods.length; index++) {
        if (controller.signal.aborted) break;
        const mod = mods[index];
        this.currentModGuid = mod.guid;
        const modStarted = performance.now();
        const modResult: ModResult = { modGuid: mod.guid, state: "Installing", instructionResults: [], durationMs: 0 };
        mod.installState = "Installing";

        const skipReason = this.modGate(mod, ctx.selection);
        if (skipReason) {
          modResult.state = "Skipped";
          mod.installState = "Skipped";
          modResult.durationMs = 0;
          summary.mods.push(modResult);
          summary.skipped++;
          this.emitEvent({ type: "log", level: "warn", message: `skipping "${mod.name}": ${skipReason}` });
          this.emitEvent({ type: "mod-finished", result: modResult });
          continue;
        }

        this.emitEvent({ type: "mod-started", modGuid: mod.guid, index, total: mods.length, name: mod.name });
        let failed = false;
        const steps: Array<{ instruction: Instruction; option?: ModOption }> = mod.instructions.map((instruction) => ({ instruction }));
        for (const step of steps) {
          if (controller.signal.aborted) break;
          const result = await this.runStep(ctx, store, session, mod, step.instruction, step.option);
          modResult.instructionResults.push(result);
          if (result.code === "UserCancelled") {
            failed = true;
            break;
          }
          if (!isSoftResult(result)) {
            failed = true;
            break;
          }
        }
        // Options: computed after the mod's instructions ran, so a Choose can adjust the selection.
        if (!failed && !controller.signal.aborted) {
          for (const option of mod.options) {
            if (!ctx.selection.selectedGuids.has(option.guid)) continue;
            for (const instruction of option.instructions) {
              if (controller.signal.aborted) break;
              const result = await this.runStep(ctx, store, session, mod, instruction, option);
              modResult.instructionResults.push(result);
              if (!isSoftResult(result)) {
                failed = true;
                break;
              }
            }
            if (failed) break;
          }
        }

        modResult.durationMs = Math.round(performance.now() - modStarted);
        if (failed) {
          modResult.state = "Failed";
          summary.failed++;
        } else if (controller.signal.aborted) {
          modResult.state = "Failed";
          summary.failed++;
        } else {
          modResult.state = "Installed";
          summary.succeeded++;
        }
        mod.installState = modResult.state;
        summary.mods.push(modResult);
        this.emitEvent({ type: "mod-finished", result: modResult });
        if (modResult.state === "Failed") {
          if (!controller.signal.aborted) {
            const failure = modResult.instructionResults.find((result) => !isSoftResult(result));
            this.emitEvent({ type: "install-error", message: `Installation stopped at ${mod.name}: ${failure?.message ?? failure?.code ?? "instruction failed"}` });
          }
          break;
        }
      }

      summary.finishedAt = new Date().toISOString();
      if (controller.signal.aborted) this.emitEvent({ type: "install-cancelled" });
      this.emitEvent({ type: "install-finished", summary });
      return summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`install failed: ${message}`);
      summary.finishedAt = new Date().toISOString();
      summary.failed = Math.max(1, summary.failed);
      this.emitEvent({ type: "install-error", message });
      this.emitEvent({ type: "install-finished", summary });
      return summary;
    } finally {
      this.currentModGuid = undefined;
      this.pending = undefined;
      this.active = false;
    }
  }

  /** Mod-level dependency / restriction check. Returns a reason to skip, or undefined. */
  private modGate(mod: ModComponent, selection: SelectionSet): string | undefined {
    const missing = mod.dependencies.filter((g) => !selection.selectedGuids.has(g));
    if (missing.length) return `requires ${missing.map((g) => `"${selection.names.get(g) ?? g}"`).join(", ")}`;
    const blocked = mod.restrictions.filter((g) => selection.selectedGuids.has(g));
    if (blocked.length) return `restricted by ${blocked.map((g) => `"${selection.names.get(g) ?? g}"`).join(", ")}`;
    return undefined;
  }

  private async runStep(
    ctx: InstallContext,
    store: CheckpointSink | undefined,
    session: CheckpointSession | undefined,
    mod: ModComponent,
    instruction: Instruction,
    option?: ModOption,
  ): Promise<InstructionResult> {
    this.emitEvent({
      type: "instruction-started",
      modGuid: mod.guid,
      instructionGuid: instruction.guid,
      action: instruction.action,
      description: instruction.description ?? describeBriefly(instruction),
    });
    let predicted: string[] = [];
    const opaqueWrites = !gateInstruction(ctx, instruction, mod, option) && (instruction.action === "Patcher" || instruction.action === "Execute");
    if (store && session) {
      // These tools decide their output files at runtime. Save all existing game
      // files before invoking them, then scan again to discover newly created files.
      try {
        predicted = opaqueWrites ? await ctx.fs.walk(ctx.dirs.kotorDirectory) : await predictTouched(ctx, instruction);
        await store.beforeTouch(session, predicted);
      } catch (err) {
        const message = `checkpoint baseline failed; instruction was not executed: ${err instanceof Error ? err.message : String(err)}`;
        ctx.logger.error(message);
        const result: InstructionResult = {
          instructionGuid: instruction.guid, modGuid: mod.guid, optionGuid: option?.guid,
          action: instruction.action, code: "UnknownError", message, touched: [], durationMs: 0,
        };
        this.emitEvent({ type: "log", level: "error", message });
        this.emitEvent({ type: "instruction-finished", result });
        return result;
      }
    }
    const result = await executeInstruction(ctx, instruction, mod, option);
    if (store && session && result.code !== "UserCancelled") {
      try {
        const meta = await store.create(session, {
          label: `${mod.name}: ${instruction.action}`,
          modGuid: mod.guid,
          instructionGuid: instruction.guid,
          touched: opaqueWrites
            ? [...new Set([...predicted, ...await ctx.fs.walk(ctx.dirs.kotorDirectory), ...result.touched])]
            : result.touched,
        });
        result.checkpointId = meta.id;
        this.emitEvent({ type: "checkpoint-created", checkpointId: meta.id, isAnchor: meta.isAnchor, index: meta.index });
      } catch (err) {
        result.code = "UnknownError";
        result.message = `checkpoint persistence failed; installation must stop: ${err instanceof Error ? err.message : String(err)}`;
        ctx.logger.error(result.message);
      }
    }
    ctx.telemetry?.record({
      operation: `instruction:${instruction.action}`,
      success: isSoftResult(result),
      durationMs: result.durationMs,
      data: { modGuid: mod.guid, instructionGuid: instruction.guid, optionGuid: option?.guid, code: result.code },
      errors: isSoftResult(result) ? undefined : [result.message ?? result.code],
    });
    const level = isSoftResult(result) ? "info" : "error";
    this.emitEvent({
      type: "log",
      level,
      message: `${mod.name}: ${instruction.action} -> ${result.code}${result.message ? ` (${result.message})` : ""}`,
    });
    this.emitEvent({ type: "instruction-finished", result });
    return result;
  }
}

/** Results that do not fail the mod. */
export function isSoftResult(result: InstructionResult): boolean {
  return (
    result.code === "Success" ||
    result.code === "Skipped" ||
    result.code === "DependencyNotSelected" ||
    result.code === "RestrictionSelected"
  );
}

function describeBriefly(instruction: Instruction): string {
  const src = instruction.source.length ? instruction.source[0] + (instruction.source.length > 1 ? ` (+${instruction.source.length - 1})` : "") : "";
  return instruction.destination ? `${instruction.action} ${src} -> ${instruction.destination}` : `${instruction.action} ${src}`.trim();
}
