/**
 * In-memory fake of the ModSync server, enabled with `?mock=1` or `VITE_MOCK=1`.
 *
 * It serves a small instruction file (6 mods with options, dependencies,
 * restrictions, an untested pair, a widescreen mod, an aspyrOnly mod and a
 * fullBuildOnly mod), simulates validation, an install run that streams
 * InstallEvents (including a `choose-option` prompt), downloads with progress
 * and a "needs browser" case, checkpoints and a tiny fake file system.
 */
import type { ApiClient, EventBus, ServerEvent } from "./client";
import type {
  ArchiveListResult,
  BrowseResult,
  CheckpointSession,
  DownloadItem,
  Guid,
  InstallSummary,
  Instruction,
  InstructionFile,
  ModComponent,
  ModOption,
  ModResult,
  RequiredDownload,
  SelectionResult,
  UserPrompt,
  UserPromptAnswer,
  UserSettings,
  ValidationIssue,
  ValidationReport,
  GraphResult,
  GraphEdge,
} from "../types";

const G = {
  k1cp: "11111111-1111-4111-8111-111111111111",
  hires: "22222222-2222-4222-8222-222222222222",
  hiresOptA: "22222222-2222-4222-8222-2222222222a1",
  hiresOptB: "22222222-2222-4222-8222-2222222222b2",
  hiresOptC: "22222222-2222-4222-8222-2222222222c3",
  jedi: "33333333-3333-4333-8333-333333333333",
  brotherhood: "44444444-4444-4444-8444-444444444444",
  aspyr: "55555555-5555-4555-8555-555555555555",
  widescreen: "66666666-6666-4666-8666-666666666666",
  fullbuild: "77777777-7777-4777-8777-777777777777",
} as const;

let guidCounter = 0;
function fakeGuid(): Guid {
  guidCounter++;
  return `aaaaaaaa-0000-4000-8000-${String(guidCounter).padStart(12, "0")}`;
}

function instr(action: Instruction["action"], source: string[], extra: Partial<Instruction> = {}): Instruction {
  return { guid: fakeGuid(), action, source, overwrite: true, dependencies: [], restrictions: [], ...extra };
}

function mod(partial: Partial<ModComponent> & { guid: Guid; name: string }): ModComponent {
  return {
    authors: [],
    modLink: [],
    category: [],
    tier: "Unknown",
    installationMethod: "Unknown",
    dependencies: [],
    restrictions: [],
    installAfter: [],
    installBefore: [],
    untestedWith: [],
    instructions: [],
    options: [],
    isSelected: false,
    installState: "NotInstalled",
    isDownloaded: false,
    fullBuildOnly: false,
    isWidescreen: false,
    aspyrOnly: false,
    isPatch: false,
    ...partial,
  };
}

function option(partial: Partial<ModOption> & { guid: Guid; name: string }): ModOption {
  return {
    dependencies: [],
    restrictions: [],
    installAfter: [],
    installBefore: [],
    instructions: [],
    isSelected: false,
    ...partial,
  };
}

