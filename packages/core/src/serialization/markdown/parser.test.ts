import { describe, expect, it } from "vitest";
import { K1_FULL_MD, K2_DS_MD } from "./fixtures.test.js";
import { parseMarkdownBuild } from "./parser.js";
import { stableGuidForName } from "./stableGuid.js";

describe("parseMarkdownBuild (r/kotor full.md)", () => {
  const { file, warnings } = parseMarkdownBuild(K1_FULL_MD, { sourceUrl: "https://kotor.example/full.md" });
  const [k1cp, jc, hires] = file.mods;

  it("detects config and section contents", () => {
    expect(file.config.name).toBe("KOTOR 1 Full Build");
    expect(file.config.targetGame).toBe("KOTOR1");
    expect(file.config.sourceUrl).toBe("https://kotor.example/full.md");
    expect(file.config.beforeModListContent).toContain("## Introduction");
    expect(file.config.beforeModListContent).toContain("### Table of Contents");
    expect(file.config.beforeModListContent).toContain("Mods are listed in install order.");
    expect(file.config.beforeModListContent).not.toContain("# KOTOR 1 Full Build");
    expect(file.config.widescreenSectionContent).toBe("## Widescreen Mods\n\nOnly install these after the base build.");
    expect(file.config.afterModListContent).toBe("## Closing\n\nThat's it, enjoy the game!");
    expect(file.config.aspyrSectionContent).toBeUndefined();
  });

  it("finds three mods with heading levels", () => {
    expect(file.mods.map((m) => m.name)).toEqual(["KOTOR 1 Community Patch", "JC's Minor Fixes for K1", "KOTOR High Resolution Menus"]);
    expect(file.mods.every((m) => m.headingLevel === 3)).toBe(true);
  });

  it("uses the hidden [HIDDEN:MOD] block verbatim", () => {
    expect(k1cp.guid).toBe("c5418549-6b7e-4a8c-8b8e-4aa1bc63c732");
    expect(k1cp.instructions.map((i) => i.action)).toEqual(["Extract", "Patcher"]);
    expect(k1cp.instructions[0].source).toEqual(["<<modDirectory>>\\KOTOR 1 Community Patch*.zip"]);
    expect(k1cp.instructions[0].overwrite).toBe(true);
    expect(k1cp.instructions[1].destination).toBe("<<kotorDirectory>>");
    expect(k1cp.instructions[1].source).toEqual(["<<modDirectory>>\\KOTOR 1 Community Patch*\\TSLPatcher.exe"]);
    expect(k1cp.authors).toEqual(["A Future Pilot", "et al"]);
    expect(k1cp.modLink).toEqual(["https://deadlystream.com/files/file/1258-kotor-1-community-patch/"]);
    expect(k1cp.category).toEqual(["Bugfix"]);
    expect(k1cp.tier).toBe("Essential");
    expect(k1cp.language).toBe("YES");
    expect(k1cp.installationMethod).toBe("TSLPatcher");
    expect(k1cp.directions).toBe("Run the installer and select your game directory.");
    expect(k1cp.usageWarnings).toBe("Install this first.");
    expect(k1cp.description).toBe("A compilation of bugfixes and improvements.");
  });

  it("parses structured keyword steps", () => {
    expect(jc.instructions.map((i) => i.action)).toEqual(["Extract", "Move", "Move", "Delete", "Rename"]);
    const [extract, moveAll, moveSpecific, del, rename] = jc.instructions;
    expect(extract.source).toEqual(["<<modDirectory>>/JC's Minor Fixes for K1*.zip"]);
    expect(moveAll.source).toEqual(["<<modDirectory>>/JC's Minor Fixes for K1*/Straight Fixes/*"]);
    expect(moveAll.destination).toBe("<<kotorDirectory>>/Override");
    expect(moveSpecific.source).toEqual([
      "<<modDirectory>>/JC's Minor Fixes for K1*/Things What Bother Me Fixes/man26_enter4.dlg",
      "<<modDirectory>>/JC's Minor Fixes for K1*/Things What Bother Me Fixes/k_pdan_zhar10.dlg",
    ]);
    expect(moveSpecific.destination).toBe("<<kotorDirectory>>/Override");
    expect(del.source).toEqual(["<<kotorDirectory>>/Override/foo.tga"]);
    expect(rename.source).toEqual(["<<modDirectory>>/JC's Minor Fixes for K1*/w_ionrfl_04.mdl"]);
    expect(rename.destination).toBe("w_ionrfl_004.mdl");
    expect(jc.directions).toContain("**SKIP** the Bugfix folder");
    expect(jc.modLink).toEqual(["https://deadlystream.com/files/file/1474-jcs-minor-fixes-for-k1/", "https://example.com/mirror.zip"]);
    expect(jc.category).toEqual(["Bugfix", "Immersion"]);
    expect(jc.tier).toBe("Recommended");
    const guids = new Set(jc.instructions.map((i) => i.guid));
    expect(guids.size).toBe(5);
  });

  it("resolves Masters to GUIDs and keeps unresolved names", () => {
    expect(jc.dependencies).toEqual([k1cp.guid]);
    expect(jc.usageWarnings).toContain("Masters (unresolved): Some Mod That Does Not Exist");
    expect(jc.usageWarnings).toContain("Skip the");
    expect(warnings.some((w) => w.includes("Some Mod That Does Not Exist"))).toBe(true);
  });

  it("auto-generates instructions for prose entries and flags widescreen mods", () => {
    expect(hires.isWidescreen).toBe(true);
    expect(jc.isWidescreen).toBe(false);
    expect(hires.description).toBe("(spoiler-free)");
    expect(hires.instructions.map((i) => i.action)).toEqual(["Extract", "Move"]);
    expect(hires.instructions[0].source).toEqual(["<<modDirectory>>\\KOTOR High Resolution Menus*.{zip,rar,7z}"]);
    expect(hires.instructions[1].destination).toBe("<<kotorDirectory>>\\Override");
    expect(hires.directions).toContain("Extract the archive");
    expect(warnings.some((w) => w.includes("KOTOR High Resolution Menus") && w.includes("auto-generated"))).toBe(true);
    expect(warnings.some((w) => w.includes("JC's Minor Fixes") && w.includes("auto-generated"))).toBe(false);
  });

  it("derives deterministic GUIDs from names", () => {
    expect(jc.guid).toBe(stableGuidForName("JC's Minor Fixes for K1"));
    const again = parseMarkdownBuild(K1_FULL_MD).file;
    expect(again.mods.map((m) => m.guid)).toEqual(file.mods.map((m) => m.guid));
    expect(again.mods[0].instructions.map((i) => i.guid)).toEqual(k1cp.instructions.map((i) => i.guid));
    expect(again.mods[1].instructions.map((i) => i.guid)).toEqual(jc.instructions.map((i) => i.guid));
    expect(warnings.some((w) => w.includes("had no Guid"))).toBe(false);
    expect(again.mods[2].instructions.map((i) => i.guid)).toEqual(hires.instructions.map((i) => i.guid));
  });
});

