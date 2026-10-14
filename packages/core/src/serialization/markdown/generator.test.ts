import { describe, expect, it } from "vitest";
import { createInstruction, createInstructionFile, createMod, createOption } from "../../model/defaults.js";
import { toBracedGuid } from "../../model/guid.js";
import type { InstructionFile, ModComponent } from "../../model/types.js";
import { K1_FULL_MD } from "./fixtures.test.js";
import { describeInstruction, generateMarkdownDocs, type MarkdownStyle } from "./generator.js";
import { parseMarkdownBuild } from "./parser.js";
import { stableGuidForName } from "./stableGuid.js";

// Mod GUIDs are name-derived so that styles without hidden blocks round-trip exactly.
const A = stableGuidForName("KOTOR 1 Community Patch");
const B = stableGuidForName("JC's Minor Fixes for K1");
const C = stableGuidForName("KOTOR High Resolution Menus");
const OPT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OPT2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
let n = 0;
const g = (): string => `${(n++).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;

function sampleFile(): InstructionFile {
  return createInstructionFile({
    config: {
      targetGame: "KOTOR1",
      name: "KOTOR 1 Full Build rev 12",
      version: "12",
      compatibilityLevel: "Compatible",
      patcherEngine: "Native",
      spoilerFree: false,
      platform: "PC",
      beforeModListContent: "## Introduction\n\nRead this **first**.\n\n### Requirements\n\n- A clean install",
      widescreenSectionContent: "## Widescreen Mods\n\nOnly after the base build.",
      afterModListContent: "## Closing\n\nEnjoy!",
    },
    mods: [
      createMod({
        guid: A,
        name: "KOTOR 1 Community Patch",
        headingLevel: 3,
        description: "A compilation of bugfixes.",
        directions: "Install this first.",
        authors: ["A Future Pilot", "et al"],
        modLink: ["https://deadlystream.com/files/file/1258-kotor-1-community-patch/"],
        category: ["Bugfix", "Immersion"],
        tier: "Essential",
        language: "YES",
        installationMethod: "TSLPatcher",
        usageWarnings: "Do not skip.",
        expectedFiles: ["KOTOR 1 Community Patch 1.10.0.zip"],
        instructions: [
          createInstruction("Extract", { guid: g(), source: ["<<modDirectory>>\\KOTOR 1 Community Patch*.zip"] }),
          createInstruction("Patcher", { guid: g(), source: ["<<modDirectory>>\\KOTOR 1 Community Patch*\\TSLPatcher.exe"], destination: "<<kotorDirectory>>", arguments: "0" }),
        ],
      }),
      createMod({
        guid: B,
        name: "JC's Minor Fixes for K1",
        headingLevel: 3,
        description: "Fixes minor issues.\nSecond line of description.",
        authors: ["JCarter426"],
        modLink: ["https://deadlystream.com/files/file/1474/", "https://example.com/mirror.zip"],
        category: ["Bugfix"],
        tier: "Recommended",
        installationMethod: "Loose-File",
        dependencies: [A],
        restrictions: [C],
        installAfter: [A],
        fullBuildOnly: true,
        instructions: [
          createInstruction("Extract", { guid: g(), source: ["<<modDirectory>>/JC's Minor Fixes for K1*.zip"], description: "unpack it" }),
          createInstruction("Move", { guid: g(), source: ["<<modDirectory>>/JC's Minor Fixes for K1*/Straight Fixes/*"], destination: "<<kotorDirectory>>/Override" }),
          createInstruction("Move", {
            guid: g(),
            source: ["<<modDirectory>>/JC's Minor Fixes for K1*/Extra/man26_enter4.dlg", "<<modDirectory>>/JC's Minor Fixes for K1*/Extra/k_pdan_zhar10.dlg"],
            destination: "<<kotorDirectory>>/Override",
            overwrite: false,
            dependencies: [A],
            restrictions: [C],
            platform: "Mobile",
          }),
          createInstruction("Delete", { guid: g(), source: ["<<kotorDirectory>>/Override/foo.tga", "<<kotorDirectory>>/Override/bar.tga"] }),
          createInstruction("Rename", { guid: g(), source: ["<<modDirectory>>/JC*/w_ionrfl_04.mdl"], destination: "w_ionrfl_004.mdl" }),
          createInstruction("Execute", { guid: g(), source: ["<<modDirectory>>/JC*/setup.exe"], arguments: "/silent" }),
          createInstruction("DelDuplicate", { guid: g(), source: ["<<kotorDirectory>>/Override"], arguments: ".tpc" }),
        ],
        options: [
          createOption({
            guid: OPT,
            name: "Things What Bother Me",
            description: "Opinionated fixes.",
            isSelected: true,
            exclusiveGroup: "twbm",
            restrictions: [OPT2],
            instructions: [createInstruction("Move", { guid: g(), source: ["<<modDirectory>>/JC*/TWBM/*"], destination: "<<kotorDirectory>>/Override" })],
          }),
          createOption({ guid: OPT2, name: "Nothing", instructions: [] }),
        ],
      }),
      createMod({
        guid: C,
        name: "KOTOR High Resolution Menus",
        headingLevel: 3,
        authors: ["ndix UR"],
        modLink: ["https://deadlystream.com/files/file/1264/"],
        category: ["UI"],
        tier: "Recommended",
        installationMethod: "Loose-File",
        isWidescreen: true,
        instructions: [createInstruction("Extract", { guid: g(), source: ["<<modDirectory>>\\KOTOR High Resolution Menus*.zip"] })],
      }),
    ],
  });
}

/** Projection used to compare mods across a structured round trip (child GUIDs are regenerated). */
function projectMod(mod: ModComponent, withGuids: boolean): unknown {
  const stripInstr = (i: ModComponent["instructions"][number]): unknown => {
    const { guid, ...rest } = i;
    void guid;
    return withGuids ? i : rest;
  };
  return {
    guid: mod.guid,
    name: mod.name,
    description: mod.description,
    directions: mod.directions,
    authors: mod.authors,
    modLink: mod.modLink,
    category: mod.category,
    tier: mod.tier,
    language: mod.language,
    installationMethod: mod.installationMethod,
    usageWarnings: mod.usageWarnings,
    expectedFiles: mod.expectedFiles,
    dependencies: mod.dependencies,
    restrictions: mod.restrictions,
    installAfter: mod.installAfter,
    installBefore: mod.installBefore,
    untestedWith: mod.untestedWith,
    fullBuildOnly: mod.fullBuildOnly,
    isWidescreen: mod.isWidescreen,
    aspyrOnly: mod.aspyrOnly,
    isPatch: mod.isPatch,
    headingLevel: mod.headingLevel,
    instructions: mod.instructions.map(stripInstr),
    options: mod.options.map((o) => ({ name: o.name, description: o.description, instructions: o.instructions.map(stripInstr) })),
  };
}

describe("generateMarkdownDocs", () => {
  const file = sampleFile();

  it("emits structured steps", () => {
    const md = generateMarkdownDocs(file, "structured");
    expect(md).toContain("# KOTOR 1 Full Build rev 12");
    expect(md).toContain("## Mod List");
    expect(md).toContain("### KOTOR 1 Community Patch");
    expect(md).toContain("**Name:** [KOTOR 1 Community Patch](https://deadlystream.com/files/file/1258-kotor-1-community-patch/)");
    expect(md).toContain("**Category & Tier:** Bugfix & Immersion / 1 - Essential");
    expect(md).toContain("**Masters:** KOTOR 1 Community Patch");
    expect(md).toContain("1. **EXTRACT** `<<modDirectory>>/JC's Minor Fixes for K1*.zip` — unpack it");
    expect(md).toContain("2. **MOVE ALL** from `<<modDirectory>>/JC's Minor Fixes for K1*/Straight Fixes/*` to `<<kotorDirectory>>/Override`");
    expect(md).toContain(`3. **MOVE SPECIFIC** from \`<<modDirectory>>/JC's Minor Fixes for K1*/Extra/\` to \`<<kotorDirectory>>/Override\` (do not overwrite) _(requires ${toBracedGuid(A)}; conflicts ${toBracedGuid(C)}; Mobile only)_:\n   - man26_enter4.dlg\n   - k_pdan_zhar10.dlg`);
    expect(md).toContain("2. **PATCHER** `<<modDirectory>>\\KOTOR 1 Community Patch*\\TSLPatcher.exe` with `0`");
    expect(md).toContain("6. **RUN** `<<modDirectory>>/JC*/setup.exe` with `/silent`");
    expect(md).toContain("**Option:** Things What Bother Me — Opinionated fixes.");
    expect(md).toContain("## Widescreen Mods");
    expect(md.indexOf("## Widescreen Mods")).toBeLessThan(md.indexOf("### KOTOR High Resolution Menus"));
    expect(md).not.toContain("<!--");
    expect(md.trimEnd().endsWith("Enjoy!")).toBe(true);
  });

  it("deadlystream style adds hidden YAML blocks", () => {
    const md = generateMarkdownDocs(file, "deadlystream");
    expect(md).toContain("<!--<<ModSync:Config>>");
    expect((md.match(/<!--<<ModSync>>/g) ?? []).length).toBe(3);
    expect(md).toContain(`Guid: "${toBracedGuid(A)}"`);
  });

  it("reddit style is prose without hidden blocks", () => {
    const md = generateMarkdownDocs(file, "reddit");
    expect(md).not.toContain("<!--");
    expect(md).not.toContain("**EXTRACT**");
    expect(md).toContain("**Installation Instructions:** Extract `<<modDirectory>>\\KOTOR 1 Community Patch*.zip`. Install with TSLPatcher/HoloPatcher from");
  });

  for (const style of ["structured", "deadlystream"] as MarkdownStyle[]) {
    it(`round-trips through the parser (${style})`, () => {
      const md = generateMarkdownDocs(file, style);
      const { file: back, warnings } = parseMarkdownBuild(md);
      expect(warnings.filter((w) => w.includes("auto-generated") || w.includes("unresolved") || w.includes("dropped"))).toEqual([]);
      expect(back.config.name).toBe(file.config.name);
      expect(back.config.targetGame).toBe("KOTOR1");
      expect(back.config.beforeModListContent).toBe(file.config.beforeModListContent);
      expect(back.config.widescreenSectionContent).toBe(file.config.widescreenSectionContent);
      expect(back.config.afterModListContent).toBe(file.config.afterModListContent);
      const exact = style === "deadlystream";
      expect(back.mods.map((m) => projectMod(m, exact))).toEqual(file.mods.map((m) => projectMod(m, exact)));
      if (exact) {
        expect(back.mods).toEqual(file.mods);
        expect(back.config.version).toBe("12");
      }
    });
  }

  it("round-trips mod metadata and dependencies in reddit style", () => {
    const md = generateMarkdownDocs(file, "reddit");
    const { file: back } = parseMarkdownBuild(md);
    expect(back.mods.map((m) => [m.guid, m.name, m.tier, m.category, m.dependencies, m.restrictions, m.isWidescreen])).toEqual(
      file.mods.map((m) => [m.guid, m.name, m.tier, m.category, m.dependencies, m.restrictions, m.isWidescreen]),
    );
    expect(back.mods[0].instructions.map((i) => i.action)).toEqual(["Extract", "Patcher"]);
  });

  it("re-generates an imported guide without losing anything", () => {
    const first = parseMarkdownBuild(K1_FULL_MD).file;
    const second = parseMarkdownBuild(generateMarkdownDocs(first, "deadlystream")).file;
    expect(second.mods).toEqual(first.mods);
    expect(second.config.widescreenSectionContent).toBe(first.config.widescreenSectionContent);
    // Structured style carries no hidden GUIDs, so an explicit (non name-derived) GUID cannot survive;
    // compare with GUID references replaced by mod names.
    const third = parseMarkdownBuild(generateMarkdownDocs(first, "structured")).file;
    const byName = (f: InstructionFile): unknown =>
      JSON.parse(
        JSON.stringify(
          f.mods.map((m) => projectMod(m, false)),
          (_k, v: unknown) => (typeof v === "string" ? (f.mods.find((m) => m.guid === v)?.name ?? v) : v),
        ),
      );
    expect(byName(third)).toEqual(byName(first));
  });
});

