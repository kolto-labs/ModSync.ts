/**
 * The structured "keyword step" grammar used by newer community guides:
 *
 *   1. **EXTRACT** `<<modDirectory>>/Foo*.zip`
 *   2. **MOVE ALL** from `<<modDirectory>>/Foo*∕*` to `<<kotorDirectory>>/Override`
 *   3. **MOVE SPECIFIC** from `<<modDirectory>>/Foo*∕` to `<<kotorDirectory>>/Override`:
 *      - a.dlg
 *      - b.dlg
 *   4. **DELETE** `<<kotorDirectory>>/Override/x.tga`
 *   5. **RENAME** `<<modDirectory>>/x/a.mdl` to `b.mdl`
 *   6. **PATCHER** `<<modDirectory>>/Foo*∕TSLPatcher.exe`
 *   7. **RUN** `<<modDirectory>>/setup.exe` with `/silent`
 *   8. **SKIP** `...` (free text, no instruction)
 *
 * Optional suffixes: `(do not overwrite)`, `_(requires {G}; conflicts {G}; Mobile only)_`
 * and ` — description`. Both the parser and the generator live here so the
 * two stay in sync.
 */
import { createInstruction } from "../../model/defaults.js";
import { isGuid, normalizeGuid, toBracedGuid } from "../../model/guid.js";
import type { ActionType, Guid, Instruction } from "../../model/types.js";
import { normalizeActionType } from "../normalize.js";

const STEP_RE = /^\s*(?:(?:\d+[.)])|[-*+])?\s*\*\*([A-Za-z][A-Za-z ]*?)\*\*:?\s*(.*)$/;
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const TOKEN_RE = /(?:\b(from|to|into|as|with|using)\s+)?`([^`]*)`/g;
const OVERWRITE_RE = /\((?:do not|don't|do not|no)\s+overwrite\)|\(skip existing\)/i;
const ANNOTATION_RE = /_\(([^)]*)\)_/;

export interface StepParseResult {
  instructions: Instruction[];
  /** Lines that were not steps (prose, SKIP notes). */
  prose: string[];
  warnings: string[];
}

/** True when the line starts a structured step (`**KEYWORD** ...`). */
export function isStepLine(line: string): boolean {
  const m = STEP_RE.exec(line);
  if (!m) return false;
  const kw = m[1].trim().toUpperCase();
  return kw === "SKIP" || normalizeActionType(kw) !== undefined;
}

function splitList(text: string): string[] {
  return text
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinDir(dir: string, name: string): string {
  if (/[\\/]$/.test(dir)) return dir + name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir + sep + name;
}

/**
 * Parse the lines of an "Installation Instructions" block. `guidFor(i)` provides
 * the GUID of the i-th parsed instruction (deterministic in the importer).
 */
export function parseStructuredSteps(lines: string[], guidFor: (index: number) => Guid): StepParseResult {
  const instructions: Instruction[] = [];
  const prose: string[] = [];
  const warnings: string[] = [];
  let collecting: { instr: Instruction; dir: string } | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const m = STEP_RE.exec(line);
    const keyword = m ? m[1].trim().toUpperCase() : undefined;
    const action = keyword ? (keyword === "SKIP" ? undefined : normalizeActionType(keyword)) : undefined;

    if (m && keyword === "SKIP") {
      collecting = undefined;
      prose.push(line.trim());
      continue;
    }
    if (m && action) {
      collecting = undefined;
      const instr = parseStepBody(action, keyword ?? "", m[2], guidFor(instructions.length), warnings);
      instructions.push(instr.instruction);
      if (instr.collectDir !== undefined) collecting = { instr: instr.instruction, dir: instr.collectDir };
      continue;
    }
    if (collecting) {
      const b = BULLET_RE.exec(line);
      if (b) {
        const item = b[1].replace(/^`|`$/g, "").trim();
        if (item) collecting.instr.source.push(joinDir(collecting.dir, item));
        continue;
      }
      if (line.trim() === "") continue;
      collecting = undefined;
    }
    prose.push(line);
  }
  return { instructions, prose: trimBlankLines(prose), warnings };
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

function parseStepBody(
  action: ActionType,
  keyword: string,
  body: string,
  guid: Guid,
  warnings: string[],
): { instruction: Instruction; collectDir?: string } {
  let text = body;
  let description: string | undefined;
  const dash = text.indexOf(" — ");
  if (dash >= 0) {
    description = text.slice(dash + 3).trim();
    text = text.slice(0, dash);
  }
  const instr = createInstruction(action, { guid });
  if (description) instr.description = description;
  if (OVERWRITE_RE.test(text)) instr.overwrite = false;
  const ann = ANNOTATION_RE.exec(text);
  if (ann) {
    for (const part of ann[1].split(";")) {
      const p = part.trim();
      let mm: RegExpExecArray | null;
      if ((mm = /^requires\s+(.+)$/i.exec(p))) instr.dependencies.push(...splitList(mm[1]).map(asGuid));
      else if ((mm = /^conflicts\s+(.+)$/i.exec(p))) instr.restrictions.push(...splitList(mm[1]).map(asGuid));
      else if ((mm = /^(PC|Mobile)\s+only$/i.exec(p))) instr.platform = mm[1].toLowerCase() === "pc" ? "PC" : "Mobile";
    }
    text = text.replace(ANNOTATION_RE, "");
  }

  const sources: string[] = [];
  let destination: string | undefined;
  let args: string | undefined;
  for (const t of text.matchAll(TOKEN_RE)) {
    const prep = (t[1] ?? "").toLowerCase();
    const value = t[2].trim();
    if (prep === "to" || prep === "into" || prep === "as") destination = value;
    else if (prep === "with" || prep === "using") args = value;
    else sources.push(value);
  }
  if (sources.length === 0) {
    // Unquoted paths: take the first path-looking word sequence.
    const bare = /(<<\w+>>[^\s,]*)/.exec(text);
    if (bare) sources.push(bare[1]);
    else warnings.push(`step "${keyword}" has no source path: ${body.trim()}`);
  }

  const mode = keyword.endsWith(" ALL") ? "all" : keyword.endsWith(" SPECIFIC") ? "specific" : "plain";
  let collectDir: string | undefined;
  if (mode === "all") {
    instr.source = sources.map((s) => (/\*$/.test(s) ? s : joinDir(s, "*")));
  } else if (mode === "specific") {
    collectDir = sources[0] ?? "";
    instr.source = [];
  } else {
    instr.source = sources;
  }
  if (destination !== undefined) instr.destination = destination;
  if (args !== undefined) instr.arguments = args;
  if (action === "Patcher" && instr.destination === undefined) instr.destination = "<<kotorDirectory>>";
  return { instruction: instr, collectDir };
}

function asGuid(s: string): string {
  return isGuid(s) ? normalizeGuid(s) : s;
}

const KEYWORDS: Record<ActionType, string> = {
  Unset: "UNSET",
  Run: "RUN",
  Extract: "EXTRACT",
  Move: "MOVE",
  Copy: "COPY",
  Delete: "DELETE",
  Rename: "RENAME",
  Execute: "RUN",
  Patcher: "PATCHER",
  Choose: "CHOOSE",
  DelDuplicate: "DELDUPLICATE",
  CleanList: "CLEANLIST",
  CreateDirectory: "CREATEDIRECTORY",
};

function tick(s: string): string {
  return "`" + s.replace(/`/g, "'") + "`";
}

