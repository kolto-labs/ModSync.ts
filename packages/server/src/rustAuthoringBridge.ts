/** Explicit optional Rust persistence backend. No shell and no installer commands. */
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { canonicalRevisionId, readAuthoringOperations, type AuthoringEditOperation } from '@modsync/core';
export type RustAuthoringCommand = { operation:'edit'; label:string; operations:AuthoringEditOperation[] } | { operation:'undo'|'redo' };
export interface RustAuthoringResult { backend:'rust-cli'; currentRevision:string; status:Record<string,unknown> }
export async function persistWithRustAuthoring(executable:string,directory:string,expectedRevision:string,command:RustAuthoringCommand):Promise<RustAuthoringResult> {
  if(!isAbsolute(executable)||!isAbsolute(directory))throw new Error('Rust authoring executable and session directory must be absolute');
  if(!canonicalRevisionId(expectedRevision))throw new Error('Expected a canonical revision identity');
  const info=await lstat(executable);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('Rust authoring executable must be an ordinary file');
  let input='';
  const args=['easy',command.operation,directory];
  if(command.operation==='edit') {
    if(typeof command.label!=='string'||Buffer.byteLength(command.label,'utf8')>4096)throw new Error('Invalid revision label');
    input=JSON.stringify(readAuthoringOperations(command.operations));
    if(Buffer.byteLength(input,'utf8')>8*1024*1024)throw new Error('Editor document exceeds 8 MiB');
    args.push('-','--label',command.label);
  }
  args.push('--expected-revision',expectedRevision);
  const status=await runRustAuthoring(executable,args,input);
  if(status===null||typeof status!=='object'||Array.isArray(status))throw new Error('Invalid Rust authoring response; reload the session');
  const currentRevision=(status as Record<string,unknown>).currentRevision;
  if(typeof currentRevision!=='string'||!canonicalRevisionId(currentRevision))throw new Error('Rust authoring CLI lacks the verified revision contract; reload the session');
  return {backend:'rust-cli',currentRevision,status:status as Record<string,unknown>};
}

async function runRustAuthoring(executable:string,args:string[],input=''):Promise<unknown> {
  if(!isAbsolute(executable))throw new Error('Rust authoring executable must be absolute');
  const info=await lstat(executable);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('Rust authoring executable must be an ordinary file');
  const env={...process.env};delete env.DISPLAY;delete env.WAYLAND_DISPLAY;delete env.SESSION_MANAGER;
  const text=await new Promise<string>((resolve,reject)=>{
    const child=spawn(executable,args,{shell:false,stdio:['pipe','pipe','pipe'],env,windowsHide:true});
    const output:Buffer[]=[];let bytes=0,errorBytes=0;const errors:Buffer[]=[];let failure:string|undefined;let escalation:ReturnType<typeof setTimeout>|undefined;
    const stop=(reason:string)=>{if(failure)return;failure=reason;child.kill('SIGTERM');escalation=setTimeout(()=>child.kill('SIGKILL'),2000);escalation.unref();};
    const deadline=setTimeout(()=>stop('Rust authoring command timed out; persistence outcome is uncertain, reload the session'),60000);deadline.unref();
    child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>8*1024*1024)stop('Rust authoring output exceeded 8 MiB; reload the session');else output.push(data);});
    child.stderr.on('data',(data:Buffer)=>{errorBytes+=data.length;if(errorBytes<=1024*1024)errors.push(data);else stop('Rust authoring diagnostics exceeded 1 MiB; reload the session');});
    child.stdin.on('error',()=>{});
    child.on('error',(error)=>{clearTimeout(deadline);if(escalation)clearTimeout(escalation);reject(error);});
    child.on('close',(code,signal)=>{clearTimeout(deadline);if(escalation)clearTimeout(escalation);if(failure)reject(new Error(failure));else if(code!==0)reject(new Error(`Rust authoring failed (${code??signal}); reload the session before retrying: ${Buffer.concat(errors).toString('utf8').slice(0,8192)}`));else {try{resolve(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(output)));}catch(error){reject(error);}}});
    child.stdin.end(input);
  });
  return JSON.parse(text) as unknown;
}
export interface RustPredictionEntry {path:string;directory:boolean;content_known:boolean;bytes:number|null}
export interface RustPrediction {backend:'rust-cli';revisionId:string;entries:RustPredictionEntry[];events:{component:string;step:number;message:string}[]}
export async function predictWithRustAuthoring(executable:string,directory:string,expectedRevision:string,sourceDirectory:string,gameDirectory:string,component:number,instructions:number):Promise<RustPrediction> {
  if(![directory,sourceDirectory,gameDirectory].every(isAbsolute)||!canonicalRevisionId(expectedRevision))throw new Error('Prediction requires absolute roots and a canonical revision');
  if(!Number.isSafeInteger(component)||component<0||!Number.isSafeInteger(instructions)||instructions<0)throw new Error('Invalid prediction point');
  const value=await runRustAuthoring(executable,['easy','predict',directory,'--source-dir',sourceDirectory,'--game-dir',gameDirectory,'--component',String(component),'--instructions',String(instructions),'--expected-revision',expectedRevision]);
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid Rust prediction result');
  const result=value as Record<string,unknown>;
  if(!Array.isArray(result.entries)||!Array.isArray(result.events))throw new Error('Invalid Rust prediction result');
  const entries=result.entries.map((value:unknown):RustPredictionEntry=>{
    if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid predicted entry');
    const entry=value as Record<string,unknown>;
    if(typeof entry.path!=='string'||typeof entry.directory!=='boolean'||typeof entry.content_known!=='boolean'||(entry.bytes!==null&&(typeof entry.bytes!=='number'||!Number.isSafeInteger(entry.bytes)||entry.bytes<0)))throw new Error('Unsupported predicted entry');
    if(!entry.content_known&&entry.bytes!==null)throw new Error('Unknown predicted content cannot have a known size');
    return {path:entry.path,directory:entry.directory,content_known:entry.content_known,bytes:entry.bytes as number|null};
  });
  const events=result.events.map((value:unknown)=>{if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid prediction event');const event=value as Record<string,unknown>;if(typeof event.component!=='string'||typeof event.message!=='string'||typeof event.step!=='number'||!Number.isSafeInteger(event.step)||event.step<0)throw new Error('Invalid prediction event');return {component:event.component,message:event.message,step:event.step};});
  return {backend:'rust-cli',revisionId:expectedRevision,entries,events};
}
