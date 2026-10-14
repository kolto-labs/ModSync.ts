/**
 * Importer for the KOTOR community modbuild guides (r/kotor `full.md`,
 * DeadlyStream markdown). See docs/PLAN.md "serialization/" for the contract.
 */
import { createMod, createOption } from "../../model/defaults.js";
import { isGuid, normalizeGuid } from "../../model/guid.js";
import type { Guid, InstructionFile, ModComponent, ModOption, TargetGame } from "../../model/types.js";
import {
  configFromRecord,
  createLenientContext,
  finishLenient,
  modFromRecord,
  splitAuthors,
  type LenientContext,
  type UnknownRecord,
} from "../lenient.js";
import { normalizeCategories, normalizeInstallationMethod, normalizeTargetGame, normalizeTier, parseCategoryAndTier } from "../normalize.js";
import { generateInstructionsFromDescription } from "./autoInstructions.js";
import { extractHtmlComments, findHiddenConfigRecord, findHiddenModRecord, MODSYNC_CONFIG_MARKER } from "./hidden.js";
import { normalizeNameForGuid, stableChildGuid, stableGuidForName } from "./stableGuid.js";
import { parseStructuredSteps } from "./steps.js";

export interface MarkdownImportProfile {
  /** Override the detected target game. */
  targetGame?: TargetGame;
  /** Recorded in `config.sourceUrl`. */
  sourceUrl?: string;
  /** Heading that starts the mod list (default: /mod\s*list/i). */
  modListHeading?: RegExp;
  /** Force the heading level of mod entries (2 or 3). Detected otherwise. */
  modHeadingLevel?: number;
  /** Generate heuristic instructions for mods that have none (default true). */
  autoInstructions?: boolean;
}

export interface MarkdownImportResult {
  file: InstructionFile;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Sectioning
// ---------------------------------------------------------------------------

interface Section {
  level: number;
  title: string;
  /** Raw heading line (for verbatim re-emission). */
  headingLine: string;
  lines: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LABEL_RE = /^\s*\*\*([^*\n]+?)\s*:\s*\*\*\s*(.*)$|^\s*\*\*([^*\n:]+?)\*\*\s*:\s*(.*)$/;
const STEP_HEAD_RE = /^\s*(?:(?:\d+[.)])|[-*+])?\s*\*\*[A-Za-z][A-Za-z ]*?\*\*/;
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function splitSections(md: string): Section[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const sections: Section[] = [{ level: 0, title: "", headingLine: "", lines: [] }];
  let inFence = false;
  let inComment = false;
  for (const line of lines) {
    const current = sections[sections.length - 1];
    if (!inComment && /^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      if (inComment) {
        if (line.includes("-->")) inComment = false;
        current.lines.push(line);
        continue;
      }
      const open = line.lastIndexOf("<!--");
      if (open >= 0 && line.indexOf("-->", open) < 0) inComment = true;
      const m = !inComment ? HEADING_RE.exec(line) : null;
      if (m && open < 0) {
        sections.push({ level: m[1].length, title: m[2].trim(), headingLine: line, lines: [] });
        continue;
      }
    }
    current.lines.push(line);
  }
  return sections;
}

interface LabelEntry {
  key: string;
  label: string;
  lines: string[];
}

function labelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isLabelLine(line: string): RegExpExecArray | null {
  if (STEP_HEAD_RE.test(line) && !LABEL_RE.test(line)) return null;
  const m = LABEL_RE.exec(line);
  if (!m) return null;
  // `**MOVE SPECIFIC** from x to y:` is a step, not a label.
  const label = (m[1] ?? m[3]).trim();
  if (/^[A-Z][A-Z ]+$/.test(label) && /\b(EXTRACT|MOVE|COPY|DELETE|RENAME|RUN|PATCHER|SKIP|CHOOSE|EXECUTE)\b/.test(label)) return null;
  return m;
}

/** Split a mod body into leading free text and label entries (values continue until the next label). */
function parseLabels(lines: string[]): { leading: string[]; entries: LabelEntry[] } {
  const leading: string[] = [];
  const entries: LabelEntry[] = [];
  let current: LabelEntry | undefined;
  for (const line of normalizeAdmonitions(lines)) {
    const m = isLabelLine(line);
    if (m) {
      const label = (m[1] ?? m[3]).trim();
      const rest = (m[2] ?? m[4] ?? "").trim();
      current = { key: labelKey(label), label, lines: rest ? [rest] : [] };
      entries.push(current);
    } else if (current) current.lines.push(line);
    else leading.push(line);
  }
  return { leading, entries };
}

/** Convert community-guide admonitions into field boundaries before parsing metadata. */
function normalizeAdmonitions(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*:::(?:note|warning|tip|danger|info)\s*$/i.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    let titleIndex = i + 1;
    while (titleIndex < lines.length && !lines[titleIndex].trim()) titleIndex++;
    const title = lines[titleIndex]?.trim();
    if (!title || title.startsWith(":")) { out.push(lines[i]); continue; }
    const end = lines.findIndex((line, index) => index > titleIndex && /^\s*:::\s*$/.test(line));
    if (end < 0) { out.push(lines[i]); continue; }
    out.push(`**${title.replace(/\*/g, "")}:**`);
    for (const line of lines.slice(titleIndex + 1, end)) out.push(line.replace(/^\s*:\s{0,3}/, ""));
    i = end;
  }
  return out;
}

