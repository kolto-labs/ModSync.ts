/**
 * ModSync domain model.
 *
 * This file is the shared contract between every package in the monorepo.
 * It intentionally contains only types and enums (no runtime logic beyond
 * const tables) so that the web UI can import it without pulling Node APIs.
 *
 * Terminology follows the original C# KOTORModSync:
 *   - ModComponent: one mod in an instruction file (a `[[thisMod]]` table).
 *   - Option: a mod-like object nested inside a mod ("customizations").
 *   - Instruction: a single step (Extract, Move, Copy, ...) that runs in order.
 *   - Instruction file / modbuild: the TOML document listing every mod.
 */

/** A canonical GUID: lowercase, hyphenated, no braces. */
export type Guid = string;

export const ACTION_TYPES = [
  "Unset",
  "Run",
  "Extract",
  "Move",
  "Copy",
  "Delete",
  "Rename",
  "Execute",
  "Patcher",
  "Choose",
  "DelDuplicate",
  "CleanList",
  "CreateDirectory",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const TARGET_GAMES = ["KOTOR1", "KOTOR2", "Unknown"] as const;
export type TargetGame = (typeof TARGET_GAMES)[number];

export const PLATFORMS = ["PC", "Mobile"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const INSTALL_STATES = [
  "NotInstalled",
  "Installing",
  "Installed",
  "Failed",
  "Skipped",
] as const;
export type InstallState = (typeof INSTALL_STATES)[number];

export const INSTALLATION_METHODS = [
  "Loose-File",
  "TSLPatcher",
  "HoloPatcher",
  "Executable",
  "Mixed",
  "Unknown",
] as const;
export type InstallationMethod = (typeof INSTALLATION_METHODS)[number];

export const COMPATIBILITY_LEVELS = ["Compatible", "Untested", "Incompatible"] as const;
export type CompatibilityLevel = (typeof COMPATIBILITY_LEVELS)[number];

/** Canonical tiers. Aliases seen in guides map to these via `normalizeTier`. */
export const TIERS = ["Essential", "Recommended", "Suggested", "Optional", "Unknown"] as const;
export type Tier = (typeof TIERS)[number];

/** Canonical category keywords. A mod may carry several. */
export const CATEGORIES = [
  "Patch",
  "Bugfix",
  "Graphics Improvement",
  "Mechanics Change",
  "Gameplay",
  "Appearance Change",
  "Immersion",
  "Story",
  "Restored Content",
  "Added Content",
  "UI",
  "Audio",
  "Widescreen",
  "Unknown",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Placeholders that instruction files must use for every path. */
export const PLACEHOLDER_MOD_DIRECTORY = "<<modDirectory>>";
export const PLACEHOLDER_KOTOR_DIRECTORY = "<<kotorDirectory>>";

/**
 * One instruction step. Field names mirror the TOML keys (PascalCase in files,
 * camelCase here; the serializer maps them).
 */
export interface Instruction {
  /** Unrecognized serialized fields preserved for lossless editing; not execution support. */
  metadata?: Record<string, unknown>;
  guid: Guid;
  action: ActionType;
  /**
   * Files to handle. Wildcards allowed. For Choose: either folder paths
   * (with wildcards) or Option/Mod GUIDs.
   */
  source: string[];
  /** Move/Copy/Rename/Patcher/Delete/CleanList/Choose. For Rename: the new file name. */
  destination?: string;
  /** Move/Copy/Rename/Patcher/Choose. True overwrites; false skips existing. Default true. */
  overwrite: boolean;
  /** GUIDs that must be selected for this instruction to run. */
  dependencies: Guid[];
  /** GUIDs that must NOT be selected for this instruction to run. */
  restrictions: Guid[];
  /**
   * Execute: extra command line arguments.
   * Patcher: namespace option index in namespaces.ini (0-based) or a changes ini name.
   * DelDuplicate: the file extension (e.g. ".tpc").
   */
  arguments?: string;
  /** Free text for the editor and generated docs. */
  description?: string;
  /** Only run this instruction on the given platform (Aspyr/mobile pipeline). */
  platform?: Platform;
}

/** A user-customizable feature nested inside a mod. Defined just like a mod. */
export interface ModOption {
  /** Unrecognized serialized fields preserved for lossless editing; not execution support. */
  metadata?: Record<string, unknown>;
  guid: Guid;
  name: string;
  description?: string;
  directions?: string;
  dependencies: Guid[];
  restrictions: Guid[];
  installAfter: Guid[];
  installBefore: Guid[];
  instructions: Instruction[];
  /** Selected by default when the parent mod is selected. */
  isSelected: boolean;
  /** Group key: at most one option per exclusive group may be selected. */
  exclusiveGroup?: string;
}

export interface ModComponent {
  /** Unrecognized serialized fields preserved for lossless editing; not execution support. */
  metadata?: Record<string, unknown>;
  guid: Guid;
  name: string;
  description?: string;
  /** Human directions shown before install (e.g. the modder's readme notes). */
  directions?: string;
  authors: string[];
  /** Download links. */
  modLink: string[];
  /** Expected archive/file names in the mod directory, used by the downloader and validator. */
  expectedFiles?: string[];
  category: Category[];
  tier: Tier;
  /** Language support note, e.g. "YES", "NO", "PARTIAL - ...". */
  language?: string;
  installationMethod: InstallationMethod;
  /** Free-form "Usage Warnings" / "Masters" / "Incompatibilities" text from the docs. */
  usageWarnings?: string;
  dependencies: Guid[];
  restrictions: Guid[];
  installAfter: Guid[];
  installBefore: Guid[];
  /** Pairs that are only allowed at CompatibilityLevel "Untested". */
  untestedWith: Guid[];
  instructions: Instruction[];
  options: ModOption[];
  isSelected: boolean;
  installState: InstallState;
  isDownloaded: boolean;
  /** Mod is not part of the spoiler-free build. */
  fullBuildOnly: boolean;
  /** Mod is a widescreen / EXE-level mod handled by the widescreen phase. */
  isWidescreen: boolean;
  /** Mod is only for the Aspyr (mobile/Steam Aspyr) version. */
  aspyrOnly: boolean;
  /** Mod is a patch for another mod (not a standalone mod). */
  isPatch: boolean;
  /** Heading level in the source markdown (2 or 3). */
  headingLevel?: number;
  /** Optional image URLs for the installing slideshow. */
  images?: string[];
  /** Expected SHA1 hashes of archive files (filename -> sha1 hex). */
  expectedHashes?: Record<string, string>;
}

/** Top-level instruction file metadata. */
export interface MainConfig {
  /** Unrecognized serialized fields preserved for lossless editing; not execution support. */
  metadata?: Record<string, unknown>;
  /** Display name of the modbuild (e.g. "KOTOR 1 Full Build rev 12"). */
  name?: string;
  targetGame: TargetGame;
  /** Free-form version string of the modbuild. */
  version?: string;
  author?: string;
  description?: string;
  /** Markdown shown before the mod list. */
  beforeModListContent?: string;
  /** Aspyr section markdown (KOTOR2 only). */
  aspyrSectionContent?: string;
  /** Widescreen section markdown. */
  widescreenSectionContent?: string;
  /** Markdown shown after the widescreen mods. */
  afterModListContent?: string;
  /** Default compatibility level; "Untested" allows untested pairs. */
  compatibilityLevel: CompatibilityLevel;
  /** Preferred patcher engine. */
  patcherEngine: PatcherEngine;
  /** Spoiler-free mode hides descriptions/links and skips FullBuildOnly mods. */
  spoilerFree: boolean;
  platform: Platform;
  /** Where the source document (e.g. full.md) came from, for merge. */
  sourceUrl?: string;
}

export const PATCHER_ENGINES = ["Native", "HoloPatcher", "TSLPatcher"] as const;
export type PatcherEngine = (typeof PATCHER_ENGINES)[number];

/** A whole instruction file. */
export interface InstructionFile {
  /** Authoritative Rust JSON for atomic authoring; mods/config are a display projection. */
  rustAuthoringGuide?: Record<string, unknown>;
  /** Unrecognized serialized fields preserved for lossless editing; not execution support. */
  metadata?: Record<string, unknown>;
  config: MainConfig;
  mods: ModComponent[];
}

/** Directories chosen by the user; both placeholders resolve to these. */
export interface Directories {
  modDirectory: string;
  kotorDirectory: string;
}

/** User-facing settings persisted between runs. */
export interface UserSettings extends Directories {
  patcherEngine: PatcherEngine;
  /** Path to an external holopatcher executable or `pykotor` cli. */
  holoPatcherPath?: string;
  /** Path to a TSLPatcher.exe when engine is TSLPatcher (wine on non-Windows). */
  tslPatcherPath?: string;
  /** Path to a 7z cli binary used as a fallback for exotic archives. */
  sevenZipPath?: string;
  compatibilityLevel: CompatibilityLevel;
  spoilerFree: boolean;
  platform: Platform;
  theme: "dark" | "light";
  /** Nexus Mods API key for direct downloads (optional). */
  nexusApiKey?: string;
  maxConcurrentDownloads: number;
  /** Where checkpoints live; default `<kotorDirectory>/.modsync/checkpoints`. */
  checkpointDirectory?: string;
  createCheckpoints: boolean;
  telemetryEnabled: boolean;
  verboseLogging: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Severity = "info" | "warning" | "error";

export interface ValidationIssue {
  severity: Severity;
  /** Stable machine code, e.g. "missing-archive", "cycle", "path-escape". */
  code: string;
  message: string;
  modGuid?: Guid;
  optionGuid?: Guid;
  instructionGuid?: Guid;
  /** Path involved, already resolved when available. */
  path?: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  /** True when no error-severity issue exists. */
  ok: boolean;
  /** Resolved install order (GUIDs) computed during validation. */
  installOrder: Guid[];
  /** Files the dry run expects to exist in modDirectory before install. */
  requiredDownloads: RequiredDownload[];
}

export interface RequiredDownload {
  modGuid: Guid;
  modName: string;
  /** Glob or exact filename relative to modDirectory. */
  pattern: string;
  /** Whether a file matching the pattern was found. */
  found: boolean;
  matchedFiles: string[];
  links: string[];
}

// ---------------------------------------------------------------------------
// Execution results and events
// ---------------------------------------------------------------------------

export const RESULT_CODES = [
  "Success",
  "Skipped",
  "DependencyNotSelected",
  "RestrictionSelected",
  "FileNotFoundPre",
  "FileNotFoundPost",
  "PathEscape",
  "ArchiveError",
  "PatcherError",
  "ExecuteError",
  "UserCancelled",
  "UnknownInnerError",
  "UnknownError",
] as const;
export type ResultCode = (typeof RESULT_CODES)[number];

export interface InstructionResult {
  instructionGuid: Guid;
  modGuid: Guid;
  optionGuid?: Guid;
  action: ActionType;
  code: ResultCode;
  message?: string;
  /** Files created/modified/deleted by this step (resolved absolute paths). */
  touched: string[];
  durationMs: number;
  /** Checkpoint id created after this instruction, if any. */
  checkpointId?: string;
}

export interface ModResult {
  modGuid: Guid;
  state: InstallState;
  instructionResults: InstructionResult[];
  durationMs: number;
}

export interface InstallSummary {
  startedAt: string;
  finishedAt: string;
  mods: ModResult[];
  succeeded: number;
  failed: number;
  skipped: number;
  /** Explicit virtual result, never counted as physically Installed mods. */
  virtualPrediction?: import("../authoring/predictionRuntime.js").AuthoringPrediction;
  checkpointSessionId?: string;
  /** Fatal transaction/setup error; successful counts alone do not imply completed installation. */
  error?: string;
  recoveryPending?: boolean;
}

/** A question the installer asks the user mid-run (Choose action, patcher namespace, execute confirm). */
export interface UserPrompt {
  id: string;
  kind: "choose-folder" | "choose-option" | "patcher-namespace" | "confirm" | "message";
  title: string;
  message: string;
  choices: Array<{ id: string; label: string; description?: string; isDefault?: boolean }>;
  modGuid?: Guid;
  instructionGuid?: Guid;
  /** Allow "none of the above". */
  allowNone?: boolean;
}

export interface UserPromptAnswer {
  promptId: string;
  choiceId?: string;
  /** For confirm prompts. */
  accepted?: boolean;
}

/** Progress events streamed to the UI (WebSocket / Electron IPC). */
export type InstallEvent =
  | { type: "install-started"; total: number; order: Guid[] }
  | { type: "mod-started"; modGuid: Guid; index: number; total: number; name: string }
  | { type: "instruction-started"; modGuid: Guid; instructionGuid: Guid; action: ActionType; description: string }
  | { type: "instruction-finished"; result: InstructionResult }
  | { type: "mod-finished"; result: ModResult }
  | { type: "checkpoint-created"; checkpointId: string; isAnchor: boolean; index: number }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string }
  | { type: "prompt"; prompt: UserPrompt }
  | { type: "install-finished"; summary: InstallSummary }
  | { type: "install-cancelled" }
  | { type: "install-error"; message: string };

export type DownloadEvent =
  | { type: "download-queued"; id: string; modGuid: Guid; url: string }
  | { type: "download-started"; id: string; fileName?: string; totalBytes?: number }
  | { type: "download-progress"; id: string; receivedBytes: number; totalBytes?: number; bytesPerSecond: number }
  | { type: "download-finished"; id: string; fileName: string; path: string; sha1?: string }
  | { type: "download-failed"; id: string; error: string; url: string }
  | { type: "download-needs-browser"; id: string; url: string; reason: string };

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export interface CheckpointFileEntry {
  /** Path relative to kotorDirectory, always forward slashes. */
  path: string;
  /** SHA1 of the content; undefined for deleted files. */
  sha1?: string;
  size?: number;
  mtimeMs?: number;
}

export interface CheckpointMeta {
  id: string;
  sessionId: string;
  index: number;
  isAnchor: boolean;
  createdAt: string;
  label: string;
  modGuid?: Guid;
  instructionGuid?: Guid;
  /** Number of file entries changed relative to the previous checkpoint. */
  changedCount: number;
  /** Bytes added to the content-addressed store by this checkpoint. */
  storedBytes: number;
}

export interface CheckpointSession {
  id: string;
  kotorDirectory: string;
  createdAt: string;
  /** Anchor spacing: every Nth checkpoint is a full manifest. */
  anchorInterval: number;
  checkpoints: CheckpointMeta[];
}

// ---------------------------------------------------------------------------
// Logging / telemetry
// ---------------------------------------------------------------------------

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export interface TelemetryEvent {
  operation: string;
  success: boolean;
  durationMs: number;
  data?: Record<string, unknown>;
  errors?: string[];
}

export interface TelemetrySink {
  record(event: TelemetryEvent): void;
}