describe("describeInstruction", () => {
  const mod = createMod({ name: "X", options: [createOption({ guid: OPT, name: "Opt A" })] });
  it("enumerates under five sources and summarizes otherwise", () => {
    expect(describeInstruction(createInstruction("Move", { source: ["<<modDirectory>>\\m\\a", "<<modDirectory>>\\m\\b"], destination: "<<kotorDirectory>>\\Override" }), mod)).toBe(
      "Move `<<modDirectory>>\\m\\a`, `<<modDirectory>>\\m\\b` to `<<kotorDirectory>>\\Override`.",
    );
    const many = ["a", "b", "c", "d", "e"].map((x) => `<<modDirectory>>\\m\\${x}`);
    expect(describeInstruction(createInstruction("Move", { source: many, destination: "<<kotorDirectory>>\\Override", overwrite: false }), mod)).toBe(
      "Move everything in `<<modDirectory>>\\m` to `<<kotorDirectory>>\\Override`, without overwriting existing files.",
    );
    expect(describeInstruction(createInstruction("Move", { source: ["<<modDirectory>>\\m\\*"], destination: "<<kotorDirectory>>\\Override" }), mod)).toBe(
      "Move everything in `<<modDirectory>>\\m` to `<<kotorDirectory>>\\Override`.",
    );
  });
  it("describes other actions", () => {
    expect(describeInstruction(createInstruction("Extract", { source: ["<<modDirectory>>\\x.zip"] }), mod)).toBe("Extract `<<modDirectory>>\\x.zip`.");
    expect(describeInstruction(createInstruction("Choose", { source: [OPT, "<<modDirectory>>\\alt"], destination: "<<kotorDirectory>>\\Override" }), mod)).toBe(
      'Choose one of "Opt A", `<<modDirectory>>\\alt` and move it to `<<kotorDirectory>>\\Override`.',
    );
    expect(describeInstruction(createInstruction("Execute", { source: ["<<modDirectory>>\\s.exe"], arguments: "/q", description: "silent" }), mod)).toBe(
      "Run `<<modDirectory>>\\s.exe` with arguments `/q` (silent).",
    );
    expect(describeInstruction(createInstruction("DelDuplicate", { source: ["<<kotorDirectory>>\\Override"], arguments: ".tpc" }), mod)).toBe(
      "Delete duplicate `.tpc` files in `<<kotorDirectory>>\\Override`.",
    );
  });
});
