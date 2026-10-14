/**
 * Lenient conversion between untyped records (as produced by the TOML / YAML
 * parsers or the line-based hidden-block parser) and the domain model, plus
 * the reverse mapping used by every serializer (PascalCase keys, braced
 * uppercase GUIDs, C# KOTORModSync style).
 */
import { isGuid, newGuid, normalizeGuid, toBracedGuid, tryNormalizeGuid } from "../model/guid.js";
import { createInstruction, createMainConfig, createMod, createOption } from "../model/defaults.js";
import {
  COMPATIBILITY_LEVELS,
  INSTALL_STATES,
  PATCHER_ENGINES,
  PLATFORMS,
  type CompatibilityLevel,
  type InstallState,
  type Instruction,
  type MainConfig,
  type ModComponent,
  type ModOption,
  type PatcherEngine,
  type Platform,
} from "../model/types.js";
import {
  normalizeActionType,
  normalizeCategories,
  normalizeInstallationMethod,
  normalizeTargetGame,
  normalizeTier,
  tierLabel,
} from "./normalize.js";

export type UnknownRecord = Record<string, unknown>;

export interface LenientContext {
  warnings: string[];
  /** Number of instructions that were missing a Guid (aggregated warning). */
  generatedInstructionGuids: number;
}

export function createLenientContext(): LenientContext {
  return { warnings: [], generatedInstructionGuids: 0 };
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A view over a record with case/punctuation-insensitive key lookup that
 * remembers which keys were consumed so the caller can report the rest.
 */
export class RecordView {
  private readonly byKey = new Map<string, { original: string; value: unknown }>();
  private readonly used = new Set<string>();

  constructor(private readonly sourceRecord: UnknownRecord) {
    for (const [k, v] of Object.entries(sourceRecord)) {
      const key = keyOf(k);
      if (!this.byKey.has(key)) this.byKey.set(key, { original: k, value: v });
    }
  }

  has(...names: string[]): boolean {
    return names.some((n) => this.byKey.has(keyOf(n)));
  }

  get(...names: string[]): unknown {
    for (const n of names) {
      const hit = this.byKey.get(keyOf(n));
      if (hit !== undefined) {
        this.used.add(keyOf(n));
        return hit.value;
      }
    }
    return undefined;
  }

  string(...names: string[]): string | undefined {
    const v = this.get(...names);
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v)) return v.map(String).join("\n");
    if (typeof v === "object") return undefined;
    return String(v);
  }

  bool(fallback: boolean, ...names: string[]): boolean {
    const v = this.get(...names);
    if (v === undefined || v === null) return fallback;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    if (["true", "yes", "1", "y", "on"].includes(s)) return true;
    if (["false", "no", "0", "n", "off", ""].includes(s)) return false;
    return fallback;
  }

  /** A string or array value normalized to an array of trimmed strings. */
  strings(...names: string[]): string[] {
    const v = this.get(...names);
    return toStringArray(v);
  }

  records(...names: string[]): UnknownRecord[] {
    const v = this.get(...names);
    if (Array.isArray(v)) return v.filter(isRecord);
    if (isRecord(v)) return [v];
    return [];
  }

  record(...names: string[]): UnknownRecord | undefined {
    const v = this.get(...names);
    return isRecord(v) ? v : undefined;
  }

  unusedRecord(): UnknownRecord {
    return Object.fromEntries(Object.entries(this.sourceRecord).filter(([key]) => !this.used.has(keyOf(key))));
  }

  unusedKeys(): string[] {
    const out: string[] = [];
    for (const [key, { original }] of this.byKey) if (!this.used.has(key)) out.push(original);
    return out;
  }
}

export function toStringArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && typeof x !== "object").map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "object") return [];
  const s = String(v).trim();
  return s ? [s] : [];
}

function guidList(view: RecordView, ctx: LenientContext, label: string, ...names: string[]): string[] {
  const out: string[] = [];
  for (const raw of view.strings(...names)) {
    if (isGuid(raw)) {
      const g = normalizeGuid(raw);
      if (!out.includes(g)) out.push(g);
    } else {
      ctx.warnings.push(`${label}: "${raw}" in ${names[0]} is not a GUID; kept as-is`);
      out.push(raw);
    }
  }
  return out;
}

