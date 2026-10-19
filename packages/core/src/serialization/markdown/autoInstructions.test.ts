import { describe, expect, it } from "vitest";
import { createMod } from "../../model/defaults.js";
import { detectRunCount, generateInstructionsFromDescription, guessArchive } from "./autoInstructions.js";

const GUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("generateInstructionsFromDescription", () => {
  it("TSLPatcher: extract then patcher", () => {
    const mod = createMod({ guid: GUID, name: "NPC Alignment Fix", installationMethod: "TSLPatcher", modLink: ["https://deadlystream.com/files/file/1/"] });
    const instrs = generateInstructionsFromDescription(mod);
    expect(instrs.map((i) => i.action)).toEqual(["Extract", "Patcher"]);
    expect(instrs[0].source).toEqual(["<<modDirectory>>\\NPC Alignment Fix*.{zip,rar,7z}"]);
    expect(instrs[1].source).toEqual(["<<modDirectory>>\\NPC Alignment Fix*"]);
    expect(instrs[1].destination).toBe("<<kotorDirectory>>");
    expect(instrs.every((i) => i.description === "auto-generated")).toBe(true);
    expect(instrs[0].guid).not.toBe(instrs[1].guid);
    expect(generateInstructionsFromDescription(mod)).toEqual(instrs);
  });
  it("Loose-File: extract then move * to Override, using expected files when present", () => {
    const mod = createMod({ guid: GUID, name: "X: Y?", installationMethod: "Loose-File", expectedFiles: ["Ultimate Dantooine 1.0.rar"] });
    const instrs = generateInstructionsFromDescription(mod);
    expect(instrs.map((i) => i.action)).toEqual(["Extract", "Move"]);
    expect(instrs[0].source).toEqual(["<<modDirectory>>\\Ultimate Dantooine 1.0.rar"]);
    expect(instrs[1].source).toEqual(["<<modDirectory>>\\Ultimate Dantooine 1.0\\*"]);
    expect(instrs[1].destination).toBe("<<kotorDirectory>>\\Override");
  });
  it("executable links run directly", () => {
    const mod = createMod({ guid: GUID, name: "TSLRCM", installationMethod: "Executable", modLink: ["https://example.com/dl/tslrcm2022.exe"] });
    const instrs = generateInstructionsFromDescription(mod);
    expect(instrs.map((i) => i.action)).toEqual(["Execute"]);
    expect(instrs[0].source).toEqual(["<<modDirectory>>\\tslrcm2022.exe"]);
  });
  it("archive links use the file name; unknown methods guess from text", () => {
    expect(guessArchive(createMod({ name: "n", modLink: ["https://example.com/a/b/mod%20v2.7z"] }))).toEqual({
      pattern: "<<modDirectory>>\\mod v2.7z",
      folder: "<<modDirectory>>\\mod v2",
      isExecutable: false,
    });
    const unknown = generateInstructionsFromDescription(createMod({ guid: GUID, name: "U", description: "Drop into Override." }));
    expect(unknown.map((i) => i.action)).toEqual(["Extract", "Move"]);
    expect(generateInstructionsFromDescription(createMod({ guid: GUID, name: "V" })).map((i) => i.action)).toEqual(["Extract"]);
  });

  it("script methods run the script instead of a patcher, then move loose files when the guide says so", () => {
    const mod = createMod({
      guid: GUID,
      name: "Sample Scripted Pack",
      installationMethod: "Executable",
      modLink: ["https://example.com/dl/pack.7z"],
      directions: "Run apply.bat, then copy the loose-file components into Override.",
    });
    const instrs = generateInstructionsFromDescription(mod);
    expect(instrs.map((i) => i.action)).toEqual(["Extract", "Execute", "Move"]);
    expect(instrs[1].source).toEqual(["<<modDirectory>>\\pack\\*.bat"]);
    expect(instrs[2].source).toEqual(["<<modDirectory>>\\pack\\*"]);
    expect(instrs[2].destination).toBe("<<kotorDirectory>>\\Override");
    expect(instrs.some((i) => i.action === "Patcher")).toBe(false);
  });
  it("script methods without loose-file wording only Execute the script", () => {
    const mod = createMod({ guid: GUID, name: "Sample Script", installationMethod: "Executable", modLink: ["https://example.com/dl/s.zip"], directions: "Double-click run.sh." });
    const instrs = generateInstructionsFromDescription(mod);
    expect(instrs.map((i) => i.action)).toEqual(["Extract", "Execute"]);
    expect(instrs[1].source).toEqual(["<<modDirectory>>\\s\\*.sh"]);
  });
  it("duplicate-removal scripts become DelDuplicate when the guide names the extension", () => {
    const mod = createMod({
      guid: GUID,
      name: "Sample Duplicate Cleaner",
      installationMethod: "Executable",
      directions: "Run clean.bat to remove duplicate .tga textures that also exist as .tpc.",
    });
    const instrs = generateInstructionsFromDescription(mod);
    expect(instrs.map((i) => i.action)).toEqual(["DelDuplicate"]);
    expect(instrs[0].source).toEqual(["<<kotorDirectory>>\\Override"]);
    expect(instrs[0].arguments).toBe(".tga");
  });
  it("duplicate wording that names both or neither extension keeps Execute", () => {
    const both = createMod({ guid: GUID, name: "Sample Both", installationMethod: "Executable", modLink: ["https://example.com/a.zip"], directions: "Run clean.bat to remove duplicate tga or tpc files." });
    expect(generateInstructionsFromDescription(both).map((i) => i.action)).toEqual(["Extract", "Execute"]);
    const none = createMod({ guid: GUID, name: "Sample None", installationMethod: "Executable", modLink: ["https://example.com/a.zip"], directions: "Run clean.bat." });
    expect(generateInstructionsFromDescription(none).map((i) => i.action)).toEqual(["Extract", "Execute"]);
  });
});

