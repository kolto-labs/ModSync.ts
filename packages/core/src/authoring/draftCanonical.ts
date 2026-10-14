/** Supported Rust Internal component normalization for draft identities.
 * Refuses legacy resource migration and noncanonical structured getters until
 * their Rust ports exist. This is not TS lenient TOML normalization.
 */
import type { DraftComponentRecord } from "./draftReview.js";
const rustTrim=(value:string):string=>value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const names = ['Unset','Extract','Execute','Patcher','Move','Copy','Rename','Delete','DelDuplicate','Choose','Run','CleanList','CreateDirectory'];
const fields = ['Guid','Name','Author','Description','Directions','Tier','Category','IsSelected','Dependencies','Restrictions','InstallBefore','InstallAfter','Instructions','Options','ResourceRegistry'];
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Component must be an object');
  return value as Record<string,unknown>;
}
function text(value: unknown, fallback=''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error('Structured scalar normalization is not yet supported for draft identity');
  return value;
}
function list(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('Structured list normalization is not yet supported for draft identity');
  return [...value];
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('Nonboolean normalization is not yet supported for draft identity');
  return value;
}
function normalizeSource(path: string): string {
  if (!rustTrim(path)) return path;
  function fix(value: string): string {
    let output='';
    for (const c of value.replace(/^\\+/,'')) {
      const char=c === '\\' ? '/' : c;
      if (char === '/' && output.endsWith('/') && !output.slice(0,-1).endsWith(':')) continue;
      output+=char;
    }
    return output.length > 1 ? output.replace(/\/+$/,'') : output;
  }
  const fixed=fix(path), lower=fixed.replace(/[A-Z]/g,(c)=>c.toLowerCase());
  return ['<<moddirectory>>','<<kotordirectory>>','<<gamedirectory>>'].some((p)=>lower.startsWith(p)) ? fixed : fix('<<modDirectory>>/'+fixed);
}
function instruction(value: unknown, normalize=true): Record<string,unknown> {
  const source=structuredClone(record(value)), r:Record<string,unknown>={};
  if (normalize) for (const [key,v] of Object.entries(source)) if (v === null) delete source[key];
  const action=text(source.Action,'Unset');
  if (!names.includes(action)) throw new Error('Noncanonical Action normalization is not yet supported for draft identity');
  for (const key of ['Guid','Parent']) { const v=text(source[key]); if (v) r[key]=v; }
  r.Action=action;
  const paths=list(normalize && Array.isArray(source.Source) ? source.Source.filter((item)=>item !== null) : source.Source);
  r.Source=normalize ? paths.filter((p)=>!!rustTrim(p)).map((p)=>action === 'Choose' ? p : normalizeSource(p)) : paths;
  r.Destination=text(source.Destination); r.Arguments=text(source.Arguments);
  // Rust normalization inserts false for an absent Delete Overwrite; otherwise serde defaults true.
  r.Overwrite=boolean(source.Overwrite,!normalize || action !== 'Delete');
  r.Dependencies=list(source.Dependencies); r.Restrictions=list(source.Restrictions);
  return r;
}
export function canonicalizeRustDraftComponent(value: DraftComponentRecord): DraftComponentRecord {
  function visit(raw: DraftComponentRecord, depth: number, option: boolean): DraftComponentRecord {
    if (depth>64) throw new Error('Draft option nesting exceeds 64 levels');
    const input=structuredClone(raw), output:DraftComponentRecord={};
    for (const key of Object.keys(input)) {
      if ([...fields,"DraftReview","UnresolvedMasters"].some((known)=>known.toLowerCase()===key.toLowerCase() && known!==key)) throw new Error("Noncanonical component property is not yet supported for draft identity");
    }
    for (const [key,v] of Object.entries(input)) if (v === null) delete input[key];
    if (Object.hasOwn(input,'ModLink') || Object.hasOwn(input,'ModLinkFilenames') || Object.hasOwn(input,'modLinkFilenames')) throw new Error('Legacy resource migration is not yet supported for draft identity');
    for (const [key,v] of Object.entries(input)) if (!fields.includes(key)) output[key]=v;
    for (const key of ['Guid','Name','Author','Description','Directions','Tier']) output[key]=text(input[key]);
    if (!option) {
      const tier=output.Tier as string, lower=tier.toLowerCase();
      output.Tier=[['essential','1 - Essential'],['recommend','2 - Recommended'],['suggest','3 - Suggested'],['option','4 - Optional']].find(([word])=>lower.includes(word!))?.[1] ?? rustTrim(tier);
    } else if (Object.hasOwn(input,'Tier')) {
      // Rust applies tier normalization even for options, though only top-level tier uses text getters.
      const tier=output.Tier as string, lower=tier.toLowerCase();
      output.Tier=[['essential','1 - Essential'],['recommend','2 - Recommended'],['suggest','3 - Suggested'],['option','4 - Optional']].find(([word])=>lower.includes(word!))?.[1] ?? rustTrim(tier);
    }
    output.Category=list(input.Category);
    if (!option && Object.hasOwn(input,'Language')) output.Language=list(input.Language);
    output.IsSelected=boolean(input.IsSelected,false);
    for (const key of ['Dependencies','Restrictions','InstallBefore','InstallAfter']) output[key]=list(input[key]);
    if (input.Instructions !== undefined && !Array.isArray(input.Instructions)) throw new Error('Instructions must be an array');
    output.Instructions=(input.Instructions as unknown[]|undefined ?? []).map((value)=>instruction(value));
    if (input.Options !== undefined && !Array.isArray(input.Options)) throw new Error('Options must be an array');
    output.Options=(input.Options as unknown[]|undefined ?? []).map((item)=>visit(record(item),depth+1,true));
    const registry=input.ResourceRegistry === undefined ? {} : record(input.ResourceRegistry);
    for (const metadata of Object.values(registry)) {
      if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
        const resource=metadata as Record<string,unknown>;
        if (Object.keys(resource).some((k)=>k.toLowerCase()==='primaryurl')) throw new Error('PrimaryUrl resource normalization is not yet supported for draft identity');
        if (resource.Files !== null && typeof resource.Files === 'object' && !Array.isArray(resource.Files)) {
          const files=resource.Files as Record<string,unknown>;
          for (const [key,flag] of Object.entries(files)) if (typeof flag==='string') {
            const lower=flag.replace(/[A-Z]/g,(c)=>c.toLowerCase());
            if (!['null','true','false'].includes(lower)) throw new Error('Invalid resource file selection');
            files[key]=lower==='null' ? null : lower==='true';
          }
        }
      }
    }
    output.ResourceRegistry=registry;
    return output;
  }
  return visit(record(value),0,false);
}

