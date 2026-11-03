import { beforeEach, describe, expect, it, vi } from "vitest";

const observer = vi.hoisted(() => vi.fn());
vi.mock("react", () => ({ useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => unknown) => { subscribe(observer); return snapshot(); } }));

const client = vi.hoisted(() => ({
  connect: vi.fn(),
  events: { on: vi.fn() },
  health: vi.fn(async () => ({ isElectron: false })),
  getSettings: vi.fn(async () => ({ theme: "dark", spoilerFree: false })),
  updateSettings: vi.fn(),
  getFile: vi.fn(async () => null),
  installStatus: vi.fn(async () => ({ running: false })),
  downloads: vi.fn(async () => []),
  answerPrompt: vi.fn(),
  selectAll: vi.fn(async () => undefined),
  getSelection: vi.fn(async () => ({ selectedGuids: [], order: [], issues: [] })),
}));
vi.mock("../api/client", () => ({ api: client }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { hash: "" } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("document", { documentElement: { setAttribute: vi.fn() } });
});

describe("installer state", () => {
  it("uses the native Select All endpoint and refreshes the application's selection", async () => {
    const { actions, setState, getState } = await import("./store");
    setState({ file: { config: {}, mods: [] } as never });
    const file = { config: {}, mods: [{ guid: "native-mod", isSelected: true }] };
    const selection = { selectedGuids: ["native-mod"], order: [], issues: [{ code: "dependency-missing" }] };
    client.getFile.mockResolvedValueOnce(file as never);
    client.getSelection.mockResolvedValueOnce(selection as never);
    await actions.selectAll();
    expect(client.selectAll).toHaveBeenCalledTimes(1);
    expect(client.getFile).toHaveBeenCalledTimes(1);
    expect(client.getSelection).toHaveBeenCalledTimes(1);
    expect(getState().file).toEqual(file);
    expect(getState().selection).toEqual(selection);
  });
  it("initializes a single connection and subscription under repeated mounting", async () => {
    const { actions } = await import("./store");
    await Promise.all([actions.init(), actions.init()]);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.events.on).toHaveBeenCalledTimes(1);
    expect(client.getSettings).toHaveBeenCalledTimes(1);
  });

  it("preserves an edited draft when switching modes", async () => {
    const { actions, getState, setState } = await import("./store");
    const draft = { config: { name: "Edited build" }, mods: [] };
    setState({ draft: draft as never });
    actions.setMode("installer");
    actions.setMode("editor");
    expect(getState().draft).toBe(draft);
  });

  it("keeps a failed prompt answer available for retry", async () => {
    const { actions, getState, setState } = await import("./store");
    const prompt = { id: "prompt-1", kind: "confirm", choices: [] };
    setState({ install: { ...getState().install, pendingPrompt: prompt as never } });
    client.answerPrompt.mockRejectedValueOnce(new Error("Disconnected"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await actions.answerPrompt({ accepted: true });
    expect(getState().install.pendingPrompt).toBe(prompt);
    client.answerPrompt.mockResolvedValueOnce(undefined);
    await actions.answerPrompt({ accepted: true });
    expect(getState().install.pendingPrompt).toBeUndefined();
    log.mockRestore();
  });

  it("does not dismiss a newer prompt when a prior answer finishes", async () => {
    const { actions, getState, setState } = await import("./store");
    const first = { id: "first", kind: "confirm", choices: [] };
    const next = { id: "next", kind: "confirm", choices: [] };
    setState({ install: { ...getState().install, pendingPrompt: first as never } });
    client.answerPrompt.mockImplementationOnce(async () => {
      setState({ install: { ...getState().install, pendingPrompt: next as never } });
    });
    await actions.answerPrompt({ accepted: true });
    expect(getState().install.pendingPrompt).toBe(next);
  });
  it("restores the running phase, order, and progress page after reload", async () => {
    const { actions, getState } = await import("./store");
    client.installStatus.mockResolvedValueOnce({ running: true, phase: "widescreen", order: ["mod-1"] } as never);
    await actions.refreshInstallStatus();
    expect(getState().install.phase).toBe("widescreen");
    expect(getState().install.order).toEqual(["mod-1"]);
    expect(getState().step).toBe(12);
  });

  it("still initializes when restoring local preferences is rejected during installation", async () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === "modsync.spoilerFree" ? "true" : null, setItem: vi.fn() });
    client.updateSettings.mockRejectedValueOnce(new Error("Installation running"));
    const { actions, getState } = await import("./store");
    await actions.init();
    expect(getState().ready).toBe(true);
    expect(getState().settings).not.toBeNull();
    expect(getState().spoilerFree).toBe(false);
  });

  it("restores server settings after an optimistic update is rejected", async () => {
    const { actions, getState, setState } = await import("./store");
    setState({ settings: { theme: "dark", spoilerFree: false } as never });
    client.updateSettings.mockRejectedValueOnce(new Error("Installation running"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await actions.updateSettings({ spoilerFree: true });
    expect(getState().settings?.spoilerFree).toBe(false);
    log.mockRestore();
  });

  it("reduces every streamed event while batching renderer notifications", async () => {
    vi.useFakeTimers();
    const { actions, getState, useAppState } = await import("./store");
    await actions.init();
    useAppState();
    const handleEvent = client.events.on.mock.calls[0][0] as unknown as (event: unknown) => void;
    for (let seq = 1; seq <= 1000; seq++) {
      handleEvent({ seq, event: { type: "instruction-finished", result: { modGuid: "test-mod", action: "Copy", code: "Success" } } });
    }
    expect(getState().install.perMod["test-mod"].done).toBe(1000);
    expect(observer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(observer).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

});
