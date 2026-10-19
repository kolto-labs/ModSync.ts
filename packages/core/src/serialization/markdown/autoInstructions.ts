/**
 * Heuristic instruction generation for guide entries that carry no structured
 * steps or hidden metadata. The result is a best guess and callers should warn.
 */
import { createInstruction } from "../../model/defaults.js";
import { PLACEHOLDER_KOTOR_DIRECTORY, PLACEHOLDER_MOD_DIRECTORY, type Instruction, type ModComponent } from "../../model/types.js";
import { detectInstallationHints } from "../normalize.js";
import { stableChildGuid } from "./stableGuid.js";

const ARCHIVE_EXT_RE = /\.(zip|rar|7z)$/i;
const EXE_EXT_RE = /\.exe$/i;
const AUTO_NOTE = "auto-generated";
const ARCHIVE_WORD_RE = /\.(zip|rar|7z)\b|\b(extract|unzip|unpack)\b/i;
const MAX_MULTI_RUNS = 12;
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const COUNT_TOKEN = "(\\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const RUN_TIMES_RE = new RegExp(`\\b(?:run|runs|running|execute|install|apply|patch)\\b[^.\\n]{0,60}?\\b${COUNT_TOKEN}\\s*(?:x\\b|times\\b)`, "i");
const RUN_COUNT_RE = new RegExp(`\\b${COUNT_TOKEN}\\s+(?:separate\\s+)?(?:runs|passes)\\b`, "i");
const RUN_TWICE_RE = /\b(?:run|execute|install|apply|patch)\b[^.\n]{0,60}?\btwice\b/i;
const DUPLICATE_EXT_RE = /\b(?:remov\w*|delet\w*|del)\s+(?:the\s+|all\s+)?duplicat\w*\s+\.?(tga|tpc)\b(?!\s*(?:\/|&|,|and\b|or\b)\s*\.?(?:tga|tpc)\b)/i;

function fileNameFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    return last || undefined;
  } catch {
    const last = url.split(/[\\/]/).pop();
    return last || undefined;
  }
}

/** Characters that cannot appear in file names. */
export function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, " ").trim();
}

/** Guide text that can name the script to run, the run count or a duplicate removal. */
function hintText(mod: ModComponent): string {
  return [mod.name, mod.description ?? "", mod.directions ?? ""].join("\n");
}

function toCount(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : (NUMBER_WORDS[token.toLowerCase()] ?? 0);
}

/** Number of patcher runs the guide asks for ("run 6 times"); undefined when not stated. */
export function detectRunCount(text: string): number | undefined {
  const m = RUN_TIMES_RE.exec(text) ?? RUN_COUNT_RE.exec(text);
  const count = m ? toCount(m[1]) : RUN_TWICE_RE.test(text) ? 2 : 0;
  return count >= 2 && count <= MAX_MULTI_RUNS ? count : undefined;
}

/** Extension named by "remove duplicate .tga" wording; undefined when absent or when both extensions are listed. */
function duplicateExtension(text: string): string | undefined {
  const m = DUPLICATE_EXT_RE.exec(text);
  return m ? `.${m[1].toLowerCase()}` : undefined;
}

export interface ArchiveGuess {
  /** Placeholder path (with wildcards) of the downloaded file. */
  pattern: string;
  /** Placeholder path of the folder the archive extracts into. */
  folder: string;
  /** True when the download itself is an executable installer. */
  isExecutable: boolean;
}

/**
 * Guess where the mod's download lands in the mod directory. A link or expected
 * file ending in `.exe` is an installer, not an archive. An Executable method
 * with no archive file or archive wording anywhere is also taken as an installer.
 */
