/**
 * Validation: a full dry run of an instruction file against a
 * VirtualFileSystem, plus static checks on GUIDs, placeholders and archive
 * references. Nothing is written to disk.
 */

import { openArchive as defaultOpenArchive, isArchiveExtension } from "../archive/index.js";
import { containsPlaceholder, isAbsolutePath, isInsideRoot, normalizePath } from "../fs/paths.js";
import { RealFileSystem } from "../fs/realFileSystem.js";
import { VirtualFileSystem } from "../fs/virtualFileSystem.js";
import { resolveWildcards } from "../fs/wildcards.js";
import { NullLogger } from "../logging/logger.js";
import type {
  Guid,
  Instruction,
  InstructionFile,
  InstructionResult,
  Logger,
  ModComponent,
  ModOption,
  RequiredDownload,
  UserPrompt,
  UserSettings,
  ValidationIssue,
  ValidationReport,
} from "../model/types.js";
import type { FileSystemPort } from "../ports/filesystem.js";
import { executeInstruction, gateInstruction } from "./actions/index.js";
import { resolveSources } from "./actions/common.js";
import { defaultExtractDir } from "./actions/extract.js";
import { autoAnswerPrompt, createInstallContext, type InstallContext } from "./context.js";
import { computeInstallOrder } from "./order.js";
import type { PatcherPort } from "./patcherPort.js";
import { checkSelectionConstraints, computeSelection, indexFile } from "./selection.js";

export interface ValidateOptions {
  openArchive?: typeof defaultOpenArchive;
  /** Base file system the VFS overlays (default: the real disk). */
  baseFs?: FileSystemPort;
  logger?: Logger;
  patcher?: PatcherPort;
}

/** Map an instruction result to a validation issue (undefined for Success). */
export function issueFromResult(result: InstructionResult, instruction: Instruction, mod: ModComponent): ValidationIssue | undefined {
  const base = { modGuid: mod.guid, optionGuid: result.optionGuid, instructionGuid: instruction.guid };
  const where = `${mod.name} / ${instruction.action}${instruction.description ? ` (${instruction.description})` : ""}`;
  const msg = result.message ?? "";
  switch (result.code) {
    case "Success":
      return undefined;
    case "Skipped":
    case "DependencyNotSelected":
    case "RestrictionSelected":
      return { severity: "info", code: "instruction-skipped", message: `${where}: ${msg}`, ...base };
    case "FileNotFoundPre":
      return instruction.action === "Extract"
        ? { severity: "error", code: "missing-archive", message: `${where}: ${msg}`, ...base, path: instruction.source[0] }
        : { severity: "error", code: "missing-source", message: `${where}: ${msg}`, ...base, path: instruction.source[0] };
    case "FileNotFoundPost":
      return { severity: "error", code: "missing-result", message: `${where}: ${msg}`, ...base };
    case "PathEscape":
      return { severity: "error", code: "path-escape", message: `${where}: ${msg}`, ...base };
    case "ArchiveError":
      return { severity: "error", code: "archive-error", message: `${where}: ${msg}`, ...base };
    case "PatcherError":
      return { severity: "error", code: "patcher-error", message: `${where}: ${msg}`, ...base };
    case "ExecuteError":
      return { severity: "error", code: "execute-error", message: `${where}: ${msg}`, ...base };
    case "UserCancelled":
      return { severity: "warning", code: "cancelled", message: `${where}: ${msg}`, ...base };
    default:
      return { severity: "error", code: "unknown-error", message: `${where}: ${msg}`, ...base };
  }
}

const RELATION_FIELDS = ["dependencies", "restrictions", "installAfter", "installBefore"] as const;

