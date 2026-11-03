import type { AuthoringSessionResult, AuthoringPersistRequest } from "../api/client";
/**
 * A tiny external store consumed through `useSyncExternalStore`.
 * All server-synchronised state lives here; components call the `actions`
 * helpers which talk to the API client and push results into the store.
 */
import { useSyncExternalStore } from "react";
import { goTo } from "../wizard/navigation";
import { api, type ConnectionState, type EventEnvelope } from "../api/client";
import type {
  CheckpointSession,
  DownloadItem,
  GameDetectResult,
  Guid,
  InstallEvent,
  InstallSummary,
  InstructionFile,
  ModComponent,
  SelectionResult,
  UserPrompt,
  UserSettings,
  ValidationReport,
} from "../types";

export type Theme = "dark" | "light";
export type Mode = "installer" | "editor";

export interface LogLine {
  seq: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  time: string;
}

export interface ModProgress {
  done: number;
  total: number;
  state: "pending" | "running" | "done" | "failed" | "skipped";
}

export interface InstallState {
  running: boolean;
  phase: "base" | "widescreen";
  order: Guid[];
  total: number;
  modIndex: number;
  currentMod?: Guid;
  currentModName?: string;
  currentInstruction?: { action: string; description: string; instructionGuid: Guid };
  perMod: Record<Guid, ModProgress>;
  summary?: InstallSummary;
  /** Summary of the base phase, kept while the widescreen phase runs. */
  baseSummary?: InstallSummary;
  widescreenSummary?: InstallSummary;
  pendingPrompt?: UserPrompt;
  events: InstallEvent[];
  log: LogLine[];
  error?: string;
  cancelled: boolean;
  checkpointCount: number;
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  message: string;
}

export interface AppState {
  ready: boolean;
  connection: ConnectionState;
  isElectron: boolean;
  settings: UserSettings | null;
  file: InstructionFile | null;
  /** Editor working copy (separate from the installer's file until saved). */
  draft: InstructionFile | null;
  fileSource?: string;
  authoringSession: AuthoringSessionResult["session"] | null;
  authoringBackend: "rust-cli" | null;
  authoringBusy: boolean;
  selection: SelectionResult | null;
  report: ValidationReport | null;
  validating: boolean;
  install: InstallState;
  downloads: DownloadItem[];
  checkpoints: CheckpointSession[];
  game: GameDetectResult | null;
  step: number;
  theme: Theme;
  spoilerFree: boolean;
  mode: Mode;
  showDownloads: boolean;
  showDag: boolean;
  toasts: Toast[];
  selectedModGuid?: Guid;
}

const emptyInstall = (): InstallState => ({
  running: false,
  phase: "base",
  order: [],
  total: 0,
  modIndex: 0,
  perMod: {},
  events: [],
  log: [],
  cancelled: false,
  checkpointCount: 0,
});

function readLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const initialMode: Mode = window.location.hash.startsWith("#editor") ? "editor" : "installer";

let state: AppState = {
  ready: false,
  connection: "disconnected",
  isElectron: Boolean(window.modsync?.isElectron),
  settings: null,
  file: null,
  draft: null,
  authoringSession: null,
  authoringBackend: null,
  authoringBusy: false,
  selection: null,
  report: null,
  validating: false,
  install: emptyInstall(),
  downloads: [],
  checkpoints: [],
  game: null,
  step: 0,
  theme: readLocal<Theme>("modsync.theme", "dark"),
  spoilerFree: readLocal<boolean>("modsync.spoilerFree", false),
  mode: initialMode,
  showDownloads: false,
  showDag: false,
  toasts: [],
};

const listeners = new Set<() => void>();
let notificationTimer: ReturnType<typeof setTimeout> | undefined;

