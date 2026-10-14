/** Native Electron renderer -> real authenticated server -> synthetic install. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron as electron, type ElectronApplication } from "playwright";
import { closeElectron, withDeadline } from "./electron-shutdown.js";

import { auditCorpus, prepareSyntheticFixture, verifySyntheticFiles, prepareDerivedFixture, verifyDerivedFiles, verifyBaselineFiles, snapshotTree } from "./synthetic-fixtures.js";
async function finalizeDesktop(desktop: ElectronApplication, dir: string, logs: string[]): Promise<void> {
    let traceFailure: unknown;
    try {
      await withDeadline(desktop.context().tracing.stop({ path: join(dir, "trace.zip") }), 15_000, "Electron trace finalization");
    } catch (error) {
      traceFailure = error;
      await writeFile(join(dir, "trace-error.log"), error instanceof Error ? error.message : String(error));
    }
    try {
      await closeElectron(desktop, dir);
    } finally {
      await writeFile(join(dir, "electron.log"), logs.join("\n").replace(/([?&]token=|Bearer )[a-zA-Z0-9]+/g, "$1[redacted]"));
    }
    if (traceFailure) throw traceFailure;
}
const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const corpus = resolve(flag("--corpus"));
const output = resolve(flag("--output", "artifacts/electron"));
await mkdir(output, { recursive: true });
await auditCorpus(corpus, output);
const manifest = { games: await Promise.all([prepareSyntheticFixture(join(output, "fixtures"), "KOTOR1"), prepareSyntheticFixture(join(output, "fixtures"), "KOTOR2"), prepareDerivedFixture(corpus, join(output, "fixtures"), "KOTOR1"), prepareDerivedFixture(corpus, join(output, "fixtures"), "KOTOR2")]) };
const require = createRequire(resolve("packages/electron/package.json"));
const executablePath = require("electron") as string;
const results: unknown[] = [];
for (const fixture of manifest.games) {
  const derived = "componentCount" in fixture;
  const dir = join(output, `${fixture.game}-${derived ? "fullmd-derived" : "features"}`);
  await mkdir(dir, { recursive: true });
  const profile = join(dir, "electron-profile");
  const configRoot = join(dir, "native-config");
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(configRoot, { recursive: true })]);
  console.log(`Starting native GUI lane ${fixture.game} ${derived ? "fullmd-derived" : "features"}`);
  const logs: string[] = [];
  const errors: string[] = [];
  const desktop = await electron.launch({
    executablePath,
    args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), `--user-data-dir=${profile}`, resolve("packages/electron/dist/main.js")],
    env: { ...process.env, MODSYNC_SETTINGS_PATH: fixture.settings, MODSYNC_USER_DATA_DIRECTORY: profile, XDG_CONFIG_HOME: configRoot, APPDATA: configRoot },
    timeout: 60_000,
  }).catch(async (error) => {
    await writeFile(join(dir, "launch-error.log"), [error.stack ?? String(error), ...(Array.isArray(error.log) ? error.log : [])].join("\n"));
    throw error;
  });
  await desktop.context().tracing.start({ screenshots: true, snapshots: true });
  desktop.process().stdout?.on("data", (chunk) => logs.push(String(chunk)));
  desktop.process().stderr?.on("data", (chunk) => logs.push(String(chunk)));
  let page;
  try {
    const actualProfile = await desktop.evaluate(({ app }) => app.getPath("userData"));
    assert.equal(resolve(actualProfile), resolve(profile), "Native singleton/profile isolation was not applied");
    await writeFile(join(dir, "native-profile.json"), JSON.stringify({ expected: profile, actual: actualProfile, isolated: true }, null, 2));
    page = await desktop.firstWindow();
    page.setDefaultTimeout(30_000);
    page.on("console", (message) => {
      logs.push(`[renderer ${message.type()}] ${message.text()}`);
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByRole("heading", { name: "Welcome to ModSync" }).waitFor();
    assert.equal(await page.title(), "ModSync");
    assert.equal(new URL(page.url()).hostname, "127.0.0.1", "Renderer must use the in-process local server");
    assert.equal(await page.locator("vite-error-overlay").count(), 0, "Framework error overlay visible");
    assert.equal(await page.evaluate(() => Boolean((window as Window & { modsync?: { isElectron?: boolean } }).modsync?.isElectron)), true, "Native preload bridge missing");
    assert.equal(await page.locator("text=Mock mode is active").count(), 0, "Must use real server");
    await page.screenshot({ path: join(dir, "01-welcome.png"), fullPage: true });
    await page.getByRole("button", { name: "Next →", exact: true }).click();
    await page.getByRole("heading", { name: "Setup", exact: true }).waitFor();
    if (derived) {
      // First import the real pinned full.md and demonstrate why originals cannot install here.
      await page.getByPlaceholder("/path/to/build.toml").fill(join(output, `${fixture.game === "KOTOR1" ? "kotor1" : "kotor2"}-source-full.md`));
      await page.getByRole("button", { name: "Load", exact: true }).click();
      await page.locator(".alert-success").filter({ hasText: "Loaded" }).waitFor();
      const originalFile = await page.evaluate(async () => {
        const token = new URL(location.href).searchParams.get("token");
        const response = await fetch("/api/file", { headers: { authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`Original source load HTTP ${response.status}`);
        return response.json();
      });
      assert.equal(originalFile.mods.length, fixture.componentCount, "Original guide component coverage differs from mapped lane");
      await writeFile(join(dir, "original-guide-loaded.json"), JSON.stringify(originalFile, null, 2));
      for (let step = 0; step < 8; step++) {
        if (await page.getByRole("button", { name: "Select essentials", exact: true }).count()) break;
        await page.getByRole("button", { name: "Next →", exact: true }).click();
      }
      const selectionResponse = page.waitForResponse((response) => response.url().includes("/select-defaults"));
      await page.getByRole("button", { name: "Select essentials", exact: true }).click();
      assert.equal((await selectionResponse).status(), 200);
      await page.getByRole("button", { name: "Next →", exact: true }).click();
      const validationResponse = page.waitForResponse((response) => response.url().endsWith("/api/validate"));
      await page.getByRole("button", { name: "Next →", exact: true }).click();
      const originalReport = await (await validationResponse).json();
      assert.equal(originalReport.ok, false, "Original guide must require unavailable mod assets");
      assert(originalReport.requiredDownloads.some((download: { found: boolean }) => !download.found), "Missing originals must be reported");
      await page.screenshot({ path: join(dir, "00-original-fullmd-missing-assets.png"), fullPage: true });
      await writeFile(join(dir, "original-guide-validation.json"), JSON.stringify(originalReport, null, 2));
      for (let step = 0; step < 8; step++) {
        if (await page.getByRole("heading", { name: "Setup", exact: true }).count()) break;
        await page.getByRole("button", { name: "← Back", exact: true }).click();
      }
    }
    await page.getByPlaceholder("/path/to/build.toml").fill(fixture.instructions);
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await page.locator(".alert-success").filter({ hasText: "Loaded" }).waitFor();
    // Exercise directory edits through the renderer even when isolated settings prefill them.
    await page.getByPlaceholder("/home/you/kotor-mods").fill(fixture.mods);
    await page.getByPlaceholder("/home/you/kotor-mods").press("Tab");
    await page.locator("input[placeholder^='C:']").fill(fixture.kotor);
    await page.locator("input[placeholder^='C:']").press("Tab");
    await page.screenshot({ path: join(dir, "02-setup.png"), fullPage: true });
    // Traverse notes, selection, downloads and validation through visible controls.
    for (let step = 0; step < 12; step++) {
      if (await page.getByRole("heading", { name: "Ready to install", exact: true }).count()) break;
      await page.getByRole("button", { name: "Next →", exact: true }).click();
    }
    await page.getByRole("heading", { name: "Ready to install", exact: true }).waitFor();
    await page.screenshot({ path: join(dir, "03-ready.png"), fullPage: true });
    await page.getByRole("button", { name: "Begin installation", exact: true }).click();
    await page.getByRole("button", { name: "I understand, continue", exact: true }).click();
    await page.getByRole("button", { name: "I have read them", exact: true }).click();
    await page.getByRole("button", { name: /^Install \d+ mods$/ }).click();
    if (!derived) await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("heading", { name: "Installation finished", exact: true }).waitFor({ timeout: 300_000 });
    await page.screenshot({ path: join(dir, "04-installed.png"), fullPage: true });
    const status = await page.evaluate(async () => {
      const token = new URL(location.href).searchParams.get("token");
      const response = await fetch("/api/install/status", { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Install status HTTP ${response.status}`);
      return response.json();
    });
    assert.equal(status.running, false);
    assert.equal(status.summary.failed, 0, "Installation reported failures");
    await writeFile(join(dir, "rendered.html"), await page.content());
    assert(status.summary.succeeded > 0, "No synthetic mods installed");
    const baseTree = await snapshotTree(fixture.kotor);
    const baseProofs = derived ? await verifyDerivedFiles(fixture) : await verifySyntheticFiles(fixture, false);
    assert.deepEqual(status.order, derived ? fixture.expectedOrder : fixture.expectedOrder.slice(0, 3), "Base install order mismatch");
    await page.getByRole("button", { name: "Next →", exact: true }).click();
    await page.getByRole("heading", { name: "Base install complete", exact: true }).waitFor();
    await page.screenshot({ path: join(dir, "05-base-checkpoints.png"), fullPage: true });
    if (!derived) {
      for (let step = 0; step < 8; step++) {
        if (await page.getByRole("heading", { name: "Widescreen install complete", exact: true }).count()) break;
        await page.getByRole("button", { name: "Next →", exact: true }).click();
      }
      await page.getByRole("heading", { name: "Widescreen install complete", exact: true }).waitFor();
    }
    const completeTree = await snapshotTree(fixture.kotor);
    const completeProofs = derived ? baseProofs : await verifySyntheticFiles(fixture);
    await page.screenshot({ path: join(dir, "06-complete.png"), fullPage: true });
    const restoreResponse = page.waitForResponse((response) => response.url().includes("/restore") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Restore", exact: true }).first().click();
    assert.equal((await restoreResponse).status(), 200, "GUI checkpoint restore failed");
    const phaseRestoreTree = await snapshotTree(fixture.kotor);
    const restoreProofs = derived ? [] : await verifySyntheticFiles(fixture, false);
    if (!derived) {
      await page.getByRole("checkbox", { name: "Show all checkpoint sessions", exact: true }).check();
      const restoreBaseResponse = page.waitForResponse((response) => response.url().includes("/restore") && response.request().method() === "POST");
      await page.locator(`[data-checkpoint-session="${status.summary.checkpointSessionId}"]`).getByRole("button", { name: "Restore", exact: true }).first().click();
      assert.equal((await restoreBaseResponse).status(), 200, "GUI base baseline restore failed");
    }
    await verifyBaselineFiles(fixture);
    const originalBaselineTree = await snapshotTree(fixture.kotor);
    await page.screenshot({ path: join(dir, "07-restored.png"), fullPage: true });
    await writeFile(join(dir, "file-proofs.json"), JSON.stringify({ baseProofs, completeProofs, restoreProofs, trees: { baseTree, completeTree, phaseRestoreTree, originalBaselineTree } }, null, 2));
    await page.getByRole("button", { name: "Next →", exact: true }).click();
    await page.getByRole("heading", { name: "All done", exact: true }).waitFor();
    assert.equal(errors.length, 0, `Renderer errors: ${errors.join("; ")}`);
    await writeFile(join(dir, "install-status.json"), JSON.stringify(status, null, 2));
    results.push({ game: fixture.game, lane: derived ? "fullmd-derived-mechanical" : "synthetic-features", originalSourceInstalled: false, omittedPatcherAndExecutableEffects: true, status: "passed", succeeded: status.summary.succeeded, checkpointSessionId: status.summary.checkpointSessionId });
  } catch (error) {
    if (page) await page.screenshot({ path: join(dir, "failure.png"), fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    await writeFile(join(dir, "electron.log"), logs.join("\n").replace(/([?&]token=|Bearer )[a-zA-Z0-9]+/g, "$1[redacted]"));
    console.log(`Closing native GUI lane ${fixture.game} ${derived ? "fullmd-derived" : "features"}`);
    await finalizeDesktop(desktop, dir, logs);
    console.log(`Graceful Electron exit verified for ${fixture.game} ${derived ? "fullmd-derived" : "features"}`);
  }
}
await writeFile(join(output, "gui-results.json"), JSON.stringify({ runtime: "native-electron", platform: process.platform, results }, null, 2));
console.log(`Native Electron clickthrough passed for ${results.length} games`);