export function createMockFile(): InstructionFile {
  const mods: ModComponent[] = [
    mod({
      guid: G.k1cp,
      name: "KOTOR 1 Community Patch",
      description:
        "A compilation of previous bugfix mods and a number of new fixes. Corrects hundreds of bugs, typos and other issues left in the game.",
      directions: "Run the installer and choose the **K1CP** namespace when asked.",
      authors: ["A Future Pilot", "DarthParametric", "JCarter426"],
      modLink: ["https://deadlystream.com/files/file/1258-kotor-1-community-patch/"],
      expectedFiles: ["KOTOR1CommunityPatch*.zip"],
      category: ["Bugfix"],
      tier: "Essential",
      installationMethod: "TSLPatcher",
      language: "YES",
      isSelected: true,
      installBefore: [G.hires],
      images: ["https://picsum.photos/seed/k1cp/640/360"],
      instructions: [
        instr("Extract", ["<<modDirectory>>/KOTOR1CommunityPatch*.zip"], { description: "Extract the community patch" }),
        instr("Patcher", ["<<modDirectory>>/KOTOR1CommunityPatch/tslpatchdata"], {
          destination: "<<kotorDirectory>>",
          description: "Run the TSLPatcher install",
        }),
      ],
    }),
    mod({
      guid: G.hires,
      name: "Ultimate Character Overhaul",
      description:
        "AI-upscaled character textures for every party member and NPC. Pick a texture resolution below.",
      directions: "The Extract instruction unpacks a **huge** archive; it may take a few minutes.",
      authors: ["ShiningRedHD"],
      modLink: ["https://www.nexusmods.com/kotor/mods/1282"],
      expectedFiles: ["Ultimate_Character_Overhaul_*.7z"],
      category: ["Graphics Improvement", "Appearance Change"],
      tier: "Recommended",
      installationMethod: "Loose-File",
      language: "YES",
      isSelected: true,
      dependencies: [G.k1cp],
      untestedWith: [G.brotherhood],
      usageWarnings: "Requires at least 4 GB of free disk space.",
      images: ["https://picsum.photos/seed/uco1/640/360", "https://picsum.photos/seed/uco2/640/360"],
      instructions: [
        instr("Extract", ["<<modDirectory>>/Ultimate_Character_Overhaul_*.7z"]),
        instr("Move", ["<<modDirectory>>/Ultimate_Character_Overhaul_*/Override/*"], {
          destination: "<<kotorDirectory>>/Override",
        }),
        instr("Choose", [G.hiresOptA, G.hiresOptB], { description: "Pick a texture resolution" }),
      ],
      options: [
        option({
          guid: G.hiresOptA,
          name: "2K textures",
          description: "Balanced quality, recommended for most GPUs.",
          isSelected: true,
          exclusiveGroup: "resolution",
          instructions: [
            instr("Move", ["<<modDirectory>>/Ultimate_Character_Overhaul_*/2K/*"], {
              destination: "<<kotorDirectory>>/Override",
            }),
          ],
        }),
        option({
          guid: G.hiresOptB,
          name: "4K textures",
          description: "Highest quality. Needs a lot of VRAM.",
          exclusiveGroup: "resolution",
          instructions: [
            instr("Move", ["<<modDirectory>>/Ultimate_Character_Overhaul_*/4K/*"], {
              destination: "<<kotorDirectory>>/Override",
            }),
          ],
        }),
        option({
          guid: G.hiresOptC,
          name: "Include cutscene textures",
          description: "Also replaces the pre-rendered movie textures.",
          instructions: [
            instr("Move", ["<<modDirectory>>/Ultimate_Character_Overhaul_*/Movies/*"], {
              destination: "<<kotorDirectory>>/Movies",
            }),
          ],
        }),
      ],
    }),
    mod({
      guid: G.jedi,
      name: "JC's Jedi Tailor",
      description: "Adds a tailor on Dantooine who lets you customize your robes. Contains **story spoilers** for the Dantooine arc.",
      authors: ["JCarter426"],
      modLink: ["https://deadlystream.com/files/file/1236-jcs-jedi-tailor/"],
      expectedFiles: ["JC_JediTailor_K1_1.3.zip"],
      category: ["Added Content", "Immersion"],
      tier: "Suggested",
      installationMethod: "TSLPatcher",
      language: "PARTIAL - dialogue is English only",
      dependencies: [G.k1cp],
      restrictions: [G.brotherhood],
      instructions: [
        instr("Extract", ["<<modDirectory>>/JC_JediTailor_K1_1.3.zip"]),
        instr("Patcher", ["<<modDirectory>>/JC_JediTailor_K1_1.3/TSLPatcher.exe"], { destination: "<<kotorDirectory>>" }),
      ],
    }),
    mod({
      guid: G.brotherhood,
      name: "Brotherhood of Shadow: Solomon's Revenge",
      description: "A massive story mod adding a new planet and hours of content. This is not spoiler-free.",
      authors: ["Silveredge9"],
      modLink: ["https://deadlystream.com/files/file/1236-brotherhood-of-shadow/"],
      expectedFiles: ["BoSSR_1.1.rar"],
      category: ["Added Content", "Story"],
      tier: "Optional",
      installationMethod: "Mixed",
      language: "NO",
      fullBuildOnly: true,
      dependencies: [G.k1cp],
      restrictions: [G.jedi],
      usageWarnings: "Incompatible with JC's Jedi Tailor.",
      instructions: [
        instr("Extract", ["<<modDirectory>>/BoSSR_1.1.rar"]),
        instr("Execute", ["<<modDirectory>>/BoSSR_1.1/install.exe"], { arguments: "/silent" }),
      ],
    }),
    mod({
      guid: G.aspyr,
      name: "Aspyr Steam Patch Compatibility Fix",
      description: "Restores compatibility for the Aspyr (Steam / mobile) build.",
      authors: ["Community"],
      modLink: ["https://github.com/example/aspyr-fix/releases"],
      expectedFiles: ["aspyr-fix.zip"],
      category: ["Patch"],
      tier: "Essential",
      installationMethod: "Loose-File",
      aspyrOnly: true,
      isPatch: true,
      instructions: [
        instr("Extract", ["<<modDirectory>>/aspyr-fix.zip"], { platform: "Mobile" }),
        instr("Copy", ["<<modDirectory>>/aspyr-fix/*"], { destination: "<<kotorDirectory>>/Override", platform: "Mobile" }),
      ],
    }),
    mod({
      guid: G.widescreen,
      name: "KOTOR High Resolution Menus",
      description: "Widescreen support for the main menu and in-game GUI. Applied in the widescreen phase.",
      directions: "Make sure UniWS has already patched your executable resolution.",
      authors: ["ndix UR"],
      modLink: ["https://deadlystream.com/files/file/1264-kotor-high-resolution-menus/"],
      expectedFiles: ["kotor_hi_res_menus*.zip"],
      category: ["Widescreen", "UI"],
      tier: "Recommended",
      installationMethod: "Loose-File",
      isWidescreen: true,
      installAfter: [G.hires],
      instructions: [
        instr("Extract", ["<<modDirectory>>/kotor_hi_res_menus*.zip"]),
        instr("Choose", ["<<modDirectory>>/kotor_hi_res_menus*/*x*"], {
          destination: "<<kotorDirectory>>/Override",
          description: "Pick your resolution folder",
        }),
      ],
    }),
    mod({
      guid: G.fullbuild,
      name: "Movie-Style Ending Cinematic",
      description: "Replaces the ending cinematic with a fan-made movie-style cutscene. Full build only.",
      authors: ["Fan Cinematics"],
      modLink: ["https://www.nexusmods.com/kotor/mods/9999"],
      expectedFiles: ["ending-cinematic.zip"],
      category: ["Story", "Immersion"],
      tier: "Optional",
      installationMethod: "Loose-File",
      fullBuildOnly: true,
      instructions: [
        instr("Extract", ["<<modDirectory>>/ending-cinematic.zip"]),
        instr("Move", ["<<modDirectory>>/ending-cinematic/*.bik"], { destination: "<<kotorDirectory>>/Movies" }),
        instr("DelDuplicate", ["<<kotorDirectory>>/Override"], { arguments: ".tpc" }),
      ],
    }),
  ];
  return {
    config: {
      name: "KOTOR 1 Demo Build (mock)",
      targetGame: "KOTOR1",
      version: "mock-1",
      author: "ModSync mock",
      description: "A synthetic instruction file that exercises every UI feature.",
      beforeModListContent: [
        "# Before you start",
        "",
        "This build expects a **fresh install** of the game. Back up your `Override` folder first.",
        "",
        "## Requirements",
        "",
        "- A legal copy of the game (Steam, GOG or disc)",
        "- About *8 GB* of free disk space",
        "- Patience: TSLPatcher steps can take a while",
        "",
        "1. Install the game",
        "2. Run it once so the config file exists",
        "3. Come back here and press Next",
        "",
        "See the [KOTOR mod build guide](https://kotor.neocities.org/) for the original documentation.",
        "",
        "```",
        "swkotor.exe -> should be in your game directory",
        "```",
      ].join("\n"),
      aspyrSectionContent: "## Aspyr users\n\nThe Aspyr version needs the **Steam patch compatibility fix**. Select it on the next page.",
      widescreenSectionContent:
        "## Widescreen\n\nWidescreen mods patch the executable and GUI files. They are installed in a separate phase after the base build. **Make a backup.**",
      afterModListContent: "# All done\n\nLaunch the game and enjoy. Report problems on the [DeadlyStream forums](https://deadlystream.com).",
      compatibilityLevel: "Compatible",
      patcherEngine: "Native",
      spoilerFree: false,
      platform: "PC",
      sourceUrl: "https://example.invalid/full.md",
    },
    mods,
  };
}

