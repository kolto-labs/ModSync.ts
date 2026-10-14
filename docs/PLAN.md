# ModSync (TypeScript) implementation plan

This document is the working contract between packages. Implementation agents
build against the module paths and signatures listed here. If you must deviate,
update this file in the same change.

## Goals (from the design brief)

ModSync is a multi-mod instruction builder and installer for KOTOR 1 and 2.
End users: load an instruction file, check/uncheck mods, pick directories,
press Install All. Developers: an editor that creates instruction files
(TOML) and generates the human docs (markdown) from them.

Hybrid delivery: one Fastify server (`@modsync/server`) drives `@modsync/core`.
`@modsync/electron` hosts that server in-process and opens a BrowserWindow on it.
`@modsync/web` is the React UI served by that server and usable from a plain
browser on localhost. `@modsync/cli` exposes validate/install/docs/import.

## Packages

| package | responsibility |
|---|---|
| `@modsync/kotor-formats` | Binary readers/writers: GFF, 2DA, TLK, SSF, ERF/MOD/RIM, resource type table. TSLPatcher-compatible `changes.ini` / `namespaces.ini` engine (native). |
| `@modsync/core` | Domain model, TOML + markdown serialization, path sandbox, VFS + real fs, archive adapters, selection/ordering, validation (dry run), actions, installer, checkpoints, downloads, widescreen, settings, logging. No HTTP. |
| `@modsync/server` | Fastify REST + WebSocket, serves web bundle, directory browser, session token. |
| `@modsync/web` | React + Vite wizard UI, editor, DAG view. Only imports types from core (`@modsync/core/model` types are browser-safe). |
| `@modsync/electron` | Main process: start server on 127.0.0.1:0 with a token, BrowserWindow, preload with `pickDirectory/pickFile/openExternal`. |
| `@modsync/cli` | `modsync validate|install|dry-run|docs|import-md|checkpoints|serve`. |

## Core module map and public API

All core source lives in `packages/core/src`. `index.ts` re-exports everything below.

### `model/` (done)
`types.ts`, `guid.ts`, `defaults.ts`. See file for the domain model.

### `ports/` (done)
`filesystem.ts` (`FileSystemPort`, including optional `realpath` for canonical containment checks), `archive.ts` (`ArchiveReader`, `ArchiveOpener`).

