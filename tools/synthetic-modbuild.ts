/** Run corpus audit separately from an original, controlled CLI installer fixture. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { auditCorpus, prepareSyntheticFixture, verifySyntheticFiles, prepareDerivedFixture, verifyDerivedFiles, snapshotTree, type SyntheticFixture } from "./synthetic-fixtures.js";

const args=process.argv.slice(2);
function flag(name:string,fallback?:string) { const i=args.indexOf(name); const value=i<0?fallback:args[i+1]; if(!value||value.startsWith("--"))throw Error(`Missing ${name}`);return value; }
const output=resolve(flag("--output","artifacts/synthetic-cli"));
const corpus=resolve(flag("--corpus"));
await mkdir(output,{recursive:true});
const audit=await auditCorpus(corpus,output);
const selected=flag("--game","both");
assert.ok(["both","KOTOR1","KOTOR2"].includes(selected),"--game must be both, KOTOR1 or KOTOR2");
const fixtures: SyntheticFixture[]=[];
for(const game of ["KOTOR1","KOTOR2"] as const) if(selected==="both"||selected===game) fixtures.push(await prepareSyntheticFixture(output,game));
const derived = [];
for (const f of fixtures) derived.push(await prepareDerivedFixture(corpus,output,f.game));
await writeFile(join(output,"prepared.json"),JSON.stringify({corpusCommit:audit.commit,games:fixtures,derived},null,2));
if(!args.includes("--prepare-only")) {
 const cli=fileURLToPath(new URL("../packages/cli/dist/main.js",import.meta.url));
 const implementationCommit=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
 const workingTreeDirty=Boolean(execFileSync("git",["status","--porcelain","--untracked-files=no"],{encoding:"utf8"}).trim());
 await writeFile(join(output,"provenance.json"),JSON.stringify({implementationCommit,workingTreeDirty,workingTreeDirtyScope:"tracked implementation files; generated/untracked corpus and artifact directories are excluded",toolEntrySha256:createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),lockfileSha256:createHash("sha256").update(await readFile("pnpm-lock.yaml")).digest("hex"),cliEntry:{path:cli,sha256:createHash("sha256").update(await readFile(cli)).digest("hex")},runtime:{node:process.version,platform:process.platform,architecture:process.arch},argv:process.argv,corpusCommit:audit.commit},null,2));
 const results=[];
 for(const f of fixtures) {
  const logs: Record<string,string>={};
  const run=(label:string,argv:string[])=>{const p=spawnSync(process.execPath,[cli,...argv],{encoding:"utf8",timeout:120000,maxBuffer:8*1024*1024});logs[label]=p.stdout+"\nSTDERR:\n"+p.stderr;writeFileSync(join(f.root,`${label}.log`),logs[label]);writeFileSync(join(f.root,`${label}.command.json`),JSON.stringify({executable:process.execPath,argv:[cli,...argv],exitCode:p.status,signal:p.signal,error:p.error?.message},null,2));assert.equal(p.status,0,`${label} failed: ${p.error??p.stderr}\n${p.stdout}`);return p.stdout;};
  const opts=[f.instructions,"--settings",f.settings];
  const beforeGame=await snapshotTree(f.kotor);const beforeMods=await snapshotTree(f.mods);
  const validation=JSON.parse(run("validate",["validate",...opts,"--json"]));assert.equal(validation.ok,true);assert.deepEqual(validation.installOrder,f.expectedOrder);
  run("dry-run",["dry-run",...opts,"--yes"]);
  assert.deepEqual(await snapshotTree(f.kotor),beforeGame,"Dry-run must not modify the game tree");assert.deepEqual(await snapshotTree(f.mods),beforeMods,"Dry-run must not modify archives/source tree");
  run("install-base",["install",...opts,"--yes","--json"]);
  await verifySyntheticFiles(f,false);
  run("install-widescreen",["install",...opts,"--yes","--phase","widescreen","--json"]);
  const proofs=await verifySyntheticFiles(f);
  const sessions=JSON.parse(run("checkpoints",["checkpoints","list","--settings",f.settings,"--json"]));assert.equal(sessions.length,2);
  const base=sessions.find((s: {checkpoints:unknown[]})=>s.checkpoints.length===8);assert.ok(base,"Baseline plus seven base instruction checkpoints expected");
  const widescreen=sessions.find((session:{checkpoints:unknown[]})=>session.checkpoints.length===2);assert.ok(widescreen,"Baseline plus one widescreen phase checkpoint expected");
  run("restore-widescreen-baseline",["checkpoints","restore",widescreen.id,widescreen.checkpoints[0].id,"--settings",f.settings]);
  await verifySyntheticFiles(f,false);
  run("restore-baseline",["checkpoints","restore",base.id,base.checkpoints[0].id,"--settings",f.settings]);
  const restored=await snapshotTree(f.kotor);assert.deepEqual(restored,beforeGame,"Both phase baselines restore the entire original synthetic game tree");
  for(const [label,text] of Object.entries(logs))await writeFile(join(f.root,`${label}.log`),text);
  results.push({game:f.game,lane:"controlled-original-synthetic-CLI-install",authoredMods:4,baseInstructionCount:7,widescreenInstructionCount:1,validation,proofs,checkpointSessions:sessions,dryRunNoWrites:true,bothPhaseRollbackToOriginalTreeVerified:true,actionsVerified:["Extract","Move","Copy","Rename","Delete","Choose"],notExercised:["Patcher","Execute","CleanList","binary widescreen patching","real game assets","source guide installation"]});
 }
 const derivedResults=[];
 for(const f of derived) {
  const run=(label:string,argv:string[])=>{const p=spawnSync(process.execPath,[cli,...argv],{encoding:"utf8",timeout:600000,maxBuffer:32*1024*1024});writeFileSync(join(f.root,`${label}.log`),p.stdout+"\nSTDERR:\n"+p.stderr);writeFileSync(join(f.root,`${label}.command.json`),JSON.stringify({executable:process.execPath,argv:[cli,...argv],exitCode:p.status,signal:p.signal,error:p.error?.message},null,2));assert.equal(p.status,0,`${label} failed: ${p.error??p.stderr}\n${p.stdout}`);return p.stdout;};
  const opts=[f.instructions,"--settings",f.settings];const beforeGame=await snapshotTree(f.kotor);const beforeMods=await snapshotTree(f.mods);
  const validation=JSON.parse(run("validate",["validate",...opts,"--json"]));assert.equal(validation.ok,true);assert.deepEqual(validation.installOrder,f.expectedOrder);
  run("dry-run",["dry-run",...opts,"--yes"]);assert.deepEqual(await snapshotTree(f.kotor),beforeGame);assert.deepEqual(await snapshotTree(f.mods),beforeMods);
  const stdout=run("install",["install",...opts,"--yes","--json"]);const summary=JSON.parse(stdout.slice(stdout.lastIndexOf("\n{")+1));assert.equal(summary.failed,0);assert.equal(summary.succeeded,f.componentCount);assert.deepEqual(summary.mods.map((m:{modGuid:string})=>m.modGuid),f.expectedOrder);
  const proofs=await verifyDerivedFiles(f);const sessions=JSON.parse(run("checkpoints",["checkpoints","list","--settings",f.settings,"--json"]));assert.equal(sessions.length,1);assert.equal(sessions[0].checkpoints.length,f.componentCount*2+1);
  run("restore-baseline",["checkpoints","restore",sessions[0].id,sessions[0].checkpoints[0].id,"--settings",f.settings]);assert.deepEqual(await snapshotTree(f.kotor),beforeGame);
  derivedResults.push({game:f.game,lane:"fullmd-derived-synthetic-mechanical-install",componentCount:f.componentCount,instructionCount:f.componentCount*2,summary,proofs,validation,dryRunNoWrites:true,baselineRollbackVerified:true,mapping:f.mappingPath,statement:"Source mapped synthetic archive and file mechanics only. Patcher/Execute/prose omissions remain unverified."});
 }
 await writeFile(join(output,"derived-results.json"),JSON.stringify({corpusCommit:audit.commit,results:derivedResults},null,2));
 await writeFile(join(output,"synthetic-results.json"),JSON.stringify({corpusCommit:audit.commit,statement:"The source guide audit and controlled synthetic installation are separate lanes. This is not installation of either real modbuild.",results},null,2));
 const report = ["# Synthetic CLI simulation", "", `Corpus: kolto-labs/mod-builds @ ${audit.commit}`, "", "## Scope", "", "No real mod archives or game assets were downloaded. Guide parsing, guide-derived synthetic mechanics, and standalone feature fixtures are separate lanes. Successful component receipts do not prove patcher settings, executable tools, guide prose, or real game compatibility.", "", "## Source corpus audit", "", ...audit.guides.map(g => `${g.game}: ${g.modCount} parsed components; ${g.explicitInstructionCount} explicit instructions; ${g.generatedInstructionCount} heuristic instructions; ${g.warnings.length} import warnings; ${g.gaps.heuristicRequiresAuthorReview.length} components require author review.`), "", "Full imported files are retained in *-guide-explicit.toml and *-guide-generated.toml. Every imported instruction and unverified prose is retained in the corpus audit and derived component mapping.", "", "## Guide-derived mechanical lane", "", ...derivedResults.map(r => `${r.game}: ${r.componentCount} components, ${r.instructionCount} synthetic instructions, ${r.proofs.length} hash-verified receipts. Validation/order, dry-run with zero source/game writes, checkpoint recording, and baseline restore passed.`), "", "Patcher and Execute steps are omitted explicitly. For those components, receipt transfer is auxiliary Copy, never a simulated patcher or tool execution.", "", "## Standalone feature lane", "", "For both games: Extract, Move, Copy, Rename, Delete, folder Choose, selected option, phase routing, checkpoints and rollback passed. Synthetic widescreen phase only copies text; no executable or GUI binary patch occurs.", "", "Not exercised: Patcher, Execute, CleanList, real binary widescreen patching, original mod payload effects, actual game startup or gameplay.", ""];
 await writeFile(join(output,"summary.md"),report.join("\n"));
 console.log(JSON.stringify({output,corpusCommit:audit.commit,games:derivedResults.map(r=>({game:r.game,components:r.componentCount,instructions:r.instructionCount})),result:"passed"}));
} else console.log(JSON.stringify({output,prepared:fixtures.map(f=>f.game)}));