function enumValue<T extends string>(values: readonly T[], raw: string | undefined): T | undefined {
  if (raw === undefined) return undefined;
  const key = keyOf(raw);
  return values.find((v) => keyOf(v) === key);
}

function preserveUnused(view: RecordView, ctx: LenientContext, label: string): UnknownRecord {
  const metadata = structuredClone(view.unusedRecord());
  for (const key of Object.keys(metadata)) ctx.warnings.push(`${label}: unknown key "${key}" preserved without execution support`);
  return metadata;
}

// ---------------------------------------------------------------------------
// record -> model
// ---------------------------------------------------------------------------

export function instructionFromRecord(rec: UnknownRecord, ctx: LenientContext, label: string): Instruction {
  const view = new RecordView(rec);
  const actionRaw = view.string("Action", "Type", "ActionType");
  const action = normalizeActionType(actionRaw);
  if (!action) {
    throw new Error(`${label}: unknown instruction action ${JSON.stringify(actionRaw ?? "")}`);
  }
  let guid: string;
  const rawGuid = view.string("Guid", "Id");
  if (rawGuid && isGuid(rawGuid)) guid = normalizeGuid(rawGuid);
  else {
    if (rawGuid) ctx.warnings.push(`${label}: invalid instruction Guid ${JSON.stringify(rawGuid)}; generated a new one`);
    else ctx.generatedInstructionGuids += 1;
    guid = newGuid();
  }
  const instr = createInstruction(action, {
    guid,
    source: view.strings("Source", "Sources", "Paths", "Path", "From"),
    overwrite: view.bool(true, "Overwrite"),
    dependencies: guidList(view, ctx, label, "Dependencies", "Dependency", "Requires"),
    restrictions: guidList(view, ctx, label, "Restrictions", "Restricted", "Restriction", "Conflicts"),
  });
  const destination = view.string("Destination", "Dest", "To", "Target");
  if (destination !== undefined && destination !== "") instr.destination = destination;
  const args = view.string("Arguments", "Args", "Argument");
  if (args !== undefined && args !== "") instr.arguments = args;
  const description = view.string("Description", "Desc");
  if (description) instr.description = description;
  const platform = enumValue(PLATFORMS, view.string("Platform"));
  if (platform) instr.platform = platform;
  // Legacy keys accepted but ignored on purpose.
  view.get("Patch");
  instr.metadata = preserveUnused(view, ctx, label);
  return instr;
}

function instructionList(view: RecordView, ctx: LenientContext, label: string): Instruction[] {
  return view.records("Instructions", "Instruction").map((r, i) => instructionFromRecord(r, ctx, `${label} instruction #${i + 1}`));
}

export function optionFromRecord(rec: UnknownRecord, ctx: LenientContext, parentLabel: string): ModOption {
  const view = new RecordView(rec);
  const name = view.string("Name") ?? "";
  const label = `${parentLabel} option "${name}"`;
  const rawGuid = view.string("Guid", "Id");
  let guid: string;
  if (rawGuid && isGuid(rawGuid)) guid = normalizeGuid(rawGuid);
  else {
    if (rawGuid) ctx.warnings.push(`${label}: invalid Guid ${JSON.stringify(rawGuid)}; generated a new one`);
    guid = newGuid();
  }
  const option = createOption({
    guid,
    name,
    dependencies: guidList(view, ctx, label, "Dependencies", "Dependency"),
    restrictions: guidList(view, ctx, label, "Restrictions", "Restricted", "Restriction"),
    installAfter: guidList(view, ctx, label, "InstallAfter"),
    installBefore: guidList(view, ctx, label, "InstallBefore"),
    instructions: instructionList(view, ctx, label),
    isSelected: view.bool(false, "IsSelected", "Selected"),
  });
  const description = view.string("Description");
  if (description) option.description = description;
  const directions = view.string("Directions");
  if (directions) option.directions = directions;
  const group = view.string("ExclusiveGroup", "Group");
  if (group) option.exclusiveGroup = group;
  option.metadata = preserveUnused(view, ctx, label);
  return option;
}