function trimLines(lines: string[]): string {
  return lines.join("\n").replace(/^\s*\n/, "").replace(/\s+$/, "");
}

function stripMarkdown(text: string): string {
  return text
    .replace(LINK_RE, "$1")
    .replace(/(\*\*|__|\*|_)(.*?)\1/g, "$2")
    .replace(/`/g, "")
    .trim();
}

function extractLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LINK_RE)) if (!out.includes(m[2])) out.push(m[2]);
  for (const m of text.matchAll(/(?<![(\]])\bhttps?:\/\/[^\s)>]+/g)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

function splitNames(text: string): string[] {
  return stripMarkdown(text)
    .split(/\s*(?:,|;|\band\b|&|\n)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s && !/^(n\/?a|none|-|no)$/i.test(s));
}

function yes(text: string): boolean {
  return /^(yes|true|y|1|required)\b/i.test(text.trim());
}

function appendText(existing: string | undefined, extra: string): string {
  return existing ? `${existing}\n\n${extra}` : extra;
}

// ---------------------------------------------------------------------------
// Mod entry
// ---------------------------------------------------------------------------

interface PendingMod {
  mod: ModComponent;
  /** Names to resolve against other mods, by target list. */
  refs: Array<{ list: "dependencies" | "restrictions" | "installAfter" | "installBefore" | "untestedWith"; names: string[] }>;
  hadInstructions: boolean;
}

interface ParseState {
  ctx: LenientContext;
  warnings: string[];
  autoInstructions: boolean;
  usedGuids: Map<Guid, string>;
}

function parseModSection(section: Section, state: ParseState, isWidescreen: boolean): PendingMod {
  const { text, comments } = extractHtmlComments(section.lines.join("\n"));
  const headingLinks = extractLinks(section.title);
  const name = stripMarkdown(section.title);
  const modLabel = `mod "${name}"`;

  // Hidden metadata (either dialect).
  const hidden = findHiddenModRecord(comments);
  if (hidden.error) state.warnings.push(`${modLabel}: ${hidden.error}`);

  let mod: ModComponent;
  let guid: Guid | undefined;
  if (hidden.record) {
    const rec: UnknownRecord = { ...hidden.record };
    const guidKey = Object.keys(rec).find((k) => k.toLowerCase() === "guid");
    const rawGuid = guidKey ? rec[guidKey] : undefined;
    if (typeof rawGuid === "string" && isGuid(rawGuid)) guid = normalizeGuid(rawGuid);
    else if (rawGuid !== undefined) state.warnings.push(`${modLabel}: invalid hidden Guid ${JSON.stringify(rawGuid)}`);
    if (guidKey) delete rec[guidKey];
    if (!Object.keys(rec).some((k) => k.toLowerCase() === "name")) rec.Name = name;
    rec.Guid = guid ?? uniqueStableGuid(name, state);
    injectStableGuids(rec, rec.Guid as Guid);
    const before = state.ctx.warnings.length;
    mod = modFromRecord(rec, state.ctx, 0);
    // Re-label lenient warnings with the mod name.
    for (let i = before; i < state.ctx.warnings.length; i++) state.ctx.warnings[i] = state.ctx.warnings[i].replace(/^mod "[^"]*"/, `${modLabel} (hidden block)`);
    if (!guid) guid = mod.guid;
  } else {
    guid = uniqueStableGuid(name, state);
    mod = createMod({ guid, name });
  }
  state.usedGuids.set(guid, name);
  if (!mod.name) mod.name = name;
  mod.headingLevel = section.level;
  if (isWidescreen) mod.isWidescreen = true;
  for (const link of headingLinks) if (!mod.modLink.includes(link)) mod.modLink.push(link);

  const { leading, entries } = parseLabels(text.split("\n"));
  const leadingText = trimLines(leading);
  if (leadingText) mod.directions = appendText(undefined, leadingText);

  const pending: PendingMod = { mod, refs: [], hadInstructions: mod.instructions.length > 0 };
  const stepsFromLabels: string[] = [];
  const options: ModOption[] = [];
  let sawCategoryTier = false;

  for (const entry of entries) {
    const value = trimLines(entry.lines);
    const first = entry.lines[0] ?? "";
    switch (entry.key) {
      case "name": {
        for (const link of extractLinks(value)) if (!mod.modLink.includes(link)) mod.modLink.push(link);
        const plain = stripMarkdown(first);
        if (!mod.name && plain) mod.name = plain;
        break;
      }
      case "author":
      case "authors": {
        for (const a of splitAuthors(stripMarkdown(value))) if (a && !mod.authors.includes(a)) mod.authors.push(a);
        break;
      }
      case "description":
        mod.description = value;
        break;
      case "categorytier":
      case "categoryandtier":
      case "categoriestier": {
        const ct = parseCategoryAndTier(value);
        mod.category = ct.category;
        mod.tier = ct.tier;
        sawCategoryTier = true;
        break;
      }
      case "category":
      case "categories":
        mod.category = normalizeCategories(value);
        break;
      case "tier":
        mod.tier = normalizeTier(value);
        break;
      case "nonenglishfunctionality":
      case "language":
      case "languages":
        mod.language = value;
        break;
      case "installationmethod":
      case "installmethod":
      case "method":
        mod.installationMethod = normalizeInstallationMethod(value);
        break;
      case "masters":
      case "dependencies":
      case "requires":
      case "requirements":
        pending.refs.push({ list: "dependencies", names: splitNames(value) });
        break;
      case "restrictions":
      case "incompatible":
      case "incompatiblewith":
      case "conflicts":
        pending.refs.push({ list: "restrictions", names: splitNames(value) });
        break;
      case "installafter":
        pending.refs.push({ list: "installAfter", names: splitNames(value) });
        break;
      case "installbefore":
        pending.refs.push({ list: "installBefore", names: splitNames(value) });
        break;
      case "untestedwith":
        pending.refs.push({ list: "untestedWith", names: splitNames(value) });
        break;
      case "installationinstructions":
      case "installinstructions":
      case "instructions":
      case "installation":
        stepsFromLabels.push(...entry.lines);
        break;
      case "usagewarnings":
      case "usagewarning":
      case "warnings":
      case "warning":
      case "compatibilitywarnings":
      case "incompatibilities":
      case "knownissues":
        mod.usageWarnings = appendText(mod.usageWarnings, value);
        break;
      case "link":
      case "links":
      case "download":
      case "downloads":
      case "modlink":
        for (const link of extractLinks(value)) if (!mod.modLink.includes(link)) mod.modLink.push(link);
        break;
      case "expectedfiles":
        mod.expectedFiles = value.split(/\s*,\s*|\n/).map((s) => s.replace(/^`|`$/g, "").trim()).filter(Boolean);
        break;
      case "flags": {
        const flags = value.toLowerCase();
        if (/full[- ]?build[- ]?only/.test(flags)) mod.fullBuildOnly = true;
        if (/aspyr[- ]?only/.test(flags)) mod.aspyrOnly = true;
        if (/\bpatch\b/.test(flags)) mod.isPatch = true;
        if (/widescreen/.test(flags)) mod.isWidescreen = true;
        break;
      }
      case "aspyronly":
      case "steamaspyronly":
        mod.aspyrOnly = yes(value);
        break;
      case "fullbuildonly":
        mod.fullBuildOnly = yes(value);
        break;
      case "patch":
      case "ispatch":
        mod.isPatch = yes(value);
        break;
      case "option":
      case "options": {
        const option = parseOptionEntry(entry, mod, options.length, state);
        options.push(option);
        break;
      }
      default:
        mod.directions = appendText(mod.directions, `**${entry.label}:** ${value}`.trim());
        break;
    }
  }
  if (!sawCategoryTier && mod.tier === "Unknown" && mod.category.length === 0 && !hidden.record) {
    state.warnings.push(`${modLabel}: no "Category & Tier" label`);
  }

  // Instructions: hidden block wins, then structured steps, then heuristics.
  const parsed = parseStructuredSteps(stepsFromLabels, (i) => stableChildGuid(guid ?? mod.guid, "instruction", i));
  for (const w of parsed.warnings) state.warnings.push(`${modLabel}: ${w}`);
  if (!pending.hadInstructions && parsed.instructions.length) {
    mod.instructions = parsed.instructions;
    pending.hadInstructions = true;
  }
  if (parsed.prose.length) mod.directions = appendText(mod.directions, parsed.prose.join("\n"));
  if (!pending.hadInstructions && state.autoInstructions) {
    mod.instructions = generateInstructionsFromDescription(mod);
    state.warnings.push(`${modLabel}: instructions auto-generated from installation method and links`);
  }
  if (options.length && mod.options.length === 0) mod.options = options;
  return pending;
}

function parseOptionEntry(entry: LabelEntry, mod: ModComponent, index: number, state: ParseState): ModOption {
  const first = entry.lines[0] ?? "";
  let name = first;
  let description: string | undefined;
  const dash = first.indexOf(" — ");
  if (dash >= 0) {
    name = first.slice(0, dash);
    description = first.slice(dash + 3).trim();
  }
  name = stripMarkdown(name);
  const guid = stableChildGuid(mod.guid, "option", index);
  const parsed = parseStructuredSteps(entry.lines.slice(1), (i) => stableChildGuid(guid, "instruction", i));
  for (const w of parsed.warnings) state.warnings.push(`mod "${mod.name}" option "${name}": ${w}`);
  const option = createOption({ guid, name, instructions: parsed.instructions });
  if (description) option.description = description;
  if (parsed.prose.length) option.directions = parsed.prose.join("\n");
  return option;
}

function findKey(rec: UnknownRecord, name: string): string | undefined {
  return Object.keys(rec).find((k) => k.toLowerCase() === name);
}

/** Give GUID-less instructions/options of a hidden record deterministic GUIDs derived from the parent. */
function injectStableGuids(rec: UnknownRecord, parentGuid: Guid): void {
  const children = (key: string): UnknownRecord[] => {
    const k = findKey(rec, key);
    const v = k ? rec[k] : undefined;
    return Array.isArray(v) ? v.filter((x): x is UnknownRecord => typeof x === "object" && x !== null && !Array.isArray(x)) : [];
  };
  [...children("instructions"), ...children("instruction")].forEach((instr, i) => {
    const k = findKey(instr, "guid");
    if (!k || !isGuid(String(instr[k]))) instr[k ?? "Guid"] = stableChildGuid(parentGuid, "instruction", i);
  });
  [...children("options"), ...children("option")].forEach((opt, i) => {
    const k = findKey(opt, "guid");
    if (!k || !isGuid(String(opt[k]))) opt[k ?? "Guid"] = stableChildGuid(parentGuid, "option", i);
    injectStableGuids(opt, String(opt[k ?? "Guid"]));
  });
}

function uniqueStableGuid(name: string, state: ParseState): Guid {
  let guid = stableGuidForName(name);
  let n = 1;
  while (state.usedGuids.has(guid)) {
    n += 1;
    guid = stableGuidForName(name, String(n));
    if (n === 2) state.warnings.push(`duplicate mod name "${name}"; later entry received a derived GUID`);
  }
  return guid;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

function sectionText(section: Section): string {
  return [section.headingLine, ...section.lines].join("\n").trim();
}

const STRONG_LABELS = new Set([
  "name",
  "author",
  "authors",
  "description",
  "categorytier",
  "categoryandtier",
  "installationmethod",
  "installationinstructions",
  "masters",
  "nonenglishfunctionality",
]);

function isModSection(section: Section): boolean {
  const { text, comments } = extractHtmlComments(section.lines.join("\n"));
  if (findHiddenModRecord(comments).record) return true;
  return text.split("\n").some((l) => {
    const m = isLabelLine(l);
    return m !== null && STRONG_LABELS.has(labelKey((m[1] ?? m[3]).trim()));
  });
}

/** Parse a community modbuild guide into an instruction file. */
export function parseMarkdownBuild(md: string, profile: MarkdownImportProfile = {}): MarkdownImportResult {
  const state: ParseState = {
    ctx: createLenientContext(),
    warnings: [],
    autoInstructions: profile.autoInstructions ?? true,
    usedGuids: new Map(),
  };
  const modListRe = profile.modListHeading ?? /^\s*mod\s*list\b/i;
  const sections = splitSections(md.replace(/^﻿/, ""));

  // Title and mod list boundaries.
  const titleIdx = sections.findIndex((s) => s.level === 1);
  let modListIdx = sections.findIndex((s) => s.level > 0 && modListRe.test(stripMarkdown(s.title)));
  const hasListHeading = modListIdx >= 0;

  // Mod heading level.
  let modLevel = profile.modHeadingLevel;
  if (modLevel === undefined) {
    const firstMod =
      sections.find((s, i) => i > Math.max(modListIdx, titleIdx, 0) && s.level > 0 && isModSection(s)) ??
      sections.find((s) => s.level > 0 && isModSection(s));
    modLevel = firstMod?.level ?? 3;
  }
  if (!hasListHeading) {
    // Without a list heading the list starts at the first mod entry.
    modListIdx = sections.findIndex((s, i) => i > 0 && s.level > 0 && s.level <= modLevel && isModSection(s));
    if (modListIdx < 0) modListIdx = sections.length;
  }

  // Merge headings deeper than the mod level into their parent section.
  const merged: Section[] = [];
  let listStart = -1;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (i > modListIdx && s.level > modLevel && merged.length) {
      const parent = merged[merged.length - 1];
      parent.lines.push(s.headingLine, ...s.lines);
      continue;
    }
    if (i === modListIdx) listStart = merged.length;
    merged.push({ ...s, lines: [...s.lines] });
  }
  if (listStart < 0) listStart = merged.length;

  // Version-specific fix packages may precede the main Mod List in community guides.
  const aspyrStart = hasListHeading ? merged.findIndex((section, index) => index < listStart && section.level === 2 &&
    (/aspyr/i.test(section.title) || (/^critical:/i.test(section.title) && /aspyr/i.test(section.lines.join("\n"))))) : -1;
  const aspyrEnd = aspyrStart < 0 ? -1 : merged.findIndex((section, index) => index > aspyrStart && section.level <= 2);
  const aspyrBoundary = aspyrEnd < 0 ? listStart : aspyrEnd;
  const aspyrMods = aspyrStart < 0 ? [] : merged.slice(aspyrStart + 1, aspyrBoundary).filter(isModSection);

  // Before-content: everything after the title heading up to the mod list heading.
  const beforeParts: string[] = [];
  for (let i = 0; i < listStart; i++) {
    const s = merged[i];
    if (aspyrMods.length && i >= aspyrStart && i < aspyrBoundary) continue;
    if (i === titleIdx) beforeParts.push(s.lines.join("\n"));
    else beforeParts.push(sectionText(s));
  }
  const configCommentRe = new RegExp(`<!--\\s*${MODSYNC_CONFIG_MARKER.replace(/[<>:]/g, "\\$&")}[\\s\\S]*?-->`);
  let beforeRaw = beforeParts.join("\n\n");
  const listIntro = hasListHeading ? merged[listStart].lines.join("\n") : "";
  const { comments: preComments } = extractHtmlComments(beforeRaw + "\n" + listIntro);
  const hiddenConfig = findHiddenConfigRecord(preComments);
  if (hiddenConfig.error) state.warnings.push(hiddenConfig.error);
  beforeRaw = beforeRaw.replace(configCommentRe, "");
  // The mod list heading's own body (intro text) also belongs before the mods.
  const intro = listIntro.replace(configCommentRe, "").trim();
  if (intro) beforeRaw = [beforeRaw.trim(), intro].filter(Boolean).join("\n\n");

  const pendings: PendingMod[] = aspyrMods.map((section) => {
    const pending = parseModSection(section, state, false);
    pending.mod.aspyrOnly = true;
    return pending;
  });
  const afterParts: string[] = [];
  let aspyr: string | undefined = aspyrMods.length ? sectionText(merged[aspyrStart]) : undefined;
  let widescreen: string | undefined;
  let inWidescreen = false;
  const orphan: Section[] = [];
  const listSections = merged.slice(hasListHeading ? listStart + 1 : listStart);

  for (const s of listSections) {
    if (isModSection(s)) {
      for (const o of orphan) state.warnings.push(`section "${o.title}" between mods is not supported and was dropped`);
      orphan.length = 0;
      pendings.push(parseModSection(s, state, inWidescreen));
      continue;
    }
    const title = stripMarkdown(s.title);
    if (/aspyr/i.test(title) && aspyr === undefined) {
      aspyr = sectionText(s);
    } else if (/widescreen/i.test(title) && widescreen === undefined) {
      widescreen = sectionText(s);
      inWidescreen = true;
    } else orphan.push(s);
  }
  for (const o of orphan) afterParts.push(sectionText(o));

  // Resolve name references.
  const byName = new Map<string, Guid>();
  for (const p of pendings) byName.set(normalizeNameForGuid(p.mod.name), p.mod.guid);
  const resolve = (name: string): Guid | undefined => {
    if (isGuid(name)) return normalizeGuid(name);
    const key = normalizeNameForGuid(name);
    const exact = byName.get(key);
    if (exact) return exact;
    const candidates = [...byName.entries()].filter(([k]) => k.includes(key) || key.includes(k));
    return candidates.length === 1 ? candidates[0][1] : undefined;
  };
  for (const p of pendings) {
    for (const ref of p.refs) {
      const unresolved: string[] = [];
      for (const n of ref.names) {
        const g = resolve(n);
        if (g && g !== p.mod.guid) {
          if (!p.mod[ref.list].includes(g)) p.mod[ref.list].push(g);
        } else if (!g) unresolved.push(n);
      }
      if (unresolved.length) {
        state.warnings.push(`mod "${p.mod.name}": unresolved ${ref.list} ${unresolved.map((u) => JSON.stringify(u)).join(", ")}`);
        const label = ref.list === "dependencies" ? "Masters" : ref.list;
        p.mod.usageWarnings = appendText(p.mod.usageWarnings, `${label} (unresolved): ${unresolved.join(", ")}`);
      }
    }
  }

  // Config.
  const config = configFromRecord(hiddenConfig.record, state.ctx);
  const title = titleIdx >= 0 ? stripMarkdown(sections[titleIdx].title) : undefined;
  if (title && !config.name) config.name = title;
  if (profile.targetGame) config.targetGame = profile.targetGame;
  else if (config.targetGame === "Unknown") {
    config.targetGame = normalizeTargetGame(title);
    if (config.targetGame === "Unknown") config.targetGame = normalizeTargetGame(beforeRaw.slice(0, 4000));
  }
  if (profile.sourceUrl) config.sourceUrl = profile.sourceUrl;
  const before = beforeRaw.trim();
  if (before) config.beforeModListContent = before;
  if (aspyr) config.aspyrSectionContent = aspyr;
  if (widescreen) config.widescreenSectionContent = widescreen;
  const after = afterParts.join("\n\n").trim();
  if (after) config.afterModListContent = after;

  const mods = pendings.map((p) => p.mod);
  if (mods.length === 0) state.warnings.push("no mod entries found");
  const warnings = [...finishLenient(state.ctx), ...state.warnings];
  return { file: { config, mods }, warnings };
}