export function guessArchive(mod: ModComponent): ArchiveGuess {
  const mdir = PLACEHOLDER_MOD_DIRECTORY + "\\";
  const fromExpected = (expected: string): ArchiveGuess => {
    const file = expected.includes("<<") ? expected : mdir + expected;
    return { pattern: file, folder: file.replace(/\.[^.\\/]+$/, ""), isExecutable: EXE_EXT_RE.test(expected) };
  };
  const listed = mod.expectedFiles?.find((f) => ARCHIVE_EXT_RE.test(f) || EXE_EXT_RE.test(f));
  if (listed) return fromExpected(listed);
  for (const link of mod.modLink) {
    const name = fileNameFromUrl(link);
    if (name && (ARCHIVE_EXT_RE.test(name) || EXE_EXT_RE.test(name))) {
      return { pattern: mdir + name, folder: mdir + name.replace(/\.[^.]+$/, ""), isExecutable: EXE_EXT_RE.test(name) };
    }
  }
  if (mod.expectedFiles?.[0]) return fromExpected(mod.expectedFiles[0]);
  const base = sanitizeFileName(mod.name) || "mod";
  if (mod.installationMethod === "Executable") {
    const text = hintText(mod);
    if (!detectInstallationHints(text).scriptExt && !ARCHIVE_WORD_RE.test(text)) {
      return { pattern: `${mdir}${base}*.exe`, folder: `${mdir}${base}*`, isExecutable: true };
    }
  }
  return { pattern: `${mdir}${base}*.{zip,rar,7z}`, folder: `${mdir}${base}*`, isExecutable: false };
}

/**
 * Generate instructions from the mod's installation method and links:
 * archive -> Extract; TSLPatcher/HoloPatcher -> Patcher (one per run for
 * "Multi-Run" guides that state the run count); Loose-File -> Move `*` to
 * Override; `.exe` downloads (no Extract) -> Execute; `.bat`/`.cmd`/`.sh`
 * methods -> Execute of the script (DelDuplicate for duplicate removal).
 */
export function generateInstructionsFromDescription(mod: ModComponent): Instruction[] {
  const out: Instruction[] = [];
  const guess = guessArchive(mod);
  const next = (partial: Partial<Instruction>): Instruction => {
    const instr = createInstruction(partial.action ?? "Extract", {
      ...partial,
      guid: stableChildGuid(mod.guid, "auto", out.length),
      description: partial.description ?? AUTO_NOTE,
    });
    out.push(instr);
    return instr;
  };
  const override = `${PLACEHOLDER_KOTOR_DIRECTORY}\\Override`;
  const method = mod.installationMethod;
  const hints = hintText(mod);
  const text = hints.toLowerCase();
  const { scriptExt, multiRun } = detectInstallationHints(hints);

  if (method === "Executable" && scriptExt && !guess.isExecutable) {
    const duplicateExt = duplicateExtension(hints);
    if (duplicateExt) {
      next({ action: "DelDuplicate", source: [override], arguments: duplicateExt });
      return out;
    }
    next({ action: "Extract", source: [guess.pattern] });
    next({ action: "Execute", source: [`${guess.folder}\\*.${scriptExt}`] });
    if (/loose|override/.test(text)) next({ action: "Move", source: [`${guess.folder}\\*`], destination: override });
    return out;
  }

  if (guess.isExecutable) {
    next({ action: "Execute", source: [guess.pattern] });
    return out;
  }

  next({ action: "Extract", source: [guess.pattern] });
  const patch = (): void => {
    const runs = detectRunCount(hints);
    if (runs) {
      for (let run = 0; run < runs; run++) {
        next({
          action: "Patcher",
          source: [guess.folder],
          destination: PLACEHOLDER_KOTOR_DIRECTORY,
          arguments: String(run),
          description: `${AUTO_NOTE}; multi-run ${run + 1} of ${runs} (namespace index ${run})`,
        });
      }
      return;
    }
    next({
      action: "Patcher",
      source: [guess.folder],
      destination: PLACEHOLDER_KOTOR_DIRECTORY,
      ...(multiRun ? { description: `${AUTO_NOTE}; multi-run: run count/options not stated in the guide, only one run emitted - review` } : {}),
    });
  };
  switch (method) {
    case "TSLPatcher":
    case "HoloPatcher":
      patch();
      break;
    case "Loose-File":
      next({ action: "Move", source: [`${guess.folder}\\*`], destination: override });
      break;
    case "Executable":
      next({ action: "Execute", source: [`${guess.folder}\\*.exe`] });
      break;
    case "Mixed":
      next({ action: "Patcher", source: [guess.folder], destination: PLACEHOLDER_KOTOR_DIRECTORY });
      break;
    default:
      if (/tslpatcher|holopatcher/.test(text)) patch();
      else if (/override/.test(text)) next({ action: "Move", source: [`${guess.folder}\\*`], destination: override });
      break;
  }
  return out;
}