function notifyListeners(): void {
  for (const listener of [...listeners]) listener();
}

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>), immediate = true): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  if (immediate) notifyListeners();
  else if (notificationTimer === undefined) {
    notificationTimer = setTimeout(() => {
      notificationTimer = undefined;
      notifyListeners();
    }, 16);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to the whole state (the app is small; re-rendering is cheap). */
export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** Subscribe to a slice; the selector must return a stable reference for unchanged data. */
export function useSelector<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export function modName(s: AppState, guid: Guid): string {
  const f = s.file;
  if (!f) return guid;
  for (const m of f.mods) {
    if (m.guid === guid) return m.name;
    for (const o of m.options) if (o.guid === guid) return `${m.name} / ${o.name}`;
  }
  return guid;
}

export function findMod(s: AppState, guid: Guid | undefined): ModComponent | undefined {
  return guid ? s.file?.mods.find((m) => m.guid === guid) : undefined;
}

/** Mods that count as selected for the current phase, honouring spoiler-free/platform. */
export function effectiveSelectedMods(s: AppState, phase?: "base" | "widescreen"): ModComponent[] {
  if (!s.file) return [];
  return s.file.mods.filter((m) => {
    if (!m.isSelected) return false;
    if (s.spoilerFree && m.fullBuildOnly) return false;
    if (m.aspyrOnly && s.settings?.platform !== "Mobile") return false;
    if (phase === "base" && m.isWidescreen) return false;
    if (phase === "widescreen" && !m.isWidescreen) return false;
    return true;
  });
}

export function hasWidescreenMods(s: AppState): boolean {
  return Boolean(s.file?.mods.some((m) => m.isWidescreen));
}

export function selectedWidescreenMods(s: AppState): ModComponent[] {
  return effectiveSelectedMods(s, "widescreen");
}

let toastId = 0;
export function toast(kind: Toast["kind"], message: string, ttl = 5000): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ttl);
}

export function reportError(err: unknown, prefix?: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(prefix ?? "", err);
  toast("error", prefix ? `${prefix}: ${msg}` : msg, 8000);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  writeLocal("modsync.theme", theme);
}

let initialization: Promise<void> | undefined;

