// Electron main process (ESM; Electron >= 28 supports an ESM entry point).
//
// Responsibilities: start the in-process ModSync server on 127.0.0.1:0 with a
// random bearer token, open a BrowserWindow on it, expose native dialogs via
// IPC (see ipc.ts / preload.cts), own the single-instance lock and forward
// `nxm://` links from Nexus Mods to the server.
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createModSyncServer } from "@modsync/server";
import type { ModSyncServer } from "@modsync/server";
import { IPC } from "./bridge.js";
import { electronBridge, isSafeExternalUrl, pickFile, registerIpcHandlers } from "./ipc.js";

const NXM_SCHEME = "nxm";
const GITHUB_URL = "https://github.com/bodencrouch/ModSync.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Built web bundle: `packages/web/dist`, resolved relative to `packages/electron/dist`. */
const STATIC_DIR = app.isPackaged
  ? path.join(app.getAppPath(), "web")
  : path.resolve(__dirname, "../../web/dist");
const PRELOAD = path.join(__dirname, "preload.cjs");

// ---------------------------------------------------------------------------
// Single instance lock. Must run before `app.whenReady()` — the losing
// instance quits immediately and its argv (possibly an nxm:// link) is
// delivered to the primary through the `second-instance` event.
// ---------------------------------------------------------------------------
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
}

let server: ModSyncServer | undefined;
let baseUrl: string | undefined;
let mainWindow: BrowserWindow | undefined;
const token = randomBytes(32).toString("hex");

/** nxm:// links that arrived before the server was listening. */
const pendingNxm: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appUrl(extra: Record<string, string> = {}, hash = ""): string {
  if (!baseUrl) throw new Error("server not started");
  const u = new URL("/", baseUrl);
  u.searchParams.set("token", token);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  if (hash) u.hash = hash;
  return u.toString();
}

function sameOrigin(url: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

async function apiPost(route: string, body: unknown): Promise<Response> {
  if (!baseUrl) throw new Error("server not started");
  return fetch(new URL(route, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function extractNxmLinks(argv: readonly string[]): string[] {
  return argv.filter((a) => a.toLowerCase().startsWith(`${NXM_SCHEME}://`));
}

async function forwardNxm(url: string): Promise<void> {
  if (!baseUrl) {
    pendingNxm.push(url);
    return;
  }
  try {
    const res = await apiPost("/api/downloads/nxm", { url });
    if (!res.ok) {
      console.error(`[modsync] server rejected nxm link (${res.status}): ${url}`);
    }
  } catch (err) {
    console.error(`[modsync] failed to forward nxm link: ${String(err)}`);
  }
  focusMainWindow();
}

function flushPendingNxm(): void {
  const queued = pendingNxm.splice(0);
  for (const url of queued) void forwardNxm(url);
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Mirrors `defaultSettingsPath()` in `@modsync/core` (folder only). */
function settingsDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "ModSync");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "modsync");
}

async function openExternalSafe(url: string): Promise<void> {
  if (isSafeExternalUrl(url)) await shell.openExternal(url);
}

// ---------------------------------------------------------------------------
// Protocol registration (nxm:// from Nexus Mods "Download with manager")
// ---------------------------------------------------------------------------

function registerNxmProtocol(): void {
  // In development the executable is `electron` itself, so the handler must
  // include the script path; packaged builds only need the scheme.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(NXM_SCHEME, process.execPath, [path.resolve(process.argv[1]!)]);
  } else {
    app.setAsDefaultProtocolClient(NXM_SCHEME);
  }
}

// macOS delivers protocol links via `open-url` (possibly before `ready`).
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (url.toLowerCase().startsWith(`${NXM_SCHEME}://`)) void forwardNxm(url);
});