### `fs/`
- `paths.ts`
  - `class PathResolver { constructor(dirs: Directories); resolve(raw: string): string; resolveMany(raw: string[]): string[]; }`
    Replaces `<<modDirectory>>` / `<<kotorDirectory>>` (case-insensitive), converts `\` to `/`, normalizes `..`, and throws `PathEscapeError` when the result is outside either root. Placeholder-less relative paths are an error. A bare `<<kotorDirectory>>` resolves to the root itself.
  - `isInsideRoot(root: string, candidate: string): boolean`
  - `hasWildcard(p: string): boolean`
  - `toPosix(p: string): string`, `toNative(p: string): string`
- `realFileSystem.ts`: `class RealFileSystem implements FileSystemPort` (node:fs/promises, case-insensitive `resolveCase` by scanning the parent directory).
- `virtualFileSystem.ts`: `class VirtualFileSystem implements FileSystemPort` overlay over a `FileSystemPort` base (snapshot lazily on first touch of a directory). Records mutations. `constructor(base: FileSystemPort)`. Extra: `getMutations(): VfsMutation[]`, `addVirtualFiles(entries: {path; size}[])` (used by simulated Extract).
- `wildcards.ts`: `resolveWildcards(fs: FileSystemPort, absolutePattern: string): Promise<string[]>` using picomatch against listings, case-insensitive. Non-wildcard input returns `[input]` if it exists (case-resolved) or `[]`.

### `archive/`
- `index.ts`: `openArchive(path: string, opts?: { sevenZipPath?: string }): Promise<ArchiveReader>`, `detectArchiveFormat(path): Promise<ArchiveFormat | undefined>`, `isArchiveExtension(name)`.
- Extraction accepts optional `beforeWrite` and `signal` hooks; ZIP streams directly, while RAR/7z codecs extract to private disk staging and stream each validated regular file to its destination. All native writes check canonical containment immediately before writing, and checkpoint predictions list output paths so partial cancelled extraction can be rolled back.
- `zip.ts` (yauzl), `rar.ts` (node-unrar-js), `sevenZip.ts` (7z-wasm; with optional CLI fallback via `sevenZipPath`), `sfx.ts` (locate the `37 7A BC AF 27 1C` signature with chunked reads, hand the slice to the 7z adapter).

### `serialization/`
- `toml.ts`: `parseInstructionFile(text: string): InstructionFile`, `serializeInstructionFile(file: InstructionFile): string`.
  Lenient parse: keys case-insensitive; `Source` string or array; GUIDs braced or not; both `[[thisMod]]` and `[[modList]]` root tables, with `[[thisMod.Instructions]]` and `[[thisMod.Options]]` (`[[thisMod.Options.Instructions]]`). Top-level `[Config]` table maps to `MainConfig`. Serialize in the C# style (PascalCase keys, braced upper GUIDs, `[[thisMod]]`).
- `normalize.ts`: `normalizeTier(text): Tier`, `normalizeCategories(text): Category[]`, `parseCategoryAndTier("Bugfix & Immersion / 2 - Recommended")`.
- `markdown/parser.ts`: `parseMarkdownBuild(md: string, profile?: MarkdownImportProfile): MarkdownImportResult { file: InstructionFile; warnings: string[] }`. Handles: `## Mod List` boundaries, `### Name` / `## Name` headings, `**Name:** [text](link)`, `**Author:**`, `**Description:**`, `**Category & Tier:**`, `**Non-English Functionality:**`, `**Installation Method:**`, `**Installation Instructions:**` (natural language + structured keywords `**EXTRACT**`, `**MOVE ALL**`, `**MOVE SPECIFIC**`, `**DELETE**`, `**RENAME**`, `**RUN**`/`**PATCHER**`, `**SKIP**`), `**Masters:**`, `**Usage Warnings:**`, hidden `<!-- [HIDDEN:MOD] ... [ENDHIDDEN] -->` TOML block, hidden `<!--<<ModSync>> ... -->` YAML block, before/aspyr/widescreen/after sections. Unknown paragraphs are kept as `directions`.
- `markdown/generator.ts`: `generateMarkdownDocs(file: InstructionFile, style: "reddit" | "deadlystream" | "structured"): string` and `describeInstruction(instr, mod): string` (under five sources enumerate, otherwise "everything in ...").
- `markdown/autoInstructions.ts`: `generateInstructionsFromDescription(mod): Instruction[]` heuristics (archive -> Extract; TSLPatcher -> Patcher; loose-file -> Move to Override).
- `merge.ts`: `mergeInstructionFiles(existing: InstructionFile, incoming: InstructionFile): MergeResult { file; added: Guid[]; updated: Guid[]; removed: Guid[]; conflicts: MergeConflict[] }` matching by GUID then by normalized name; existing instructions win unless incoming has instructions and existing has none.
- `cleanlist.ts`: `parseCleanList(csv: string): CleanListEntry[]` (`{ modName: string; files: string[] }`), `matchCleanListEntry(entry, selectedModNames): boolean` (exact case-insensitive or partial containment either way).

