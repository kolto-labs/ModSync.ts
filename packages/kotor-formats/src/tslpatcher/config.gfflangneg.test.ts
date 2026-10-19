import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GffFieldType, type GffLocString, addField, createGffRoot, createLocString, getFieldByPath, readGff, writeGff } from "../gff.js";
import { normalizeGffLangSubstringId, parseChangesIni } from "./config.js";
import { TslPatcher } from "./engine.js";
import { NodePatcherFs } from "./nodeFs.js";

let tmp: string;
let gameDir: string;
let dataDir: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "kotor-formats-langneg-"));
  gameDir = path.join(tmp, "game");
  dataDir = path.join(tmp, "mod", "tslpatchdata");
  await fsp.mkdir(path.join(gameDir, "Override"), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  const root = createGffRoot("UTI ");
  addField(root.root, "DescIdentified", GffFieldType.LocString, createLocString(-1, [[0, "old"]]));
  await fsp.writeFile(path.join(gameDir, "Override", "item_a.uti"), writeGff(root));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

function ini(key: string): string {
  return ["[GFFList]", "File0=item_a.uti", "[item_a.uti]", `${key}=Generic text`].join("\n");
}

async function run(text: string) {
  const log = await new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs: new NodePatcherFs(), backupDir: path.join(tmp, "backup") }).apply(parseChangesIni(text));
  const gff = readGff(new Uint8Array(await fsp.readFile(path.join(gameDir, "Override", "item_a.uti"))));
  const loc = getFieldByPath(gff, "DescIdentified")!.value as GffLocString;
  return { log, loc };
}

describe("GFF modify keys with negative language ids", () => {
  it("parses (lang-1) as a language part instead of folding it into the field path", () => {
    const cfg = parseChangesIni(ini("DescIdentified(lang-1)"));
    expect(cfg.gff[0]!.modifiers[0]).toEqual({
      kind: "modify",
      path: "DescIdentified",
      part: { kind: "lang", id: -1 },
      value: { kind: "constant", value: "Generic text" },
    });
  });

  it("maps negative ids onto English substrings the way HoloPatcher's floor division does", () => {
    expect(normalizeGffLangSubstringId(-1)).toEqual({ id: 1, adjusted: true });
    expect(normalizeGffLangSubstringId(-2)).toEqual({ id: 0, adjusted: true });
    expect(normalizeGffLangSubstringId(-3)).toEqual({ id: 1, adjusted: true });
    expect(normalizeGffLangSubstringId(0)).toEqual({ id: 0, adjusted: false });
    expect(normalizeGffLangSubstringId(7)).toEqual({ id: 7, adjusted: false });
  });

  it("applies ModifyField with (lang-1) to the localized string and warns", async () => {
    const { log, loc } = await run(ini("DescIdentified(lang-1)"));
    expect(log.errors).toEqual([]);
    expect(loc.substrings.get(1)).toBe("Generic text");
    expect(loc.substrings.get(0)).toBe("old");
    expect(loc.strref).toBe(-1);
    expect(log.warnings.some((w) => w.includes("DescIdentified(lang-1)"))).toBe(true);
  });

  it("applies (lang-2) to the neutral English substring", async () => {
    const { log, loc } = await run(ini("DescIdentified(lang-2)"));
    expect(log.errors).toEqual([]);
    expect(loc.substrings.get(0)).toBe("Generic text");
  });

  it("keeps non-negative ids warning-free", async () => {
    const { log, loc } = await run(ini("DescIdentified(lang0)"));
    expect(log.errors).toEqual([]);
    expect(log.warnings).toEqual([]);
    expect(loc.substrings.get(0)).toBe("Generic text");
  });

  it("still fails for a negative language id on a non-localized field", async () => {
    const root = createGffRoot("UTI ");
    addField(root.root, "DescIdentified", GffFieldType.Int, 3);
    await fsp.writeFile(path.join(gameDir, "Override", "item_a.uti"), writeGff(root));
    const { log } = await run(ini("DescIdentified(lang-1)")).catch((e: unknown) => ({ log: { errors: [String(e)] }, loc: undefined }));
    expect(log.errors.join("\n")).toMatch(/not an ExoLocString/);
  });
});
