/** Original text fixtures only. No downloaded mods or game assets. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, readdir, access, readlink } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { parseMarkdownBuild } from "../packages/core/src/serialization/markdown/parser.js";
import { serializeInstructionFile } from "../packages/core/src/serialization/toml.js";
import { createDefaultSettings } from "../packages/core/src/model/defaults.js";
import { file, mod, instr, option, G, writeText, writeZip } from "../packages/core/src/engine/testing.js";

export const CORPUS_COMMIT = "21b2f0499d28ecd4ee2092701dee5792ba5da4b9";
export const GUIDE_SHA256 = { KOTOR1: "8f4e7b164954b203d872cb7e92e06d153abe84195f683ae36d428b5b99cd75a2", KOTOR2: "f442bdf574031623ed577609730d887069b9bc8e38e8e2f38ecc43a7e7487d5f" } as const;
export type FixtureGame = "KOTOR1" | "KOTOR2";
export interface SyntheticFixture { game: FixtureGame; root: string; mods: string; kotor: string; checkpoints: string; instructions: string; settings: string; expectedOrder: string[]; }


export function readGuideBlob(corpus: string, game: FixtureGame): string {
  const source = `content/${game === "KOTOR1" ? "k1" : "k2"}/full.md`;
  const bytes = execFileSync("git", ["-C", resolve(corpus), "show", `${CORPUS_COMMIT}:${source}`], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(createHash("sha256").update(bytes).digest("hex"), GUIDE_SHA256[game], "Immutable guide blob checksum differs");
  return bytes.toString("utf8");
}
export async function snapshotTree(root: string): Promise<Record<string, { type: "directory" | "file" | "symlink"; sha256?: string; target?: string }>> {
  const result: Record<string, { type: "directory" | "file" | "symlink"; sha256?: string; target?: string }> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name); const key = relative(root, path).replace(/\\/g, "/");
      if (entry.isSymbolicLink()) result[key] = { type: "symlink", target: await readlink(path) };
      else if (entry.isDirectory()) { result[key] = { type: "directory" }; await walk(path); }
      else { assert.ok(entry.isFile(), `Unexpected file type: ${path}`); result[key] = { type: "file", sha256: createHash("sha256").update(await readFile(path)).digest("hex") }; }
    }
  }
  await walk(root); return result;
}
async function verifyWholeGame(f: SyntheticFixture, expected: Record<string,string>) {
  const manifest: Awaited<ReturnType<typeof snapshotTree>> = { Override: { type: "directory" } };
  for (const [name, text] of Object.entries(expected)) manifest[`Override/${name}`] = { type: "file", sha256: createHash("sha256").update(text).digest("hex") };
  assert.deepEqual(await snapshotTree(f.kotor), manifest, "Whole synthetic game tree differs from expected directory/file manifest");
}
export async function verifyBaselineFiles(f: SyntheticFixture): Promise<void> {
  const expected: Record<string,string> = "componentCount" in f ? { "baseline.txt": "original derived fixture baseline\n" } : { "baseline.txt": "original synthetic baseline\n", "obsolete.txt": "original synthetic obsolete\n" };
  await verifyWholeGame(f,expected);
}

export async function auditCorpus(corpus: string, output: string) {
  const commit = execFileSync("git", ["-C", resolve(corpus), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(commit, CORPUS_COMMIT, "Guide checkout must match the reviewed immutable corpus pin");
  const guides = [];
  for (const [folder, game] of [["k1", "KOTOR1"], ["k2", "KOTOR2"]] as const) {
    const source = `content/${folder}/full.md`;
    const markdown = readGuideBlob(corpus, game);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, `${game.toLowerCase()}-source-full.md`), markdown);
    assert.equal(createHash("sha256").update(markdown).digest("hex"), GUIDE_SHA256[game], "Guide content differs from pinned corpus (including dirty checkout changes)");
    const explicit = parseMarkdownBuild(markdown, { targetGame: game, autoInstructions: false });
    const generated = parseMarkdownBuild(markdown, { targetGame: game, autoInstructions: true });
    assert.ok(generated.file.mods.length > 0, `No mods parsed from ${source}`);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, `${game.toLowerCase()}-guide-explicit.toml`), serializeInstructionFile(explicit.file));
    await writeFile(join(output, `${game.toLowerCase()}-guide-generated.toml`), serializeInstructionFile(generated.file));
    const actions: Record<string, number> = {};
    const inventory = generated.file.mods.map((m) => {
      const instructions = [...m.instructions, ...m.options.flatMap((o) => o.instructions)];
      for (const i of instructions) actions[i.action] = (actions[i.action] ?? 0) + 1;
      return { guid: m.guid, name: m.name, installationMethod: m.installationMethod, instructionCount: instructions.length, actions: instructions.map((i) => i.action), instructions, directions: m.directions, usageWarnings: m.usageWarnings, heuristic: !explicit.file.mods.find((x) => x.guid === m.guid)?.instructions.length };
    });
    guides.push({ game, source, sha256: createHash("sha256").update(markdown).digest("hex"), modCount: inventory.length,
      explicitInstructionCount: explicit.file.mods.reduce((n,m) => n + m.instructions.length + m.options.reduce((k,o) => k + o.instructions.length,0),0),
      generatedInstructionCount: inventory.reduce((n,m) => n + m.instructionCount,0), actions,
      gaps: { noInstructions: inventory.filter((m) => m.instructionCount === 0), heuristicRequiresAuthorReview: inventory.filter((m) => m.heuristic).map((m) => ({ guid: m.guid, name: m.name, reason: "Heuristic import is not a verified representation of the guide prose; original archive layouts and patcher namespaces are unknown." })) }, warnings: generated.warnings, inventory });
  }
  const audit = { lane: "source-guide-corpus-audit", repository: "kolto-labs/mod-builds", commit,
    statement: "Parsing and heuristic generation coverage only. Neither guide was installed. Generated instructions are not verified against original mod archives or game files.", guides };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "corpus-audit.json"), JSON.stringify(audit, null, 2));
  return audit;
}

async function refuseExistingRoot(root: string): Promise<void> {
  try { await access(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Synthetic fixture output already exists: ${root}. Choose a fresh output directory.`);
}

export async function prepareSyntheticFixture(output: string, game: FixtureGame): Promise<SyntheticFixture> {
  const root = resolve(output, game.toLowerCase());
  await refuseExistingRoot(root);
  const mods = join(root, "mods"); const kotor = join(root, "game"); const checkpoints = join(root, "checkpoints");
  await mkdir(join(kotor, "Override"), { recursive: true });
  await writeText(join(kotor, "Override", "baseline.txt"), "original synthetic baseline\n");
  await writeText(join(kotor, "Override", "obsolete.txt"), "original synthetic obsolete\n");
  await writeZip(join(mods, "OriginalFixture.zip"), { "Override/extracted.txt": "original synthetic archive payload\n" });
  await writeText(join(mods, "source.txt"), "original synthetic copy payload\n");
  await writeText(join(mods, "Choices", "First", "chosen.txt"), "original synthetic first choice\n");
  await writeText(join(mods, "Choices", "Second", "chosen.txt"), "original synthetic second choice\n");
  await writeText(join(mods, "option.txt"), "original synthetic option\n");
  await writeText(join(mods, "widescreen-phase.txt"), "phase selection only; no executable patch\n");
  const fixtureFile = file([
    mod(2, { name: "Synthetic dependent copy rename delete", dependencies: [G(1)], installAfter: [G(1)], instructions: [
      instr("Copy", { guid: G(201), source: ["<<modDirectory>>/source.txt"], destination: "<<kotorDirectory>>/Override" }),
      instr("Rename", { guid: G(202), source: ["<<kotorDirectory>>/Override/source.txt"], destination: "renamed.txt" }),
      instr("Delete", { guid: G(203), source: ["<<kotorDirectory>>/Override/obsolete.txt"] }),
    ] }),
    mod(1, { name: "Synthetic archive extract move", instructions: [
      instr("Extract", { guid: G(101), source: ["<<modDirectory>>/OriginalFixture.zip"] }),
      instr("Move", { guid: G(102), source: ["<<modDirectory>>/OriginalFixture/Override/*"], destination: "<<kotorDirectory>>/Override" }),
    ] }),
    mod(3, { name: "Synthetic folder choice and selected option", installAfter: [G(2)], instructions: [
      instr("Choose", { guid: G(301), source: ["<<modDirectory>>/Choices/*"], destination: "<<kotorDirectory>>/Override" }),
    ], options: [option(31, { name: "Synthetic selected option", instructions: [
      instr("Copy", { guid: G(311), source: ["<<modDirectory>>/option.txt"], destination: "<<kotorDirectory>>/Override" }),
    ] })] }),
    mod(4, { name: "Synthetic widescreen phase routing only", isWidescreen: true, instructions: [
      instr("Copy", { guid: G(401), source: ["<<modDirectory>>/widescreen-phase.txt"], destination: "<<kotorDirectory>>/Override" }),
    ] }),
  ], { name: `${game} controlled synthetic fixture`, targetGame: game, widescreenSectionContent: "Synthetic phase routing; no real executable or GUI binary patch is performed." });
  const settings = join(root, "settings.json"); const instructions = join(root, "synthetic.toml");
  await writeFile(instructions, serializeInstructionFile(fixtureFile));
  await writeFile(settings, JSON.stringify(createDefaultSettings({ modDirectory: mods, kotorDirectory: kotor, checkpointDirectory: checkpoints }), null, 2));
  const fixture = { game, root, mods, kotor, checkpoints, instructions, settings, expectedOrder: [G(1), G(2), G(3), G(4)] };
  await writeFile(join(root,"fixture.json"), JSON.stringify(fixture,null,2));
  return fixture;
}

export async function verifySyntheticFiles(f: SyntheticFixture, includeWidescreen = true) {
  const expected: Record<string,string> = { "baseline.txt":"original synthetic baseline\n", "extracted.txt":"original synthetic archive payload\n", "renamed.txt":"original synthetic copy payload\n", "chosen.txt":"original synthetic first choice\n", "option.txt":"original synthetic option\n" };
  if (includeWidescreen) expected["widescreen-phase.txt"]="phase selection only; no executable patch\n";
  await verifyWholeGame(f, expected);
  const proofs = [];
  for (const [name,text] of Object.entries(expected)) { const content = await readFile(join(f.kotor,"Override",name),"utf8"); assert.equal(content,text); proofs.push({path:`Override/${name}`, sha256:createHash("sha256").update(content).digest("hex")}); }
  return proofs;
}

export interface DerivedFixture extends SyntheticFixture {
  componentCount: number;
  mappingPath: string;
  expectedReceipts: Array<{path:string;content:string;sourceGuid:string;sourceName:string}>;
}
/** Executes mechanical Extract/Move models keyed to every parsed guide component.
 * Patcher/Execute and semantic prose are recorded as omissions, never simulated as patcher success. */
