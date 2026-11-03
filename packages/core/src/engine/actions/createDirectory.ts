/** Rust CreateDirectory projection; real execution is closed until directory rollback ownership exists. */
import type { Instruction, InstructionResult, ModComponent, ModOption } from "../../model/types.js";
import { baseName, joinPath, normalizePath, splitPath } from "../../fs/paths.js";
import type { InstallContext } from "../context.js";
import { ActionError, checkCancelled, runAction } from "./common.js";

export async function directoryDestination(ctx:InstallContext,instruction:Instruction):Promise<string>{
 if(instruction.source.length || (instruction.arguments ?? "").length)throw new ActionError("UnknownError","CreateDirectory requires empty Source and Arguments");
 if(!instruction.destination?.trim())throw new ActionError("PathEscape","CreateDirectory requires a child destination");
 if(!ctx.fs.inspectPath||!ctx.fs.inspectDirectoryEntries)throw new ActionError("UnknownError","Filesystem cannot inspect directory/symlink ancestry");
 const target=ctx.resolver.resolve(instruction.destination),roots=[ctx.dirs.modDirectory,ctx.dirs.kotorDirectory].filter(Boolean).map(normalizePath);
 const folded=target.toLowerCase();const matching=roots.filter(root=>folded.startsWith(root.toLowerCase().replace(/\/$/,"")+"/"));
 const root=matching.sort((a,b)=>b.length-a.length)[0];
 if(!root||roots.some(root=>root.toLowerCase()===folded))throw new ActionError("PathEscape","CreateDirectory requires a child of a configured root");
 if(/[*?[\]\0]/.test(baseName(target)))throw new ActionError("PathEscape","CreateDirectory name cannot contain wildcard or NUL characters");
 // Reject physical symlinks all the way to the volume root, including the configured root itself.
 const parts=splitPath(root);let physical=parts.root;
 for(const segment of parts.segments){physical=joinPath(physical,segment);const stat=await ctx.fs.inspectPath(physical);if(!stat||!stat.isDirectory||stat.isSymbolicLink)throw new ActionError("PathEscape","Configured root ancestry must contain real directories");}
 let current=root;const segments=target.slice(root.length).replace(/^\//,"").split("/");
 for(let index=0;index<segments.length;index++){
  checkCancelled(ctx);const names=await ctx.fs.inspectDirectoryEntries(current);const matches=names.filter(entry=>entry.name.toLowerCase()===segments[index].toLowerCase());
  if(matches.length>1)throw new ActionError("PathEscape","Ambiguous directory spelling");
  const next=matches[0]?.path??joinPath(current,segments[index]);const stat=await ctx.fs.inspectPath(next);
  if(stat&&(stat.isSymbolicLink||!stat.isDirectory))throw new ActionError("PathEscape","File or symlink blocks CreateDirectory destination/ancestor");
  if(index<segments.length-1&&!stat)throw new ActionError("PathEscape","CreateDirectory requires an existing parent");
  current=next;
 }
 return current;
}
export function executeCreateDirectory(ctx:InstallContext,instruction:Instruction,mod:ModComponent,option?:ModOption):Promise<InstructionResult>{
 return runAction(ctx,instruction,mod,option,async run=>{
  if(!ctx.dryRun||!ctx.fs.isVirtual||!ctx.fs.projectDirectory)throw new ActionError("UnknownError","CreateDirectory real execution refused: durable empty-directory checkpoint ownership and rollback are not implemented");
  const path=await directoryDestination(ctx,instruction);checkCancelled(ctx);await ctx.fs.projectDirectory(path);run.touch(path);run.note("projected directory; no disk mutation");
 });
}
