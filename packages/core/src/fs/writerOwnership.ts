/** OS ownership prerequisite only. Physical installation remains gated until verified recovery exists. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
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
/** Stable existing lock only; never creates/truncates/unlinks lock files or interprets PID/TTL metadata. */
export async function withExistingWriterOwnership<T>(lockPath:string,rootDirectory:string,work:()=>Promise<T>):Promise<T>{
 const addon=backend();await ordinaryAncestors(rootDirectory);
 const root=await realpath(rootDirectory),rootBefore=await lstat(root,{bigint:true});
 const parent=await realpath(dirname(lockPath)),path=join(parent,basename(lockPath));
 await ordinaryAncestors(parent);
 const key=path;if(reservations.has(key))throw new Error('Writer root is reserved in this process');reservations.add(key);
 let file:FileHandle|undefined,acquired=false;
 try{
  const before=await lstat(path,{bigint:true});if(!before.isFile()||before.isSymbolicLink())throw new Error('Writer lock must be an existing ordinary file');
  file=await open(path,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
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
/** Match Rust sibling lock derivation and hold BOTH mod/game leases in deterministic order. */
export async function withExistingInstallRootOwnership<T>(modDirectory:string,gameDirectory:string,work:()=>Promise<T>):Promise<T>{
 await Promise.all([ordinaryAncestors(modDirectory),ordinaryAncestors(gameDirectory)]);
 const roots=[...new Set(await Promise.all([realpath(modDirectory),realpath(gameDirectory)]))].sort((a,b)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8')));
 if(roots.some(root=>dirname(root)===root))throw new Error('Install roots must have a parent directory');
 const enter=async(index:number):Promise<T>=>{if(index===roots.length)return work();const root=roots[index]!,hash=createHash('sha256').update(root,'utf8').digest('hex').slice(0,16),lock=join(dirname(root),`.modsync-lock-${hash}`);return withExistingWriterOwnership(lock,root,()=>enter(index+1));};
 return enter(0);
}