### `engine/`
- `selection.ts`: `computeSelection(file, settings): SelectionSet` where `SelectionSet = { selectedGuids: Set<Guid>; mods: ModComponent[]; options: Map<Guid, ModOption>; names: Map<Guid, string> }`. Applies spoiler-free (`fullBuildOnly` removed), platform (`aspyrOnly` only on Mobile), and includes selected options' GUIDs. `isSelected(sel, guid)`, `checkSelectionConstraints(file, sel, level): ValidationIssue[]` (dependencies missing, restrictions violated, untested pairs without Untested level, exclusive option groups).
- `order.ts`: `computeInstallOrder(file, sel): { order: Guid[]; issues: ValidationIssue[] }` Kahn's algorithm, min-heap keyed by file index (stable), cycle reported with the path.
- `graph.ts`: `buildDependencyGraph(file): { nodes: GraphNode[]; edges: GraphEdge[] }` for the DAG view (`kind: "dependency" | "restriction" | "installAfter" | "installBefore" | "untested"`).
- `context.ts`: `interface InstallContext { fs: FileSystemPort; resolver: PathResolver; dirs: Directories; settings: UserSettings; selection: SelectionSet; logger: Logger; prompt: (p: UserPrompt) => Promise<UserPromptAnswer>; dryRun: boolean; openArchive: typeof openArchive; patcher: PatcherPort; telemetry?: TelemetrySink; signal?: AbortSignal }`.
- `actions/*.ts`: one file per action exporting `execute<Action>(ctx, instruction, mod, option?): Promise<InstructionResult>`; `actions/index.ts` exports `executeInstruction(ctx, instruction, mod, option?)` which first evaluates per-instruction dependencies/restrictions and platform and returns `DependencyNotSelected` / `RestrictionSelected` / `Skipped` without running.
  Semantics:
  - Extract: source archives (wildcards ok) -> extract into `<archive dir>/<archive name without extension>/` unless `destination` given. In dryRun, list entries and add them to the VFS.
  - Move/Copy: each resolved source (file or directory) -> destination directory (created). Directory into directory merges. `overwrite=false` skips existing files (info log). Missing source -> `FileNotFoundPre`.
  - Delete: missing file -> warning, still Success. Wildcards ok.
  - Rename: single source file -> `destination` is the new file name (in the same directory) or an absolute path.
  - Execute: spawn (real run) with `arguments`; in dryRun only checks existence. Require `ctx.prompt` confirm when `settings.platform` is web mode? No: always allowed but always logged; server gates it with a confirm prompt.
  - Patcher: source = path to `tslpatcher.exe`/`TSLPatcher.exe`/`holopatcher` or a directory containing `tslpatchdata`; destination = kotor dir. `arguments` = namespace index (0-based) or ini name. Uses `ctx.patcher` (`PatcherPort.install({ tslpatchdataDir, gameDir, namespaceIndex?, iniName?, dryRun })`). If a `namespaces.ini` exists and no argument, prompt `patcher-namespace`.
  - Choose: sources are either GUIDs (options) or folder paths/wildcards. Prompt `choose-folder` / `choose-option` unless exactly one candidate or a selected option already answers it. The chosen folder's contents are moved to `destination` (default `<<kotorDirectory>>/Override`).
  - DelDuplicate: within the resolved source directories, when two files share a base name and one has extension `arguments` (e.g. `.tpc`) while another exists (`.tga`), delete the one with extension `arguments`.
  - CleanList: `source[0]` is the CSV, `destination` a directory; for each entry whose mod name matches a selected mod name, delete listed files from destination (missing files logged verbose). Also matches option names.
