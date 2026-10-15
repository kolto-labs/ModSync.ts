/** OS ownership prerequisite only. Physical installation remains gated until verified recovery exists. */
import {createHash} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {lstat,open,realpath,type FileHandle} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename,dirname,join,resolve} from 'node:path';

interface NativeOwnership {tryLock(fd:number):boolean;release(fd:number):void}
const reservationKey=Symbol.for('modsync.writer-ownership.reservations');
const shared=globalThis as typeof globalThis & {[reservationKey]?:Set<string>};
const reservations=shared[reservationKey]??=new Set<string>();
const require=createRequire(import.meta.url);
let native:NativeOwnership|undefined;
function backend():NativeOwnership {
 if(process.platform!=='linux'&&process.platform!=='darwin')throw new Error('Safe native lock-file opening is not yet implemented on this platform');
 if(!constants.O_NOFOLLOW)throw new Error('Safe no-follow lock opening is unavailable');
 if(!native){const loaded:unknown=require('../../native/writer_ownership.node');if(!loaded||typeof loaded!=='object'||!('tryLock' in loaded)||!('release' in loaded)||typeof loaded.tryLock!=='function'||typeof loaded.release!=='function')throw new Error('Native writer ownership addon is unavailable');native=loaded as NativeOwnership;}
 return native;
}
async function ordinaryAncestors(path:string):Promise<void>{
 for(let current=resolve(path);;current=dirname(current)){const entry=await lstat(current);if(entry.isSymbolicLink()||!entry.isDirectory())throw new Error('Writer root ancestry must be ordinary directories');if(dirname(current)===current)return;}
}
function errorCode(error:unknown):string|undefined{return typeof error==='object'&&error!==null&&'code'in error?String((error as {code?:unknown}).code):undefined;}
const lockOpenFlags=constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK;
async function openExistingLock(path:string):Promise<{file:FileHandle;before:BigIntStats}>{
 const before=await lstat(path,{bigint:true});
 if(before.isSymbolicLink()||!before.isFile())throw new Error('Writer lock must be an ordinary file');
 return {file:await open(path,lockOpenFlags),before};
}
async function openOrCreateLock(path:string):Promise<{file:FileHandle;before:BigIntStats}>{
 for(let attempt=0;attempt<3;attempt++){
  let before:BigIntStats;
  try{before=await lstat(path,{bigint:true});}
  catch(error){
   if(errorCode(error)!=='ENOENT')throw error;
   let created:FileHandle;
   try{created=await open(path,lockOpenFlags|constants.O_CREAT|constants.O_EXCL,0o600);}
   catch(createError){if(errorCode(createError)==='EEXIST')continue;throw createError;}
   try{return {file:created,before:await lstat(path,{bigint:true})};}
   catch(error){await created.close();throw error;}
  }
  if(before.isSymbolicLink()||!before.isFile())throw new Error('Writer lock must be an ordinary file');
  try{return {file:await open(path,lockOpenFlags),before};}
  catch(error){if(errorCode(error)==='ENOENT')continue;throw error;}
 }
 throw new Error('Writer lock identity changed during creation');
}
async function withWriterOwnership<T>(lockPath:string,rootDirectory:string,work:()=>Promise<T>,createMissing:boolean):Promise<T>{
 const addon=backend();await ordinaryAncestors(rootDirectory);
 const root=await realpath(rootDirectory),rootBefore=await lstat(root,{bigint:true});
 const parent=await realpath(dirname(lockPath)),path=join(parent,basename(lockPath));
 await ordinaryAncestors(parent);
 const key=path;if(reservations.has(key))throw new Error('Writer root is reserved in this process');reservations.add(key);
 let file:FileHandle|undefined,acquired=false;
 try{
  const opened=createMissing?await openOrCreateLock(path):await openExistingLock(path);file=opened.file;const before=opened.before;
  const fdIdentity=await file.stat({bigint:true}),linked=await lstat(path,{bigint:true});
  if(!fdIdentity.isFile()||linked.isSymbolicLink()||!linked.isFile()||before.dev!==fdIdentity.dev||before.ino!==fdIdentity.ino||linked.dev!==fdIdentity.dev||linked.ino!==fdIdentity.ino)throw new Error('Writer lock identity changed');
  if(!addon.tryLock(file.fd))throw new Error('Another process owns this writer root');acquired=true;
  const after=await lstat(root,{bigint:true}),lockAfter=await lstat(path,{bigint:true});
  if(after.isSymbolicLink()||!after.isDirectory()||after.dev!==rootBefore.dev||after.ino!==rootBefore.ino||lockAfter.isSymbolicLink()||lockAfter.dev!==fdIdentity.dev||lockAfter.ino!==fdIdentity.ino||await realpath(rootDirectory)!==root)throw new Error('Writer root identity changed during acquisition');
  return await work();
 }finally{
  try{if(acquired&&file)addon.release(file.fd);}finally{try{await file?.close();}finally{reservations.delete(key);}}
 }
}
export function withExistingWriterOwnership<T>(lockPath:string,rootDirectory:string,work:()=>Promise<T>):Promise<T>{
 return withWriterOwnership(lockPath,rootDirectory,work,false);
}
function withWriterOwnershipCreatingLock<T>(lockPath:string,rootDirectory:string,work:()=>Promise<T>):Promise<T>{
 return withWriterOwnership(lockPath,rootDirectory,work,true);
}
async function withInstallRoots<T>(modDirectory:string,gameDirectory:string,work:()=>Promise<T>,createMissing:boolean):Promise<T>{
 await Promise.all([ordinaryAncestors(modDirectory),ordinaryAncestors(gameDirectory)]);
 const roots=[...new Set(await Promise.all([realpath(modDirectory),realpath(gameDirectory)]))].sort((a,b)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8')));
 if(roots.some(root=>dirname(root)===root))throw new Error('Install roots must have a parent directory');
 const enter=async(index:number):Promise<T>=>{if(index===roots.length)return work();const root=roots[index]!,hash=createHash('sha256').update(root,'utf8').digest('hex').slice(0,16),lock=join(dirname(root),`.modsync-lock-${hash}`),acquire=createMissing?withWriterOwnershipCreatingLock:withExistingWriterOwnership;return acquire(lock,root,()=>enter(index+1));};
 return enter(0);
}
export function withExistingInstallRootOwnership<T>(modDirectory:string,gameDirectory:string,work:()=>Promise<T>):Promise<T>{
 return withInstallRoots(modDirectory,gameDirectory,work,false);
}
export function withInstallRootOwnership<T>(modDirectory:string,gameDirectory:string,work:()=>Promise<T>):Promise<T>{
 return withInstallRoots(modDirectory,gameDirectory,work,true);
}
