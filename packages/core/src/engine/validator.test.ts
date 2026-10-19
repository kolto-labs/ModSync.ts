import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseInstructionFile } from "../serialization/toml.js";
import { G, file, instr, makeSandbox, mod, option, writeText, writeZip, type Sandbox } from "./testing.js";
import { validate } from "./validator.js";

const EXAMPLE = path.resolve(__dirname, "../../../../instructions/example_kotor1.toml");

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox("modsync-validate-");
});
afterEach(async () => {
  await sb.cleanup();
});

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      out.push(p);
      if (e.isDirectory()) await visit(p);
    }
  };
  await visit(dir);
  return out.sort();
}

describe("validate on the example instruction file", () => {
  it("reports missing archives when the mod directory is empty", async () => {
    const f = parseInstructionFile(await readFile(EXAMPLE, "utf8"));
    const before = await snapshot(sb.root);
    const report = await validate(f, sb.settings);
    expect(report.ok).toBe(false);
    const missing = report.issues.filter((i) => i.code === "missing-archive");
    // Four selected mods each extract one archive.
    expect(missing).toHaveLength(4);
    expect(missing.map((i) => i.modGuid)).toEqual(expect.arrayContaining(["1f0a5b58-0f0d-4b0f-9b9f-000000000001"]));
    expect(report.issues.filter((i) => i.code === "duplicate-guid")).toEqual([]);
    expect(report.issues.filter((i) => i.code === "unknown-guid")).toEqual([]);
    expect(report.requiredDownloads).toHaveLength(4);
    expect(report.requiredDownloads.every((d) => !d.found && d.pattern.includes("<<modDirectory>>"))).toBe(true);
    expect(report.requiredDownloads[0].links[0]).toContain("deadlystream");
    expect(report.installOrder).toHaveLength(4);
    expect(report.installOrder[0]).toBe("1f0a5b58-0f0d-4b0f-9b9f-000000000001");
    expect(await snapshot(sb.root)).toEqual(before);
  });

  it("passes with zero errors when the expected archives exist, without writing anything", async () => {
    const f = parseInstructionFile(await readFile(EXAMPLE, "utf8"));
    await writeZip(`${sb.mods}/KOTOR 1 Community Patch v1.10.zip`, {
      "tslpatchdata/changes.ini": "[InstallList]\ninstall_folder0=Override\n\n[Override]\nFile0=k1cp.txt\n",
      "tslpatchdata/k1cp.txt": "x",
    });
    await writeZip(`${sb.mods}/Ultimate Dantooine High Resolution - TPC Version.zip`, {
      "DAN_wall03.tpc": "1",
      "DAN_NEW1.tpc": "2",
      "DAN_other.tpc": "3",
    });
    await writeZip(`${sb.mods}/Character Textures and Model Fixes 1.2.zip`, {
      "cleanlist_k1.txt": "HD Astromechs,c_drdastro.tpc\n",
      "Override/c_drdastro.tpc": "a",
      "Override/p_bastilah.tpc": "b",
    });
    await writeZip(`${sb.mods}/Visually Repair HK-47.zip`, { "HK-47 only/hk47.tpc": "1", "All HK/hk47.tpc": "2", "All HK/hk50.tpc": "3" });
    const before = await snapshot(sb.root);
    const report = await validate(f, sb.settings);
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.requiredDownloads.every((d) => d.found && d.matchedFiles.length === 1)).toBe(true);
    expect(report.issues.filter((i) => i.code === "archive-not-referenced")).toEqual([]);
    expect(await snapshot(sb.root)).toEqual(before);
    expect(await readdir(`${sb.kotor}/Override`)).toEqual([]);
  });
});

