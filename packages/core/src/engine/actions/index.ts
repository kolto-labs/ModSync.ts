/**
 * Action dispatch. `executeInstruction` evaluates the per-instruction
 * gates (platform, dependencies, restrictions) and then runs the action.
 * `predictTouched` computes the paths an instruction is about to modify so
 * the checkpoint store can snapshot them first.
 */

import type { ActionType, Instruction, InstructionResult, ModComponent, ModOption } from "../../model/types.js";
import { parseCleanList } from "../../serialization/cleanlist.js";
import type { InstallContext } from "../context.js";
import { executeChoose, chooseFolderCandidates, isOptionChoose, DEFAULT_CHOOSE_DESTINATION } from "./choose.js";
import { executeCleanList, planCleanList } from "./cleanList.js";
import { joinPath } from "../../fs/paths.js";
import { planTransfer, resolveDestination, resolveSources } from "./common.js";
import { executeCreateDirectory, directoryDestination } from "./createDirectory.js";
import { executeCopy } from "./copy.js";
import { executeDelete } from "./delete.js";
import { executeDelDuplicate, findDuplicates, normalizeExtension } from "./delDuplicate.js";
import { executeExecute } from "./execute.js";
import { defaultExtractDir, executeExtract } from "./extract.js";
import { executeMove } from "./move.js";
import { executePatcher } from "./patcher.js";
import { executeRename, renameTarget } from "./rename.js";

export * from "./common.js";
export * from "./extract.js";
export * from "./move.js";
export * from "./copy.js";
export * from "./createDirectory.js";
export * from "./delete.js";
export * from "./rename.js";
export * from "./execute.js";
export * from "./patcher.js";
export * from "./choose.js";
export * from "./delDuplicate.js";
export * from "./cleanList.js";

export type ActionExecutor = (
  ctx: InstallContext,
  instruction: Instruction,
  mod: ModComponent,
  option?: ModOption,
) => Promise<InstructionResult>;

export const ACTION_EXECUTORS: Record<ActionType, ActionExecutor> = {
  Unset: async (_ctx, instruction, mod, option) => gateResult(instruction, mod, option, "UnknownError", "Choose an action before installing this instruction"),
  Run: executeExecute,
  Extract: executeExtract,
  Move: executeMove,
  Copy: executeCopy,
  CreateDirectory: executeCreateDirectory,
  Delete: executeDelete,
  Rename: executeRename,
  Execute: executeExecute,
  Patcher: executePatcher,
  Choose: executeChoose,
  DelDuplicate: executeDelDuplicate,
  CleanList: executeCleanList,
};

function gateResult(
  instruction: Instruction,
  mod: ModComponent,
  option: ModOption | undefined,
  code: InstructionResult["code"],
  message: string,
): InstructionResult {
  return {
    instructionGuid: instruction.guid,
    modGuid: mod.guid,
    optionGuid: option?.guid,
    action: instruction.action,
    code,
    message,
    touched: [],
    durationMs: 0,
  };
}

/**
 * Decide whether an instruction should run at all. Returns a result to
 * report instead of running, or undefined when the instruction may run.
 */
export function gateInstruction(
  ctx: InstallContext,
  instruction: Instruction,
  mod: ModComponent,
  option?: ModOption,
): InstructionResult | undefined {
  if (instruction.platform && instruction.platform !== ctx.settings.platform) {
    return gateResult(instruction, mod, option, "Skipped", `only for platform ${instruction.platform}`);
  }
  const missing = instruction.dependencies.filter((g) => !ctx.selection.selectedGuids.has(g));
  if (missing.length) {
    const names = missing.map((g) => `"${ctx.selection.names.get(g) ?? g}"`).join(", ");
    return gateResult(instruction, mod, option, "DependencyNotSelected", `requires ${names}`);
  }
  const blocked = instruction.restrictions.filter((g) => ctx.selection.selectedGuids.has(g));
  if (blocked.length) {
    const names = blocked.map((g) => `"${ctx.selection.names.get(g) ?? g}"`).join(", ");
    return gateResult(instruction, mod, option, "RestrictionSelected", `not run because ${names} is selected`);
  }
  const executor = ACTION_EXECUTORS[instruction.action];
  if (!executor) return gateResult(instruction, mod, option, "UnknownError", `unknown action "${instruction.action}"`);
  return undefined;
}

