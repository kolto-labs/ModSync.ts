import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GffFieldType, addField, createGffRoot, getFieldByPath, readGff, writeGff } from "../gff.js";
import { parseChangesIni } from "./config.js";
import { TslPatcher } from "./engine.js";
import { NodePatcherFs } from "./nodeFs.js";

class VirtualNodeFs extends NodePatcherFs {
  readonly isVirtual = true;
}

let tmp: string;
let gameDir: string;
let dataDir: string;

function sampleGff(): Uint8Array {
  const root = createGffRoot("UTC ");
  addField(root.root, "Speed", GffFieldType.Float, 1);
  addField(root.root, "Scale", GffFieldType.Double, 1);
  addField(root.root, "Position", GffFieldType.Vector, { x: 0, y: 0, z: 0 });
  addField(root.root, "Facing", GffFieldType.Orientation, { x: 0, y: 0, z: 0, w: 1 });
  return writeGff(root);
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "kotor-formats-decimalcomma-"));
  gameDir = path.join(tmp, "game");
  dataDir = path.join(tmp, "mod", "tslpatchdata");
  await fsp.mkdir(path.join(gameDir, "Override"), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function run(ini: string, fs: NodePatcherFs, dryRun: boolean) {
  return new TslPatcher({ tslpatchdataDir: dataDir, gameDir, fs, dryRun, backupDir: path.join(tmp, "backup") }).apply(parseChangesIni(ini));
}

function modifyIni(values: { speed: string; scale: string; position: string; facing: string }): string {
  return ["[GFFList]", "File0=npc_a.utc", "[npc_a.utc]", `Speed=${values.speed}`, `Scale=${values.scale}`, `Position=${values.position}`, `Facing=${values.facing}`].join("\n");
}

async function readPatched() {
  return readGff(new Uint8Array(await fsp.readFile(path.join(gameDir, "Override", "npc_a.utc"))));
}

describe("decimal-comma floats in GFF values", () => {
  beforeEach(async () => {
    await fsp.writeFile(path.join(gameDir, "Override", "npc_a.utc"), sampleGff());
  });

  it("accepts a single comma as the decimal separator for Float, Double, Vector and Orientation", async () => {
    const log = await run(modifyIni({ speed: "-8,5", scale: "113,25", position: "1,5|-2,25|3", facing: "0|0|0,5|0,5" }), new NodePatcherFs(), false);
    expect(log.errors).toEqual([]);
    const gff = await readPatched();
    expect(getFieldByPath(gff, "Speed")!.value).toBe(-8.5);
    expect(getFieldByPath(gff, "Scale")!.value).toBe(113.25);
    expect(getFieldByPath(gff, "Position")!.value).toEqual({ x: 1.5, y: -2.25, z: 3 });
    expect(getFieldByPath(gff, "Facing")!.value).toEqual({ x: 0, y: 0, z: 0.5, w: 0.5 });
  });

  it("accepts exponent notation with a decimal comma", async () => {
    const log = await run(modifyIni({ speed: "1", scale: "6,12323426292584E-17", position: "0|0|0", facing: "0|0|0|1" }), new NodePatcherFs(), false);
    expect(log.errors).toEqual([]);
    expect(getFieldByPath(await readPatched(), "Scale")!.value).toBe(6.12323426292584e-17);
  });

  it("keeps dot-decimal values unchanged", async () => {
    const log = await run(modifyIni({ speed: "2.5", scale: "-1e-3", position: "1.5|2|3", facing: "0|0|0|1" }), new NodePatcherFs(), false);
    expect(log.errors).toEqual([]);
    const gff = await readPatched();
    expect(getFieldByPath(gff, "Speed")!.value).toBe(2.5);
    expect(getFieldByPath(gff, "Scale")!.value).toBe(-0.001);
  });

  it.each([
    ["multiple commas", "1,234,5"],
    ["a thousands separator mixed with a decimal point", "1,234.5"],
    ["a decimal point before a comma", "1.234,5"],
    ["a lone comma", ","],
    ["non-numeric text", "abc,5"],
  ])("still rejects %s", async (_label, bad) => {
    const log = await run(modifyIni({ speed: bad, scale: "1", position: "0|0|0", facing: "0|0|0|1" }), new NodePatcherFs(), false);
    expect(log.errors.join("\n")).toContain(`expected a number, got "${bad}"`);
    expect(log.filesWritten).toEqual([]);
  });

  it("rejects a comma-separated vector instead of reading it as one decimal comma", async () => {
    const log = await run(modifyIni({ speed: "1", scale: "1", position: "1,2,3", facing: "0|0|0|1" }), new NodePatcherFs(), false);
    expect(log.errors.join("\n")).toContain('expected a number, got "1,2,3"');
  });
});

describe("dry run over a zero-byte virtual placeholder target", () => {
  const addIni = (value: string, fieldType = "Float") =>
    ["[GFFList]", "File0=npc_a.utc", "[npc_a.utc]", "AddField0=add_speed", "[add_speed]", `FieldType=${fieldType}`, "Label=Speed", `Value=${value}`].join("\n");

  beforeEach(async () => {
    await fsp.writeFile(path.join(gameDir, "Override", "npc_a.utc"), new Uint8Array(0));
  });

  it("reports an added numeric value that cannot be parsed", async () => {
    const log = await run(addIni("1,2,3"), new VirtualNodeFs(), true);
    expect(log.errors.join("\n")).toContain('expected a number, got "1,2,3"');
  });

  it("reports a malformed added Vector value", async () => {
    const log = await run(addIni("1,5|2,5", "Vector"), new VirtualNodeFs(), true);
    expect(log.errors.join("\n")).toMatch(/Position needs x\|y\|z/);
  });

  it("accepts a decimal-comma value and leaves the patch unverified", async () => {
    const log = await run(addIni("6,5"), new VirtualNodeFs(), true);
    expect(log.errors).toEqual([]);
    expect(log.unverified.join("\n")).toMatch(/zero-byte virtual placeholder/);
  });

  it("does not check values on a real-fs dry run beyond the existing empty-file error", async () => {
    const log = await run(addIni("6,5"), new NodePatcherFs(), true);
    expect(log.errors.join("\n")).toMatch(/is empty \(0 bytes\)/);
  });
});