describe("validate static checks", () => {
  it("finds duplicate GUIDs, unknown GUIDs, missing placeholders and constraint errors", async () => {
    const f = file([
      mod(1, { dependencies: [G(99)], instructions: [instr("Move", { guid: G(50), source: ["<<modDirectory>>/a"], destination: "<<kotorDirectory>>" })] }),
      mod(2, { restrictions: [G(1)], instructions: [instr("Delete", { guid: G(50), source: ["relative/thing.txt"] })] }),
      mod(1, { name: "Dup" }),
    ]);
    const report = await validate(f, sb.settings);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain("duplicate-guid");
    expect(codes.filter((c) => c === "duplicate-guid")).toHaveLength(2);
    expect(codes).toContain("unknown-guid");
    expect(codes).toContain("missing-placeholder");
    expect(codes).toContain("restriction-selected");
    expect(codes).toContain("missing-source");
    // The runtime PathEscape of the placeholder-less path is not double reported.
    expect(codes).not.toContain("path-escape");
    expect(report.ok).toBe(false);
  });

  it("warns for archives nothing extracts and for extracted folders nothing uses", async () => {
    await writeZip(`${sb.mods}/unused.zip`, { "a.txt": "1" });
    const f = file([
      mod(1, {
        expectedFiles: ["never-extracted.7z"],
        instructions: [
          instr("Extract", { source: ["<<modDirectory>>/unused.zip"] }),
          instr("Move", { source: ["<<modDirectory>>/other.rar/x"], destination: "<<kotorDirectory>>/Override" }),
        ],
      }),
    ]);
    const report = await validate(f, sb.settings);
    const noExtract = report.issues.filter((i) => i.code === "no-extract-for-archive");
    expect(noExtract.map((i) => i.path).sort()).toEqual(["never-extracted.7z", "other.rar"]);
    expect(report.issues.filter((i) => i.code === "archive-not-referenced")).toHaveLength(1);
    expect(report.issues.find((i) => i.code === "archive-not-referenced")?.severity).toBe("warning");
  });

  it("records prompt-required for questions the installer will ask and auto-answers them", async () => {
    await writeText(`${sb.mods}/ws/A/a.gui`, "1");
    await writeText(`${sb.mods}/ws/B/a.gui`, "2");
    const f = file([
      mod(1, {
        options: [option(11, { isSelected: false }), option(12, { isSelected: false })],
        instructions: [instr("Choose", { guid: G(40), source: ["<<modDirectory>>/ws/*"] }), instr("Choose", { guid: G(41), source: [G(11), G(12)] })],
      }),
    ]);
    const report = await validate(f, sb.settings);
    expect(report.ok).toBe(true);
    const prompts = report.issues.filter((i) => i.code === "prompt-required");
    expect(prompts.map((i) => i.instructionGuid)).toEqual([G(40), G(41)]);
    expect(await readdir(`${sb.kotor}/Override`)).toEqual([]);
  });

  it("reports a patcher targeting a zero-byte extracted 2DA as info, not an error", async () => {
    await writeZip(`${sb.mods}/pack_a.zip`, {
      "tslpatchdata/changes.ini": "[2DAList]\nTable0=table_a.2da\n\n[table_a.2da]\nChangeRow0=row_fix\n\n[row_fix]\nRowIndex=0\nlabel=changed\n",
      "tslpatchdata/table_a.2da": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    });
    const f = file([
      mod(1, {
        instructions: [
          instr("Extract", { source: ["<<modDirectory>>/pack_a.zip"] }),
          instr("Patcher", { guid: G(50), source: ["<<modDirectory>>/pack_a"], destination: "<<kotorDirectory>>" }),
        ],
      }),
    ]);
    const report = await validate(f, sb.settings);
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
    const notices = report.issues.filter((i) => i.code === "virtual-source-unverified");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ severity: "info", modGuid: G(1), instructionGuid: G(50) });
    expect(notices[0]!.message).toContain("table_a.2da");
    expect(await readdir(`${sb.kotor}/Override`)).toEqual([]);
  });

  it("reports cycles and dependency problems from the selection", async () => {
    const f = file([mod(1, { installAfter: [G(2)] }), mod(2, { installAfter: [G(1)] }), mod(3, { dependencies: [G(4)] }), mod(4, { isSelected: false })]);
    const report = await validate(f, sb.settings);
    expect(report.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["cycle", "dependency-missing"]));
  });
});