describe("parseMarkdownBuild (DeadlyStream style, ## mods, YAML hidden block)", () => {
  const { file, warnings } = parseMarkdownBuild(K2_DS_MD);
  const [tslrcm, csuc] = file.mods;

  it("reads the hidden config block and the aspyr section", () => {
    expect(file.config.targetGame).toBe("KOTOR2");
    expect(file.config.version).toBe("rev 3");
    expect(file.config.name).toBe("KOTOR 2 (The Sith Lords) Mod Build");
    expect(file.config.beforeModListContent).toBe("Intro paragraph.");
    expect(file.config.aspyrSectionContent).toBe("## Aspyr Patch Notes\n\nIf you use the Aspyr patch, read this.");
  });

  it("handles level-2 mod headings", () => {
    expect(file.mods.map((m) => m.name)).toEqual(["The Sith Lords Restored Content Mod (TSLRCM)", "Character Start Up Changes"]);
    expect(tslrcm.headingLevel).toBe(2);
  });

  it("uses the YAML block verbatim, including options", () => {
    expect(tslrcm.guid).toBe("751edb92-05e8-4b5f-a98c-1bf9921ac05b");
    expect(tslrcm.instructions.map((i) => i.action)).toEqual(["Extract", "Move"]);
    expect(tslrcm.instructions[0].guid).toBe("851edb92-05e8-4b5f-a98c-1bf9921ac05b");
    expect(tslrcm.instructions[1].source).toEqual(["feat.2da", "featgain.2da"]);
    expect(tslrcm.options).toHaveLength(1);
    expect(tslrcm.options[0].name).toBe("Skip intro");
    expect(tslrcm.options[0].isSelected).toBe(true);
    expect(tslrcm.options[0].instructions[0].action).toBe("Delete");
    expect(tslrcm.options[0].guid).toBe(parseMarkdownBuild(K2_DS_MD).file.mods[0].options[0].guid);
    expect(tslrcm.instructions[1].guid).toBe(parseMarkdownBuild(K2_DS_MD).file.mods[0].instructions[1].guid);
    expect(tslrcm.installationMethod).toBe("Executable");
    expect(tslrcm.authors).toEqual(["Zbyl2", "DarthStoney", "Hassat Hunter", "VarsityPuppet"]);
  });

  it("resolves Masters by fuzzy name", () => {
    expect(csuc.dependencies).toEqual([tslrcm.guid]);
    expect(csuc.instructions.map((i) => i.action)).toEqual(["Extract", "Move"]);
    expect(warnings.some((w) => w.includes("unresolved"))).toBe(false);
  });
});

