/**
 * Typed parser for TSLPatcher `changes.ini` and `namespaces.ini`
 * (docs/KOTOR_FORMATS.md section 7). Parsing is fail-closed: malformed input
 * throws PatcherConfigError with section/key context (HoloPatcher style).
 */
import { GffFieldType, parseGffFieldType } from "../gff.js";
import { ssfSoundIndex } from "../ssf.js";
import { IniDocument, IniEntry, IniSection, numericSuffix, orderByNumericSuffix, parseIni } from "./ini.js";
import { parseToken } from "./memory.js";

export class PatcherConfigError extends Error {
  constructor(
    message: string,
    readonly section?: string,
    readonly key?: string,
  ) {
    super(section !== undefined ? `[${section}]${key !== undefined ? ` ${key}` : ""}: ${message}` : message);
    this.name = "PatcherConfigError";
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A literal or token reference appearing as a value in any list section. */
export type PatcherValue =
  | { kind: "constant"; value: string }
  | { kind: "strref"; token: number }
  | { kind: "2damemory"; token: number }
  /** 2DA cells only: max integer in the column + 1 */
  | { kind: "high" };

export function parsePatcherValue(raw: string, allowHigh = false): PatcherValue {
  const t = parseToken(raw);
  if (t) return t;
  if (allowHigh && raw.trim().toLowerCase() === "high()") return { kind: "high" };
  return { kind: "constant", value: raw };
}

export type OverrideType = "ignore" | "warn" | "rename";

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface PatcherSettings {
  windowCaption?: string;
  confirmMessage?: string;
  /** 0 none, 1 errors, 2 general, 3 warnings, 4 verbose */
  logLevel: number;
  installerMode?: number;
  backupFiles: boolean;
  plaintextLog: boolean;
  lookupGameFolder: boolean;
  /** 1 KOTOR, 2 TSL */
  lookupGameNumber?: number;
  saveProcessedScripts: boolean;
  required: { files: string[]; message?: string }[];
  fileExists?: string;
  ignoreExtensions: string[];
  /** every key of [Settings] verbatim (case preserved) */
  raw: Map<string, string>;
}

export type TlkModifier =
  /** StrRef<N>=<M>: append entry M of the source file, remember index as StrRef<N> */
  | { kind: "append"; token: number; sourceIndex: number; sourceFile?: string }
  /** Replace<N>/ReplaceFile<N> sections: overwrite dialog.tlk[dialogIndex] with source[sourceIndex] */
  | { kind: "replace"; dialogIndex: number; sourceIndex: number; sourceFile?: string }
  /** StrRef<N>/Text + StrRef<N>/Sound: append a literal entry */
  | { kind: "direct"; token: number; text: string; sound: string };

export interface TlkListConfig {
  /** file in tslpatchdata holding the entries to append (default append.tlk) */
  sourceFile: string;
  sourceFolder?: string;
  /** folder (relative to game dir) holding dialog.tlk; default = game root */
  destination?: string;
  modifiers: TlkModifier[];
}

export interface InstallFileConfig {
  filename: string;
  /** Replace<N> (true) or File<N> (false) */
  replaceExisting: boolean;
  sourceFolder?: string;
  saveAs?: string;
  /** overrides the folder destination */
  destination?: string;
  overrideType: OverrideType;
}

export interface InstallFolderConfig {
  /** relative to the game dir; may be an archive path (Modules\foo.mod) */
  destination: string;
  files: InstallFileConfig[];
}

export interface PatchFileCommon {
  filename: string;
  /** relative to the game dir; default Override */
  destination: string;
  /** true: take the tslpatchdata copy over any existing game copy */
  replaceFile: boolean;
  /** name of the resource inside the destination (also what is read as the existing target); default: the list name */
  saveAs?: string;
  /** name of the file in tslpatchdata; default: the list name */
  sourceFile?: string;
  sourceFolder?: string;
  overrideType: OverrideType;
}

export type RowTargetKind = "rowIndex" | "rowLabel" | "labelIndex";
export interface RowTarget {
  kind: RowTargetKind;
  value: PatcherValue;
}

export type TwoDAStoreSource =
  | { kind: "rowIndex" }
  | { kind: "rowLabel" }
  | { kind: "column"; column: string }
  /** `2DAMEMORY<N>=2DAMEMORY<M>` / `=StrRef<M>`: copy the value of another token */
  | { kind: "value"; value: PatcherValue };
export interface TwoDAStore {
  pool: "2damemory" | "strref";
  token: number;
  source: TwoDAStoreSource;
  /** Number of the section's cell assignments listed before this store; set only when cells follow it and the source does not read cell content. */
  beforeCells?: number;
}

export interface TwoDAAddRow {
  kind: "addRow";
  section: string;
  exclusiveColumn?: string;
  rowLabel?: PatcherValue;
  cells: Map<string, PatcherValue>;
  stores: TwoDAStore[];
}
export interface TwoDAChangeRow {
  kind: "changeRow";
  section: string;
  target: RowTarget;
  cells: Map<string, PatcherValue>;
  stores: TwoDAStore[];
}
export interface TwoDACopyRow {
  kind: "copyRow";
  section: string;
  target: RowTarget;
  exclusiveColumn?: string;
  newRowLabel?: PatcherValue;
  cells: Map<string, PatcherValue>;
  stores: TwoDAStore[];
}
export type AddColumnStoreSource = { kind: "index"; index: number } | { kind: "label"; label: string };
export interface TwoDAAddColumn {
  kind: "addColumn";
  section: string;
  columnLabel: string;
  defaultValue: string;
  indexInserts: { index: number; value: PatcherValue }[];
  labelInserts: { label: string; value: PatcherValue }[];
  stores: { pool: "2damemory" | "strref"; token: number; source: AddColumnStoreSource }[];
}
export type TwoDAModifier = TwoDAAddRow | TwoDAChangeRow | TwoDACopyRow | TwoDAAddColumn;

export interface TwoDAFileConfig extends PatchFileCommon {
  modifiers: TwoDAModifier[];
}

export type GffLocStringPart = { kind: "strref" } | { kind: "lang"; id: number };

export interface GffModifyField {
  kind: "modify";
  /** path as written (may contain 2DAMEMORY<N> segments) */
  path: string;
  /** `(strref)` / `(lang<N>)` suffix */
  part?: GffLocStringPart;
  value: PatcherValue;
}
export interface GffLocStringSpec {
  strref?: PatcherValue;
  /** keyed by substring id (lang<N>) */
  substrings: Map<number, PatcherValue>;
}
export interface GffAddField {
  kind: "add";
  section: string;
  fieldType: GffFieldType;
  /** parent path; "" = root. Ignored for nested AddFields (parent is the new field). */
  path: string;
  label: string;
  /** struct type id for Struct fields */
  typeId: number;
  value?: PatcherValue;
  locString?: GffLocStringSpec;
  /** 2DAMEMORY<N>=ListIndex */
  storeListIndex: number[];
  /** 2DAMEMORY<N>=!FieldPath */
  storeFieldPath: number[];
  /** TypeId=ListIndex: the new struct's type id is its index in the list */
  typeIdFromListIndex: boolean;
  /** 2DAMEMORY<N>=2DAMEMORY<M>, applied after the field exists (before children) */
  copyMemory: { token: number; source: number }[];
  children: GffAddField[];
}
export interface GffStorePath {
  kind: "storePath";
  token: number;
}
/**
 * `2DAMEMORY<N>=2DAMEMORY<M>` directly in a GFF file section. When token N holds a stored field path the
 * value of token M (dereferenced if it is a field path too) is written into that field; otherwise token N
 * becomes a copy of token M.
 */
export interface GffMemoryAssign {
  kind: "memoryAssign";
  token: number;
  source: number;
}
export type GffModifier = GffModifyField | GffAddField | GffStorePath | GffMemoryAssign;

export interface GffFileConfig extends PatchFileCommon {
  modifiers: GffModifier[];
}

export type CompileFileConfig = PatchFileCommon;

export interface HackEdit {
  offset: number;
  value: PatcherValue;
}
export interface HackFileConfig extends PatchFileCommon {
  edits: HackEdit[];
}

export interface SsfSoundEdit {
  name: string;
  /** 0-27 */
  index: number;
  value: PatcherValue;
}
export interface SsfFileConfig extends PatchFileCommon {
  sounds: SsfSoundEdit[];
}

export interface PatcherConfig {
  settings: PatcherSettings;
  tlk: TlkListConfig;
  install: InstallFolderConfig[];
  twoda: TwoDAFileConfig[];
  gff: GffFileConfig[];
  compile: CompileFileConfig[];
  hack: HackFileConfig[];
  ssf: SsfFileConfig[];
  /** the parsed ini, for anything not modelled above */
  ini: IniDocument;
}

export interface Namespace {
  key: string;
  name: string;
  description?: string;
  iniName: string;
  infoName?: string;
  /**
   * Data folder of this namespace, relative to `tslpatchdata`. Read from
   * `DataPath` (TSLPatcher/HoloPatcher key), falling back to the legacy
   * `DataFolderName` key.
   */
  dataFolderName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBool(raw: string, section: string, key: string): boolean {
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off", ""].includes(v)) return false;
  throw new PatcherConfigError(`expected a boolean (0/1), got "${raw}"`, section, key);
}

function parseIntStrict(raw: string, section: string, key: string): number {
  const v = raw.trim();
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^0x[0-9a-f]+$/i.test(v)) return parseInt(v, 16);
  throw new PatcherConfigError(`expected an integer, got "${raw}"`, section, key);
}

/** TSLPatcher also writes TLK indices in Replace/Append sections as `StrRef<N>`. */
function stripStrRefPrefix(raw: string): string {
  const v = raw.trim();
  return /^strref\d+$/i.test(v) ? v.slice(6) : v;
}

function parseOverrideType(raw: string | undefined, section: string): OverrideType {
  if (raw === undefined) return "ignore";
  const v = raw.trim().toLowerCase();
  if (v === "ignore" || v === "warn" || v === "rename") return v;
  throw new PatcherConfigError(`!OverrideType must be ignore, warn or rename, got "${raw}"`, section, "!OverrideType");
}

function requireSection(ini: IniDocument, name: string, referencedFrom: string, key: string): IniSection {
  const s = ini.getSection(name);
  if (!s) throw new PatcherConfigError(`references section [${name}] which does not exist`, referencedFrom, key);
  return s;
}

function normalizeDest(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const v = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return v === "" ? fallback : v;
}

function readCommon(ini: IniDocument, filename: string, replaceFromKey: boolean, listSection: string, key: string, required: boolean): { common: PatchFileCommon; section?: IniSection } {
  const section = ini.getSection(filename);
  if (!section && required) throw new PatcherConfigError(`no [${filename}] section describing the modifications`, listSection, key);
  const common: PatchFileCommon = {
    filename,
    destination: normalizeDest(section?.get("!Destination"), "Override"),
    replaceFile: replaceFromKey || (section?.has("!ReplaceFile") ? parseBool(section.get("!ReplaceFile")!, filename, "!ReplaceFile") : false),
    overrideType: parseOverrideType(section?.get("!OverrideType"), filename),
  };
  const saveAs = section?.get("!SaveAs") ?? section?.get("!Filename");
  if (saveAs !== undefined && saveAs.trim() !== "") common.saveAs = saveAs.trim();
  const sourceFile = section?.get("!SourceFile");
  if (sourceFile !== undefined && sourceFile.trim() !== "") common.sourceFile = sourceFile.trim();
  const src = section?.get("!SourceFolder");
  if (src !== undefined && src.trim() !== "" && src.trim() !== ".") common.sourceFolder = src.trim().replace(/\\/g, "/");
  return section ? { common, section } : { common };
}

function isBang(key: string): boolean {
  return key.startsWith("!");
}

/**
 * Entries of a file-list section in INI file order. TSLPatcher/HoloPatcher treat the key as an opaque
 * identifier (`File<N>`, `Table<N>`, `Replace<N>`, ...) and only look at the value (the file name); a key
 * starting with `Replace` marks a replacing entry.
 */
function fileListEntries(section: IniSection): (IniEntry & { replace: boolean })[] {
  const out: (IniEntry & { replace: boolean })[] = [];
  for (const e of section.entries) {
    if (isBang(e.key)) continue;
    if (e.value.trim() === "") throw new PatcherConfigError("empty file name", section.name, e.key);
    out.push({ ...e, replace: e.key.toLowerCase().startsWith("replace") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// [Settings]
// ---------------------------------------------------------------------------

function parseSettings(ini: IniDocument): PatcherSettings {
  const s = ini.getSection("Settings");
  const settings: PatcherSettings = {
    logLevel: 3,
    backupFiles: true,
    plaintextLog: false,
    lookupGameFolder: false,
    saveProcessedScripts: false,
    required: [],
    ignoreExtensions: [],
    raw: new Map(),
  };
  if (!s) return settings;
  const requiredByIndex = new Map<number, { files: string[]; message?: string }>();
  for (const e of s.entries) {
    settings.raw.set(e.key, e.value);
    const k = e.key.toLowerCase();
    switch (k) {
      case "windowcaption":
        settings.windowCaption = e.value;
        break;
      case "confirmmessage":
        settings.confirmMessage = e.value;
        break;
      case "loglevel":
        settings.logLevel = parseIntStrict(e.value, s.name, e.key);
        break;
      case "installermode":
        settings.installerMode = parseIntStrict(e.value, s.name, e.key);
        break;
      case "backupfiles":
        settings.backupFiles = parseBool(e.value, s.name, e.key);
        break;
      case "plaintextlog":
        settings.plaintextLog = parseBool(e.value, s.name, e.key);
        break;
      case "lookupgamefolder":
        settings.lookupGameFolder = parseBool(e.value, s.name, e.key);
        break;
      case "lookupgamenumber":
        settings.lookupGameNumber = parseIntStrict(e.value, s.name, e.key);
        break;
      case "saveprocessedscripts":
        settings.saveProcessedScripts = parseBool(e.value, s.name, e.key);
        break;
      case "fileexists":
        settings.fileExists = e.value;
        break;
      case "ignoreextensions":
        settings.ignoreExtensions = e.value
          .split(",")
          .map((x) => x.trim().replace(/^\./, "").toLowerCase())
          .filter((x) => x !== "");
        break;
      default: {
        const req = /^required(\d*)$/i.exec(e.key);
        const msg = /^requiredmsg(\d*)$/i.exec(e.key);
        if (req) {
          const idx = req[1] === "" ? 0 : Number(req[1]);
          const entry = requiredByIndex.get(idx) ?? { files: [] };
          entry.files.push(...e.value.split(",").map((x) => x.trim()).filter((x) => x !== ""));
          requiredByIndex.set(idx, entry);
        } else if (msg) {
          const idx = msg[1] === "" ? 0 : Number(msg[1]);
          const entry = requiredByIndex.get(idx) ?? { files: [] };
          entry.message = e.value;
          requiredByIndex.set(idx, entry);
        }
        // other keys are kept in `raw` only
      }
    }
  }
  settings.required = [...requiredByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return settings;
}

// ---------------------------------------------------------------------------
// [TLKList]
// ---------------------------------------------------------------------------

function parseTlkList(ini: IniDocument): TlkListConfig {
  const cfg: TlkListConfig = { sourceFile: "append.tlk", modifiers: [] };
  const s = ini.getSection("TLKList");
  if (!s) return cfg;
  const direct = new Map<number, { text?: string; sound?: string; line: number }>();
  const entries = orderByNumericSuffix(s.entries, ["StrRef", "Replace", "ReplaceFile", "AppendFile", "Append"]);
  for (const e of entries) {
    const k = e.key.toLowerCase();
    if (k === "!sourcefile") {
      cfg.sourceFile = e.value.trim();
      continue;
    }
    if (k === "!sourcefolder" || k === "!defaultsourcefolder") {
      if (e.value.trim() !== "" && e.value.trim() !== ".") cfg.sourceFolder = e.value.trim().replace(/\\/g, "/");
      continue;
    }
    if (k === "!defaultdestination" || k === "!destination") {
      cfg.destination = normalizeDest(e.value, "");
      if (cfg.destination === "") delete cfg.destination;
      continue;
    }
    if (isBang(e.key)) continue;

    const slash = /^strref(\d+)[\\/](text|sound)$/i.exec(e.key);
    if (slash) {
      const token = Number(slash[1]);
      const d = direct.get(token) ?? { line: e.line };
      if (slash[2]!.toLowerCase() === "text") d.text = e.value;
      else d.sound = e.value.trim();
      direct.set(token, d);
      continue;
    }
    const strref = numericSuffix(e.key, "StrRef");
    if (strref !== undefined) {
      cfg.modifiers.push({ kind: "append", token: strref, sourceIndex: parseIntStrict(e.value, s.name, e.key) });
      continue;
    }
    const isReplace = numericSuffix(e.key, "Replace") !== undefined || numericSuffix(e.key, "ReplaceFile") !== undefined;
    const isAppend = numericSuffix(e.key, "AppendFile") !== undefined || numericSuffix(e.key, "Append") !== undefined;
    if (isReplace || isAppend) {
      const sectionName = e.value.trim();
      const sub = requireSection(ini, sectionName, s.name, e.key);
      const sourceFile = sub.get("!SourceFile")?.trim() || sectionName;
      for (const pair of sub.entries) {
        if (isBang(pair.key)) continue;
        const left = parseIntStrict(stripStrRefPrefix(pair.key), sub.name, pair.key);
        const right = parseIntStrict(stripStrRefPrefix(pair.value), sub.name, pair.key);
        if (isReplace) cfg.modifiers.push({ kind: "replace", dialogIndex: left, sourceIndex: right, sourceFile });
        else cfg.modifiers.push({ kind: "append", token: left, sourceIndex: right, sourceFile });
      }
      continue;
    }
    throw new PatcherConfigError(`unexpected key "${e.key}" in [TLKList]`, s.name, e.key);
  }
  for (const [token, d] of [...direct.entries()].sort((a, b) => a[0] - b[0])) {
    if (d.text === undefined) throw new PatcherConfigError(`StrRef${token}/Sound given without StrRef${token}/Text`, s.name, `StrRef${token}/Sound`);
    cfg.modifiers.push({ kind: "direct", token, text: d.text, sound: d.sound ?? "" });
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// [InstallList]
// ---------------------------------------------------------------------------

function parseInstallList(ini: IniDocument): InstallFolderConfig[] {
  const out: InstallFolderConfig[] = [];
  const s = ini.getSection("InstallList");
  if (!s) return out;
  for (const e of orderByNumericSuffix(s.entries, ["install_folder"])) {
    if (isBang(e.key)) continue;
    // TSLPatcher/HoloPatcher: the section is named by the KEY ([install_folderN]) and the value is the
    // destination folder (or archive path) relative to the game dir. A section named after the value is
    // accepted as a fallback. The key is an opaque identifier; any key naming a section is accepted.
    const folderSection = ini.getSection(e.key) ?? ini.getSection(e.value.trim());
    if (!folderSection) throw new PatcherConfigError(`references section [${e.key}] which does not exist`, s.name, e.key);
    const folder: InstallFolderConfig = { destination: normalizeDest(e.value, "Override"), files: [] };
    for (const f of fileListEntries(folderSection)) {
      const filename = f.value.trim();
      const { common, section } = readCommon(ini, filename, f.replace, folderSection.name, f.key, false);
      const file: InstallFileConfig = { filename, replaceExisting: common.replaceFile, overrideType: common.overrideType };
      if (common.saveAs) file.saveAs = common.saveAs;
      if (common.sourceFolder) file.sourceFolder = common.sourceFolder;
      if (section?.has("!Destination")) file.destination = common.destination;
      folder.files.push(file);
    }
    out.push(folder);
  }
  return out;
}

// ---------------------------------------------------------------------------
// [2DAList]
// ---------------------------------------------------------------------------

const ROW_TARGET_KEYS: Record<string, RowTargetKind> = { rowindex: "rowIndex", rowlabel: "rowLabel", labelindex: "labelIndex" };

function parseStore(key: string, value: string, section: string): TwoDAStore | undefined {
  const t = parseToken(key);
  if (!t) return undefined;
  const v = value.trim().toLowerCase();
  const tokenSource = parseToken(value);
  const source: TwoDAStoreSource = tokenSource
    ? { kind: "value", value: tokenSource }
    : v === "rowindex"
      ? { kind: "rowIndex" }
      : v === "rowlabel"
        ? { kind: "rowLabel" }
        : { kind: "column", column: value.trim() };
  if (source.kind === "column" && source.column === "") throw new PatcherConfigError("memory store needs RowIndex, RowLabel or a column name", section, key);
  return { pool: t.kind, token: t.token, source };
}

function parseRowModifier(kind: "addRow" | "changeRow" | "copyRow", section: IniSection): TwoDAModifier {
  const cells = new Map<string, PatcherValue>();
  const stores: TwoDAStore[] = [];
  let target: RowTarget | undefined;
  let exclusiveColumn: string | undefined;
  let rowLabel: PatcherValue | undefined;
  let newRowLabel: PatcherValue | undefined;
  for (const e of section.entries) {
    const k = e.key.toLowerCase();
    if (k === "exclusivecolumn") {
      exclusiveColumn = e.value.trim();
      continue;
    }
    if (k === "newrowlabel") {
      newRowLabel = parsePatcherValue(e.value.trim(), true);
      continue;
    }
    if (kind === "addRow" && k === "rowlabel") {
      rowLabel = parsePatcherValue(e.value.trim(), true);
      continue;
    }
    const tk = ROW_TARGET_KEYS[k];
    if (tk && kind !== "addRow") {
      if (target) throw new PatcherConfigError(`multiple row selectors (${target.kind} and ${tk})`, section.name, e.key);
      target = { kind: tk, value: parsePatcherValue(e.value.trim()) };
      continue;
    }
    const store = parseStore(e.key, e.value, section.name);
    if (store) {
      if (store.source.kind !== "column") store.beforeCells = cells.size;
      stores.push(store);
      continue;
    }
    if (isBang(e.key)) continue;
    cells.set(e.key, parsePatcherValue(e.value, true));
  }
  for (const store of stores) if (store.beforeCells !== undefined && store.beforeCells >= cells.size) delete store.beforeCells;
  if (kind === "addRow") {
    const m: TwoDAAddRow = { kind, section: section.name, cells, stores };
    if (exclusiveColumn) m.exclusiveColumn = exclusiveColumn;
    const label = rowLabel ?? newRowLabel;
    if (label) m.rowLabel = label;
    return m;
  }
  if (!target) throw new PatcherConfigError(`${kind} needs a RowIndex, RowLabel or LabelIndex selector`, section.name);
  if (kind === "changeRow") return { kind, section: section.name, target, cells, stores };
  const m: TwoDACopyRow = { kind, section: section.name, target, cells, stores };
  if (exclusiveColumn) m.exclusiveColumn = exclusiveColumn;
  if (newRowLabel) m.newRowLabel = newRowLabel;
  return m;
}

function parseAddColumn(section: IniSection): TwoDAAddColumn {
  const m: TwoDAAddColumn = { kind: "addColumn", section: section.name, columnLabel: "", defaultValue: "****", indexInserts: [], labelInserts: [], stores: [] };
  for (const e of section.entries) {
    const k = e.key.toLowerCase();
    if (k === "columnlabel") m.columnLabel = e.value.trim();
    else if (k === "defaultvalue") m.defaultValue = e.value;
    else if (/^i\d+$/.test(k)) m.indexInserts.push({ index: Number(k.slice(1)), value: parsePatcherValue(e.value, true) });
    else if (k.startsWith("l") && k.length > 1) m.labelInserts.push({ label: e.key.slice(1), value: parsePatcherValue(e.value, true) });
    else {
      const t = parseToken(e.key);
      if (t) {
        const v = e.value.trim();
        if (/^i\d+$/i.test(v)) m.stores.push({ pool: t.kind, token: t.token, source: { kind: "index", index: Number(v.slice(1)) } });
        else if (/^l.+$/i.test(v)) m.stores.push({ pool: t.kind, token: t.token, source: { kind: "label", label: v.slice(1) } });
        else throw new PatcherConfigError(`AddColumn memory store must be I<index> or L<label>, got "${e.value}"`, section.name, e.key);
      } else if (!isBang(e.key)) throw new PatcherConfigError(`unexpected key "${e.key}" in AddColumn section`, section.name, e.key);
    }
  }
  if (m.columnLabel === "") throw new PatcherConfigError("AddColumn needs ColumnLabel", section.name, "ColumnLabel");
  return m;
}

function parse2daList(ini: IniDocument): TwoDAFileConfig[] {
  const out: TwoDAFileConfig[] = [];
  const s = ini.getSection("2DAList");
  if (!s) return out;
  for (const e of fileListEntries(s)) {
    const filename = e.value.trim();
    const { common, section } = readCommon(ini, filename, e.replace, s.name, e.key, true);
    const file: TwoDAFileConfig = { ...common, modifiers: [] };
    for (const m of section!.entries) {
      if (isBang(m.key)) continue;
      const sub = requireSection(ini, m.value.trim(), section!.name, m.key);
      if (numericSuffix(m.key, "AddRow") !== undefined) file.modifiers.push(parseRowModifier("addRow", sub));
      else if (numericSuffix(m.key, "ChangeRow") !== undefined) file.modifiers.push(parseRowModifier("changeRow", sub));
      else if (numericSuffix(m.key, "CopyRow") !== undefined) file.modifiers.push(parseRowModifier("copyRow", sub));
      else if (numericSuffix(m.key, "AddColumn") !== undefined) file.modifiers.push(parseAddColumn(sub));
      else throw new PatcherConfigError(`unexpected key "${m.key}" (expected AddRow/ChangeRow/CopyRow/AddColumn<N>)`, section!.name, m.key);
    }
    out.push(file);
  }
  return out;
}

// ---------------------------------------------------------------------------
// [GFFList]
// ---------------------------------------------------------------------------

function parseAddField(ini: IniDocument, section: IniSection, depth: number): GffAddField {
  if (depth > 32) throw new PatcherConfigError("AddField nesting too deep (cycle?)", section.name);
  const typeRaw = section.get("FieldType");
  if (typeRaw === undefined) throw new PatcherConfigError("AddField section needs FieldType", section.name, "FieldType");
  const fieldType = parseGffFieldType(typeRaw);
  if (fieldType === undefined) throw new PatcherConfigError(`unknown FieldType "${typeRaw}"`, section.name, "FieldType");
  const add: GffAddField = {
    kind: "add",
    section: section.name,
    fieldType,
    path: (section.get("Path") ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
    label: (section.get("Label") ?? "").trim(),
    typeId: 0,
    storeListIndex: [],
    storeFieldPath: [],
    copyMemory: [],
    typeIdFromListIndex: false,
    children: [],
  };
  const loc: GffLocStringSpec = { substrings: new Map() };
  for (const e of section.entries) {
    const k = e.key.toLowerCase();
    if (k === "fieldtype" || k === "path" || k === "label") continue;
    if (k === "typeid") {
      if (e.value.trim().toLowerCase() === "listindex") add.typeIdFromListIndex = true;
      else add.typeId = parseIntStrict(e.value, section.name, e.key);
      continue;
    }
    if (k === "value") {
      add.value = parsePatcherValue(e.value);
      continue;
    }
    if (k === "strref") {
      loc.strref = parsePatcherValue(e.value.trim());
      continue;
    }
    const lang = /^lang(\d+)$/i.exec(e.key);
    if (lang) {
      loc.substrings.set(Number(lang[1]), parsePatcherValue(e.value));
      continue;
    }
    if (numericSuffix(e.key, "AddField") !== undefined) continue;
    const t = parseToken(e.key);
    if (t && t.kind === "2damemory") {
      const v = e.value.trim().toLowerCase();
      if (v === "listindex") add.storeListIndex.push(t.token);
      else if (v === "!fieldpath") add.storeFieldPath.push(t.token);
      else {
        const src = parseToken(e.value);
        if (src?.kind !== "2damemory") throw new PatcherConfigError(`2DAMEMORY assignment in AddField must be ListIndex, !FieldPath or 2DAMEMORY<M>, got "${e.value}"`, section.name, e.key);
        add.copyMemory.push({ token: t.token, source: src.token });
      }
      continue;
    }
    if (isBang(e.key)) continue;
    throw new PatcherConfigError(`unexpected key "${e.key}" in AddField section`, section.name, e.key);
  }
  if (fieldType === GffFieldType.LocString) add.locString = loc;
  else if (loc.strref !== undefined || loc.substrings.size > 0) throw new PatcherConfigError("StrRef/lang<N> keys are only valid for ExoLocString fields", section.name);
  if (fieldType === GffFieldType.Struct || fieldType === GffFieldType.List || fieldType === GffFieldType.LocString) {
    // no scalar value needed
  } else if (add.value === undefined) {
    throw new PatcherConfigError(`AddField of type ${GffFieldType[fieldType]} needs Value=`, section.name, "Value");
  }
  for (const c of section.numbered("AddField")) {
    const sub = requireSection(ini, c.value.trim(), section.name, c.key);
    add.children.push(parseAddField(ini, sub, depth + 1));
  }
  return add;
}

function parseGffModifyKey(key: string): { path: string; part?: GffLocStringPart } {
  const m = /^(.*)\((strref|lang(\d+))\)$/i.exec(key.trim());
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!m) return { path: norm(key) };
  const path = norm(m[1]!);
  if (m[3] !== undefined) return { path, part: { kind: "lang", id: Number(m[3]) } };
  return { path, part: { kind: "strref" } };
}

function parseGffList(ini: IniDocument): GffFileConfig[] {
  const out: GffFileConfig[] = [];
  const s = ini.getSection("GFFList");
  if (!s) return out;
  for (const e of fileListEntries(s)) {
    const filename = e.value.trim();
    const { common, section } = readCommon(ini, filename, e.replace, s.name, e.key, true);
    const file: GffFileConfig = { ...common, modifiers: [] };
    for (const m of section!.entries) {
      if (isBang(m.key)) continue;
      if (numericSuffix(m.key, "AddField") !== undefined) {
        const sub = requireSection(ini, m.value.trim(), section!.name, m.key);
        file.modifiers.push(parseAddField(ini, sub, 0));
        continue;
      }
      const t = parseToken(m.key);
      if (t?.kind === "2damemory") {
        const v = m.value.trim();
        if (v.toLowerCase() === "!fieldpath") {
          file.modifiers.push({ kind: "storePath", token: t.token });
          continue;
        }
        const src = parseToken(v);
        if (src?.kind === "2damemory") {
          file.modifiers.push({ kind: "memoryAssign", token: t.token, source: src.token });
          continue;
        }
        // otherwise `2DAMEMORY<N>=<value>` writes <value> to the field whose path is stored in token N
      } else if (t?.kind === "strref") {
        throw new PatcherConfigError(`unexpected key "${m.key}" in GFF section (StrRef<N> cannot be a field path)`, section!.name, m.key);
      }
      const { path, part } = parseGffModifyKey(m.key);
      if (path === "") throw new PatcherConfigError("empty field path", section!.name, m.key);
      const mod: GffModifyField = { kind: "modify", path, value: parsePatcherValue(m.value) };
      if (part) mod.part = part;
      file.modifiers.push(mod);
    }
    out.push(file);
  }
  return out;
}

// ---------------------------------------------------------------------------
// [CompileList] [HACKList] [SSFList]
// ---------------------------------------------------------------------------

function parseCompileList(ini: IniDocument): CompileFileConfig[] {
  const out: CompileFileConfig[] = [];
  const s = ini.getSection("CompileList");
  if (!s) return out;
  for (const e of fileListEntries(s)) {
    const { common } = readCommon(ini, e.value.trim(), e.replace, s.name, e.key, false);
    out.push(common);
  }
  return out;
}

function parseHackList(ini: IniDocument): HackFileConfig[] {
  const out: HackFileConfig[] = [];
  const s = ini.getSection("HACKList");
  if (!s) return out;
  for (const e of fileListEntries(s)) {
    const { common, section } = readCommon(ini, e.value.trim(), e.replace, s.name, e.key, true);
    const file: HackFileConfig = { ...common, edits: [] };
    for (const m of section!.entries) {
      if (isBang(m.key)) continue;
      const offset = parseIntStrict(m.key, section!.name, m.key);
      const value = parsePatcherValue(m.value.trim());
      if (value.kind === "constant") parseIntStrict(value.value, section!.name, m.key);
      file.edits.push({ offset, value });
    }
    out.push(file);
  }
  return out;
}

function parseSsfList(ini: IniDocument): SsfFileConfig[] {
  const out: SsfFileConfig[] = [];
  const s = ini.getSection("SSFList");
  if (!s) return out;
  for (const e of fileListEntries(s)) {
    const { common, section } = readCommon(ini, e.value.trim(), e.replace, s.name, e.key, true);
    const file: SsfFileConfig = { ...common, sounds: [] };
    for (const m of section!.entries) {
      if (isBang(m.key)) continue;
      const index = ssfSoundIndex(m.key);
      if (index < 0) throw new PatcherConfigError(`unknown sound name "${m.key}"`, section!.name, m.key);
      const value = parsePatcherValue(m.value.trim());
      if (value.kind === "constant") parseIntStrict(value.value, section!.name, m.key);
      file.sounds.push({ name: m.key, index, value });
    }
    out.push(file);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function parseChangesIni(text: string): PatcherConfig {
  const ini = parseIni(text);
  return {
    settings: parseSettings(ini),
    tlk: parseTlkList(ini),
    install: parseInstallList(ini),
    twoda: parse2daList(ini),
    gff: parseGffList(ini),
    compile: parseCompileList(ini),
    hack: parseHackList(ini),
    ssf: parseSsfList(ini),
    ini,
  };
}

/**
 * Parse `namespaces.ini`. A file without a `[Namespaces]` section, or with no
 * `Namespace<N>` entries, declares no variants and yields `[]` so callers fall
 * back to the default `changes.ini`. A listed entry whose section is missing
 * is still an error.
 */
export function parseNamespacesIni(text: string): Namespace[] {
  const ini = parseIni(text);
  const s = ini.getSection("Namespaces");
  if (!s) return [];
  const out: Namespace[] = [];
  for (const e of s.numbered("Namespace")) {
    const key = e.value.trim();
    const sub = requireSection(ini, key, s.name, e.key);
    const ns: Namespace = { key, name: sub.get("Name")?.trim() || key, iniName: sub.get("IniName")?.trim() || "changes.ini" };
    const desc = sub.get("Description");
    if (desc !== undefined) ns.description = desc;
    const info = sub.get("InfoName")?.trim();
    if (info) ns.infoName = info;
    const data = sub.get("DataPath")?.trim() || sub.get("DataFolderName")?.trim();
    if (data) ns.dataFolderName = data;
    out.push(ns);
  }
  return out;
}
