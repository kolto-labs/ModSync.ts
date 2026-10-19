/**
 * Patcher: apply a TSLPatcher-style mod. The source may point at the exe,
 * at the `tslpatchdata` folder, or at the mod folder containing it.
 */

import { baseName, normalizePath, parentPath } from "../../fs/paths.js";
import type { Instruction, InstructionResult, ModComponent, ModOption, UserPrompt } from "../../model/types.js";
import type { InstallContext } from "../context.js";
import type { FileSystemPort } from "../../ports/filesystem.js";
import { findChildCaseInsensitive, listNamespaces } from "../patcherPort.js";
import { ActionError, promptId, resolveDestination, resolveSources, runAction } from "./common.js";

export const TSLPATCHDATA = "tslpatchdata";

/** Deepest level (1 = direct child) at which a nested `tslpatchdata` folder is accepted. */
export const TSLPATCHDATA_MAX_DEPTH = 3;

const TOP_LEVEL_LISTING_LIMIT = 25;

function relativeTo(root: string, path: string): string {
  const prefix = `${normalizePath(root).replace(/\/+$/, "")}/`;
  const full = normalizePath(path);
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

/**
 * Find the `tslpatchdata` folder under an extracted mod directory,
 * case-insensitively. A direct child wins; otherwise the shallowest match
 * within TSLPATCHDATA_MAX_DEPTH levels is used (breadth-first). Several
 * matches at the same depth are ambiguous and fail rather than guess.
 */
export async function findTslpatchdataDir(fs: FileSystemPort, root: string): Promise<string | undefined> {
  let level = [normalizePath(root)];
  for (let depth = 1; depth <= TSLPATCHDATA_MAX_DEPTH && level.length > 0; depth++) {
    const hits: string[] = [];
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await fs.readDir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        if (entry.name.toLowerCase() === TSLPATCHDATA) hits.push(entry.path);
        else next.push(entry.path);
      }
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const listed = hits.map((h) => `"${relativeTo(root, h)}"`).sort().join(", ");
      throw new ActionError(
        "PatcherError",
        `ambiguous "${TSLPATCHDATA}" folders under "${normalizePath(root)}": ${hits.length} found at depth ${depth} (${listed}); point the source at one of them`,
      );
    }
    level = next;
  }
  return undefined;
}

async function describeTopLevel(fs: FileSystemPort, match: string): Promise<string> {
  const st = await fs.stat(match);
  if (!st?.isDirectory) return `"${match}" (not a directory)`;
  try {
    const entries = (await fs.readDir(match)).map((e) => (e.isDirectory ? `${e.name}/` : e.name)).sort();
    const shown = entries.slice(0, TOP_LEVEL_LISTING_LIMIT).join(", ");
    const more = entries.length > TOP_LEVEL_LISTING_LIMIT ? `, … (+${entries.length - TOP_LEVEL_LISTING_LIMIT} more)` : "";
    return `"${match}" (top-level entries: ${entries.length === 0 ? "none" : shown + more})`;
  } catch {
    return `"${match}" (unreadable)`;
  }
}

/** Locate the tslpatchdata folder from a source match (exe, tslpatchdata dir, or mod dir). */
export async function locateTslpatchdata(
  ctx: InstallContext,
  match: string,
): Promise<{ tslpatchdataDir: string; executablePath?: string; selectedIniName?: string } | undefined> {
  const st = await ctx.fs.stat(match);
  if (!st) return undefined;
  if (!st.isDirectory) {
    const containing = parentPath(st.path);
    if (baseName(containing).toLowerCase() === TSLPATCHDATA) {
      const name = baseName(st.path);
      return { tslpatchdataDir: containing, ...(name.toLowerCase().endsWith(".ini") && name.toLowerCase() !== "namespaces.ini" ? { selectedIniName: name } : {}) };
    }
    const dir = await findChildCaseInsensitive(ctx.fs, containing, TSLPATCHDATA);
    const dataStat = dir ? await ctx.fs.stat(dir) : undefined;
    return dataStat?.isDirectory ? { tslpatchdataDir: dir!, ...(baseName(st.path).toLowerCase().endsWith(".exe") ? { executablePath: st.path } : {}) } : undefined;
  }
  if (baseName(st.path).toLowerCase() === TSLPATCHDATA) return { tslpatchdataDir: st.path };
  const found = await findTslpatchdataDir(ctx.fs, st.path);
  return found ? { tslpatchdataDir: found } : undefined;
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
    let located: { tslpatchdataDir: string; executablePath?: string; selectedIniName?: string } | undefined;
    for (const m of matches) {
      located = await locateTslpatchdata(ctx, m);
      if (located) break;
    }
    if (!located) {
      const searched = await Promise.all(matches.map((m) => describeTopLevel(ctx.fs, m)));
      throw new ActionError(
        "FileNotFoundPre",
        `no "${TSLPATCHDATA}" folder found (searched up to ${TSLPATCHDATA_MAX_DEPTH} levels deep, case-insensitive) under ${searched.join(", ")}`,
      );
    }

    const gameDir = instruction.destination?.trim()
      ? await resolveDestination(ctx, instruction.destination)
      : normalizePath(ctx.dirs.kotorDirectory);

    const parsedArguments = parsePatcherArguments(instruction.arguments);
    let iniName = parsedArguments.iniName;
    let namespaceIndex = parsedArguments.namespaceIndex;
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
      } else if (located.selectedIniName) {
        iniName = located.selectedIniName;
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
    for (const note of result.unverified ?? []) {
      ctx.notify?.({ code: "virtual-source-unverified", message: `${mod.name}: ${note}`, modGuid: mod.guid, instructionGuid: instruction.guid });
    }
    run.touch(...result.filesWritten);
    if (!result.ok) throw new ActionError("PatcherError", result.errors.join("; ") || "patcher failed");
    run.note(`${ctx.dryRun ? "validated" : "applied"} ${located.tslpatchdataDir}${namespaceIndex !== undefined ? ` [namespace ${namespaceIndex}]` : ""}${iniName ? ` [${iniName}]` : ""} (${result.filesWritten.length} file(s))`);
  });
}
