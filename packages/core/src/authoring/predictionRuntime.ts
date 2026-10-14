/** Independent, virtual-only execution of canonical authored Rust guides. Raw records remain authoritative. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openArchive } from '../archive/index.js';
import { VirtualFileSystem } from '../fs/virtualFileSystem.js';
import { RealFileSystem } from '../fs/realFileSystem.js';
import { baseName, joinPath, parentPath, splitPath } from '../fs/paths.js';
import { createInstruction, createMod } from '../model/defaults.js';
import { ACTION_TYPES, type Instruction, type InstructionResult, type ModComponent, type UserSettings } from '../model/types.js';
import { isGuid, normalizeGuid } from '../model/guid.js';
import { createInstallContext } from '../engine/context.js';
import { executeInstruction, defaultExtractDir, resolveSources, resolveDestination, checkCancelled } from '../engine/actions/index.js';
import { requiresDraftReview, type DraftComponentRecord } from './draftReview.js';
import { decodeRustAuthoringGuide, validateRustAuthoringGuide, type RustAuthoringGuide } from './transactions.js';
import { readArchivePins, verifyArchivePin } from './archivePins.js';

/** Every reached base segment is inspected before following it; recursive VFS walks use this reader too.
 * This is readonly traversal validation, not an OS-owned stable snapshot against concurrent replacement.
 */
class PredictionBase extends RealFileSystem {
 override async resolveCase(path:string):Promise<string|undefined>{
  const {root,segments}=splitPath(path);if(!root)throw new Error('Prediction requires absolute filesystem paths');
  let current=root;const rootStat=await super.inspectPath(current);
  if(!rootStat?.isDirectory||rootStat.isSymbolicLink)throw new Error('Unsafe prediction filesystem root');
  for(let index=0;index<segments.length;index++){
   const names=await readdir(current),wanted=segments[index]!,matches=names.filter(name=>name.toLowerCase()===wanted.toLowerCase());
   if(matches.length>1)throw new Error('Ambiguous physical case collision in prediction');
   const name=matches[0];if(name===undefined)return undefined;
   current=joinPath(current,name);const stat=await super.inspectPath(current);
   if(!stat)return undefined;if(stat.isSymbolicLink)throw new Error('Prediction cannot traverse symbolic links');
   if(index<segments.length-1&&!stat.isDirectory)return undefined;
  }
  return current;
 }
 override async readDir(path:string){
  const actual=await this.resolveCase(path);if(!actual)throw new Error('Prediction directory does not exist');
  const entries=[];
  for(const name of await readdir(actual)){
   const child=joinPath(actual,name),stat=await super.inspectPath(child);
   if(!stat)throw new Error('Prediction directory changed during inspection');
   if(stat.isSymbolicLink)throw new Error('Prediction directory contains a symbolic link');
   entries.push({name,path:child,isDirectory:stat.isDirectory});
  }
  return entries;
 }
}