- `validator.ts`: `validate(file, settings, opts?: { openArchive?; baseFs?: FileSystemPort }): Promise<ValidationReport>`. Full dry run: selection constraints, order, then executes every instruction against a `VirtualFileSystem` with `dryRun: true` and auto-answering prompts with defaults; collects issues (`missing-archive`, `missing-source`, `no-extract-for-archive`, `path-escape`, `unknown-guid`, `duplicate-guid`, `cycle`, ...). `requiredDownloads` lists archives referenced by Extract sources.
- `installer.ts`: `class Installer extends EventEmitter` (typed `on("event", (e: InstallEvent) => void)`). `constructor(file, settings, deps: { fs?: FileSystemPort; logger?: Logger; patcher?: PatcherPort; checkpoints?: CheckpointStore; telemetry?; openArchive? })`. `run(opts?: { phase?: "base" | "widescreen"; modGuids?: Guid[] }): Promise<InstallSummary>`, `answerPrompt(answer: UserPromptAnswer): void`, `cancel(): void`. Runs mods in computed order, instructions in order, creates a checkpoint after each instruction when enabled, emits events. Mod-level dependency/restriction failure marks the mod `Skipped`.
- `patcherPort.ts`: `interface PatcherPort { install(req: PatcherRequest): Promise<PatcherResult> }`, `createPatcher(settings): PatcherPort` which picks Native (from `@modsync/kotor-formats`), HoloPatcher (spawn `holoPatcherPath --install --game-dir --tslpatchdata --namespace-option-index`), or TSLPatcher (spawn exe, wine on non-Windows).

### `checkpoints/`
- `store.ts`: `class CheckpointStore { constructor(opts: { rootDir: string; kotorDirectory: string; fs?: FileSystemPort; anchorInterval?: number }); startSession(label): Promise<CheckpointSession>; create(session, meta: { label; modGuid?; instructionGuid?; touched: string[] }): Promise<CheckpointMeta>; list(): Promise<CheckpointSession[]>; restore(sessionId, checkpointId, onProgress?): Promise<void>; delete(sessionId): Promise<void> }`.
  Layout: `<rootDir>/cas/<sha1[0..2]>/<sha1>` content blobs, `<rootDir>/sessions/<sessionId>/session.json`, `<rootDir>/sessions/<sessionId>/<index>.json` (anchor = full manifest of tracked files; non-anchor = delta list of `CheckpointFileEntry` changed vs previous). Restoring walks back to the nearest anchor then forward using the session's recorded anchor interval. Session metadata, relative manifest paths, and SHA1 references are validated; restore preflights all blob hashes and canonical destination containment before changing game files. Patcher/Execute instructions snapshot existing game files before running and scan afterward to track opaque changes. Installation fails closed when a requested checkpoint session or baseline cannot be captured; checkpoint persistence failure marks the instruction failed and stops further work. The first failed mod stops guide execution. Preflight and setup errors emit both install-error and terminal install-finished events with a nonzero failed summary. Checkpoint 0 (baseline) stores only metadata plus hashes of files touched later (lazy: before a file is first overwritten/deleted, its current content is stored in the CAS).

### `downloads/`
- `manager.ts`: `class DownloadManager extends EventEmitter` (`DownloadEvent`). `enqueue(modGuid, url, opts?)`, `start()`, `pause()`, `list()`. Direct HTTP with `fetch`, filename from `Content-Disposition` or URL, resume with Range, SHA1 on completion, `maxConcurrentDownloads`. Nexus: with `nexusApiKey` use the API (`/v1/games/{game}/mods/{id}/files/{fileId}/download_link.json`) else emit `download-needs-browser`. DeadlyStream and unknown hosts that return HTML emit `download-needs-browser`. `nxm://` links are opened via a callback (Vortex).
- `hosts.ts`: `classifyUrl(url): { host: "nexus" | "deadlystream" | "github" | "mega" | "direct" | "other"; game?; modId?; fileId? }`.

### `widescreen/`
- `uniws.ts`: `patchExecutableResolution(exeBytes: Uint8Array, game: TargetGame, width: number, height: number): { patched: Uint8Array; offsets: number[] }` (search for the little-endian 4:3 pairs 640x480, 800x600, 1024x768, 1280x960, 1600x1200 in the known `swkotor.exe` / `swkotor2.exe` resolution table pattern and replace the highest entry; refuse when no pattern is found). `detectResolutions(bytes)`.
- `gui.ts`: `resizeGuiFile(gffBytes, from: {w,h}, to: {w,h}): Uint8Array` scaling `EXTENT`/`LEFT`/`TOP`/`WIDTH`/`HEIGHT` fields in `.gui` GFFs (uses kotor-formats).

