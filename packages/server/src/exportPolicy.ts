/** Standalone exports are new files, separate from locked Rust session writes. */
import { realpath, lstat } from "node:fs/promises";
import { dirname, basename, join, relative, isAbsolute } from "node:path";
import { HttpError } from "./state.js";
const within = (root:string,path:string):boolean => { const rel=relative(root,path); return rel==="" || (!rel.startsWith("..")&&!isAbsolute(rel)); };
async function existing(path:string):Promise<boolean>{try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}}
export async function safeExportPath(target:string, allowed:readonly string[], protectedRoots:readonly string[]):Promise<string>{
 if(!allowed.length)throw new HttpError(403,"Configure an explicit export directory before exporting");
 const parent=await realpath(dirname(target));
 const roots=await Promise.all(allowed.map(root=>realpath(root)));
 if(!roots.some(root=>within(root,parent)))throw new HttpError(403,"Destination is outside configured export directories");
 for(const root of protectedRoots.filter(Boolean)) { let canonical:string;try{canonical=await realpath(root);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}if(within(canonical,parent))throw new HttpError(403,"Cannot export into an authoring, game, mod or checkpoint directory"); }
 for(let cursor=parent;;cursor=dirname(cursor)) { if(await existing(join(cursor,"head.json")))throw new HttpError(403,"Cannot export inside a persisted authoring session");if(dirname(cursor)===cursor)break; }
 const path=join(parent,basename(target));
 if(await existing(path))throw new HttpError(409,"Export requires a new filename; existing files are preserved");
 return path;
}