describe("parseMarkdownBuild edge cases", () => {
  it("works without a Mod List heading", () => {
    const md = "# KOTOR 2 build\n\nHello.\n\n### Mod A\n**Author:** X\n**Category & Tier:** Bugfix / 1 - Essential\n\n### Mod B\n**Author:** Y\n**Masters:** Mod A\n";
    const { file, warnings } = parseMarkdownBuild(md);
    expect(file.mods.map((m) => m.name)).toEqual(["Mod A", "Mod B"]);
    expect(file.config.beforeModListContent).toBe("Hello.");
    expect(file.mods[1].dependencies).toEqual([file.mods[0].guid]);
    expect(file.config.targetGame).toBe("KOTOR2");
    expect(warnings.some((w) => w.includes("dropped"))).toBe(false);
  });

  it("gives duplicate names distinct stable GUIDs", () => {
    const md = "## Mod List\n### Same\n**Author:** a\n### Same\n**Author:** b\n";
    const { file, warnings } = parseMarkdownBuild(md, { autoInstructions: false });
    expect(file.mods[0].guid).not.toBe(file.mods[1].guid);
    expect(file.mods[1].guid).toBe(parseMarkdownBuild(md).file.mods[1].guid);
    expect(warnings.some((w) => w.includes("duplicate mod name"))).toBe(true);
    expect(file.mods[0].instructions).toEqual([]);
  });

  it("keeps unknown labels and leading paragraphs as directions", () => {
    const md = "## Mod List\n### X\nSome note first.\n\n**Author:** a\n**Note:** be careful\n**Installation Method:** Loose-File\n";
    const { file } = parseMarkdownBuild(md);
    expect(file.mods[0].directions).toBe("Some note first.\n\n**Note:** be careful");
  });

  it("reports an invalid hidden YAML block", () => {
    const md = "## Mod List\n### X\n<!--<<ModSync>>\nGuid: [oops\n-->\n**Author:** a\n";
    const { warnings } = parseMarkdownBuild(md);
    expect(warnings.some((w) => w.includes("invalid ModSync YAML"))).toBe(true);
  });
});