// ---------------------------------------------------------------------------

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface MockState {
  settings: UserSettings;
  file: InstructionFile | null;
  running: boolean;
  cancelled: boolean;
  currentMod?: Guid;
  summary?: InstallSummary;
  pendingPrompt?: UserPrompt;
  promptResolver?: (a: UserPromptAnswer) => void;
  downloads: DownloadItem[];
  checkpoints: CheckpointSession[];
  logs: string[];
}

const fakeFs: Record<string, string[]> = {
  "/": ["home", "mnt", "opt"],
  "/home": ["user"],
  "/home/user": ["Games", "Mods", "Downloads"],
  "/home/user/Games": ["KOTOR", "KOTOR2"],
  "/home/user/Games/KOTOR": ["Override", "Movies", "swkotor.exe", "dialog.tlk", "chitin.key"],
  "/home/user/Games/KOTOR/Override": [],
  "/home/user/Games/KOTOR/Movies": [],
  "/home/user/Games/KOTOR2": ["Override", "swkotor2.exe", "KOTOR2.exe"],
  "/home/user/Games/KOTOR2/Override": [],
  "/home/user/Mods": [
    "KOTOR1CommunityPatch_1.10.0.zip",
    "Ultimate_Character_Overhaul_2K.7z",
    "JC_JediTailor_K1_1.3.zip",
    "kotor_hi_res_menus_1.5.zip",
    "build.toml",
  ],
  "/home/user/Downloads": ["something.txt"],
  "/mnt": ["c"],
  "/mnt/c": ["Program Files (x86)"],
  "/mnt/c/Program Files (x86)": ["Steam"],
  "/mnt/c/Program Files (x86)/Steam": ["steamapps"],
  "/mnt/c/Program Files (x86)/Steam/steamapps": ["common"],
  "/mnt/c/Program Files (x86)/Steam/steamapps/common": ["swkotor"],
  "/mnt/c/Program Files (x86)/Steam/steamapps/common/swkotor": ["swkotor.exe", "Override"],
  "/opt": [],
};

