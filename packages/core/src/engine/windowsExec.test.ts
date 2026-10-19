import { describe, expect, it } from "vitest";

import { WineUnavailableError, createProcessHost, isWindowsBatchScript, isWindowsExecutable, planLaunch, resolveExecuteStdin, toWinePath, translateArgumentsForWine, type ProcessHost } from "./windowsExec.js";

const MZ = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);

function stubHost(partial: Partial<ProcessHost> & { present?: Record<string, string>; head?: Uint8Array } = {}): ProcessHost {
  const present = partial.present ?? { wine: "/usr/bin/wine" };
  return createProcessHost({
    platform: "linux",
    env: { DISPLAY: ":0", PATH: "/usr/bin" },
    run: async () => ({ code: 0, signal: null, stdout: "", stderr: "" }),
    findExecutable: async (name) => present[name],
    readHead: async () => partial.head ?? MZ,
    ...partial,
  });
}

describe("windows executable launch planning", () => {
  it("recognises the MZ magic and nothing else", () => {
    expect(isWindowsExecutable(MZ)).toBe(true);
    expect(isWindowsExecutable(ELF)).toBe(false);
    expect(isWindowsExecutable(new TextEncoder().encode("#!/bin/sh\n"))).toBe(false);
    expect(isWindowsExecutable(new Uint8Array([0x4d]))).toBe(false);
    expect(isWindowsExecutable(new Uint8Array())).toBe(false);
  });

  it("maps POSIX paths onto wine's Z: drive", () => {
    expect(toWinePath("/games/base/Override/a.txt")).toBe("Z:\\games\\base\\Override\\a.txt");
    expect(toWinePath("/games/base/../base/x")).toBe("Z:\\games\\base\\x");
  });

  it("translates only arguments that point into the game or mod directories", () => {
    const roots = ["/games/base", "/mods"];
    expect(
      translateArgumentsForWine(
        ["/silent", "/games/base", "/games/base/Override/a.txt", "/DIR=/games/base/Override", "--src=/mods/pack/files", "/etc/hosts", "/DIR=/elsewhere/x", "relative/path", "C:\\already\\windows", "/games/baseline/x"],
        roots,
      ),
    ).toEqual([
      "/silent",
      "Z:\\games\\base",
      "Z:\\games\\base\\Override\\a.txt",
      "/DIR=Z:\\games\\base\\Override",
      "--src=Z:\\mods\\pack\\files",
      "/etc/hosts",
      "/DIR=/elsewhere/x",
      "relative/path",
      "C:\\already\\windows",
      "/games/baseline/x",
    ]);
  });

  it("does not translate when a root is not a POSIX path", () => {
    expect(translateArgumentsForWine(["/games/base/x"], ["C:/games/base"])).toEqual(["/games/base/x"]);
  });

  it("launches the plain program on Windows without looking at the file", async () => {
    let looked = false;
    const host = stubHost({ platform: "win32", readHead: async () => { looked = true; return MZ; } });
    expect(await planLaunch(host, "C:\\mods\\setup.exe", ["/S"], [])).toEqual({ command: "C:\\mods\\setup.exe", args: ["/S"], viaWine: false });
    expect(looked).toBe(false);
  });

  it("launches ELF binaries, scripts and unreadable files natively", async () => {
    const plain = { command: "/mods/tool", args: ["-v"], viaWine: false };
    expect(await planLaunch(stubHost({ head: ELF }), "/mods/tool", ["-v"], [])).toEqual(plain);
    expect(await planLaunch(stubHost({ readHead: async () => { throw new Error("EACCES"); } }), "/mods/tool", ["-v"], [])).toEqual(plain);
  });

  it("runs a Windows executable through wine with WINEDEBUG silenced", async () => {
    const launch = await planLaunch(stubHost(), "/mods/fix.exe", ["/games/base/Override"], ["/games/base"]);
    expect(launch).toMatchObject({ command: "/usr/bin/wine", args: ["/mods/fix.exe", "Z:\\games\\base\\Override"], viaWine: true });
    expect(launch.env?.WINEDEBUG).toBe("-all");
  });

  it("keeps the caller's wine settings", async () => {
    const host = stubHost({ env: { DISPLAY: ":0", WINEPREFIX: "/prefix", WINEDEBUG: "err+all" } });
    const launch = await planLaunch(host, "/mods/fix.exe", [], []);
    expect(launch.env).toMatchObject({ WINEPREFIX: "/prefix", WINEDEBUG: "err+all" });
  });

  it("falls back to wine64 when plain wine is absent", async () => {
    const launch = await planLaunch(stubHost({ present: { wine64: "/opt/wine64" } }), "/mods/fix.exe", [], []);
    expect(launch.command).toBe("/opt/wine64");
  });

  it("wraps wine in xvfb-run only on a headless Linux host that has it", async () => {
    const present = { wine: "/usr/bin/wine", "xvfb-run": "/usr/bin/xvfb-run" };
    const headless = await planLaunch(stubHost({ env: { PATH: "/usr/bin" }, present }), "/mods/fix.exe", ["/S"], []);
    expect(headless.command).toBe("/usr/bin/xvfb-run");
    expect(headless.args.slice(0, 3)).toEqual(["-a", "-s", "-screen 0 1280x1024x24"]);
    expect(headless.args.slice(3)).toEqual(["/usr/bin/wine", "/mods/fix.exe", "/S"]);

    const withDisplay = await planLaunch(stubHost({ present }), "/mods/fix.exe", [], []);
    expect(withDisplay.command).toBe("/usr/bin/wine");

    const noXvfb = await planLaunch(stubHost({ env: { PATH: "/usr/bin" } }), "/mods/fix.exe", [], []);
    expect(noXvfb.command).toBe("/usr/bin/wine");

    const mac = await planLaunch(stubHost({ platform: "darwin", env: { PATH: "/usr/bin" }, present }), "/mods/fix.exe", [], []);
    expect(mac.command).toBe("/usr/bin/wine");
  });

  it("fails loudly when wine is needed but missing", async () => {
    const host = stubHost({ present: {} });
    await expect(planLaunch(host, "/mods/fix.exe", [], [])).rejects.toBeInstanceOf(WineUnavailableError);
    await expect(planLaunch(host, "/mods/fix.exe", [], [])).rejects.toThrow(/wine/);
  });

  it("recognises .bat and .cmd scripts case-insensitively", () => {
    expect(isWindowsBatchScript("/mods/run.bat")).toBe(true);
    expect(isWindowsBatchScript("/mods/RUN.CMD")).toBe(true);
    expect(isWindowsBatchScript("/mods/run.exe")).toBe(false);
    expect(isWindowsBatchScript("/mods/run.sh")).toBe(false);
  });

  it("runs a .bat through wine cmd /c with a Z: path and translated arguments, without reading the file", async () => {
    let looked = false;
    const host = stubHost({ head: ELF, readHead: async () => { looked = true; return ELF; } });
    const launch = await planLaunch(host, "/mods/pack/install.bat", ["/games/base/Override", "/q"], ["/games/base"]);
    expect(launch).toMatchObject({
      command: "/usr/bin/wine",
      args: ["cmd", "/c", "Z:\\mods\\pack\\install.bat", "Z:\\games\\base\\Override", "/q"],
      viaWine: true,
    });
    expect(launch.env?.WINEDEBUG).toBe("-all");
    expect(looked).toBe(false);
    const upper = await planLaunch(stubHost(), "/mods/pack/INSTALL.CMD", [], []);
    expect(upper.args).toEqual(["cmd", "/c", "Z:\\mods\\pack\\INSTALL.CMD"]);
  });

  it("wraps a .bat in xvfb-run on a headless Linux host and reports missing wine", async () => {
    const present = { wine: "/usr/bin/wine", "xvfb-run": "/usr/bin/xvfb-run" };
    const launch = await planLaunch(stubHost({ env: { PATH: "/usr/bin" }, present }), "/mods/a.bat", [], []);
    expect(launch.command).toBe("/usr/bin/xvfb-run");
    expect(launch.args.slice(3)).toEqual(["/usr/bin/wine", "cmd", "/c", "Z:\\mods\\a.bat"]);
    await expect(planLaunch(stubHost({ present: {} }), "/mods/a.bat", [], [])).rejects.toBeInstanceOf(WineUnavailableError);
  });

  it("leaves a .bat unchanged on Windows", async () => {
    const host = stubHost({ platform: "win32" });
    expect(await planLaunch(host, "C:\\mods\\run.bat", ["/q"], [])).toEqual({ command: "C:\\mods\\run.bat", args: ["/q"], viaWine: false });
  });

  it("keeps .exe launches unchanged when no stdin is requested", async () => {
    const launch = await planLaunch(stubHost(), "/mods/fix.exe", ["/S"], []);
    expect(launch.args).toEqual(["/mods/fix.exe", "/S"]);
    expect("stdin" in launch).toBe(false);
  });

  it("passes stdin through on native, wine and batch launches", async () => {
    expect((await planLaunch(stubHost({ head: ELF }), "/mods/tool", [], [], "y\n")).stdin).toBe("y\n");
    expect((await planLaunch(stubHost(), "/mods/fix.exe", [], [], "y\n")).stdin).toBe("y\n");
    expect((await planLaunch(stubHost(), "/mods/a.bat", [], [], "y\n")).stdin).toBe("y\n");
    expect((await planLaunch(stubHost({ platform: "win32" }), "C:\\a.bat", [], [], "y\n")).stdin).toBe("y\n");
  });

  it("derives stdin only when the instruction opts in", () => {
    expect(resolveExecuteStdin(undefined, ["a", "b"])).toEqual({ args: ["a", "b"] });
    expect(resolveExecuteStdin({ other: 1 }, ["a"])).toEqual({ args: ["a"] });
    expect(resolveExecuteStdin({ stdin: "1\n2\n" }, ["a"])).toEqual({ args: ["a"], stdin: "1\n2\n" });
    expect(resolveExecuteStdin({ stdin: "arguments" }, ["1", "yes"])).toEqual({ args: [], stdin: "1\nyes\n" });
    expect(resolveExecuteStdin({ stdin: "arguments" }, [])).toEqual({ args: [], stdin: "" });
  });
});
