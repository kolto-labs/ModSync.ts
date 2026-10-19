/**
 * Shared plumbing for actions: result construction, cancellation, path
 * resolution (placeholders + wildcards) and the transfer helper used by
 * Move / Copy / Choose.
 */

import { MissingPlaceholderError, PathEscapeError, baseName, joinPath, normalizePath } from "../../fs/paths.js";
import { resolveWildcards } from "../../fs/wildcards.js";
import type { Guid, Instruction, InstructionResult, ModComponent, ModOption, ResultCode } from "../../model/types.js";
import type { InstallContext } from "../context.js";

/** Thrown internally when `ctx.signal` is aborted; mapped to `UserCancelled`. */
export class CancelledError extends Error {
  override readonly name = "CancelledError";
  constructor(message = "Installation cancelled") {
    super(message);
  }
}

/** Thrown internally to end an action with a specific result code. */
export class ActionError extends Error {
  override readonly name = "ActionError";
  constructor(
    readonly code: ResultCode,
    message: string,
  ) {
    super(message);
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof CancelledError) return true;
  return typeof err === "object" && err !== null && "name" in err && (err as { name?: unknown }).name === "AbortError";
}

/** Throw CancelledError when the context's signal is aborted. */
export function checkCancelled(ctx: InstallContext): void {
  if (ctx.signal?.aborted) throw new CancelledError();
}

/** Mutable state an action body fills in. */
export interface ActionRun {
  touched: Set<string>;
  messages: string[];
  touch(...paths: string[]): void;
  note(message: string): void;
}

/**
 * Run an action body with timing, cancellation and error mapping. The body
 * returns an optional result code (default Success) and the final message
 * is the joined notes.
 */
export async function runAction(
  ctx: InstallContext,
  instruction: Instruction,
  mod: ModComponent,
  option: ModOption | undefined,
  body: (run: ActionRun) => Promise<ResultCode | void>,
): Promise<InstructionResult> {
  const started = performance.now();
  const touched = new Set<string>();
  const messages: string[] = [];
  const run: ActionRun = {
    touched,
    messages,
    touch: (...paths) => {
      for (const p of paths) touched.add(normalizePath(p));
    },
    note: (m) => {
      messages.push(m);
    },
  };
  const finish = (code: ResultCode, message?: string): InstructionResult => ({
    instructionGuid: instruction.guid,
    modGuid: mod.guid,
    optionGuid: option?.guid,
    action: instruction.action,
    code,
    message: message ?? (messages.length ? messages.join("; ") : undefined),
    touched: [...touched],
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
  });
  try {
    checkCancelled(ctx);
    const code = (await body(run)) ?? "Success";
    return finish(code);
  } catch (err) {
    if (isAbortError(err)) return finish("UserCancelled", err instanceof Error ? err.message : "cancelled");
    if (err instanceof ActionError) return finish(err.code, err.message);
    if (err instanceof PathEscapeError) return finish("PathEscape", err.message);
    if (err instanceof MissingPlaceholderError) return finish("PathEscape", err.message);
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`${instruction.action} ${instruction.guid} failed: ${message}`);
    return finish("UnknownError", message);
  }
}

export interface ResolvedSource {
  /** The raw instruction text. */
  raw: string;
  /** Placeholder-resolved absolute pattern (wildcards preserved). */
  pattern: string;
  /** Existing, case-resolved matches (files and directories). */
  matches: string[];
}

/** Resolve placeholders and wildcards for every source of an instruction. */
export async function resolveSources(ctx: InstallContext, sources: readonly string[]): Promise<ResolvedSource[]> {
  const out: ResolvedSource[] = [];
  for (const raw of sources) {
    checkCancelled(ctx);
    const pattern = ctx.resolver.resolve(raw);
    const matches = await resolveWildcards(ctx.fs, pattern);
    out.push({ raw, pattern, matches });
  }
  return out;
}

/** Resolve a destination string (placeholders + wildcards); the first match wins, else the literal path. */
export async function resolveDestination(ctx: InstallContext, raw: string): Promise<string> {
  const pattern = ctx.resolver.resolve(raw);
  const matches = await resolveWildcards(ctx.fs, pattern);
  if (matches.length > 0) return matches[0];
  if (/[*?]/.test(pattern)) throw new ActionError("FileNotFoundPre", `destination "${raw}" matches nothing`);
  return pattern;
}