describe("cross-format", () => {
  it("an imported guide survives a TOML serialize/parse cycle", async () => {
    const { parseInstructionFileDetailed, serializeInstructionFile } = await import("../toml.js");
    const imported = parseMarkdownBuild(K1_FULL_MD).file;
    const toml = serializeInstructionFile(imported);
    expect(toml).toContain("[[thisMod]]");
    expect(toml).toContain('Guid = "{C5418549-6B7E-4A8C-8B8E-4AA1BC63C732}"');
    const { file, warnings } = parseInstructionFileDetailed(toml);
    expect(warnings).toEqual([]);
    expect(file).toEqual(imported);
  });
});

describe("community guide version fixes and admonitions", () => {
  it("imports actual Aspyr fix packages before Mod List without importing setup headings", () => {
    const md = `# KOTOR 2 Full Build
## Installation Notes
### Linux Players
**Description:** General setup instructions, not a mod.
## CRITICAL: PC Version Differences & Fixes
Use these fixes only with the Aspyr patch.
### 3C-FD Patcher
**Name:** [3C-FD Patcher](https://example.com/3c-fd)
**Installation Method:** Executable
### Water Restoration
**Name:** [Water Restoration](https://example.com/water)
**Installation Method:** Loose-File Mod
### Stutter Fix
**Name:** [Stutter Fix and Force Cage Update](https://example.com/stutter)
**Installation Method:** Loose-File Mod
## Mod List
### TSLRCM
**Name:** [The Sith Lords Restored Content Mod](https://example.com/tslrcm)
**Installation Method:** Executable
## Enhanced Widescreen Support Mods
### Main Menu Fix
**Name:** [Main Menu Fix](https://example.com/menu)
**Installation Method:** Loose-File Mod
## Misc. Basegame Issues & Fixes
### Grass
Change the settings file.
`;
    const { file } = parseMarkdownBuild(md, { autoInstructions: false });
    expect(file.mods.map((mod) => mod.name)).toEqual(["3C-FD Patcher", "Water Restoration", "Stutter Fix", "TSLRCM", "Main Menu Fix"]);
    expect(file.mods.map((mod) => mod.aspyrOnly)).toEqual([true, true, true, false, false]);
    expect(file.mods.map((mod) => mod.isWidescreen)).toEqual([false, false, false, false, true]);
    expect(file.config.beforeModListContent).toContain("Linux Players");
    expect(file.config.beforeModListContent).not.toContain("Water Restoration");
    expect(file.config.aspyrSectionContent).toContain("Use these fixes only with the Aspyr patch.");
    expect(file.config.afterModListContent).toContain("Grass");
  });

  it("keeps installation and download admonitions out of Masters dependencies", () => {
    const md = `# KOTOR 1 Build
## Mod List
### Master
**Name:** Master
### Child
**Name:** Child
**Masters:** Master
:::note
Download Instructions
:   Ignore the txi.rar file.
:::
:::note
Installation Instructions
:   Delete ncommm07.tga, then move remaining files to Override.
:::
`;
    const { file, warnings } = parseMarkdownBuild(md, { autoInstructions: false });
    expect(file.mods[1].dependencies).toEqual([file.mods[0].guid]);
    expect(warnings.some((warning) => warning.includes("unresolved dependencies"))).toBe(false);
    expect(file.mods[1].directions).toContain("Ignore the txi.rar file.");
    expect(file.mods[1].directions).toContain("Delete ncommm07.tga, then move remaining files to Override.");
  });

  it("preserves literal underscores in resource-style headings", () => {
    const { file } = parseMarkdownBuild("# KOTOR 1 Build\n## Mod List\n### N_oldAMH01 HD\n**Name:** N_oldAMH01 HD", { autoInstructions: false });
    expect(file.mods[0].name).toBe("N_oldAMH01 HD");
    expect(file.mods[0].guid).toBe(stableGuidForName("N_oldAMH01 HD"));
  });
});