function isDir(path: string): boolean {
  return path in fakeFs;
}

export function createMockClient(events: EventBus): ApiClient {
  let seq = 0;
  const emit = (event: ServerEvent) => {
    seq++;
    events.emit({ seq, event });
  };
  const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
    state.logs.push(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`);
    emit({ type: "log", level, message });
  };

  const state: MockState = {
    settings: {
      modDirectory: "/home/user/Mods",
      kotorDirectory: "/home/user/Games/KOTOR",
      patcherEngine: "Native",
      compatibilityLevel: "Compatible",
      spoilerFree: false,
      platform: "PC",
      theme: "dark",
      maxConcurrentDownloads: 3,
      createCheckpoints: true,
      telemetryEnabled: false,
      verboseLogging: false,
    },
    // Preloaded so the wizard can be exercised immediately; Setup can still reload it.
    file: createMockFile(),
    running: false,
    cancelled: false,
    downloads: [],
    checkpoints: [],
    logs: [],
  };

  const allMods = () => state.file?.mods ?? [];
  const byGuid = (g: Guid) => allMods().find((m) => m.guid === g);
  const nameOf = (g: Guid) => {
    const m = byGuid(g);
    if (m) return m.name;
    for (const mm of allMods()) for (const o of mm.options) if (o.guid === g) return `${mm.name} / ${o.name}`;
    return g;
  };

  function effectiveSelected(): ModComponent[] {
    return allMods().filter((m) => {
      if (!m.isSelected) return false;
      if (state.settings.spoilerFree && m.fullBuildOnly) return false;
      if (m.aspyrOnly && state.settings.platform !== "Mobile") return false;
      return true;
    });
  }

  function computeSelection(): SelectionResult {
    const selected = effectiveSelected();
    const selectedSet = new Set(selected.map((m) => m.guid));
    for (const m of selected) for (const o of m.options) if (o.isSelected) selectedSet.add(o.guid);
    const issues: ValidationIssue[] = [];
    for (const m of selected) {
      for (const d of m.dependencies)
        if (!selectedSet.has(d))
          issues.push({ severity: "error", code: "dependency-missing", modGuid: m.guid, message: `${m.name} requires ${nameOf(d)}` });
      for (const r of m.restrictions)
        if (selectedSet.has(r))
          issues.push({ severity: "error", code: "restriction-selected", modGuid: m.guid, message: `${m.name} cannot be installed with ${nameOf(r)}` });
      for (const u of m.untestedWith)
        if (selectedSet.has(u) && state.settings.compatibilityLevel !== "Untested")
          issues.push({ severity: "error", code: "untested-pair", modGuid: m.guid, message: `${m.name} + ${nameOf(u)} is untested; set compatibility level to Untested to allow it` });
      const groups = new Map<string, number>();
      for (const o of m.options)
        if (o.isSelected && o.exclusiveGroup) groups.set(o.exclusiveGroup, (groups.get(o.exclusiveGroup) ?? 0) + 1);
      for (const [g, n] of groups)
        if (n > 1) issues.push({ severity: "error", code: "exclusive-group", modGuid: m.guid, message: `${m.name}: only one option of group "${g}" may be selected` });
    }
    // Kahn ordering keyed by file index
    const index = new Map(allMods().map((m, i) => [m.guid, i]));
    const edges = new Map<Guid, Set<Guid>>();
    const indeg = new Map<Guid, number>();
    for (const m of selected) {
      edges.set(m.guid, new Set());
      indeg.set(m.guid, 0);
    }
    const add = (a: Guid, b: Guid) => {
      if (!edges.has(a) || !edges.has(b) || edges.get(a)!.has(b)) return;
      edges.get(a)!.add(b);
      indeg.set(b, (indeg.get(b) ?? 0) + 1);
    };
    for (const m of selected) {
      for (const d of m.dependencies) add(d, m.guid);
      for (const a of m.installAfter) add(a, m.guid);
      for (const b of m.installBefore) add(m.guid, b);
    }
    const order: Guid[] = [];
    const ready = [...indeg.entries()].filter(([, n]) => n === 0).map(([g]) => g);
    while (ready.length) {
      ready.sort((a, b) => index.get(a)! - index.get(b)!);
      const g = ready.shift()!;
      order.push(g);
      for (const n of edges.get(g)!) {
        indeg.set(n, indeg.get(n)! - 1);
        if (indeg.get(n) === 0) ready.push(n);
      }
    }
    if (order.length !== selected.length)
      issues.push({ severity: "error", code: "cycle", message: "Dependency cycle detected between selected mods" });
    return { selectedGuids: [...selectedSet], order, issues };
  }

  function requiredDownloads(): RequiredDownload[] {
    const files = fakeFs[state.settings.modDirectory] ?? [];
    const out: RequiredDownload[] = [];
    for (const m of effectiveSelected()) {
      for (const pattern of m.expectedFiles ?? []) {
        const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
        const matched = files.filter((f) => re.test(f));
        out.push({ modGuid: m.guid, modName: m.name, pattern, found: matched.length > 0, matchedFiles: matched, links: m.modLink });
      }
    }
    return out;
  }

  async function runInstall(phase: "base" | "widescreen", modGuids?: Guid[]) {
    const sel = computeSelection();
    let mods = sel.order.map((g) => byGuid(g)!).filter((m) => (phase === "widescreen" ? m.isWidescreen : !m.isWidescreen));
    if (modGuids) mods = mods.filter((m) => modGuids.includes(m.guid));
    state.running = true;
    state.cancelled = false;
    state.summary = undefined;
    const session: CheckpointSession = {
      id: `session-${Date.now()}`,
      kotorDirectory: state.settings.kotorDirectory,
      createdAt: new Date().toISOString(),
      anchorInterval: 5,
      checkpoints: [],
    };
    state.checkpoints.unshift(session);
    const startedAt = new Date().toISOString();
    const results: ModResult[] = [];
    emit({ type: "install-started", total: mods.length, order: mods.map((m) => m.guid) });
    log("info", `Starting ${phase} install of ${mods.length} mod(s)`);
    let cpIndex = 0;
    const checkpoint = (label: string, modGuid?: Guid, instructionGuid?: Guid) => {
      const meta = {
        id: `cp-${cpIndex}`,
        sessionId: session.id,
        index: cpIndex,
        isAnchor: cpIndex % session.anchorInterval === 0,
        createdAt: new Date().toISOString(),
        label,
        modGuid,
        instructionGuid,
        changedCount: Math.floor(Math.random() * 40),
        storedBytes: Math.floor(Math.random() * 5_000_000),
      };
      session.checkpoints.push(meta);
      emit({ type: "checkpoint-created", checkpointId: meta.id, isAnchor: meta.isAnchor, index: cpIndex });
      cpIndex++;
    };
    checkpoint("baseline");
    outer: for (let i = 0; i < mods.length; i++) {
      const m = mods[i];
      state.currentMod = m.guid;
      emit({ type: "mod-started", modGuid: m.guid, index: i, total: mods.length, name: m.name });
      const modStart = Date.now();
      const modResult: ModResult = { modGuid: m.guid, state: "Installing", instructionResults: [], durationMs: 0 };
      const steps: Array<{ instruction: Instruction; option?: ModOption }> = m.instructions.map((instruction) => ({ instruction }));
      for (const o of m.options) if (o.isSelected) for (const instruction of o.instructions) steps.push({ instruction, option: o });
      for (const { instruction, option: opt } of steps) {
        if (state.cancelled) break outer;
        const desc = instruction.description ?? `${instruction.action} ${instruction.source.join(", ")}`;
        emit({ type: "instruction-started", modGuid: m.guid, instructionGuid: instruction.guid, action: instruction.action, description: desc });
        log("info", `${m.name}: ${desc}`);
        const t0 = Date.now();
        let code: InstallSummary["mods"][number]["instructionResults"][number]["code"] = "Success";
        let message: string | undefined;
        if (instruction.platform && instruction.platform !== state.settings.platform) {
          code = "Skipped";
          message = `Only for ${instruction.platform}`;
        } else if (instruction.action === "Choose" && instruction.source.length > 1) {
          const optionChoices = instruction.source.map((s) => ({ guid: s, opt: m.options.find((o) => o.guid === s) }));
          const isOptions = optionChoices.every((c) => c.opt);
          const answered = isOptions ? optionChoices.filter((c) => c.opt?.isSelected) : [];
          if (answered.length !== 1) {
            const prompt: UserPrompt = {
              id: `prompt-${Date.now()}`,
              kind: isOptions ? "choose-option" : "choose-folder",
              title: `Choose for ${m.name}`,
              message: desc,
              choices: isOptions
                ? optionChoices.map((c, idx) => ({ id: c.guid, label: c.opt!.name, description: c.opt!.description, isDefault: idx === 0 }))
                : [
                    { id: "1280x720", label: "1280x720", isDefault: true },
                    { id: "1920x1080", label: "1920x1080" },
                    { id: "2560x1440", label: "2560x1440" },
                  ],
              modGuid: m.guid,
              instructionGuid: instruction.guid,
              allowNone: true,
            };
            state.pendingPrompt = prompt;
            emit({ type: "prompt", prompt });
            const answer = await new Promise<UserPromptAnswer>((resolve) => {
              state.promptResolver = resolve;
            });
            state.pendingPrompt = undefined;
            state.promptResolver = undefined;
            if (state.cancelled) break outer;
            log("info", `User chose ${answer.choiceId ?? "none"}`);
            if (!answer.choiceId) code = "Skipped";
          } else {
            log("debug", `Choose auto-answered by selected option ${answered[0].opt!.name}`);
          }
          await wait(400);
        } else if (instruction.action === "Execute") {
          const prompt: UserPrompt = {
            id: `prompt-${Date.now()}`,
            kind: "confirm",
            title: "Run external program?",
            message: `${m.name} wants to execute ${instruction.source[0]} ${instruction.arguments ?? ""}`,
            choices: [],
            modGuid: m.guid,
            instructionGuid: instruction.guid,
          };
          state.pendingPrompt = prompt;
          emit({ type: "prompt", prompt });
          const answer = await new Promise<UserPromptAnswer>((resolve) => {
            state.promptResolver = resolve;
          });
          state.pendingPrompt = undefined;
          if (state.cancelled) break outer;
          if (!answer.accepted) {
            code = "UserCancelled";
            message = "Execution refused by user";
          }
        } else if (instruction.action === "Patcher" && m.guid === G.k1cp) {
          const prompt: UserPrompt = {
            id: `prompt-${Date.now()}`,
            kind: "patcher-namespace",
            title: "Select a TSLPatcher namespace",
            message: "namespaces.ini offers several install options.",
            choices: [
              { id: "0", label: "K1CP full install", description: "Recommended", isDefault: true },
              { id: "1", label: "K1CP without Ebon Hawk fixes" },
            ],
            modGuid: m.guid,
            instructionGuid: instruction.guid,
          };
          state.pendingPrompt = prompt;
          emit({ type: "prompt", prompt });
          await new Promise<UserPromptAnswer>((resolve) => {
            state.promptResolver = resolve;
          });
          state.pendingPrompt = undefined;
          if (state.cancelled) break outer;
          for (let p = 0; p < 4; p++) {
            await wait(250);
            log("debug", `[patcher] applied 2DA change ${p + 1}/4`);
          }
        } else {
          await wait(300 + Math.random() * 500);
          if (instruction.action === "Delete") log("warn", "File did not exist, nothing deleted");
        }
        const result = {
          instructionGuid: instruction.guid,
          modGuid: m.guid,
          optionGuid: opt?.guid,
          action: instruction.action,
          code,
          message,
          touched: code === "Success" ? [`${state.settings.kotorDirectory}/Override/example_${cpIndex}.tpc`] : [],
          durationMs: Date.now() - t0,
          checkpointId: `cp-${cpIndex}`,
        };
        if (state.settings.createCheckpoints) checkpoint(`${m.name}: ${instruction.action}`, m.guid, instruction.guid);
        modResult.instructionResults.push(result);
        emit({ type: "instruction-finished", result });
        if (code === "UserCancelled") break;
      }
      modResult.durationMs = Date.now() - modStart;
      modResult.state = modResult.instructionResults.some((r) => r.code === "UserCancelled") ? "Failed" : "Installed";
      m.installState = modResult.state;
      results.push(modResult);
      emit({ type: "mod-finished", result: modResult });
    }
    state.running = false;
    state.currentMod = undefined;
    if (state.cancelled) {
      log("warn", "Install cancelled by user");
      emit({ type: "install-cancelled" });
      return;
    }
    const summary: InstallSummary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      mods: results,
      succeeded: results.filter((r) => r.state === "Installed").length,
      failed: results.filter((r) => r.state === "Failed").length,
      skipped: results.filter((r) => r.state === "Skipped").length,
      checkpointSessionId: session.id,
    };
    state.summary = summary;
    log("info", `Install finished: ${summary.succeeded} ok, ${summary.failed} failed`);
    emit({ type: "install-finished", summary });
  }

  async function runDownload(item: DownloadItem) {
    emit({ type: "download-queued", id: item.id, modGuid: item.modGuid, url: item.url });
    await wait(300);
    if (/deadlystream|nexusmods/.test(item.url) && !state.settings.nexusApiKey && /nexusmods/.test(item.url)) {
      item.status = "needs-browser";
      item.reason = "Nexus requires an API key or a manual download";
      emit({ type: "download-needs-browser", id: item.id, url: item.url, reason: item.reason });
      return;
    }
    if (/github/.test(item.url) && item.modGuid === G.aspyr) {
      item.status = "failed";
      item.error = "HTTP 404";
      emit({ type: "download-failed", id: item.id, error: item.error, url: item.url });
      return;
    }
    item.status = "downloading";
    item.fileName = byGuid(item.modGuid)?.expectedFiles?.[0]?.replace(/\*/g, "1.0") ?? "download.zip";
    item.totalBytes = 20_000_000 + Math.floor(Math.random() * 80_000_000);
    emit({ type: "download-started", id: item.id, fileName: item.fileName, totalBytes: item.totalBytes });
    while (item.receivedBytes < item.totalBytes) {
      await wait(200);
      const chunk = Math.floor(item.totalBytes / 12);
      item.receivedBytes = Math.min(item.totalBytes, item.receivedBytes + chunk);
      item.bytesPerSecond = chunk * 5;
      emit({ type: "download-progress", id: item.id, receivedBytes: item.receivedBytes, totalBytes: item.totalBytes, bytesPerSecond: item.bytesPerSecond });
    }
    item.status = "finished";
    item.path = `${state.settings.modDirectory}/${item.fileName}`;
    fakeFs[state.settings.modDirectory]?.push(item.fileName);
    const m = byGuid(item.modGuid);
    if (m) m.isDownloaded = true;
    emit({ type: "download-finished", id: item.id, fileName: item.fileName, path: item.path, sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709" });
  }

  function graph(): GraphResult {
    const nodes = allMods().map((m) => ({ id: m.guid, name: m.name, tier: m.tier, isSelected: m.isSelected, isWidescreen: m.isWidescreen }));
    const edges: GraphEdge[] = [];
    for (const m of allMods()) {
      for (const d of m.dependencies) edges.push({ from: m.guid, to: d, kind: "dependency" });
      for (const r of m.restrictions) edges.push({ from: m.guid, to: r, kind: "restriction" });
      for (const a of m.installAfter) edges.push({ from: m.guid, to: a, kind: "installAfter" });
      for (const b of m.installBefore) edges.push({ from: m.guid, to: b, kind: "installBefore" });
      for (const u of m.untestedWith) edges.push({ from: m.guid, to: u, kind: "untested" });
    }
    return { nodes, edges };
  }

  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  return {
    events,
    isMock: true,
    connect(onState) {
      onState?.("connected");
      return () => onState?.("disconnected");
    },
    health: async () => ({ ok: true, version: "2.0.0-mock", platform: "browser", isElectron: false }),
    getSettings: async () => clone(state.settings),
    updateSettings: async (patch) => {
      Object.assign(state.settings, patch);
      return clone(state.settings);
    },
    fsRoots: async () => ({ roots: ["/", "/home/user", "/mnt/c"] }),
    fsBrowse: async (path): Promise<BrowseResult> => {
      const p = path || "/";
      if (!isDir(p)) throw new Error(`Not a directory: ${p}`);
      const parent = p === "/" ? null : p.replace(/\/[^/]+$/, "") || "/";
      return {
        path: p,
        parent,
        entries: (fakeFs[p] ?? []).map((name) => {
          const full = p === "/" ? `/${name}` : `${p}/${name}`;
          return { name, path: full, isDirectory: isDir(full) };
        }),
      };
    },
    archiveList: async (path): Promise<ArchiveListResult> => {
      await wait(200);
      const base = path.replace(/^.*\//, "").replace(/\.(zip|7z|rar|exe)$/i, "");
      return {
        path,
        entries: [
          { path: `${base}/`, size: 0, isDirectory: true },
          { path: `${base}/readme.txt`, size: 1234, isDirectory: false },
          { path: `${base}/tslpatchdata/`, size: 0, isDirectory: true },
          { path: `${base}/tslpatchdata/changes.ini`, size: 44000, isDirectory: false },
          { path: `${base}/Override/`, size: 0, isDirectory: true },
          { path: `${base}/Override/p_bastilah.tpc`, size: 2_000_000, isDirectory: false },
          { path: `${base}/Override/p_carthh.tpc`, size: 2_000_000, isDirectory: false },
        ],
      };
    },
    detectGame: async (path) => {
      await wait(150);
      const entries = fakeFs[path] ?? [];
      if (entries.includes("swkotor.exe")) return { game: "KOTOR1", isAspyr: false, executable: `${path}/swkotor.exe` };
      if (entries.includes("KOTOR2.exe")) return { game: "KOTOR2", isAspyr: true, executable: `${path}/KOTOR2.exe` };
      if (entries.includes("swkotor2.exe")) return { game: "KOTOR2", isAspyr: false, executable: `${path}/swkotor2.exe` };
      return { game: "Unknown", isAspyr: false };
    },
    loadFile: async (body) => {
      await wait(300);
      if ("content" in body && body.content.trim().startsWith("{")) {
        state.file = JSON.parse(body.content) as InstructionFile;
      } else {
        state.file = createMockFile();
        if ("url" in body) state.file.config.sourceUrl = body.url;
        if ("path" in body) state.file.config.name = `${state.file.config.name} from ${body.path}`;
      }
      return clone(state.file);
    },
    loadAuthoringSession: async () => { throw new Error("Saved sessions require the production server"); },
    predictAuthoringIndependent: async () => {throw new Error("Independent prediction requires the real readonly server");},
    predictAuthoringSession: async () => {throw new Error("Rust prediction backend is not configured");},
    authoringCapabilities: async () => ({reader:true as const,persistenceBackend:null,predictionBackend:null}),
    persistAuthoringSession: async () => { throw new Error("Rust persistence backend is unavailable in mock mode"); },
    authoringArchive: async () => {throw new Error("Saved archive inputs require the local server");},
    authoringInputs: async () => {throw new Error("Saved input objects require the production backend");},
    verifyAuthoringInput: async () => {throw new Error("Saved input objects require the production backend");},
    getFile: async () => (state.file ? clone(state.file) : null),
    putFile: async (file) => {
      state.file = clone(file);
      return clone(state.file);
    },
    saveFile: async (path) => {
      await wait(200);
      log("info", `Saved instruction file to ${path}`);
    },
    importMarkdown: async () => {
      await wait(400);
      const file = createMockFile();
      file.config.name = "Imported from markdown (mock)";
      return { file, warnings: ["Mod 'Brotherhood of Shadow' has no structured instructions; generated from description.", "Unknown tier 'Mandatory' mapped to Essential."] };
    },
    exportMarkdown: async (style) => {
      const f = state.file;
      if (!f) return { markdown: "" };
      const lines = [`# ${f.config.name ?? "Mod build"} (${style})`, "", f.config.beforeModListContent ?? "", "", "## Mod List", ""];
      for (const m of f.mods) {
        lines.push(`### ${m.name}`, "", `**Name:** [${m.name}](${m.modLink[0] ?? ""})`, `**Author:** ${m.authors.join(", ")}`, `**Description:** ${m.description ?? ""}`, `**Category & Tier:** ${m.category.join(" & ")} / ${m.tier}`, `**Installation Method:** ${m.installationMethod}`, "");
      }
      return { markdown: lines.join("\n") };
    },
    mergeFile: async () => {
      await wait(300);
      const file = state.file ?? createMockFile();
      return { file: clone(file), added: [], updated: [G.k1cp], removed: [], conflicts: [{ guid: G.hires, field: "description", existing: "old", incoming: "new" }] };
    },
    setModSelection: async (guid, selected, options) => {
      const m = byGuid(guid);
      if (!m) throw new Error(`Unknown mod ${guid}`);
      m.isSelected = selected;
      if (options) for (const o of m.options) if (o.guid in options) o.isSelected = options[o.guid];
    },
    selectDefaults: async (tier) => {
      const rank: Record<string, number> = { Essential: 0, Recommended: 1, Suggested: 2, Optional: 3, Unknown: 9 };
      const max = rank[tier ?? "Essential"] ?? 0;
      for (const m of allMods()) m.isSelected = rank[m.tier] <= max;
    },
    getSelection: async () => computeSelection(),
    getGraph: async () => graph(),
    validate: async (): Promise<ValidationReport> => {
      await wait(600);
      const sel = computeSelection();
      const issues: ValidationIssue[] = [...sel.issues];
      if (!state.settings.kotorDirectory) issues.push({ severity: "error", code: "missing-kotor-dir", message: "KOTOR directory is not set" });
      if (!state.settings.modDirectory) issues.push({ severity: "error", code: "missing-mod-dir", message: "Mod directory is not set" });
      const req = requiredDownloads();
      for (const r of req)
        if (!r.found) issues.push({ severity: "warning", code: "missing-archive", modGuid: r.modGuid, message: `${r.modName}: no file matching ${r.pattern} in the mod directory`, path: r.pattern });
      const fb = byGuid(G.fullbuild);
      if (fb?.isSelected) issues.push({ severity: "info", code: "deldup-noop", modGuid: G.fullbuild, message: "DelDuplicate found no .tpc/.tga duplicates (dry run)" });
      issues.push({ severity: "info", code: "dry-run", message: `Dry run simulated ${sel.order.length} mod(s) against a virtual file system` });
      return { issues, ok: !issues.some((i) => i.severity === "error"), installOrder: sel.order, requiredDownloads: req };
    },
    install: async (opts) => {
      if (state.running) throw new Error("An install is already running");
      void runInstall(opts.phase ?? "base", opts.modGuids);
      return { sessionId: `session-${Date.now()}` };
    },
    cancelInstall: async () => {
      state.cancelled = true;
      state.promptResolver?.({ promptId: state.pendingPrompt?.id ?? "", accepted: false });
    },
    answerPrompt: async (answer) => {
      if (state.promptResolver) state.promptResolver(answer);
    },
    installStatus: async () => ({ running: state.running, currentMod: state.currentMod, summary: state.summary, pendingPrompt: state.pendingPrompt }),
    downloads: async () => clone(state.downloads),
    startDownloads: async (modGuids) => {
      const targets = effectiveSelected().filter((m) => !modGuids || modGuids.includes(m.guid));
      for (const m of targets) {
        if (state.downloads.some((d) => d.modGuid === m.guid && d.status !== "failed")) continue;
        const url = m.modLink[0];
        if (!url) continue;
        const item: DownloadItem = { id: `dl-${state.downloads.length + 1}`, modGuid: m.guid, url, status: "queued", receivedBytes: 0 };
        state.downloads.push(item);
        void runDownload(item);
      }
    },
    openBrowser: async (url) => {
      window.open(url, "_blank", "noopener");
    },
    checkpoints: async () => clone(state.checkpoints),
    restoreCheckpoint: async (sessionId, checkpointId) => {
      await wait(800);
      log("info", `Restored checkpoint ${checkpointId} of ${sessionId}`);
    },
    logs: async (since) => state.logs.slice(since ?? 0),
  };
}