export function requireDestination(instruction: Instruction): string {
  const dest = instruction.destination?.trim();
  if (!dest) throw new ActionError("UnknownError", `${instruction.action} instruction ${instruction.guid} has no destination`);
  return dest;
}

/**
 * Every path pair a transfer of `sources` into `destDir` would produce. A source
 * directory named like `destDir` (an archive's top-level `Override/` moved into
 * `<game>/Override`) merges straight into `destDir` instead of nesting
 * `Override/Override`.
 */
export async function planTransfer(
  ctx: InstallContext,
  sources: readonly string[],
  destDir: string,
): Promise<Array<{ from: string; to: string; isDirectory: boolean }>> {
  const plan: Array<{ from: string; to: string; isDirectory: boolean }> = [];
  for (const src of sources) {
    const st = await ctx.fs.stat(src);
    if (!st) continue;
    if (!st.isDirectory) {
      plan.push({ from: src, to: joinPath(destDir, baseName(src)), isDirectory: false });
      continue;
    }
    const sameNamedAsDest = baseName(src).toLowerCase() === baseName(destDir).toLowerCase();
    const root = sameNamedAsDest ? normalizePath(destDir) : joinPath(destDir, baseName(src));
    plan.push({ from: src, to: root, isDirectory: true });
    const prefix = st.path.length + 1;
    for (const file of await ctx.fs.walk(st.path)) {
      plan.push({ from: file, to: joinPath(root, file.slice(prefix)), isDirectory: false });
    }
  }
  return plan;
}

/**
 * Move or copy `sources` (files or directories) into `destDir`. Directories
 * merge into an existing directory of the same name. With `overwrite=false`
 * existing files are kept (logged at info level).
 */
export async function transferInto(
  ctx: InstallContext,
  run: ActionRun,
  sources: readonly string[],
  destDir: string,
  mode: "move" | "copy",
  overwrite: boolean,
): Promise<{ transferred: number; skipped: number }> {
  let transferred = 0;
  let skipped = 0;
  await ctx.fs.mkdirp(destDir);
  const plan = await planTransfer(ctx, sources, destDir);
  const movedDirs: string[] = [];
  for (const step of plan) {
    checkCancelled(ctx);
    if (step.isDirectory) {
      const blocking = await ctx.fs.stat(step.to);
      if (blocking && !blocking.isDirectory) {
        if (!overwrite) {
          throw new ActionError("UnknownError", `cannot ${mode} directory "${step.from}" to "${blocking.path}": a file with that name exists`);
        }
        await ctx.fs.remove(blocking.path);
      }
      await ctx.fs.mkdirp(step.to);
      if (mode === "move") movedDirs.push(step.from);
      continue;
    }
    const existing = await ctx.fs.resolveCase(step.to);
    if (existing !== undefined) {
      if (!overwrite) {
        ctx.logger.info(`${mode}: keeping existing "${existing}" (overwrite=false)`);
        skipped++;
        continue;
      }
      const st = await ctx.fs.stat(existing);
      if (st?.isDirectory) await ctx.fs.remove(existing);
    }
    const target = existing ?? step.to;
    if (mode === "move") {
      await ctx.fs.move(step.from, target);
      run.touch(step.from);
    } else {
      await ctx.fs.copyFile(step.from, target);
    }
    run.touch(target);
    transferred++;
  }
  // Remove emptied source directories (deepest first) after a move; ones that
  // still hold skipped files stay.
  for (const dir of movedDirs.sort((a, b) => b.length - a.length)) {
    const left = await ctx.fs.walk(dir);
    if (left.length === 0) await ctx.fs.remove(dir);
  }
  return { transferred, skipped };
}

/** Convenience for building a prompt id. */
export function promptId(instruction: Instruction): string {
  return `${instruction.guid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

export function describeGuid(ctx: InstallContext, guid: Guid): string {
  return ctx.selection.names.get(guid) ?? guid;
}
