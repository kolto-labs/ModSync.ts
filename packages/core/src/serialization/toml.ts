/**
 * TOML instruction files (the KOTORModSync dialect).
 *
 * Parsing is lenient: keys are case-insensitive, `[[thisMod]]` and the legacy
 * `[[modList]]` root tables are both accepted, `Source` may be a string or an
 * array, GUIDs may be braced or not, legacy keys (`type`, `paths`,
 * `restricted`, `installOrder`, `patch`) are mapped. Serialization always emits
 * the modern form: PascalCase keys, braced uppercase GUIDs, `[[thisMod]]`.
 */
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { InstructionFile, ModComponent } from "../model/types.js";
import {
  configFromRecord,
  configToRecord,
  createLenientContext,
  finishLenient,
  isRecord,
  modFromRecord,
  modToRecord,
  type UnknownRecord,
} from "./lenient.js";

export interface ParsedInstructionFile {
  file: InstructionFile;
  /** Non-fatal problems: dropped unknown keys, generated GUIDs, legacy keys, ... */
  warnings: string[];
}

const MOD_ARRAY_KEYS = ["thismod", "modlist", "mods", "mod", "components"];
const CONFIG_KEYS = ["config", "mainconfig", "main", "settings"];

function findKey(record: UnknownRecord, candidates: string[]): string | undefined {
  for (const key of Object.keys(record)) {
    if (candidates.includes(key.toLowerCase())) return key;
  }
  return undefined;
}

/**
 * Parse an instruction file, returning the file together with warnings.
 * Throws on hard errors (invalid TOML, unknown instruction action).
 */
export function parseInstructionFileDetailed(text: string): ParsedInstructionFile {
  const ctx = createLenientContext();
  let root: unknown;
  try {
    root = parseToml(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(`Invalid instruction file: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (!isRecord(root)) throw new Error("Invalid instruction file: root is not a table");

  const configKey = findKey(root, CONFIG_KEYS);
  const configRecord = configKey ? root[configKey] : undefined;
  const config = configFromRecord(isRecord(configRecord) ? configRecord : undefined, ctx);

  const modKey = findKey(root, MOD_ARRAY_KEYS);
  const rawMods: UnknownRecord[] = [];
  if (modKey) {
    const value = root[modKey];
    if (Array.isArray(value)) rawMods.push(...value.filter(isRecord));
    else if (isRecord(value)) rawMods.push(value);
    else throw new Error(`Invalid instruction file: "${modKey}" must be an array of tables`);
  } else {
    ctx.warnings.push("no [[thisMod]] / [[modList]] tables found; file has no mods");
  }

  for (const key of Object.keys(root)) {
    if (key !== configKey && key !== modKey) ctx.warnings.push(`top-level: unknown key "${key}" dropped`);
  }

  let mods: ModComponent[] = rawMods.map((rec, i) => modFromRecord(rec, ctx, i));

  // Legacy numeric installOrder: stable sort by it (mods without one keep their file index).
  const orderKeys = rawMods.map((rec, i) => {
    const key = Object.keys(rec).find((k) => k.toLowerCase() === "installorder");
    const v = key ? rec[key] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : i;
  });
  if (rawMods.some((rec) => Object.keys(rec).some((k) => k.toLowerCase() === "installorder" && typeof rec[k] === "number"))) {
    mods = mods
      .map((mod, i) => ({ mod, key: orderKeys[i], i }))
      .sort((a, b) => a.key - b.key || a.i - b.i)
      .map((x) => x.mod);
    ctx.warnings.push("legacy numeric installOrder used to sort mods");
  }

  // Duplicate GUID detection is a validator concern, but a quick note helps the editor.
  const seen = new Set<string>();
  for (const mod of mods) {
    if (seen.has(mod.guid)) ctx.warnings.push(`duplicate mod Guid ${mod.guid} ("${mod.name}")`);
    seen.add(mod.guid);
  }

  return { file: { config, mods }, warnings: finishLenient(ctx) };
}

/** Parse an instruction file. Throws on hard errors; warnings are discarded. */
export function parseInstructionFile(text: string): InstructionFile {
  return parseInstructionFileDetailed(text).file;
}

/** Serialize in the C# KOTORModSync style. */
export function serializeInstructionFile(file: InstructionFile): string {
  const doc: UnknownRecord = {
    Config: configToRecord(file.config),
    thisMod: file.mods.map(modToRecord),
  };
  return stringifyToml(doc) + "\n";
}