describe("Multi-Run patchers", () => {
  const multi = (directions: string) =>
    generateInstructionsFromDescription(createMod({ guid: GUID, name: "Sample Multi", installationMethod: "TSLPatcher", modLink: ["https://example.com/m.7z"], directions }));
  it("emits one Patcher per stated run with the namespace index as arguments", () => {
    const instrs = multi("Multi-Run: run the patcher 3 times, picking the next option each time.");
    expect(instrs.map((i) => i.action)).toEqual(["Extract", "Patcher", "Patcher", "Patcher"]);
    expect(instrs.slice(1).map((i) => i.arguments)).toEqual(["0", "1", "2"]);
    expect(instrs.slice(1).every((i) => i.source[0] === "<<modDirectory>>\\m")).toBe(true);
    expect(new Set(instrs.map((i) => i.guid)).size).toBe(4);
    expect(instrs[2].description).toContain("multi-run 2 of 3");
  });
  it("understands spelled-out counts and twice", () => {
    expect(multi("You need to run the installer six times.").filter((i) => i.action === "Patcher")).toHaveLength(6);
    expect(multi("Run the patcher twice.").filter((i) => i.action === "Patcher")).toHaveLength(2);
  });
  it("keeps a single flagged Patcher when the run count is not stated", () => {
    const instrs = multi("Multi-Run patcher, see readme.");
    expect(instrs.map((i) => i.action)).toEqual(["Extract", "Patcher"]);
    expect(instrs[1].arguments).toBeUndefined();
    expect(instrs[1].description).toContain("multi-run");
    expect(instrs[1].description).toContain("review");
  });
  it("leaves ordinary patchers unflagged", () => {
    const instrs = multi("Run the patcher once.");
    expect(instrs.map((i) => i.description)).toEqual(["auto-generated", "auto-generated"]);
  });
  it("detectRunCount ignores implausible counts", () => {
    expect(detectRunCount("run 6 times")).toBe(6);
    expect(detectRunCount("run 40 times")).toBeUndefined();
    expect(detectRunCount("run 1 times")).toBeUndefined();
    expect(detectRunCount("nothing here")).toBeUndefined();
  });
});

describe("installer .exe downloads", () => {
  it("an .exe expected file or link emits Execute only", () => {
    for (const mod of [
      createMod({ guid: GUID, name: "Sample Installer", installationMethod: "Executable", expectedFiles: ["setup_sample.exe"] }),
      createMod({ guid: GUID, name: "Sample Installer", installationMethod: "Executable", modLink: ["https://example.com/dl/setup_sample.exe"] }),
    ]) {
      const instrs = generateInstructionsFromDescription(mod);
      expect(instrs.map((i) => i.action)).toEqual(["Execute"]);
      expect(instrs[0].source).toEqual(["<<modDirectory>>\\setup_sample.exe"]);
    }
  });
  it("an Executable method with no archive file or wording emits only Execute of Name*.exe", () => {
    const mod = createMod({ guid: GUID, name: "Sample Installer", installationMethod: "Executable", modLink: ["https://example.com/files/file/9-sample/"], directions: "Run the installer." });
    const instrs = generateInstructionsFromDescription(mod);
    expect(guessArchive(mod).isExecutable).toBe(true);
    expect(instrs.map((i) => i.action)).toEqual(["Execute"]);
    expect(instrs[0].source).toEqual(["<<modDirectory>>\\Sample Installer*.exe"]);
  });
  it("an Executable method whose guide mentions an archive keeps Extract then Execute", () => {
    const mod = createMod({ guid: GUID, name: "Sample Packed", installationMethod: "Executable", modLink: ["https://example.com/files/file/9-sample/"], directions: "Extract the archive and run the installer." });
    const instrs = generateInstructionsFromDescription(mod);
    expect(instrs.map((i) => i.action)).toEqual(["Extract", "Execute"]);
    expect(instrs[1].source).toEqual(["<<modDirectory>>\\Sample Packed*\\*.exe"]);
  });
});