/** Decode the supported serde Component subset without intake canonicalization.
 * Editor payloads retain authored tier/source spelling, like Rust EditOperation.
 */
export function decodeRustAuthoringComponent(value:unknown):DraftComponentRecord {
  function visit(raw:Record<string,unknown>,depth:number):DraftComponentRecord {
    if(depth>64)throw new Error('Option nesting exceeds 64 levels');
    const input=structuredClone(raw),output:DraftComponentRecord={};
    for(const [key,value] of Object.entries(input))if(!fields.includes(key)) {
      if(fields.some((known)=>known.toLowerCase()===key.toLowerCase()))throw new Error('Extension metadata shadows component field '+key);
      Object.defineProperty(output,key,{value,enumerable:true,writable:true,configurable:true});
    }
    for(const key of ['Guid','Name','Author','Description','Directions','Tier'])output[key]=text(input[key]);
    for(const key of ['Category','Dependencies','Restrictions','InstallBefore','InstallAfter'])output[key]=list(input[key]);
    output.IsSelected=boolean(input.IsSelected,false);
    if(input.Instructions!==undefined&&!Array.isArray(input.Instructions))throw new Error('Instructions must be an array');
    output.Instructions=(input.Instructions as unknown[]|undefined ?? []).map((value)=>instruction(value,false));
    if(input.Options!==undefined&&!Array.isArray(input.Options))throw new Error('Options must be an array');
    output.Options=(input.Options as unknown[]|undefined ?? []).map((v)=>visit(record(v),depth+1));
    output.ResourceRegistry=input.ResourceRegistry===undefined ? {} : record(input.ResourceRegistry);
    return output;
  }
  return visit(record(value),0);
}
export function decodeRustAuthoringInstruction(value:unknown):Record<string,unknown> {return instruction(value,false);}