### `settings/`
- `settings.ts`: `loadSettings(path?): Promise<UserSettings>`, `saveSettings(settings, path?)`, `defaultSettingsPath()` (`~/.config/modsync/settings.json`, or `%APPDATA%/ModSync`).

### `logging/`
- `logger.ts`: `createLogger(opts: { level; file?: string; sink?: (line) => void }): Logger`, `NullLogger`.
- `telemetry.ts`: `InMemoryTelemetry`, `NullTelemetry`.

### `game/`
- `detect.ts`: `detectGame(kotorDirectory, fs): Promise<{ game: TargetGame; isAspyr: boolean; executable?: string }>` (swkotor.exe / swkotor2.exe / KOTOR2 (Aspyr, macOS/Steam) markers). `installedModsFromOverride`.

## kotor-formats public API

`packages/kotor-formats/src/index.ts` exports:
- `gff.ts`: `readGff(bytes): GffRoot`, `writeGff(root, fileType: string): Uint8Array`, `GffStruct`, `GffField`, `GffFieldType` enum, path helpers `getFieldByPath(root, "A/B/0/C")`, `setFieldByPath`.
- `twoda.ts`: `read2da(bytes): TwoDA`, `write2da(t): Uint8Array`, `class TwoDA { columns; rows: { label; cells: Map<string,string> }[]; getCell; setCell; addRow; addColumn; findRow; copyRow }`.
- `tlk.ts`: `readTlk`, `writeTlk`, `class Tlk { language; entries: { text; soundResRef; }[] }`.
- `ssf.ts`: `readSsf`, `writeSsf`.
- `erf.ts`: `readErf`, `writeErf` (ERF/MOD/SAV), `readRim`, `writeRim`, `Encapsulated { resources: { resref; type; data }[] }`.
- `restypes.ts`: `ResourceType` table id<->extension.
- `tslpatcher/`: `parseChangesIni(text): PatcherConfig`, `parseNamespacesIni(text): Namespace[]`, `class TslPatcher { constructor(opts: { tslpatchdataDir; gameDir; fs; logger; dryRun }); apply(config): Promise<PatcherLog> }` implementing TLKList, InstallList, 2DAList, GFFList, SSFList, and HACKList; CompileList installs precompiled `.ncs` from tslpatchdata when present and no source memory substitutions require compilation; missing binaries or sources requiring substitution produce an error because a native compiler is not bundled. Backups written to `<gameDir>/backup/<timestamp>/` with `uninstall.rdf`-style listing (`modsync-uninstall.json`).

## Server API (`@modsync/server`)

Base URL `http://127.0.0.1:<port>`; every request carries `Authorization: Bearer <token>` when the server was started with a token (Electron does; `modsync serve` prints it or `--no-token`).

```
GET  /api/health                      -> { ok, version, platform, isElectron }
GET  /api/settings                    -> UserSettings
PUT  /api/settings                    <- Partial<UserSettings>
GET  /api/fs/roots                    -> { roots: string[] }
GET  /api/fs/browse?path=             -> { path, parent, entries: DirEntry[] }
GET  /api/game/detect?path=           -> detectGame result
POST /api/file/load                   <- { path } | { content } | { url }   -> InstructionFile
GET  /api/file                        -> InstructionFile | null
PUT  /api/file                        <- InstructionFile (editor)
POST /api/file/save                   <- { path }
POST /api/file/import-markdown        <- { content } | { path } -> { file, warnings }
POST /api/file/export-markdown        <- { style } -> { markdown }
POST /api/file/merge                  <- { content } -> MergeResult
PUT  /api/mods/:guid/selection        <- { selected: boolean; options?: Record<Guid, boolean> }
POST /api/mods/select-defaults        <- { tier?: Tier }  (select Essential etc.)
GET  /api/selection                   -> { selectedGuids, order, issues }
GET  /api/graph                       -> { nodes, edges }
POST /api/validate                    -> ValidationReport
POST /api/install                     <- { phase?: "base"|"widescreen"; modGuids? } -> { sessionId }
POST /api/install/cancel
POST /api/install/answer              <- UserPromptAnswer
GET  /api/install/status              -> { running, currentMod, summary?, pendingPrompt? }
GET  /api/downloads                   -> list
POST /api/downloads/start             <- { modGuids? }
POST /api/downloads/open-browser      <- { url }   (Electron: shell.openExternal)
GET  /api/checkpoints                 -> CheckpointSession[]
POST /api/checkpoints/:session/:id/restore
GET  /api/logs?since=                 -> lines
WS   /ws?token=                       server -> client: { seq, event: InstallEvent | DownloadEvent }
                                      client -> server: { type: "replay", lastSeq } | { type: "answer", answer }
```

