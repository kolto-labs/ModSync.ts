import { describe, expect, it } from "vitest";
import {
  normalizeActionType,
  normalizeCategories,
  detectInstallationHints,
  normalizeInstallationMethod,
  normalizeTargetGame,
  normalizeTier,
  parseCategoryAndTier,
  tierLabel,
} from "./normalize.js";

describe("normalizeTier", () => {
  it("lets numbers win over words", () => {
    expect(normalizeTier("1 - Essential")).toBe("Essential");
    expect(normalizeTier("2 - Recommended")).toBe("Recommended");
    expect(normalizeTier("2 - Suggested")).toBe("Recommended");
    expect(normalizeTier("3 - Suggested")).toBe("Suggested");
    expect(normalizeTier("3 - Optional")).toBe("Suggested");
    expect(normalizeTier("4 - Optional")).toBe("Optional");
    expect(normalizeTier("4 - Option")).toBe("Optional");
    expect(normalizeTier("Tier 2")).toBe("Recommended");
  });
  it("falls back to keywords", () => {
    expect(normalizeTier("Essential")).toBe("Essential");
    expect(normalizeTier("recommended")).toBe("Recommended");
    expect(normalizeTier("Suggested")).toBe("Suggested");
    expect(normalizeTier("Optional")).toBe("Optional");
    expect(normalizeTier("")).toBe("Unknown");
    expect(normalizeTier(undefined)).toBe("Unknown");
    expect(normalizeTier("whatever")).toBe("Unknown");
  });
  it("labels round-trip", () => {
    for (const t of ["Essential", "Recommended", "Suggested", "Optional"] as const) expect(normalizeTier(tierLabel(t))).toBe(t);
  });
});

describe("normalizeCategories", () => {
  it("splits on & and , and maps aliases", () => {
    expect(normalizeCategories("Bugfix & Immersion")).toEqual(["Bugfix", "Immersion"]);
    expect(normalizeCategories("Graphics, UI")).toEqual(["Graphics Improvement", "UI"]);
    expect(normalizeCategories(["Appearance", "Mechanics", "Sound"])).toEqual(["Appearance Change", "Mechanics Change", "Audio"]);
    expect(normalizeCategories("Restored Content / Story")).toEqual(["Restored Content", "Story"]);
  });
  it("dedupes and marks unknown tokens once", () => {
    expect(normalizeCategories("Bugfix & Bug Fix & Weird & Odd")).toEqual(["Bugfix", "Unknown"]);
    expect(normalizeCategories("Unknown")).toEqual([]);
    expect(normalizeCategories(undefined)).toEqual([]);
  });
});

describe("parseCategoryAndTier", () => {
  it("parses the guide label", () => {
    expect(parseCategoryAndTier("Bugfix & Immersion / 2 - Recommended")).toEqual({ category: ["Bugfix", "Immersion"], tier: "Recommended" });
    expect(parseCategoryAndTier("Graphics Improvement / 1 - Essential")).toEqual({ category: ["Graphics Improvement"], tier: "Essential" });
    expect(parseCategoryAndTier("Immersion / Appearance Change / 3 - Suggested")).toEqual({ category: ["Immersion", "Appearance Change"], tier: "Suggested" });
  });
  it("handles missing parts", () => {
    expect(parseCategoryAndTier("Bugfix")).toEqual({ category: ["Bugfix"], tier: "Unknown" });
    expect(parseCategoryAndTier("1 - Essential")).toEqual({ category: [], tier: "Essential" });
    expect(parseCategoryAndTier("")).toEqual({ category: [], tier: "Unknown" });
  });
});

describe("normalizeInstallationMethod", () => {
  it("maps vocabulary", () => {
    expect(normalizeInstallationMethod("TSLPatcher")).toBe("TSLPatcher");
    expect(normalizeInstallationMethod("TSL Patcher")).toBe("TSLPatcher");
    expect(normalizeInstallationMethod("HoloPatcher")).toBe("HoloPatcher");
    expect(normalizeInstallationMethod("Loose-File")).toBe("Loose-File");
    expect(normalizeInstallationMethod("Loose-File Mod")).toBe("Loose-File");
    expect(normalizeInstallationMethod("Installer")).toBe("Executable");
    expect(normalizeInstallationMethod("TSLPatcher + Loose-File")).toBe("Mixed");
    expect(normalizeInstallationMethod("Mixed")).toBe("Mixed");
    expect(normalizeInstallationMethod("")).toBe("Unknown");
  });
  it("maps methods naming a .bat/.cmd/.sh script to Executable before the patcher test", () => {
    expect(normalizeInstallationMethod(".bat Patcher with Loose-File Components")).toBe("Executable");
    expect(normalizeInstallationMethod("Patcher (.cmd)")).toBe("Executable");
    expect(normalizeInstallationMethod(".bat Patcher / .sh script")).toBe("Executable");
    expect(normalizeInstallationMethod("TSLPatcher + Loose-File")).toBe("Mixed");
    expect(normalizeInstallationMethod("Mixed (.bat)")).toBe("Mixed");
    expect(normalizeInstallationMethod("Patcher for .battle files")).toBe("TSLPatcher");
  });
  it("keeps Multi-Run patcher methods as patchers", () => {
    expect(normalizeInstallationMethod("TSLPatcher (Multi-Run)")).toBe("TSLPatcher");
    expect(normalizeInstallationMethod("HoloPatcher (Multi Run)")).toBe("HoloPatcher");
  });
});

describe("detectInstallationHints", () => {
  it("finds script extensions and multi-run wording", () => {
    expect(detectInstallationHints("Run install.bat")).toEqual({ scriptExt: "bat", multiRun: false });
    expect(detectInstallationHints("Run it.SH twice")).toEqual({ scriptExt: "sh", multiRun: false });
    expect(detectInstallationHints("TSLPatcher (Multi-Run)")).toEqual({ multiRun: true });
    expect(detectInstallationHints(undefined)).toEqual({ multiRun: false });
  });
});

describe("normalizeActionType / normalizeTargetGame", () => {
  it("maps actions", () => {
    expect(normalizeActionType("extract")).toBe("Extract");
    expect(normalizeActionType("MOVE ALL")).toBe("Move");
    expect(normalizeActionType("run")).toBe("Execute");
    expect(normalizeActionType("tslpatcher")).toBe("Patcher");
    expect(normalizeActionType("DelDuplicate")).toBe("DelDuplicate");
    expect(normalizeActionType("nope")).toBeUndefined();
  });
  it("maps games", () => {
    expect(normalizeTargetGame("KOTOR 1 Full Build")).toBe("KOTOR1");
    expect(normalizeTargetGame("KOTOR 2 Full Build")).toBe("KOTOR2");
    expect(normalizeTargetGame("The Sith Lords Spoiler-Free Build")).toBe("KOTOR2");
    expect(normalizeTargetGame("TSL mods")).toBe("KOTOR2");
    expect(normalizeTargetGame("Knights of the Old Republic")).toBe("KOTOR1");
    expect(normalizeTargetGame("nothing")).toBe("Unknown");
  });
});