function staticChecks(file: InstructionFile, issues: ValidationIssue[]): void {
  const { names } = indexFile(file);
  const seen = new Map<Guid, string>();
  const dup = (guid: Guid, what: string, mod: ModComponent, extra: Partial<ValidationIssue> = {}): void => {
    const prev = seen.get(guid);
    if (prev !== undefined) {
      issues.push({
        severity: "error",
        code: "duplicate-guid",
        message: `${what} GUID ${guid} is already used by ${prev}`,
        modGuid: mod.guid,
        ...extra,
      });
    } else {
      seen.set(guid, what);
    }
  };
  const checkRefs = (
    owner: { dependencies: Guid[]; restrictions: Guid[]; installAfter: Guid[]; installBefore: Guid[]; untestedWith?: Guid[] },
    label: string,
    mod: ModComponent,
    extra: Partial<ValidationIssue> = {},
  ): void => {
    for (const field of [...RELATION_FIELDS, "untestedWith"] as const) {
      for (const g of owner[field] ?? []) {
        if (!names.has(g)) {
          issues.push({
            severity: "error",
            code: "unknown-guid",
            message: `${label}: ${field} references unknown GUID ${g}`,
            modGuid: mod.guid,
            ...extra,
          });
        }
      }
    }
  };
  const checkPath = (raw: string, label: string, mod: ModComponent, extra: Partial<ValidationIssue>): void => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    if (containsPlaceholder(trimmed) || isAbsolutePath(trimmed)) return;
    issues.push({
      severity: "error",
      code: "missing-placeholder",
      message: `${label}: "${raw}" has no <<modDirectory>> / <<kotorDirectory>> placeholder`,
      modGuid: mod.guid,
      path: raw,
      ...extra,
    });
  };

  for (const mod of file.mods) {
    dup(mod.guid, `mod "${mod.name}"`, mod);
    checkRefs(mod, `"${mod.name}"`, mod);
    const checkInstruction = (instr: Instruction, option?: ModOption): void => {
      const extra = { optionGuid: option?.guid, instructionGuid: instr.guid };
      dup(instr.guid, `instruction ${instr.action} of "${mod.name}"`, mod, extra);
      checkRefs({ ...instr, installAfter: [], installBefore: [] }, `"${mod.name}" ${instr.action}`, mod, extra);
      const label = `"${mod.name}" ${instr.action}`;
      for (const s of instr.source) {
        if (instr.action === "Choose" && !/[\\/<]/.test(s)) continue; // option GUIDs
        checkPath(s, label, mod, extra);
      }
      if (instr.destination && instr.action !== "Rename") checkPath(instr.destination, label, mod, extra);
      if (instr.destination && instr.action === "Rename" && /[\\/]/.test(instr.destination)) checkPath(instr.destination, label, mod, extra);
    };
    for (const instr of mod.instructions) checkInstruction(instr);
    for (const option of mod.options) {
      dup(option.guid, `option "${option.name}" of "${mod.name}"`, mod, { optionGuid: option.guid });
      checkRefs(option, `Option "${option.name}" of "${mod.name}"`, mod, { optionGuid: option.guid });
      for (const instr of option.instructions) checkInstruction(instr, option);
    }
  }
}

/** Does `pattern` (an absolute pattern possibly with wildcards) refer to something under `dir`? */
function patternUnder(pattern: string, dir: string): boolean {
  const p = normalizePath(pattern);
  const d = normalizePath(dir);
  if (isInsideRoot(d, p)) return true;
  // A pattern like "/mods/Foo*/bar" covers "/mods/Foo v1" by prefix up to the wildcard.
  const wild = p.search(/[*?]/);
  if (wild === -1) return false;
  const prefix = p.slice(0, wild).toLowerCase();
  const dl = d.toLowerCase();
  return dl.startsWith(prefix) || prefix.startsWith(dl + "/") || prefix === dl;
}

/**
 * Validate an instruction file: constraints, order, static checks and a full
 * dry run over a VirtualFileSystem. Never writes to disk.
 */