export const actions = {
  init(): Promise<void> {
    return initialization ??= actions.initialize();
  },

  async initialize(): Promise<void> {
    applyTheme(state.theme);
    api.connect((connection) => setState({ connection }));
    api.events.on(handleEvent);
    try {
      const [health, savedSettings, file] = await Promise.all([api.health().catch(() => null), api.getSettings(), api.getFile().catch(() => null)]);
      let spoilerFree = readLocal<boolean | null>("modsync.spoilerFree", null) ?? savedSettings.spoilerFree;
      const theme = readLocal<Theme | null>("modsync.theme", null) ?? savedSettings.theme ?? "dark";
      let settings = savedSettings;
      if (spoilerFree !== savedSettings.spoilerFree) {
        try {
          settings = await api.updateSettings({ spoilerFree });
        } catch {
          spoilerFree = savedSettings.spoilerFree;
        }
      }
      applyTheme(theme);
      setState({
        settings,
        file,
        draft: file,
        spoilerFree,
        theme,
        isElectron: state.isElectron || Boolean(health?.isElectron),
        ready: true,
      });
      if (file) await actions.refreshSelection();
      await actions.refreshInstallStatus();
      await actions.refreshDownloads();
      if (settings.kotorDirectory) void actions.detectGame(settings.kotorDirectory);
    } catch (err) {
      reportError(err, "Could not reach the ModSync server");
      setState({ ready: true });
    }
  },

  setTheme(theme: Theme) {
    applyTheme(theme);
    setState({ theme });
    void api.updateSettings({ theme }).catch(() => undefined);
  },

  toggleTheme() {
    actions.setTheme(state.theme === "dark" ? "light" : "dark");
  },

  setSpoilerFree(spoilerFree: boolean) {
    writeLocal("modsync.spoilerFree", spoilerFree);
    setState({ spoilerFree, report: null });
    void actions.updateSettings({ spoilerFree }).then(async () => {
      const saved = state.settings?.spoilerFree ?? spoilerFree;
      setState({ spoilerFree: saved });
      writeLocal("modsync.spoilerFree", saved);
      await actions.refreshSelection();
    });
  },

  setMode(mode: Mode) {
    window.location.hash = mode === "editor" ? "#editor" : "";
    setState({ mode, draft: state.draft ?? state.file });
  },

  setStep(step: number) {
    setState({ step });
  },

  async updateSettings(patch: Partial<UserSettings>): Promise<void> {
    const previous = state.settings;
    setState((s) => ({ settings: s.settings ? { ...s.settings, ...patch } : s.settings, report: null }));
    try {
      const settings = await api.updateSettings(patch);
      setState({ settings });
      if (patch.kotorDirectory !== undefined) void actions.detectGame(patch.kotorDirectory);
      if (patch.platform !== undefined || patch.compatibilityLevel !== undefined) await actions.refreshSelection();
    } catch (err) {
      try {
        setState({ settings: await api.getSettings() });
      } catch {
        setState({ settings: previous });
      }
      reportError(err, "Saving settings failed");
    }
  },

  async detectGame(path: string): Promise<void> {
    if (!path) {
      setState({ game: null });
      return;
    }
    try {
      const game = await api.detectGame(path);
      setState({ game });
    } catch {
      setState({ game: { game: "Unknown", isAspyr: false } });
    }
  },

  async loadFile(body: { path: string } | { content: string } | { url: string }): Promise<boolean> {
    try {
      const file = await api.loadFile(body);
      const source = "path" in body ? body.path : "url" in body ? body.url : "uploaded content";
      setState({ file, draft: file, fileSource: source, authoringSession:null, report: null, install: emptyInstall() });
      await actions.refreshSelection();
      toast("success", `Loaded ${file.config.name ?? "instruction file"} (${file.mods.length} mods)`);
      return true;
    } catch (err) {
      reportError(err, "Loading the instruction file failed");
      return false;
    }
  },

  async loadAuthoringSession(directory:string,cursor?:number):Promise<boolean> {
    if(state.authoringBusy)return false;
    setState({authoringBusy:true});
    try {
      const result=await api.loadAuthoringSession(directory,cursor);
      const capability=await api.authoringCapabilities().catch(()=>({reader:true as const,persistenceBackend:null}));
      setState({file:result.file,draft:result.file,authoringSession:result.session,authoringBackend:capability.persistenceBackend,fileSource:`Saved session: ${result.session.directory}`,report:null,selection:null,install:emptyInstall()});
      return true;
    }catch(error){reportError(error,"Opening the saved revision failed");return false;}
    finally{setState({authoringBusy:false});}
  },
  async persistAuthoringSession(command: {operation:"edit";label:string;operations:Record<string,unknown>[]} | {operation:"undo"|"redo"}):Promise<boolean> {
    const session=state.authoringSession;
    if(state.authoringBusy||!session||state.authoringBackend!=="rust-cli")return false;
    setState({authoringBusy:true});
    try {
      const request:AuthoringPersistRequest={...command,directory:session.directory,expectedRevision:session.revisionId};
      const result=await api.persistAuthoringSession(request);
      setState({file:result.file,draft:result.file,authoringSession:result.session,report:null,selection:null});
      return true;
    }catch(error){reportError(error,"Saving the session failed; reload before retrying");setState({authoringBackend:null});return false;}
    finally{setState({authoringBusy:false});}
  },

  async refreshFile(): Promise<void> {
    try {
      const file = await api.getFile();
      setState({ file });
    } catch (err) {
      reportError(err);
    }
  },

  async refreshSelection(): Promise<void> {
    if (!state.file) return;
    try {
      const selection = await api.getSelection();
      setState({ selection });
    } catch (err) {
      reportError(err, "Could not read selection");
    }
  },

  async setModSelected(guid: Guid, selected: boolean, options?: Record<Guid, boolean>): Promise<void> {
    // optimistic local update
    setState((s) => {
      if (!s.file) return {};
      const mods = s.file.mods.map((m) => {
        if (m.guid !== guid) return m;
        const opts = options ? m.options.map((o) => (o.guid in options ? { ...o, isSelected: options[o.guid] } : o)) : m.options;
        return { ...m, isSelected: selected, options: opts };
      });
      return { file: { ...s.file, mods }, report: null };
    });
    try {
      await api.setModSelection(guid, selected, options);
      await actions.refreshSelection();
    } catch (err) {
      reportError(err, "Updating selection failed");
      await actions.refreshFile();
    }
  },

  async selectDefaults(tier?: ModComponent["tier"]): Promise<void> {
    try {
      await api.selectDefaults(tier);
      await actions.refreshFile();
      await actions.refreshSelection();
      setState({ report: null });
    } catch (err) {
      reportError(err, "Selecting defaults failed");
    }
  },

  async selectAll(): Promise<void> {
    try {
      await api.selectAll();
      await actions.refreshFile();
      await actions.refreshSelection();
      setState({ report: null });
    } catch (err) {
      reportError(err, "Selecting all mods failed");
    }
  },

  async validate(): Promise<ValidationReport | null> {
    setState({ validating: true });
    try {
      const report = await api.validate();
      setState({ report, validating: false });
      return report;
    } catch (err) {
      reportError(err, "Validation failed");
      setState({ validating: false });
      return null;
    }
  },

  async startInstall(phase: "base" | "widescreen", modGuids?: Guid[]): Promise<void> {
    const mods = effectiveSelectedMods(state, phase);
    const perMod: Record<Guid, ModProgress> = {};
    for (const m of mods) {
      const total = m.instructions.length + m.options.filter((o) => o.isSelected).reduce((n, o) => n + o.instructions.length, 0);
      perMod[m.guid] = { done: 0, total, state: "pending" };
    }
    setState((s) => ({
      install: {
        ...emptyInstall(),
        running: true,
        phase,
        perMod,
        order: mods.map((m) => m.guid),
        total: mods.length,
        baseSummary: s.install.baseSummary,
        widescreenSummary: s.install.widescreenSummary,
      },
    }));
    try {
      await api.install({ phase, modGuids });
    } catch (err) {
      reportError(err, "Starting the install failed");
      setState((s) => ({ install: { ...s.install, running: false, error: String(err) } }));
    }
  },

  async cancelInstall(): Promise<void> {
    try {
      await api.cancelInstall();
    } catch (err) {
      reportError(err, "Cancel failed");
    }
  },

  async answerPrompt(answer: { choiceId?: string; accepted?: boolean }): Promise<void> {
    const prompt = state.install.pendingPrompt;
    if (!prompt) return;
    try {
      await api.answerPrompt({ promptId: prompt.id, ...answer });
      setState((s) => s.install.pendingPrompt?.id === prompt.id
        ? { install: { ...s.install, pendingPrompt: undefined } }
        : {});
    } catch (err) {
      reportError(err, "Answering the prompt failed");
    }
  },

  async refreshInstallStatus(): Promise<void> {
    try {
      const status = await api.installStatus();
      setState((s) => ({
        install: {
          ...s.install,
          running: status.running,
          phase: status.phase ?? s.install.phase,
          order: status.order ?? s.install.order,
          total: status.order?.length ?? s.install.total,
          currentMod: status.currentMod ?? s.install.currentMod,
          summary: status.summary ?? s.install.summary,
          pendingPrompt: status.pendingPrompt,
        },
      }));
      if (status.running) {
        goTo(status.phase === "widescreen" ? "WidescreenInstalling" : "Installing");
      }
    } catch {
      /* server may not be there yet */
    }
  },

  async refreshDownloads(): Promise<void> {
    try {
      const downloads = await api.downloads();
      setState({ downloads: Array.isArray(downloads) ? downloads : [] });
    } catch {
      /* ignore */
    }
  },

  async startDownloads(modGuids?: Guid[]): Promise<void> {
    try {
      await api.startDownloads(modGuids);
      setState({ showDownloads: true });
      await actions.refreshDownloads();
    } catch (err) {
      reportError(err, "Starting downloads failed");
    }
  },

  async openExternal(url: string): Promise<void> {
    if (window.modsync?.openExternal) return window.modsync.openExternal(url);
    try {
      await api.openBrowser(url);
    } catch {
      window.open(url, "_blank", "noopener");
    }
  },

  async refreshCheckpoints(): Promise<void> {
    try {
      const checkpoints = await api.checkpoints();
      setState({ checkpoints });
    } catch (err) {
      reportError(err, "Loading checkpoints failed");
    }
  },

  async restoreCheckpoint(sessionId: string, id: string): Promise<void> {
    try {
      await api.restoreCheckpoint(sessionId, id);
      toast("success", `Restored checkpoint ${id}`);
    } catch (err) {
      reportError(err, "Restore failed");
    }
  },

  setDraft(draft: InstructionFile | null) {
    setState({ draft });
  },

  /** Push the editor draft to the server and make it the installer's file. */
  async commitDraft(): Promise<InstructionFile | null> {
    if (!state.draft) return null;
    try {
      const file = await api.putFile(state.draft);
      setState({ file, draft: file, report: null });
      await actions.refreshSelection();
      return file;
    } catch (err) {
      reportError(err, "Saving the file to the server failed");
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

function handleEvent({ seq, event }: EventEnvelope): void {
  if (event.type.startsWith("download-")) {
    handleDownloadEvent(event as Extract<typeof event, { type: `download-${string}` }>);
    return;
  }
  const e = event as InstallEvent;
  setState((s) => {
    const inst: InstallState = { ...s.install, events: [...s.install.events, e] };
    const perMod = { ...inst.perMod };
    switch (e.type) {
      case "install-started":
        inst.running = true;
        inst.order = e.order;
        inst.total = e.total;
        inst.summary = undefined;
        inst.cancelled = false;
        inst.error = undefined;
        for (const g of e.order) if (!perMod[g]) perMod[g] = { done: 0, total: countInstructions(s, g), state: "pending" };
        break;
      case "mod-started":
        inst.modIndex = e.index;
        inst.currentMod = e.modGuid;
        inst.currentModName = e.name;
        perMod[e.modGuid] = { ...(perMod[e.modGuid] ?? { done: 0, total: countInstructions(s, e.modGuid) }), state: "running" };
        break;
      case "instruction-started":
        inst.currentInstruction = { action: e.action, description: e.description, instructionGuid: e.instructionGuid };
        break;
      case "instruction-finished": {
        const p = perMod[e.result.modGuid] ?? { done: 0, total: 1, state: "running" as const };
        perMod[e.result.modGuid] = { ...p, done: p.done + 1 };
        inst.log = [
          ...inst.log,
          {
            seq,
            level: e.result.code === "Success" || e.result.code === "Skipped" ? "debug" : "warn",
            message: `${e.result.action}: ${e.result.code}${e.result.message ? ` (${e.result.message})` : ""}`,
            time: new Date().toLocaleTimeString(),
          },
        ];
        break;
      }
      case "mod-finished": {
        const p = perMod[e.result.modGuid] ?? { done: 0, total: 0, state: "running" as const };
        perMod[e.result.modGuid] = {
          ...p,
          done: p.total,
          state: e.result.state === "Installed" ? "done" : e.result.state === "Skipped" ? "skipped" : "failed",
        };
        inst.currentInstruction = undefined;
        break;
      }
      case "checkpoint-created":
        inst.checkpointCount = e.index + 1;
        break;
      case "log":
        inst.log = [...inst.log, { seq, level: e.level, message: e.message, time: new Date().toLocaleTimeString() }].slice(-2000);
        break;
      case "prompt":
        inst.pendingPrompt = e.prompt;
        break;
      case "install-finished":
        inst.running = false;
        inst.summary = e.summary;
        if (inst.phase === "widescreen") inst.widescreenSummary = e.summary;
        else inst.baseSummary = e.summary;
        inst.currentInstruction = undefined;
        inst.pendingPrompt = undefined;
        break;
      case "install-cancelled":
        inst.running = false;
        inst.cancelled = true;
        inst.pendingPrompt = undefined;
        inst.currentInstruction = undefined;
        break;
      case "install-error":
        inst.running = false;
        inst.error = e.message;
        inst.pendingPrompt = undefined;
        break;
    }
    inst.perMod = perMod;
    return { install: inst };
  }, false);
}

function countInstructions(s: AppState, guid: Guid): number {
  const m = findMod(s, guid);
  if (!m) return 1;
  return m.instructions.length + m.options.filter((o) => o.isSelected).reduce((n, o) => n + o.instructions.length, 0);
}

function handleDownloadEvent(e: Extract<EventEnvelope["event"], { type: `download-${string}` }>): void {
  setState((s) => {
    const list = [...s.downloads];
    const idx = list.findIndex((d) => d.id === e.id);
    const cur: DownloadItem = idx >= 0 ? { ...list[idx] } : { id: e.id, modGuid: "", url: "", status: "queued", receivedBytes: 0 };
    switch (e.type) {
      case "download-queued":
        cur.modGuid = e.modGuid;
        cur.url = e.url;
        cur.status = "queued";
        break;
      case "download-started":
        cur.status = "downloading";
        cur.fileName = e.fileName ?? cur.fileName;
        cur.totalBytes = e.totalBytes ?? cur.totalBytes;
        break;
      case "download-progress":
        cur.status = "downloading";
        cur.receivedBytes = e.receivedBytes;
        cur.totalBytes = e.totalBytes ?? cur.totalBytes;
        cur.bytesPerSecond = e.bytesPerSecond;
        break;
      case "download-finished":
        cur.status = "finished";
        cur.fileName = e.fileName;
        cur.path = e.path;
        cur.receivedBytes = cur.totalBytes ?? cur.receivedBytes;
        break;
      case "download-failed":
        cur.status = "failed";
        cur.error = e.error;
        cur.url = e.url;
        break;
      case "download-needs-browser":
        cur.status = "needs-browser";
        cur.url = e.url;
        cur.reason = e.reason;
        break;
    }
    if (idx >= 0) list[idx] = cur;
    else list.push(cur);
    return { downloads: list };
  }, false);
  if (e.type === "download-finished") void actions.refreshFile();
}