// Windows/Linux deliver them as argv of a second instance.
app.on("second-instance", (_event, argv) => {
  for (const url of extractNxmLinks(argv)) void forwardNxm(url);
  focusMainWindow();
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "ModSync",
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Keep the renderer on our own origin; everything else goes to the browser.
  win.webContents.on("will-navigate", (event, url) => {
    if (sameOrigin(url)) return;
    event.preventDefault();
    void openExternalSafe(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!sameOrigin(url)) void openExternalSafe(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });

  void win.loadURL(appUrl());
  return win;
}

function ensureWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  return mainWindow;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

async function menuOpenInstructionFile(): Promise<void> {
  const file = await pickFile({
    title: "Open instruction file",
    filters: [
      { name: "ModSync instruction files", extensions: ["toml", "md", "json"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!file) return;
  try {
    const res = await apiPost("/api/file/load", { path: file });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${text}`.trim());
    }
    ensureWindow().webContents.send(IPC.fileLoaded, file);
  } catch (err) {
    dialog.showErrorBox("Could not open instruction file", String(err));
  }
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";

  const fileMenu: MenuItemConstructorOptions = {
    label: "&File",
    submenu: [
      {
        label: "Open instruction file...",
        accelerator: "CmdOrCtrl+O",
        click: () => void menuOpenInstructionFile(),
      },
      {
        label: "Open Editor",
        accelerator: "CmdOrCtrl+E",
        click: () => void ensureWindow().loadURL(appUrl({}, "editor")),
      },
      { type: "separator" },
      {
        label: "Settings folder",
        click: () => void shell.openPath(settingsDir()),
      },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit", label: "Quit" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "&View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: "&Help",
    role: "help",
    submenu: [
      {
        label: "About ModSync",
        click: () =>
          void dialog.showMessageBox({
            type: "info",
            title: "About ModSync",
            message: `ModSync ${app.getVersion()}`,
            detail: [
              "A multi-mod instruction builder and installer for KOTOR 1 and 2.",
              "",
              `Electron ${process.versions.electron}`,
              `Chromium ${process.versions.chrome}`,
              `Node ${process.versions.node}`,
              "",
              "Licensed under GPL-3.0-or-later.",
            ].join("\n"),
          }),
      },
      {
        label: "Open logs folder",
        click: () => void shell.openPath(app.getPath("logs")),
      },
      { type: "separator" },
      {
        label: "GitHub",
        click: () => void shell.openExternal(GITHUB_URL),
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    fileMenu,
    { role: "editMenu" },
    viewMenu,
    { role: "windowMenu" },
    helpMenu,
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function startServer(): Promise<string> {
  if (!existsSync(STATIC_DIR)) {
    console.warn(
      `[modsync] web bundle not found at ${STATIC_DIR}; build it with "pnpm --filter @modsync/web build".`,
    );
  }
  server = await createModSyncServer({
    token,
    staticDir: STATIC_DIR,
    electronBridge,
    settingsPath: process.env.MODSYNC_SETTINGS_PATH,
  });
  return server.listen(0, "127.0.0.1");
}

async function stopServer(): Promise<void> {
  const s = server;
  server = undefined;
  baseUrl = undefined;
  if (!s) return;
  try {
    await s.close();
  } catch (err) {
    console.error(`[modsync] error closing server: ${String(err)}`);
  }
}

if (hasLock) {
  app.whenReady().then(async () => {
    registerIpcHandlers();
    registerNxmProtocol();

    try {
      baseUrl = await startServer();
    } catch (err) {
      dialog.showErrorBox("ModSync failed to start", String(err));
      app.exit(1);
      return;
    }

    buildMenu();
    ensureWindow();

    // Links that came in via argv on first launch (Windows/Linux) or via
    // `open-url` before the server was listening (macOS).
    for (const url of extractNxmLinks(process.argv)) pendingNxm.push(url);
    flushPendingNxm();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) ensureWindow();
    });
  }).catch((err) => {
    console.error(`[modsync] fatal: ${String(err)}`);
    app.exit(1);
  });
}

let quitting = false;

app.on("window-all-closed", () => {
  if (quitting) return;
  if (process.platform === "darwin") return;
  void stopServer().finally(() => app.quit());
});

app.on("before-quit", (event) => {
  if (quitting || !server) return;
  // Give the server a chance to shut down cleanly, then really quit.
  event.preventDefault();
  quitting = true;
  // Close renderer WebSockets and HTTP keep-alives before awaiting the local server.
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  void stopServer().finally(() => app.quit());
});
