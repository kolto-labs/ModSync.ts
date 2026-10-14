/**
 * Patcher: apply a TSLPatcher-style mod. The source may point at the exe,
 * at the `tslpatchdata` folder, or at the mod folder containing it.
 */

import { baseName, normalizePath, parentPath } from "../../fs/paths.js";
import type { Instruction, InstructionResult, ModComponent, ModOption, UserPrompt } from "../../model/types.js";
import type { InstallContext } from "../context.js";
import { findChildCaseInsensitive, listNamespaces } from "../patcherPort.js";
import { ActionError, promptId, resolveDestination, resolveSources, runAction } from "./common.js";

export const TSLPATCHDATA = "tslpatchdata";

/** Locate the tslpatchdata folder from a source match (exe, tslpatchdata dir, or mod dir). */
export async function locateTslpatchdata(
  ctx: InstallContext,
  match: string,
): Promise<{ tslpatchdataDir: string; executablePath?: string } | undefined> {
  const st = await ctx.fs.stat(match);
  if (!st) return undefined;
  if (!st.isDirectory) {
    const dir = await findChildCaseInsensitive(ctx.fs, parentPath(st.path), TSLPATCHDATA);
    return dir ? { tslpatchdataDir: dir, executablePath: st.path } : undefined;
  }
  if (baseName(st.path).toLowerCase() === TSLPATCHDATA) return { tslpatchdataDir: st.path };
  const child = await findChildCaseInsensitive(ctx.fs, st.path, TSLPATCHDATA);
  if (!child) return undefined;
  const childStat = await ctx.fs.stat(child);
  return childStat?.isDirectory ? { tslpatchdataDir: child } : undefined;
}

/** Interpret `arguments`: a number is a namespace index, anything else an ini name. */
export function parsePatcherArguments(args: string | undefined): { namespaceIndex?: number; iniName?: string } {
  const a = args?.trim();
  if (!a) return {};
  if (/^\d+$/.test(a)) return { namespaceIndex: Number(a) };
  return { iniName: a };
}

export async function executePatcher(
  ctx: InstallContext,
  instruction: Instruction,
  mod: ModComponent,
  option?: ModOption,
): Promise<InstructionResult> {
  return runAction(ctx, instruction, mod, option, async (run) => {
    if (instruction.source.length === 0) throw new ActionError("UnknownError", "Patcher instruction has no source");
    const sources = await resolveSources(ctx, instruction.source);
    const matches = sources.flatMap((s) => s.matches);
    if (matches.length === 0) {
      throw new ActionError("FileNotFoundPre", `patcher source not found: ${instruction.source.map((s) => `"${s}"`).join(", ")}`);
    }
    let located: { tslpatchdataDir: string; executablePath?: string } | undefined;
    for (const m of matches) {
      located = await locateTslpatchdata(ctx, m);
      if (located) break;
    }
    if (!located) throw new ActionError("FileNotFoundPre", `no "${TSLPATCHDATA}" folder found under ${matches.map((m) => `"${m}"`).join(", ")}`);

    const gameDir = instruction.destination?.trim()
      ? await resolveDestination(ctx, instruction.destination)
      : normalizePath(ctx.dirs.kotorDirectory);

    const { iniName, namespaceIndex: requestedNamespace } = parsePatcherArguments(instruction.arguments);
    let namespaceIndex = requestedNamespace;
    if (namespaceIndex === undefined && iniName === undefined) {
      let namespaces;
      try {
        namespaces = await listNamespaces(located.tslpatchdataDir, ctx.fs);
      } catch (err) {
        throw new ActionError("PatcherError", `namespaces.ini is invalid: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (namespaces && namespaces.length === 1) {
        namespaceIndex = 0;
      } else if (namespaces && namespaces.length > 1) {
        const prompt: UserPrompt = {
          id: promptId(instruction),
          kind: "patcher-namespace",
          title: `${mod.name}: choose an installation option`,
          message: instruction.description ?? `"${mod.name}" offers several TSLPatcher installation options.`,
          choices: namespaces.map((ns, i) => ({ id: String(i), label: ns.name, description: ns.description, isDefault: i === 0 })),
          modGuid: mod.guid,
          instructionGuid: instruction.guid,
        };
        const answer = await ctx.prompt(prompt);
        if (answer.choiceId === undefined) throw new ActionError("UserCancelled", "no namespace chosen");
        const idx = Number(answer.choiceId);
        if (!Number.isInteger(idx) || idx < 0 || idx >= namespaces.length) {
          throw new ActionError("UnknownError", `invalid namespace choice "${answer.choiceId}"`);
        }
        namespaceIndex = idx;
        run.note(`namespace "${namespaces[idx].name}"`);
      }
    }

    const result = await ctx.patcher.install({
      tslpatchdataDir: located.tslpatchdataDir,
      gameDir,
      namespaceIndex,
      iniName,
      dryRun: ctx.dryRun,
      fs: ctx.fs,
      executablePath: located.executablePath,
      onLog: (line) => ctx.logger.debug(`[${mod.name}] ${line}`),
    });
    for (const w of result.warnings) ctx.logger.warn(`[${mod.name}] ${w}`);
    run.touch(...result.filesWritten);
    if (!result.ok) throw new ActionError("PatcherError", result.errors.join("; ") || "patcher failed");
    run.note(`${ctx.dryRun ? "validated" : "applied"} ${located.tslpatchdataDir}${namespaceIndex !== undefined ? ` [namespace ${namespaceIndex}]` : ""}${iniName ? ` [${iniName}]` : ""} (${result.filesWritten.length} file(s))`);
  });
}