function parentDir(p: string): string | undefined {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(0, idx + 1) : undefined;
}

/** Split sources into a common directory and base names when they all share a parent. */
export function commonParent(sources: string[]): { dir: string; names: string[] } | undefined {
  if (sources.length < 2) return undefined;
  const dir = parentDir(sources[0]);
  if (!dir) return undefined;
  const names: string[] = [];
  for (const s of sources) {
    if (parentDir(s) !== dir) return undefined;
    const name = s.slice(dir.length);
    if (!name) return undefined;
    names.push(name);
  }
  return { dir, names };
}

/** Render one instruction as structured step lines (first line + optional sub-bullets). */
export function formatStep(instr: Instruction, index: number): string[] {
  let keyword = KEYWORDS[instr.action];
  let sourceText: string;
  let bullets: string[] = [];
  const shared = instr.action === "Move" || instr.action === "Copy" ? commonParent(instr.source) : undefined;
  if ((instr.action === "Move" || instr.action === "Copy") && instr.source.length === 1 && /[\\/]\*$/.test(instr.source[0])) {
    keyword += " ALL";
    sourceText = "from " + tick(instr.source[0]);
  } else if (shared) {
    keyword += " SPECIFIC";
    sourceText = "from " + tick(shared.dir);
    bullets = shared.names;
  } else {
    sourceText = instr.source.map(tick).join(", ");
  }
  const parts = [sourceText];
  if (instr.destination !== undefined && !(instr.action === "Patcher" && instr.destination === "<<kotorDirectory>>")) {
    parts.push("to " + tick(instr.destination));
  }
  if (instr.arguments !== undefined) parts.push("with " + tick(instr.arguments));
  if (!instr.overwrite) parts.push("(do not overwrite)");
  const ann: string[] = [];
  if (instr.dependencies.length) ann.push("requires " + instr.dependencies.map(bracedOrRaw).join(", "));
  if (instr.restrictions.length) ann.push("conflicts " + instr.restrictions.map(bracedOrRaw).join(", "));
  if (instr.platform) ann.push(`${instr.platform} only`);
  if (ann.length) parts.push(`_(${ann.join("; ")})_`);
  let line = `${index}. **${keyword}** ${parts.join(" ")}`;
  if (bullets.length) line += ":";
  if (instr.description) line += ` — ${instr.description.replace(/\s*\n\s*/g, " ")}`;
  return [line, ...bullets.map((b) => `   - ${b}`)];
}

function bracedOrRaw(g: string): string {
  return isGuid(g) ? toBracedGuid(g) : g;
}