export async function prepareDerivedFixture(corpus: string, output: string, game: FixtureGame): Promise<DerivedFixture> {
  const parsed = parseMarkdownBuild(readGuideBlob(corpus,game),{targetGame:game});
  const root=resolve(output,`${game.toLowerCase()}-guide-derived`); await refuseExistingRoot(root); const mods=join(root,"mods");const kotor=join(root,"game");const checkpoints=join(root,"checkpoints");
  await mkdir(join(kotor,"Override"),{recursive:true});await writeText(join(kotor,"Override","baseline.txt"),"original derived fixture baseline\n");
  const known=new Set(parsed.file.mods.map(m=>m.guid)); const mapping=[];const expectedReceipts:DerivedFixture["expectedReceipts"]=[];
  const projected=[];
  for(const [index,sourceMod] of parsed.file.mods.entries()) {
    const key=`component-${String(index+1).padStart(4,"0")}`;const receipt=`${key}.txt`;const content=JSON.stringify({game,sourceGuid:sourceMod.guid,sourceName:sourceMod.name,statement:"original synthetic receipt, no original mod or game payload"})+"\n";
    await writeZip(join(mods,`${key}.zip`),{[receipt]:content});
    const sourceInstructions=[...sourceMod.instructions,...sourceMod.options.flatMap(o=>o.instructions)];
    const models=sourceInstructions.filter(i=>i.action==="Extract"||i.action==="Move");const omitted=sourceInstructions.filter(i=>i.action!=="Extract"&&i.action!=="Move");
    // The corpus importer currently generates Extract + Move/Patcher/Execute. A unique
    // original ZIP is extracted for every component; receipt transfer is auxiliary when
    // its source action is Patcher/Execute rather than a mechanically modelled Move.
    const extract=instr("Extract",{guid:G(10000+index*2),source:[`<<modDirectory>>/${key}.zip`]});
    const hasMove=sourceInstructions.some(i=>i.action==="Move");
    const transfer=instr(hasMove?"Move":"Copy",{guid:G(10001+index*2),source:[`<<modDirectory>>/${key}/${receipt}`],destination:"<<kotorDirectory>>/Override"});
    const retainedDependencies=sourceMod.dependencies.filter(g=>known.has(g));
    projected.push(mod(index+1000,{guid:sourceMod.guid,name:`Synthetic: ${sourceMod.name}`,dependencies:retainedDependencies,installAfter:index?[parsed.file.mods[index-1].guid]:[],instructions:[extract,transfer]}));
    expectedReceipts.push({path:`Override/${receipt}`,content,sourceGuid:sourceMod.guid,sourceName:sourceMod.name});
    mapping.push({index:index+1,sourceGuid:sourceMod.guid,sourceName:sourceMod.name,sourceInstructions,mechanicallyModelledActions:models.map(i=>i.action),omittedInstructions:omitted,syntheticInstructions:[extract,transfer],auxiliaryReceiptTransfer:!hasMove, auxiliaryExtract:!sourceInstructions.some(i=>i.action==="Extract"),
      normalization:{selected:true,fullBuildOnly:false,aspyrOnly:false,widescreen:false,order:"guide source order enforced with predecessor edge",retainedDependencies,droppedUnknownDependencies:sourceMod.dependencies.filter(g=>!known.has(g)),sourceInstallAfter:sourceMod.installAfter,sourceInstallBefore:sourceMod.installBefore,sourceRestrictions:sourceMod.restrictions,sourceUntestedWith:sourceMod.untestedWith,optionsFoldedIntoAuditOnly:sourceMod.options.map(o=>o.guid)},
      unverifiedProse:sourceMod.directions,reason:"Archive filenames/content/layout are synthetic; prose, patcher settings, executables, game binaries and original payload effects are not verified."});
  }
  const instructions=join(root,"synthetic-guide-derived.toml");const settings=join(root,"settings.json");const mappingPath=join(root,"component-mapping.json");
  await writeFile(instructions,serializeInstructionFile(file(projected,{targetGame:game,name:`${game} full.md-derived synthetic mechanical lane`})));await writeFile(settings,JSON.stringify(createDefaultSettings({modDirectory:mods,kotorDirectory:kotor,checkpointDirectory:checkpoints}),null,2));
  await writeFile(mappingPath,JSON.stringify({lane:"fullmd-derived-synthetic-mechanical-install",statement:"One source-mapped component per guide entry. Success means synthetic Extract/transfer only. Omitted Patcher/Execute and source prose remain unverified.",mapping},null,2));
  const fixture={game,root,mods,kotor,checkpoints,instructions,settings,expectedOrder:projected.map(m=>m.guid),componentCount:projected.length,mappingPath,expectedReceipts};
  await writeFile(join(root,"fixture.json"),JSON.stringify(fixture,null,2));return fixture;
}
export async function verifyDerivedFiles(f: DerivedFixture) {
  const expected: Record<string,string> = { "baseline.txt": "original derived fixture baseline\n" };
  for (const receipt of f.expectedReceipts) expected[receipt.path.split("/").at(-1)!] = receipt.content;
  await verifyWholeGame(f,expected);
  const proofs=[];for(const receipt of f.expectedReceipts){const content=await readFile(join(f.kotor,receipt.path),"utf8");assert.equal(content,receipt.content);proofs.push({path:receipt.path,sourceGuid:receipt.sourceGuid,sourceName:receipt.sourceName,sha256:createHash("sha256").update(content).digest("hex")});}return proofs;
}
