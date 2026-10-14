/** Read-only saved revision intake. Does not acquire a writer lock or publish autosaves. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readAuthoringHead, seekAuthoringRevision, type AuthoringHead } from './revisionHead.js';
import { decodeRustAuthoringGuide, validateRustAuthoringGuide, type RustAuthoringGuide } from './transactions.js';
const DOCUMENT_LIMIT=8*1024*1024;
async function readDocument(path:string):Promise<Buffer> {
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('Authoring document must be ordinary');
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const before=await file.stat({bigint:true});
    if(!before.isFile()||before.size>BigInt(DOCUMENT_LIMIT))throw new Error('Editor document exceeds 8 MiB');
    const chunks:Buffer[]=[];let total=0;
    for(;;){const buffer=Buffer.allocUnsafe(Math.min(65536,DOCUMENT_LIMIT+1-total));const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>DOCUMENT_LIMIT)throw new Error('Editor document exceeds 8 MiB');chunks.push(buffer.subarray(0,bytesRead));}
    const after=await file.stat({bigint:true});
    if(after.size!==before.size||after.mtimeNs!==before.mtimeNs)throw new Error('Authoring document changed while reading');
    return Buffer.concat(chunks,total);
  }finally{await file.close();}
}
function parse(bytes:Buffer):unknown { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
export interface AuthoringSessionSnapshot { directory:string; head:AuthoringHead; guide:RustAuthoringGuide; revisionId:string; headSha256:string; revisionSha256:string; readOnly:true }
/** Read an immutable revision and confirm head publication did not race the read. */
export async function readAuthoringSessionSnapshot(directory:string,cursor?:number):Promise<AuthoringSessionSnapshot> {
  const absolute=resolve(directory);
  for(let ancestor=absolute;;ancestor=dirname(ancestor)){const info=await lstat(ancestor);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Authoring directory must be ordinary');if(dirname(ancestor)===ancestor)break;}
  const headPath=join(absolute,'head.json'),headBytes=await readDocument(headPath);
  const savedHead=readAuthoringHead(parse(headBytes));
  const head=cursor===undefined?savedHead:seekAuthoringRevision(savedHead,cursor);
  const revisionId=head.revisions[head.cursor]!.id;
  const bytes=await readDocument(join(absolute,`revision-${revisionId}.json`));
  const guide=decodeRustAuthoringGuide(parse(bytes));validateRustAuthoringGuide(guide);
  const finalHead=await readDocument(headPath);
  if(!headBytes.equals(finalHead))throw new Error('Authoring head changed while loading; retry');
  return {directory:absolute,head,guide,revisionId,headSha256:createHash('sha256').update(headBytes).digest('hex'),revisionSha256:createHash('sha256').update(bytes).digest('hex'),readOnly:true};
}