export async function validate(
  fileInput: InstructionFile,
  settings: UserSettings,
  opts: ValidateOptions = {},
): Promise<ValidationReport> {
  const file = structuredClone(fileInput);
  const issues: ValidationIssue[] = [];
  const logger = opts.logger ?? NullLogger;

  staticChecks(file, issues);

  const selection = computeSelection(file, settings);
  issues.push(...checkSelectionConstraints(file, selection, settings.compatibilityLevel));
  const { order, issues: orderIssues } = computeInstallOrder(file, selection);
  issues.push(...orderIssues);

  const baseFs = opts.baseFs ?? new RealFileSystem();
  const vfs = new VirtualFileSystem(baseFs);
  const promptIssues = new Set<string>();
  const ctx: InstallContext = createInstallContext({
    settings,
    selection,
    fs: vfs,
    logger,
    dryRun: true,
    openArchive: opts.openArchive,
    patcher: opts.patcher,
    prompt: async (prompt: UserPrompt) => {
      const key = prompt.instructionGuid ?? prompt.id;
      if (!promptIssues.has(key)) {
        promptIssues.add(key);
        issues.push({
          severity: "info",
          code: "prompt-required",
          message: `${prompt.title}: the installer will ask "${prompt.message}" (${prompt.choices.length} choices)`,
          modGuid: prompt.modGuid,
          instructionGuid: prompt.instructionGuid,
        });
      }
      return autoAnswerPrompt(prompt);
    },
  });

  // Required downloads (Extract sources of selected mods), resolved against the untouched base.
  const requiredDownloads: RequiredDownload[] = [];
  const modByGuid = indexFile(file).mods; // first occurrence wins, like the selection
  for (const mod of selection.mods) {
    const instructions = [...mod.instructions, ...mod.options.filter((o) => selection.selectedGuids.has(o.guid)).flatMap((o) => o.instructions)];
    for (const instr of instructions) {
      if (instr.action !== "Extract") continue;
      for (const raw of instr.source) {
        let matched: string[];
        try {
          matched = await resolveWildcards(baseFs, ctx.resolver.resolve(raw));
        } catch {
          matched = [];
        }
        requiredDownloads.push({
          modGuid: mod.guid,
          modName: mod.name,
          pattern: raw,
          found: matched.length > 0,
          matchedFiles: matched,
          links: [...mod.modLink],
        });
      }
    }
  }

  // Dry run in install order.
  const staticMissingPlaceholder = new Set(
    issues.filter((i) => i.code === "missing-placeholder" && i.instructionGuid).map((i) => i.instructionGuid!),
  );
  const extractDirs: Array<{ dir: string; archive: string; mod: ModComponent; instruction: Instruction }> = [];
  const referencedPatterns: string[] = [];
  const noteReferences = async (instr: Instruction): Promise<void> => {
    if (instr.action === "Extract") return;
    for (const raw of instr.source) {
      try {
        referencedPatterns.push(ctx.resolver.resolve(raw));
      } catch {
        /* reported elsewhere */
      }
    }
    if (instr.destination) {
      try {
        referencedPatterns.push(ctx.resolver.resolve(instr.destination));
      } catch {
        /* reported elsewhere */
      }
    }
  };
  const runOne = async (mod: ModComponent, instr: Instruction, option?: ModOption): Promise<void> => {
    if (instr.action === "Extract" && !gateInstruction(ctx, instr, mod, option)) {
      try {
        const sources = await resolveSources(ctx, instr.source);
        for (const s of sources) {
          for (const archive of s.matches) {
            const dir = instr.destination?.trim() ? ctx.resolver.resolve(instr.destination) : defaultExtractDir(archive);
            extractDirs.push({ dir, archive, mod, instruction: instr });
          }
        }
      } catch {
        /* reported by the run */
      }
    } else {
      await noteReferences(instr);
    }
    const result = await executeInstruction(ctx, instr, mod, option);
    const issue = issueFromResult(result, instr, mod);
    if (!issue) return;
    if (issue.code === "path-escape" && staticMissingPlaceholder.has(instr.guid)) return;
    issues.push(issue);
  };

  const ran = new Set<Guid>();
  for (const guid of order) {
    const mod = modByGuid.get(guid);
    if (!mod || ran.has(guid)) continue;
    ran.add(guid);
    for (const instr of mod.instructions) await runOne(mod, instr);
    for (const option of mod.options) {
      if (!selection.selectedGuids.has(option.guid)) continue;
      for (const instr of option.instructions) await runOne(mod, instr, option);
    }
  }

  // Archives extracted but never used by anything.
  for (const ex of extractDirs) {
    const used = referencedPatterns.some((p) => patternUnder(p, ex.dir));
    if (!used) {
      issues.push({
        severity: "warning",
        code: "archive-not-referenced",
        message: `"${ex.mod.name}": "${ex.archive}" is extracted to "${ex.dir}" but no instruction uses that folder`,
        modGuid: ex.mod.guid,
        instructionGuid: ex.instruction.guid,
        path: ex.archive,
      });
    }
  }

  // Mods referencing an archive (or an expected archive) that no Extract handles.
  for (const mod of file.mods) {
    const allInstr = [...mod.instructions, ...mod.options.flatMap((o) => o.instructions)];
    const extractSources = allInstr.filter((i) => i.action === "Extract").flatMap((i) => i.source.map((s) => s.trim().replace(/\\/g, "/").toLowerCase()));
    const covered = (name: string): boolean => {
      const n = name.toLowerCase();
      return extractSources.some((s) => {
        const base = s.slice(s.lastIndexOf("/") + 1);
        if (base === n) return true;
        const re = new RegExp("^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
        return re.test(n);
      });
    };
    const report = (name: string, instructionGuid?: Guid): void => {
      issues.push({
        severity: "warning",
        code: "no-extract-for-archive",
        message: `"${mod.name}" references archive "${name}" but no Extract instruction extracts it`,
        modGuid: mod.guid,
        instructionGuid,
        path: name,
      });
    };
    for (const expected of mod.expectedFiles ?? []) {
      if (isArchiveExtension(expected) && !covered(expected)) report(expected);
    }
    for (const instr of allInstr) {
      if (instr.action === "Extract") continue;
      for (const s of instr.source) {
        const segments = s.replace(/\\/g, "/").split("/");
        for (const seg of segments) {
          if (isArchiveExtension(seg) && !/[*?]/.test(seg) && !covered(seg)) report(seg, instr.guid);
        }
      }
    }
  }

  const ok = !issues.some((i) => i.severity === "error");
  return { issues, ok, installOrder: order, requiredDownloads };
}