const identity=(value:unknown):string=>{if(typeof value!=='string'||!isGuid(value))throw new Error('Unsupported component identity');return normalizeGuid(value);};
interface RuntimeComponent { raw:DraftComponentRecord; mod:ModComponent; children:RuntimeComponent[] }
export interface AuthoringPredictionOptions {settings:UserSettings;sessionDirectory?:string;componentGuid?:string;instructionCount?:number;signal?:AbortSignal}
export interface AuthoringPrediction {rawGuide:RustAuthoringGuide;componentCount:number;selectedIds:string[];results:InstructionResult[];mutations:ReturnType<VirtualFileSystem['getMutations']>;verifiedInputs:string[];unmodeledEffects:string[];error?:string;virtualOnly:true}
/** No lenient aliases, invented GUIDs, defaults-to-selected or unknown metadata deletion. */
function adapt(raw:DraftComponentRecord):RuntimeComponent {
 const instructions=(raw.Instructions as Record<string,unknown>[]).map(value=>{
  if(typeof value.Action!=='string'||!ACTION_TYPES.includes(value.Action as Instruction['action']))throw new Error('Unsupported canonical action');
  return createInstruction(value.Action as Instruction['action'],{guid:typeof value.Guid==='string'?value.Guid:'',source:[...value.Source as string[]],destination:value.Destination as string,arguments:value.Arguments as string,overwrite:value.Overwrite as boolean,dependencies:(value.Dependencies as string[]).map(identity),restrictions:(value.Restrictions as string[]).map(identity),metadata:structuredClone(value)});
 });
 const children=(raw.Options as DraftComponentRecord[]).map(adapt);
 const mod=createMod({guid:identity(raw.Guid),name:raw.Name as string,isSelected:raw.IsSelected as boolean,dependencies:(raw.Dependencies as string[]).map(identity),restrictions:(raw.Restrictions as string[]).map(identity),installAfter:(raw.InstallAfter as string[]).map(identity),installBefore:(raw.InstallBefore as string[]).map(identity),instructions,metadata:structuredClone(raw)});
 return {raw:structuredClone(raw),mod,children};
}
function ordered(roots:RuntimeComponent[],selected:Set<string>):RuntimeComponent[]{
 const chosen=roots.filter(c=>c.mod.isSelected),all=new Set(roots.map(c=>c.mod.guid)),ids=new Set(chosen.map(c=>c.mod.guid));
 if(!chosen.length)throw new Error('Select at least one component');
 const before=new Map(chosen.map(c=>[c.mod.guid,new Set<string>()]));
 for(const c of chosen){for(const dep of c.mod.dependencies){if(!ids.has(dep))throw new Error(`${c.mod.name} requires selected top-level component ${dep}`);before.get(c.mod.guid)!.add(dep);}for(const ref of c.mod.restrictions)if(selected.has(ref))throw new Error(`${c.mod.name} conflicts with ${ref}`);for(const ref of c.mod.installAfter){if(!all.has(ref))throw new Error('Missing InstallAfter target');if(ids.has(ref))before.get(c.mod.guid)!.add(ref);}for(const ref of c.mod.installBefore){if(!all.has(ref))throw new Error('Missing InstallBefore target');if(ids.has(ref))before.get(ref)!.add(c.mod.guid);}}
 const done=new Set<string>(),result:RuntimeComponent[]=[];while(result.length<chosen.length){const next=chosen.find(c=>!done.has(c.mod.guid)&&[...before.get(c.mod.guid)!].every(id=>done.has(id)));if(!next)throw new Error('Selected dependency/order cycle');done.add(next.mod.guid);result.push(next);}return result;
}
/** Uses real immutable archive bytes through lazy VFS members; never extracts to a physical scratch directory. */
export async function predictRustAuthoringGuide(value:unknown,options:AuthoringPredictionOptions):Promise<AuthoringPrediction>{
 const guide=decodeRustAuthoringGuide(value);validateRustAuthoringGuide(guide);const roots=guide.thisMod.map(adapt),selected=new Set<string>(),names=new Map<string,string>();let componentCount=0;
 function collect(c:RuntimeComponent,parentSelected=true):void{componentCount++;names.set(c.mod.guid,c.mod.name);if(parentSelected&&c.mod.isSelected)selected.add(c.mod.guid);for(const child of c.children)collect(child,parentSelected&&c.mod.isSelected);}roots.forEach(c=>collect(c));
 const queue=ordered(roots,selected),vfs=new VirtualFileSystem(new PredictionBase()),selection={selectedGuids:selected,mods:queue.map(c=>c.mod),options:new Map(),names};
 const ctx=createInstallContext({settings:options.settings,selection,fs:vfs,dryRun:true,signal:options.signal});
 // Root spelling/physical ancestry is established before any lazy base reads.
 for(const root of [ctx.dirs.modDirectory,ctx.dirs.kotorDirectory]){
  if(!root)throw new Error('Prediction needs explicit mod and game directories');
  for(let path=root;;path=parentPath(path)){const stat=await vfs.base.inspectPath!(path);if(!stat?.isDirectory||stat.isSymbolicLink)throw new Error('Prediction root ancestry must contain real directories');if(parentPath(path)===path)break;}
 }
 const verified=new Set<string>(),pins=readArchivePins(guide),physical=new Map<string,string>();
 if(options.sessionDirectory)for(const [name,pin] of Object.entries(pins)){
  if(/^\.tmp/i.test(name))continue;const logical=joinPath(ctx.dirs.modDirectory,name),object=join(options.sessionDirectory,'inputs',pin.sha256);physical.set(logical,object);
  await vfs.addReadOnlyFile(logical,pin.bytes,async()=>{if(pin.bytes>64*1024*1024)throw new Error('Input exceeds in-memory content bound');await verifyArchivePin(options.sessionDirectory!,pin,options.signal);const bytes=await readFile(object);verified.add(name);return bytes;});
 }
 const inputMutationCount=vfs.getMutations().length,results:InstructionResult[]=[],unmodeledEffects:string[]=[];
 const archiveFor=async(path:string)=>{const object=physical.get(path);if(object){const name=baseName(path),pin=pins[name]!;await verifyArchivePin(options.sessionDirectory!,pin,options.signal);verified.add(name);}return openArchive(object??path,{sevenZipPath:options.settings.sevenZipPath});};
 ctx.openArchive=archiveFor;
 async function extract(instruction:Instruction,component:RuntimeComponent):Promise<InstructionResult>{
  const started=performance.now(),touched:string[]=[],sources=await resolveSources(ctx,instruction.source);if(!sources.length||sources.some(s=>!s.matches.length))throw new Error('Archive source does not exist');
  for(const source of sources.flatMap(s=>s.matches)){
   const dest=instruction.destination?.trim()?await resolveDestination(ctx,instruction.destination):defaultExtractDir(source),reader=await archiveFor(source);
   try{const entries=await reader.list();if(entries.length>100000)throw new Error('Archive listing exceeds bound');if(entries.some(entry=>/(^|\/)fomod\/moduleconfig\.xml$/i.test(entry.path.replaceAll('\\','/'))))throw new Error('Archive FOMOD configuration prediction is not yet ported');await vfs.mkdirp(dest);
    for(const entry of entries){checkCancelled(ctx);const path=ctx.resolver.resolve(joinPath(dest,entry.path));if(entry.isDirectory){await vfs.mkdirp(path);continue;}if(!instruction.overwrite&&await vfs.exists(path))continue;
     await vfs.addReadOnlyFile(path,entry.size,async()=>{if(entry.size>64*1024*1024)throw new Error('Archive member exceeds bounded read');const reopened=await archiveFor(source);try{const bytes=await reopened.readEntry(entry.path);const object=physical.get(source);if(object)await verifyArchivePin(options.sessionDirectory!,pins[baseName(source)]!,options.signal);return bytes;}finally{await reopened.close();}});touched.push(path);
    }
   }finally{await reader.close();const object=physical.get(source);if(object)await verifyArchivePin(options.sessionDirectory!,pins[baseName(source)]!,options.signal);}
  }
  return {instructionGuid:instruction.guid,modGuid:component.mod.guid,action:instruction.action,code:'Success',touched,durationMs:performance.now()-started,message:'Archive members projected with lazy immutable bytes'};
 }
 async function run(component:RuntimeComponent,count=component.mod.instructions.length):Promise<void>{
  checkCancelled(ctx);if(requiresDraftReview(component.raw))throw new Error(`${component.mod.name} requires draft review`);
  if(Object.hasOwn(component.raw,'UnresolvedMasters')&&(!Array.isArray(component.raw.UnresolvedMasters)||(component.raw.UnresolvedMasters as unknown[]).length))throw new Error('Unresolved Markdown masters');
  for(const dep of component.mod.dependencies)if(!selected.has(dep))throw new Error('Component dependency not selected');for(const ref of component.mod.restrictions)if(selected.has(ref))throw new Error('Component restriction selected');
  if(Object.keys(component.raw).some(key=>/fomod/i.test(key)))throw new Error('Configured FOMOD prediction is not yet ported');
  for(const instruction of component.mod.instructions.slice(0,count)){
   checkCancelled(ctx);if(!instruction.dependencies.every(id=>selected.has(id))||instruction.restrictions.some(id=>selected.has(id))){results.push({instructionGuid:instruction.guid,modGuid:component.mod.guid,action:instruction.action,code:'Skipped',message:'Skipped by instruction conditions',touched:[],durationMs:0});continue;}
   if(instruction.action==='Choose'){
    const requested=instruction.source.map(identity);if(requested.some(id=>!component.children.some(child=>child.mod.guid===id)))throw new Error('Choose references unknown direct option');
    results.push({instructionGuid:instruction.guid,modGuid:component.mod.guid,action:'Choose',code:'Success',message:'Executing saved selected direct options at this instruction',touched:[],durationMs:0});
    for(const child of component.children)if(child.mod.isSelected&&requested.includes(child.mod.guid))await run(child);continue;
   }
   if(['Copy','Move','CleanList','DelDuplicate'].includes(instruction.action)){const dest=await resolveDestination(ctx,instruction.destination??'');if(!(await vfs.stat(dest))?.isDirectory)throw new Error('Destination does not exist at this instruction boundary');}
   const result=instruction.action==='Extract'?await extract(instruction,component):await executeInstruction(ctx,instruction,component.mod);results.push(result);
   if(['Execute','Run','Patcher'].includes(instruction.action))unmodeledEffects.push(`${component.mod.guid}:${instruction.guid}:${instruction.action}`);
   if(result.code!=='Success'&&result.code!=='Skipped')throw new Error(`${instruction.action}: ${result.message??result.code}`);
  }
 }
 let error:string|undefined;
 try{if(options.componentGuid){const component=roots.find(c=>c.mod.guid===identity(options.componentGuid));if(!component||!selected.has(component.mod.guid))throw new Error('Prediction component must be selected and top-level');const count=options.instructionCount??component.mod.instructions.length;if(!Number.isSafeInteger(count)||count<0||count>component.mod.instructions.length)throw new Error('Invalid instruction boundary');await run(component,count);}else{if(options.instructionCount!==undefined)throw new Error('Instruction boundary requires a component');for(const component of queue)await run(component);}}
 catch(cause){error=cause instanceof Error?cause.message:String(cause);}
 return {rawGuide:structuredClone(guide),componentCount,selectedIds:[...selected],results,mutations:vfs.getMutations().slice(inputMutationCount),verifiedInputs:[...verified],unmodeledEffects,error,virtualOnly:true};
}
