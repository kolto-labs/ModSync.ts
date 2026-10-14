/**
 * Generate community-guide style markdown from an instruction file.
 *
 *  - "structured": labels + keyword steps (round-trips through the parser).
 *  - "deadlystream": structured plus a hidden `<!--<<ModSync>>` YAML block per
 *    mod (exact round trip including GUIDs and option metadata).
 *  - "reddit": the classic prose format, no hidden blocks (instructions are
 *    described in prose and re-imported heuristically).
 */
import { stringify as stringifyYaml } from "yaml";
import { isGuid, toBracedGuid } from "../../model/guid.js";
import type { Guid, Instruction, InstructionFile, ModComponent, ModOption } from "../../model/types.js";
import { configToRecord, modToRecord, type UnknownRecord } from "../lenient.js";
import { tierLabel } from "../normalize.js";
import { MODSYNC_CONFIG_MARKER, MODSYNC_MARKER } from "./hidden.js";
import { commonParent, formatStep } from "./steps.js";

export type MarkdownStyle = "reddit" | "deadlystream" | "structured";

function tick(s: string): string {
  return "`" + s.replace(/`/g, "'") + "`";
}

function listSources(sources: string[]): string {
  if (sources.length === 1 && /[\\/]\*$/.test(sources[0])) return `everything in ${tick(sources[0].replace(/[\\/]\*$/, ""))}`;
  if (sources.length >= 5) {
    const shared = commonParent(sources);
    if (shared) return `everything in ${tick(shared.dir.replace(/[\\/]$/, ""))}`;
    return `everything in ${tick(sources[0])} and ${sources.length - 1} more`;
  }
  if (sources.length === 0) return "(nothing)";
  return sources.map(tick).join(", ");
}

/** One sentence describing an instruction for human readers. */
export function describeInstruction(instr: Instruction, mod: ModComponent): string {
  const srcs = listSources(instr.source);
  const dest = instr.destination !== undefined ? tick(instr.destination) : undefined;
  let text: string;
  switch (instr.action) {
    case "Unset":
      text = "Choose an action for this instruction";
      break;
    case "CreateDirectory":
      text = `Create directory ${dest ?? "(unspecified)"}`;
      break;
    case "Extract":
      text = `Extract ${srcs}` + (dest ? ` into ${dest}` : "");
      break;
    case "Move":
    case "Copy":
      text = `${instr.action} ${srcs} to ${dest ?? tick("<<kotorDirectory>>\\Override")}` + (instr.overwrite ? "" : ", without overwriting existing files");
      break;
    case "Delete":
      text = `Delete ${srcs}`;
      break;
    case "Rename":
      text = `Rename ${srcs} to ${dest ?? "(unspecified)"}`;
      break;
    case "Run":
    case "Execute":
      text = `Run ${srcs}` + (instr.arguments ? ` with arguments ${tick(instr.arguments)}` : "");
      break;
    case "Patcher":
      text = `Install with TSLPatcher/HoloPatcher from ${srcs}` + (instr.arguments ? ` (option ${tick(instr.arguments)})` : "") + (dest ? ` into ${dest}` : "");
      break;
    case "Choose": {
      const names = instr.source.map((s) => {
        if (!isGuid(s)) return tick(s);
        const opt = mod.options.find((o) => o.guid === s);
        return opt ? `"${opt.name}"` : tick(s);
      });
      text = `Choose one of ${names.join(", ")}` + (dest ? ` and move it to ${dest}` : "");
      break;
    }
    case "DelDuplicate":
      text = `Delete duplicate ${instr.arguments ? tick(instr.arguments) + " " : ""}files in ${srcs}`;
      break;
    case "CleanList":
      text = `Remove the files listed in ${srcs}` + (dest ? ` from ${dest}` : "");
      break;
  }
  if (instr.description && instr.description !== "auto-generated") text += ` (${instr.description.replace(/\s*\n\s*/g, " ")})`;
  return text + ".";
}

function nameFor(guid: Guid, names: Map<Guid, string>): string {
  return names.get(guid) ?? (isGuid(guid) ? toBracedGuid(guid) : guid);
}

function ensureHeading(content: string, fallback: string): string {
  return /^\s*#/.test(content) ? content.trim() : `${fallback}\n\n${content.trim()}`;
}

function yamlComment(marker: string, record: UnknownRecord): string {
  const text = stringifyYaml(record, { lineWidth: 0 }).replace(/-->/g, "-- >").trimEnd();
  return `<!--${marker}\n${text}\n-->`;
}

function modHiddenRecord(mod: ModComponent): UnknownRecord {
  const rec = modToRecord(mod);
  delete rec.Description;
  delete rec.Directions;
  delete rec.UsageWarnings;
  return rec;
}

function renderSteps(instructions: Instruction[]): string[] {
  const lines: string[] = [];
  instructions.forEach((instr, i) => lines.push(...formatStep(instr, i + 1)));
  return lines;
}

function renderOption(option: ModOption, mod: ModComponent, style: MarkdownStyle): string {
  const head = `**Option:** ${option.name}` + (option.description ? ` — ${option.description.replace(/\s*\n\s*/g, " ")}` : "");
  if (style === "reddit") {
    const prose = option.instructions.map((i) => describeInstruction(i, mod)).join(" ");
    return [head, prose].filter(Boolean).join("\n");
  }
  const lines = [head];
  if (option.directions) lines.push(option.directions);
  lines.push(...renderSteps(option.instructions));
  return lines.join("\n");
}

function renderMod(mod: ModComponent, style: MarkdownStyle, names: Map<Guid, string>): string {
  const level = Math.min(6, Math.max(2, mod.headingLevel ?? 3));
  const parts: string[] = [`${"#".repeat(level)} ${mod.name}`];
  if (style === "deadlystream") parts.push(yamlComment(MODSYNC_MARKER, modHiddenRecord(mod)));
  if (mod.directions) parts.push(mod.directions.trim());

  const links = mod.modLink;
  let nameLine = links.length ? `[${mod.name}](${links[0]})` : mod.name;
  if (links.length > 1) nameLine += " (also: " + links.slice(1).map((l, i) => `[link ${i + 2}](${l})`).join(", ") + ")";
  parts.push(`**Name:** ${nameLine}`);
  if (mod.authors.length) parts.push(`**Author:** ${mod.authors.join(", ")}`);
  if (mod.description) parts.push(`**Description:** ${mod.description.trim()}`);
  parts.push(`**Category & Tier:** ${mod.category.length ? mod.category.join(" & ") : "Unknown"} / ${tierLabel(mod.tier)}`);
  if (mod.language) parts.push(`**Non-English Functionality:** ${mod.language}`);
  parts.push(`**Installation Method:** ${mod.installationMethod}`);
  if (mod.dependencies.length) parts.push(`**Masters:** ${mod.dependencies.map((g) => nameFor(g, names)).join(", ")}`);
  if (mod.restrictions.length) parts.push(`**Restrictions:** ${mod.restrictions.map((g) => nameFor(g, names)).join(", ")}`);
  if (mod.installAfter.length) parts.push(`**Install After:** ${mod.installAfter.map((g) => nameFor(g, names)).join(", ")}`);
  if (mod.installBefore.length) parts.push(`**Install Before:** ${mod.installBefore.map((g) => nameFor(g, names)).join(", ")}`);
  if (mod.untestedWith.length) parts.push(`**Untested With:** ${mod.untestedWith.map((g) => nameFor(g, names)).join(", ")}`);
  if (mod.expectedFiles?.length) parts.push(`**Expected Files:** ${mod.expectedFiles.map(tick).join(", ")}`);
  const flags: string[] = [];
  if (mod.fullBuildOnly) flags.push("full-build-only");
  if (mod.aspyrOnly) flags.push("aspyr-only");
  if (mod.isPatch) flags.push("patch");
  if (flags.length) parts.push(`**Flags:** ${flags.join(", ")}`);

  if (mod.instructions.length) {
    if (style === "reddit") {
      parts.push(`**Installation Instructions:** ${mod.instructions.map((i) => describeInstruction(i, mod)).join(" ")}`);
    } else {
      parts.push(["**Installation Instructions:**", ...renderSteps(mod.instructions)].join("\n"));
    }
  }
  for (const option of mod.options) parts.push(renderOption(option, mod, style));
  if (mod.usageWarnings) parts.push(`**Usage Warnings:** ${mod.usageWarnings.trim()}`);
  return parts.join("\n\n");
}

/** Generate the guide markdown for an instruction file. */
export function generateMarkdownDocs(file: InstructionFile, style: MarkdownStyle): string {
  const { config, mods } = file;
  const names = new Map<Guid, string>();
  for (const mod of mods) {
    names.set(mod.guid, mod.name);
    for (const option of mod.options) names.set(option.guid, option.name);
  }
  const gameName = config.targetGame === "KOTOR2" ? "KOTOR 2" : config.targetGame === "KOTOR1" ? "KOTOR 1" : "KOTOR";
  const parts: string[] = [`# ${config.name ?? `${gameName} Mod Build`}`];
  if (style === "deadlystream") {
    const rec = configToRecord(config);
    delete rec.BeforeModListContent;
    delete rec.AspyrSectionContent;
    delete rec.WidescreenSectionContent;
    delete rec.AfterModListContent;
    parts.push(yamlComment(MODSYNC_CONFIG_MARKER, rec));
  }
  if (config.beforeModListContent) parts.push(config.beforeModListContent.trim());
  parts.push("## Mod List");
  if (config.aspyrSectionContent) parts.push(ensureHeading(config.aspyrSectionContent, "## Aspyr Patch Notes"));

  let widescreenEmitted = false;
  for (const mod of mods) {
    if (mod.isWidescreen && !widescreenEmitted) {
      parts.push(ensureHeading(config.widescreenSectionContent ?? "", "## Widescreen Mods"));
      widescreenEmitted = true;
    }
    parts.push(renderMod(mod, style, names));
  }
  if (!widescreenEmitted && config.widescreenSectionContent) parts.push(ensureHeading(config.widescreenSectionContent, "## Widescreen Mods"));
  if (config.afterModListContent) parts.push(config.afterModListContent.trim());
  return parts.join("\n\n") + "\n";
}