/** Split an author string ("A, B and C", "A & B") into individual authors. */
export function splitAuthors(text: string): string[] {
  return text
    .split(/\s*(?:,|&|\band\b|\/|;)\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

export function modFromRecord(rec: UnknownRecord, ctx: LenientContext, index: number): ModComponent {
  const view = new RecordView(rec);
  const name = view.string("Name") ?? "";
  const label = `mod "${name || `#${index + 1}`}"`;
  if (!name) ctx.warnings.push(`${label}: missing Name`);
  const rawGuid = view.string("Guid", "Id");
  let guid: string;
  if (rawGuid && isGuid(rawGuid)) guid = normalizeGuid(rawGuid);
  else {
    ctx.warnings.push(rawGuid ? `${label}: invalid Guid ${JSON.stringify(rawGuid)}; generated a new one` : `${label}: missing Guid; generated a new one`);
    guid = newGuid();
  }
  const authors: string[] = [];
  for (const a of view.strings("Authors", "Author")) for (const part of splitAuthors(a)) if (!authors.includes(part)) authors.push(part);

  const mod = createMod({
    guid,
    name,
    authors,
    modLink: view.strings("ModLink", "ModLinks", "Link", "Links", "Url"),
    category: normalizeCategories(view.strings("Category", "Categories")),
    tier: normalizeTier(view.string("Tier")),
    installationMethod: normalizeInstallationMethod(view.string("InstallationMethod", "InstallMethod", "Method")),
    dependencies: guidList(view, ctx, label, "Dependencies", "Dependency", "Masters"),
    restrictions: guidList(view, ctx, label, "Restrictions", "Restricted", "Restriction", "Incompatible"),
    installAfter: guidList(view, ctx, label, "InstallAfter"),
    installBefore: guidList(view, ctx, label, "InstallBefore"),
    untestedWith: guidList(view, ctx, label, "UntestedWith", "Untested"),
    instructions: instructionList(view, ctx, label),
    options: view.records("Options", "Option").map((r) => optionFromRecord(r, ctx, label)),
    isSelected: view.bool(false, "IsSelected", "Selected"),
    isDownloaded: view.bool(false, "IsDownloaded"),
    fullBuildOnly: view.bool(false, "FullBuildOnly"),
    isWidescreen: view.bool(false, "IsWidescreen", "Widescreen"),
    aspyrOnly: view.bool(false, "AspyrOnly"),
    isPatch: view.bool(false, "IsPatch", "Patch"),
  });
  const installState = enumValue(INSTALL_STATES, view.string("InstallState"));
  if (installState) mod.installState = installState as InstallState;
  const description = view.string("Description");
  if (description) mod.description = description;
  const directions = view.string("Directions");
  if (directions) mod.directions = directions;
  const language = view.string("Language", "NonEnglishFunctionality");
  if (language) mod.language = language;
  const warnings = view.string("UsageWarnings", "Warnings", "Warning");
  if (warnings) mod.usageWarnings = warnings;
  const expectedFiles = view.strings("ExpectedFiles", "ExpectedFile");
  if (expectedFiles.length) mod.expectedFiles = expectedFiles;
  const images = view.strings("Images", "Image");
  if (images.length) mod.images = images;
  const hashes = view.record("ExpectedHashes", "Hashes");
  if (hashes) {
    const table: Record<string, string> = {};
    for (const [k, v] of Object.entries(hashes)) if (typeof v === "string" || typeof v === "number") table[k] = String(v).toLowerCase();
    if (Object.keys(table).length) mod.expectedHashes = table;
  }
  const heading = view.get("HeadingLevel");
  if (typeof heading === "number" && Number.isInteger(heading)) mod.headingLevel = heading;
  const installOrder = view.get("InstallOrder");
  if (Array.isArray(installOrder)) {
    for (const g of toStringArray(installOrder)) {
      const n = tryNormalizeGuid(g);
      if (!mod.installAfter.includes(n)) mod.installAfter.push(n);
    }
    ctx.warnings.push(`${label}: legacy installOrder list treated as InstallAfter`);
  }
  mod.metadata = preserveUnused(view, ctx, label);
  return mod;
}

export function configFromRecord(rec: UnknownRecord | undefined, ctx: LenientContext): MainConfig {
  const config = createMainConfig();
  if (!rec) return config;
  const view = new RecordView(rec);
  const game = view.string("TargetGame", "Game");
  if (game !== undefined) config.targetGame = normalizeTargetGame(game);
  const set = (key: keyof MainConfig, ...names: string[]): void => {
    const v = view.string(...names);
    if (v !== undefined && v !== "") (config as unknown as Record<string, unknown>)[key] = v;
  };
  set("name", "Name", "Title");
  set("version", "Version");
  set("author", "Author");
  set("description", "Description");
  set("beforeModListContent", "BeforeModListContent", "BeforeModList");
  set("aspyrSectionContent", "AspyrSectionContent", "AspyrSection");
  set("widescreenSectionContent", "WidescreenSectionContent", "WidescreenSection");
  set("afterModListContent", "AfterModListContent", "AfterModList");
  set("sourceUrl", "SourceUrl", "Source");
  const compat = enumValue(COMPATIBILITY_LEVELS, view.string("CompatibilityLevel"));
  if (compat) config.compatibilityLevel = compat as CompatibilityLevel;
  const engine = enumValue(PATCHER_ENGINES, view.string("PatcherEngine", "Patcher"));
  if (engine) config.patcherEngine = engine as PatcherEngine;
  const platform = enumValue(PLATFORMS, view.string("Platform"));
  if (platform) config.platform = platform as Platform;
  config.spoilerFree = view.bool(false, "SpoilerFree");
  config.metadata = preserveUnused(view, ctx, "[Config]");
  return config;
}

// ---------------------------------------------------------------------------
// model -> record (PascalCase, braced upper GUIDs)
// ---------------------------------------------------------------------------

/** Metadata may round-trip, but must not override recognized parser fields. */
function extensionRecord(metadata: UnknownRecord | undefined, known: string[]): UnknownRecord {
  const keys = new Set(known.map(keyOf));
  for (const key of Object.keys(metadata ?? {})) {
    if (keys.has(keyOf(key))) throw new Error(`Extension metadata shadows serialized field ${key}`);
  }
  return structuredClone(metadata ?? {});
}

function braced(guid: string): string {
  return isGuid(guid) ? toBracedGuid(guid) : guid;
}

export function instructionToRecord(instr: Instruction): UnknownRecord {
  const rec: UnknownRecord = {
    ...extensionRecord(instr.metadata, ["Guid", "Id", "Action", "Type", "ActionType", "Description", "Desc", "Overwrite", "Source", "Sources", "Paths", "Path", "From", "Destination", "Dest", "To", "Target", "Arguments", "Args", "Argument", "Dependencies", "Dependency", "Requires", "Restrictions", "Restricted", "Restriction", "Conflicts", "Platform", "Patch"]),
    Guid: braced(instr.guid),
    Action: instr.action,
  };
  if (instr.description) rec.Description = instr.description;
  rec.Overwrite = instr.overwrite;
  rec.Source = instr.source;
  if (instr.destination !== undefined) rec.Destination = instr.destination;
  if (instr.arguments !== undefined) rec.Arguments = instr.arguments;
  if (instr.dependencies.length) rec.Dependencies = instr.dependencies.map(braced);
  if (instr.restrictions.length) rec.Restrictions = instr.restrictions.map(braced);
  if (instr.platform) rec.Platform = instr.platform;
  return rec;
}

export function optionToRecord(option: ModOption): UnknownRecord {
  const rec: UnknownRecord = {
    ...extensionRecord(option.metadata, ["Guid", "Id", "Name", "Description", "Directions", "Dependencies", "Dependency", "Restrictions", "Restricted", "Restriction", "InstallAfter", "InstallBefore", "IsSelected", "Selected", "ExclusiveGroup", "Group", "Instructions", "Instruction"]),
    Guid: braced(option.guid),
    Name: option.name,
  };
  if (option.description) rec.Description = option.description;
  if (option.directions) rec.Directions = option.directions;
  rec.Dependencies = option.dependencies.map(braced);
  rec.Restrictions = option.restrictions.map(braced);
  rec.InstallAfter = option.installAfter.map(braced);
  rec.InstallBefore = option.installBefore.map(braced);
  rec.IsSelected = option.isSelected;
  if (option.exclusiveGroup) rec.ExclusiveGroup = option.exclusiveGroup;
  rec.Instructions = option.instructions.map(instructionToRecord);
  return rec;
}

export function modToRecord(mod: ModComponent): UnknownRecord {
  const rec: UnknownRecord = {
    ...extensionRecord(mod.metadata, ["Guid", "Id", "Name", "Description", "Directions", "Authors", "Author", "Tier", "Category", "Categories", "Language", "NonEnglishFunctionality", "InstallationMethod", "InstallMethod", "Method", "ModLink", "ModLinks", "Link", "Links", "Url", "ExpectedFiles", "ExpectedFile", "ExpectedHashes", "Hashes", "Images", "Image", "UsageWarnings", "Warnings", "Warning", "Dependencies", "Dependency", "Masters", "Restrictions", "Restricted", "Restriction", "Incompatible", "InstallAfter", "InstallBefore", "UntestedWith", "Untested", "IsSelected", "Selected", "IsDownloaded", "InstallState", "FullBuildOnly", "IsWidescreen", "Widescreen", "AspyrOnly", "IsPatch", "Patch", "HeadingLevel", "InstallOrder", "Instructions", "Instruction", "Options", "Option"]),
    Guid: braced(mod.guid),
    Name: mod.name,
  };
  if (mod.description) rec.Description = mod.description;
  if (mod.directions) rec.Directions = mod.directions;
  if (mod.authors.length === 1) rec.Author = mod.authors[0];
  else rec.Authors = mod.authors;
  rec.Tier = tierLabel(mod.tier);
  rec.Category = mod.category;
  if (mod.language) rec.Language = mod.language;
  rec.InstallationMethod = mod.installationMethod;
  rec.ModLink = mod.modLink;
  if (mod.expectedFiles?.length) rec.ExpectedFiles = mod.expectedFiles;
  if (mod.expectedHashes && Object.keys(mod.expectedHashes).length) rec.ExpectedHashes = { ...mod.expectedHashes };
  if (mod.images?.length) rec.Images = mod.images;
  if (mod.usageWarnings) rec.UsageWarnings = mod.usageWarnings;
  rec.Dependencies = mod.dependencies.map(braced);
  rec.Restrictions = mod.restrictions.map(braced);
  rec.InstallAfter = mod.installAfter.map(braced);
  rec.InstallBefore = mod.installBefore.map(braced);
  if (mod.untestedWith.length) rec.UntestedWith = mod.untestedWith.map(braced);
  rec.IsSelected = mod.isSelected;
  if (mod.fullBuildOnly) rec.FullBuildOnly = true;
  if (mod.isWidescreen) rec.IsWidescreen = true;
  if (mod.aspyrOnly) rec.AspyrOnly = true;
  if (mod.isPatch) rec.IsPatch = true;
  if (mod.headingLevel !== undefined) rec.HeadingLevel = mod.headingLevel;
  rec.Instructions = mod.instructions.map(instructionToRecord);
  if (mod.options.length) rec.Options = mod.options.map(optionToRecord);
  return rec;
}

export function configToRecord(config: MainConfig): UnknownRecord {
  const rec: UnknownRecord = { ...extensionRecord(config.metadata, ["TargetGame", "Game", "Name", "Title", "Version", "Author", "Description", "SourceUrl", "Source", "CompatibilityLevel", "PatcherEngine", "Patcher", "SpoilerFree", "Platform", "BeforeModListContent", "BeforeModList", "AspyrSectionContent", "AspyrSection", "WidescreenSectionContent", "WidescreenSection", "AfterModListContent", "AfterModList"]), TargetGame: config.targetGame };
  if (config.name) rec.Name = config.name;
  if (config.version) rec.Version = config.version;
  if (config.author) rec.Author = config.author;
  if (config.description) rec.Description = config.description;
  if (config.sourceUrl) rec.SourceUrl = config.sourceUrl;
  rec.CompatibilityLevel = config.compatibilityLevel;
  rec.PatcherEngine = config.patcherEngine;
  rec.SpoilerFree = config.spoilerFree;
  rec.Platform = config.platform;
  if (config.beforeModListContent) rec.BeforeModListContent = config.beforeModListContent;
  if (config.aspyrSectionContent) rec.AspyrSectionContent = config.aspyrSectionContent;
  if (config.widescreenSectionContent) rec.WidescreenSectionContent = config.widescreenSectionContent;
  if (config.afterModListContent) rec.AfterModListContent = config.afterModListContent;
  return rec;
}

/** Flush the aggregated "instructions without Guid" note into the warnings list. */
export function finishLenient(ctx: LenientContext): string[] {
  if (ctx.generatedInstructionGuids > 0) {
    ctx.warnings.push(`${ctx.generatedInstructionGuids} instruction(s) had no Guid; new ones were generated`);
    ctx.generatedInstructionGuids = 0;
  }
  return ctx.warnings;
}