Server module map: `src/main.ts` (start standalone, parse `--port --host --token --open`), `src/createServer.ts` (`createModSyncServer(opts: { token?: string; staticDir?: string; settingsPath?; electronBridge?: { pickDirectory; pickFile; openExternal } }): Promise<{ app: FastifyInstance; listen(port, host): Promise<string> }>`), `src/state.ts` (AppState: settings, file, installer, downloads, ring buffer), `src/routes/*.ts`, `src/ws.ts`.

## Web UI (`@modsync/web`)

Vite app, React 19, no UI framework (hand-written CSS with dark/light themes). `src/api/client.ts` (typed fetch + WS with seq replay), `src/state/store.ts` (a small store with `useSyncExternalStore`), `src/wizard/` one component per page in the exact order below, `src/editor/` (mod list, mod form, instruction form with Browse Source into archives via `/api/fs/browse` and an archive listing endpoint `GET /api/archive/list?path=`), `src/graph/DagView.tsx` (SVG, layered layout, no external lib).

Wizard order (skip empty/irrelevant pages): Welcome, BeforeContent, Setup, AspyrNotice, ModSelection, DownloadsExplain, Validate (block Next on errors), InstallStart (three confirmations), Installing (slideshow + log), BaseInstallComplete, WidescreenNotice, WidescreenModSelection, WidescreenInstalling, WidescreenComplete, Finished. Everywhere: "Show Downloads" drawer, spoiler-free toggle (hides descriptions/links), theme toggle, "Editor mode" link.

## Electron (`@modsync/electron`)

`src/main.ts`: create server with random token and `staticDir` = built web bundle, `BrowserWindow` loads `http://127.0.0.1:<port>/?token=...`, `contextIsolation: true`, preload exposes `window.modsync = { pickDirectory(), pickFile(filters), openExternal(url), isElectron: true }`. IPC handlers use `dialog.showOpenDialog`. Single instance lock. `nxm://` protocol registration for Nexus.

## CLI (`@modsync/cli`)

`modsync validate <file.toml> --mods <dir> --kotor <dir>`, `modsync install ... [--phase base|widescreen] [--select guid,guid] [--all-essential] [--engine native|holopatcher|tslpatcher]`, `modsync dry-run`, `modsync docs <file.toml> --style deadlystream -o full.md`, `modsync import-md <full.md> -o file.toml [--merge existing.toml]`, `modsync checkpoints list|restore`, `modsync serve [--port] [--open]`.

## Testing

vitest at repo root. Fixtures are generated on the fly (zip via fflate, 7z via 7z-wasm, KOTOR skeleton via kotor-formats writers). Small checked-in RAR fixture allowed. Property tests for ordering with hand-rolled random DAGs (no fast-check dependency).

## Things ModSync refuses to do (from the brief, keep it that way)

No hardcoded mod names in core. No arbitrary `.bat` execution as the compatibility mechanism (CleanList replaces it). No EXE/DLL edits except the explicit, opt-in widescreen module. HoloPatcher-style fail-closed on malformed `changes.ini`. End users never edit TOML: the editor is a separate mode.