/** Run one instruction after evaluating its gates. Never throws. */
export async function executeInstruction(
  ctx: InstallContext,
  instruction: Instruction,
  mod: ModComponent,
  option?: ModOption,
): Promise<InstructionResult> {
  const gated = gateInstruction(ctx, instruction, mod, option);
  if (gated) return gated;
  const executor = ACTION_EXECUTORS[instruction.action];
  return executor(ctx, instruction, mod, option);
}

/**
 * Paths an instruction will create, modify or delete, computed without
 * mutating anything. Returns an empty list when the outcome cannot be known
 * up front (Patcher, Execute) or when resolution fails.
 */
export async function predictTouched(ctx: InstallContext, instruction: Instruction, strict = false): Promise<string[]> {
  try {
    switch (instruction.action) {
      case "CreateDirectory": return [await directoryDestination(ctx,instruction)];
      case "Move":
      case "Copy": {
        if (!instruction.destination) return [];
        const sources = await resolveSources(ctx, instruction.source);
        const dest = await resolveDestination(ctx, instruction.destination);
        const plan = await planTransfer(ctx, sources.flatMap((s) => s.matches), dest);
        const out = plan.filter((p) => !p.isDirectory).map((p) => p.to);
        if (instruction.action === "Move") out.push(...plan.filter((p) => !p.isDirectory).map((p) => p.from));
        return out;
      }
      case "Delete": {
        const sources = await resolveSources(ctx, instruction.source);
        return sources.flatMap((s) => s.matches);
      }
      case "Rename": {
        if (!instruction.destination) return [];
        const sources = await resolveSources(ctx, instruction.source);
        const src = sources.flatMap((s) => s.matches)[0];
        if (!src) return [];
        return [src, renameTarget(ctx, src, instruction.destination)];
      }
      case "Extract": {
        const sources = await resolveSources(ctx, instruction.source);
        const dest = instruction.destination?.trim() ? await resolveDestination(ctx, instruction.destination) : undefined;
        const out: string[] = [];
        for (const archive of sources.flatMap((source) => source.matches)) {
          const target = dest ?? defaultExtractDir(archive);
          const reader = await ctx.openArchive(archive, { sevenZipPath: ctx.settings.sevenZipPath });
          try {
            out.push(target, ...(await reader.list()).map((entry) => joinPath(target, entry.path)));
          } finally { await reader.close(); }
        }
        return out;
      }
      case "Choose": {
        if (isOptionChoose(instruction)) return [];
        const candidates = await chooseFolderCandidates(ctx, instruction);
        const dest = await resolveDestination(ctx, instruction.destination?.trim() || DEFAULT_CHOOSE_DESTINATION);
        const out: string[] = [];
        for (const folder of candidates) {
          const children = (await ctx.fs.readDir(folder)).map((e) => e.path);
          const plan = await planTransfer(ctx, children, dest);
          out.push(...plan.filter((p) => !p.isDirectory).flatMap((p) => [p.to, p.from]));
        }
        return out;
      }
      case "DelDuplicate":
        return findDuplicates(ctx, instruction.source, normalizeExtension(instruction.arguments));
      case "CleanList": {
        if (!instruction.destination || instruction.source.length === 0) return [];
        const sources = await resolveSources(ctx, [instruction.source[0]]);
        const csv = sources[0].matches[0];
        if (!csv) return [];
        const dest = await resolveDestination(ctx, instruction.destination);
        const entries = parseCleanList(new TextDecoder("utf-8").decode(await ctx.fs.readFile(csv)));
        const plan = await planCleanList(ctx, entries, dest);
        return plan.flatMap((p) => p.matches);
      }
      case "Patcher":
      case "Execute":
      default:
        return [];
    }
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}
