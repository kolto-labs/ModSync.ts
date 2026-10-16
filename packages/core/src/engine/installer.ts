/**
 * Installer: runs the selected mods of an instruction file in computed order
 * against the real disk, streaming `InstallEvent`s, asking the UI questions
 * through prompts, taking a checkpoint after every instruction when a
 * CheckpointStore is provided, and stopping cleanly on `cancel()`.
 */

import { EventEmitter } from "node:events";
import { predictRustAuthoringGuide } from "../authoring/predictionRuntime.js";

import type { openArchive } from "../archive/index.js";
import type { CheckpointStore } from "../checkpoints/store.js";
import { RealFileSystem } from "../fs/realFileSystem.js";
import { acquirePortableRootOwnership, type PhysicalInstallOptIn, type PortableRootOwnership } from "../fs/portableLock.js";
import { VirtualFileSystem } from "../fs/virtualFileSystem.js";
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
import { executeInstruction, predictTouched } from "./actions/index.js";
import { CancelledError } from "./actions/common.js";
import { createInstallContext, type InstallContext } from "./context.js";
import { computeInstallOrder } from "./order.js";
import type { PatcherPort } from "./patcherPort.js";
import { checkSelectionConstraints, computeSelection, type SelectionSet } from "./selection.js";

/** The three CheckpointStore methods the installer relies on. */
export type CheckpointSink = Pick<CheckpointStore, "startSession" | "beforeTouch" | "create" | "beginMutation" | "completeMutation">;

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
  /**
   * CI-only explicit opt-in to a physical (non-virtual) install guarded by the
   * portable lockfile instead of native OS ownership. Without it, every
   * non-dry-run is refused. Cannot be combined with `dryRun`.
   */
  physical?: PhysicalInstallOptIn;
  /** Immutable saved inputs and optional authored instruction boundary for canonical raw-guide prediction. */
  authoringPrediction?: { sessionDirectory?: string; componentGuid?: Guid; instructionCount?: number };
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
  private recoveryPending = false;
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
    if (this.file.rustAuthoringGuide) issues.push({ severity: "error", code: "authoring-install-unported", message: "Rust authoring installation execution is not yet ported; edit and save the guide before choosing an installation workflow" });
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
    this.recoveryPending = false;
    this.active = true;
    const controller = new AbortController();
    this.controller = controller;
    const logger = this.deps.logger ?? NullLogger;
    const startedAt = new Date().toISOString();
    const summary: InstallSummary = { startedAt, finishedAt: startedAt, mods: [], succeeded: 0, failed: 0, skipped: 0 };
    this.lastSummary = summary;
    let ownership: PortableRootOwnership | undefined;

    try {
      if (this.file.rustAuthoringGuide) {
        if (!opts.dryRun) throw new Error("Independent TypeScript physical installation is unavailable: exclusive OS writer ownership and verified recovery acknowledgement are not implemented.");
        if (opts.phase === "widescreen" || opts.modGuids !== undefined) throw new Error("Canonical authored prediction does not support legacy phase/mod filters; use an explicit authored component boundary.");
        if (this.deps.fs || this.deps.patcher || this.deps.openArchive) throw new Error("Canonical authored prediction uses its reviewed readonly filesystem/archive backend; injected legacy execution backends are unsupported.");
        const prediction = await predictRustAuthoringGuide(this.file.rustAuthoringGuide, {
          ...opts.authoringPrediction, settings: this.settings, signal: controller.signal,
        });
        summary.virtualPrediction = prediction;
        for (const result of prediction.results) this.emitEvent({ type: "instruction-finished", result });
        if (prediction.error || prediction.unmodeledEffects.length) {
          summary.error = prediction.error ?? "Virtual prediction has unmodeled external-program or patcher effects; it does not prove installation success.";
          this.emitEvent({ type: "install-error", message: summary.error });
        }
        summary.finishedAt = new Date().toISOString();
        if (controller.signal.aborted) this.emitEvent({ type: "install-cancelled" });
        this.emitEvent({ type: "install-finished", summary });
        return summary;
      }
      if (opts.authoringPrediction) throw new Error("Authored prediction options require a canonical raw guide");
      const { selection, mods, issues } = this.plan(opts);
      const errors = issues.filter((i) => i.severity === "error");
      if (errors.length) {
        summary.error = errors.map((e) => e.message).join("\n");
        this.emitEvent({ type: "install-error", message: summary.error });
        summary.finishedAt = new Date().toISOString();
        return summary;
      }
      for (const w of issues) this.emitEvent({ type: "log", level: "warn", message: w.message });

      const baseFs = this.deps.fs ?? new RealFileSystem();
      const executionFs = opts.dryRun && !baseFs.isVirtual ? new VirtualFileSystem(baseFs) : baseFs;
      const ctx: InstallContext = createInstallContext({
        settings: this.settings,
        selection,
        fs: executionFs,
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

      if (opts.physical) {
        if (opts.dryRun || opts.physical.ownership !== "portable-lockfile") {
          throw new Error('Physical install opt-in requires a real run (not dryRun) with ownership "portable-lockfile"');
        }
        if (ctx.fs.isVirtual) throw new Error("Physical install opt-in requires a non-virtual filesystem");
        if (!this.deps.checkpoints) logger.warn("CI-only physical install without a checkpoint store: a failed step cannot be restored");
        logger.warn("CI-only physical install: portable lockfile ownership excludes only other ModSync processes; native OS ownership and verified recovery are not in effect");
        ownership = await acquirePortableRootOwnership([ctx.dirs.modDirectory, ctx.dirs.kotorDirectory]);
      } else if (!ctx.dryRun || !ctx.fs.isVirtual) {
        throw new Error("Independent TypeScript physical installation is unavailable: exclusive OS writer ownership and verified recovery acknowledgement are not implemented. Use a virtual filesystem for prediction or the configured authoritative Rust workflow. CI-only explicit opt-in: portable lockfile ownership (see docs/PHYSICAL_INSTALL.md).");
      }

      let session: CheckpointSession | undefined;
      const store = this.deps.checkpoints;
      if (store && !ctx.dryRun) {
        try {
          session = await store.startSession(`${this.file.config.name ?? "ModSync"} ${startedAt}`);
          summary.checkpointSessionId = session.id;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Checkpoint setup failed before installation: ${message}`);
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
        if (failed) {
          // The virtual tree may already contain partial effects. Rust stops at
          // the failed component; later mods must not consume that partial state.
          const failure = modResult.instructionResults.find((result) => !isSoftResult(result));
          summary.error = `Installation stopped at "${mod.name}": ${failure?.message ?? failure?.code ?? "instruction failed"}`;
          this.emitEvent({ type: "install-error", message: summary.error });
          break;
        }
      }

      summary.finishedAt = new Date().toISOString();
      if (controller.signal.aborted) this.emitEvent({ type: "install-cancelled" });
      this.emitEvent({ type: "install-finished", summary });
      return summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.error = message;
      summary.recoveryPending = this.recoveryPending;
      logger.error(`install failed: ${message}`);
      summary.finishedAt = new Date().toISOString();
      this.emitEvent({ type: "install-error", message });
      return summary;
    } finally {
      try {
        await ownership?.release();
      } catch (err) {
        const message = `portable install lock release failed: ${err instanceof Error ? err.message : String(err)}`;
        summary.error = summary.error ? `${summary.error}; ${message}` : message;
        logger.error(message);
      }
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
    let checkpointOperationId:string|undefined;
    if (store && session) {
      predicted = await predictTouched(ctx, instruction, true);
      try {
        await store.beforeTouch(session, predicted);
      } catch (err) {
        throw new Error(`Checkpoint baseline failed before mutation: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.recoveryPending = true;
      checkpointOperationId=await store.beginMutation(session, instruction.guid, predicted);
    }
    const result = await executeInstruction(ctx, instruction, mod, option);
    if (store && session && !isSoftResult(result)) {
      throw new Error(`Instruction ${instruction.guid} failed (${result.code}); installation stopped with recovery pending: ${result.message ?? "partial mutation cannot be excluded"}`);
    }
    if (store && session) {
      try {
        const meta = await store.create(session, {
          label: `${mod.name}: ${instruction.action}`,
          modGuid: mod.guid,
          instructionGuid: instruction.guid,
          touched: [...new Set([...predicted,...result.touched])],
          unpredicted: result.touched.filter((path) => !predicted.some((known) => path === known || path.startsWith(`${known}/`))),
        });
        result.checkpointId = meta.id;
        if(!checkpointOperationId)throw new Error("Checkpoint operation identity is unavailable");
        await store.completeMutation(session,instruction.guid,checkpointOperationId);
        this.recoveryPending = false;
        this.emitEvent({ type: "checkpoint-created", checkpointId: meta.id, isAnchor: meta.isAnchor, index: meta.index });
      } catch (err) {
        throw new Error(`Checkpoint finalization failed; pending instruction ${instruction.guid} retained in session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
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
