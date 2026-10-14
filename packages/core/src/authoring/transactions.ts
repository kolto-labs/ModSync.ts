/** Atomic guide edits, port of Rust editor/transaction.rs over its JSON schema. */
import { canonicalizeRustDraftComponent, decodeRustAuthoringComponent, decodeRustAuthoringInstruction } from './draftCanonical.js';
import { invalidateDraftReviewTree, resolveDraft, validateDraftReviewRecords, type DraftComponentRecord, type DraftResolution } from './draftReview.js';
export interface RustAuthoringGuide extends Record<string,unknown> { thisMod: DraftComponentRecord[] }
export type AuthoringEditOperation =
  | { operation:'resolveDraft'; component:string; resolution:DraftResolution }
  | { operation:'insertComponent'; parent:string|null; index:number; component:DraftComponentRecord }
  | { operation:'replaceComponent'; guid:string; component:DraftComponentRecord }
  | { operation:'removeComponent'; guid:string }
  | { operation:'moveComponent'; guid:string; index:number }
  | { operation:'insertInstruction'|'replaceInstruction'; component:string; index:number; instruction:Record<string,unknown> }
  | { operation:'removeInstruction'; component:string; index:number }
  | { operation:'moveInstruction'; component:string; index:number; destination:number }
  | { operation:'setResource'; component:string; url:string; value:unknown }
  | { operation:'removeResource'; component:string; url:string }
  | { operation:'setGuideMetadata'; key:string; value:unknown }
  | { operation:'removeGuideMetadata'; key:string };
export class AuthoringEditError extends Error {
  constructor(readonly operationIndex:number|null,message:string) { super(message);this.name='AuthoringEditError'; }
}
const key=(s:string):string=>s.replace(/[A-Z]/g,(c)=>c.toLowerCase());
const trim=(s:string):string=>s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,'');
const has=(v:Record<string,unknown>,p:string):boolean=>Object.hasOwn(v,p);
function record(v:unknown):Record<string,unknown> { if(v===null||typeof v!=='object'||Array.isArray(v))throw new Error('Expected an object');return v as Record<string,unknown>; }
function components(v:DraftComponentRecord):DraftComponentRecord[] { return v.Options as DraftComponentRecord[]; }
function instructions(v:DraftComponentRecord):Record<string,unknown>[] { return v.Instructions as Record<string,unknown>[]; }
function identities(guide:RustAuthoringGuide):Map<string,DraftComponentRecord> {
  const result=new Map<string,DraftComponentRecord>();
  function visit(items:DraftComponentRecord[],depth:number):void {
    if(depth>64)throw new Error('Option nesting exceeds 64 levels');
    for(const c of items) {
      if(typeof c.Guid!=='string'||!trim(c.Guid))throw new Error('Every component and option needs a Guid');
      if(result.has(key(c.Guid)))throw new Error('Duplicate component GUID: '+c.Guid);
      result.set(key(c.Guid),c);visit(components(c),depth+1);
    }
  }
  visit(guide.thisMod,0);return result;
}
export function normalizeRustAuthoringGuide(value:unknown):RustAuthoringGuide {
  const raw=structuredClone(record(value));
  if(!Array.isArray(raw.thisMod))throw new Error('Guide needs a component array');
  validateDraftReviewRecords(raw);
  return {...raw,thisMod:raw.thisMod.map((v)=>canonicalizeRustDraftComponent(record(v)))};
}
export function decodeRustAuthoringGuide(value:unknown):RustAuthoringGuide {
  const raw=structuredClone(record(value));
  if(!Array.isArray(raw.thisMod))throw new Error('Guide needs a component array');
  validateDraftReviewRecords(raw);
  return {...raw,thisMod:raw.thisMod.map((v)=>decodeRustAuthoringComponent(v))};
}
export function validateRustAuthoringGuide(guide:RustAuthoringGuide):void {
  if(!guide.thisMod.length)throw new Error('The guide has no components');
  validateDraftReviewRecords(guide);
  const ids=identities(guide), graph=new Map<string,Set<string>>([...ids.keys()].map((g)=>[g,new Set()]));
  for(const [id,c] of ids) {
    canonicalizeRustDraftComponent(c); // Reject unsupported identity forms without rewriting authored fields.
    if(typeof c.Name!=='string'||!trim(c.Name))throw new Error('Component '+c.Guid+' needs a Name');
    const refs=(field:string):string[]=>c[field] as string[];
    for(const ref of [...refs('Dependencies'),...refs('Restrictions'),...refs('InstallBefore'),...refs('InstallAfter')]) {
      if(!ids.has(key(ref)))throw new Error(c.Guid+' references missing component '+ref);
      if(id===key(ref))throw new Error(c.Guid+' references itself');
    }
    for(const ref of [...refs('Dependencies'),...refs('InstallAfter')])graph.get(id)!.add(key(ref));
    for(const ref of refs('InstallBefore'))graph.get(key(ref))!.add(id);
    for(const instruction of instructions(c)) {
      for(const ref of [...instruction.Dependencies as string[],...instruction.Restrictions as string[]])if(!ids.has(key(ref)))throw new Error('Instruction in '+c.Guid+' references missing component '+ref);
      if(typeof instruction.Action==='string'&&key(instruction.Action)==='choose')for(const ref of instruction.Source as string[])if(!components(c).some((o)=>key(o.Guid as string)===key(ref)))throw new Error('Choose in '+c.Guid+' references missing direct option '+ref);
    }
  }
  const done=new Set<string>();
  while(done.size<graph.size) { const next=[...graph].find(([id,required])=>!done.has(id)&&[...required].every((r)=>done.has(r)));if(!next)throw new Error('Dependency/order cycle in guide definitions');done.add(next[0]); }
}
function siblings(items:DraftComponentRecord[],guid:string,depth=0):{items:DraftComponentRecord[];index:number}|undefined {
  if(depth>64)throw new Error('Option nesting exceeds 64 levels');
  const index=items.findIndex((c)=>key(c.Guid as string)===key(guid));if(index>=0)return {items,index};
  for(const c of items){const found=siblings(components(c),guid,depth+1);if(found)return found;}return undefined;
}
function requireComponent(guide:RustAuthoringGuide,guid:string):DraftComponentRecord { const c=identities(guide).get(key(guid));if(!c)throw new Error('Unknown component GUID: '+guid);return c; }
function position(value:number,length:number,insertion=false):void { if(!Number.isSafeInteger(value)||value<0||(insertion?value>length:value>=length))throw new Error('Edit position is out of range'); }
function move<T>(items:T[],from:number,to:number):void {position(from,items.length);position(to,items.length);const [item]=items.splice(from,1);items.splice(to,0,item!);}
function apply(guide:RustAuthoringGuide,op:AuthoringEditOperation):void {
  switch(op.operation) {
    case 'resolveDraft':resolveDraft(requireComponent(guide,op.component),op.resolution);break;
    case 'insertComponent': {const items=op.parent===null?guide.thisMod:components(requireComponent(guide,op.parent));position(op.index,items.length,true);items.splice(op.index,0,decodeRustAuthoringComponent(op.component));break;}
    case 'replaceComponent': {
      const found=siblings(guide.thisMod,op.guid);if(!found)throw new Error('Unknown component GUID: '+op.guid);
      const old=found.items[found.index]!,replacement=decodeRustAuthoringComponent(op.component);
      if(has(old,'DraftReview')&&key(old.Guid as string)!==key(replacement.Guid as string))throw new Error('Generated draft identity cannot be changed by replacement; retain its provenance');
      function preserve(c:DraftComponentRecord):void { if(has(c,'DraftReview')&&!siblings([replacement],c.Guid as string))throw new Error('Replacement cannot discard a generated child identity; use an explicit remove operation');for(const option of components(c))preserve(option); }
      preserve(old);found.items[found.index]=replacement;break;
    }
    case 'removeComponent': {const found=siblings(guide.thisMod,op.guid);if(!found)throw new Error('Unknown component GUID: '+op.guid);found.items.splice(found.index,1);break;}
    case 'moveComponent': {const found=siblings(guide.thisMod,op.guid);if(!found)throw new Error('Unknown component GUID: '+op.guid);move(found.items,found.index,op.index);break;}
    case 'insertInstruction':case 'replaceInstruction': {
      const c=requireComponent(guide,op.component),items=instructions(c);position(op.index,items.length,op.operation==='insertInstruction');
      const normalized=[decodeRustAuthoringInstruction(op.instruction)];
      if(op.operation==='insertInstruction')items.splice(op.index,0,normalized[0]!);else items[op.index]=normalized[0]!;break;
    }
    case 'removeInstruction': {const items=instructions(requireComponent(guide,op.component));position(op.index,items.length);items.splice(op.index,1);break;}
    case 'moveInstruction':move(instructions(requireComponent(guide,op.component)),op.index,op.destination);break;
    case 'setResource':if(!trim(op.url))throw new Error('Resource URL cannot be empty');Object.defineProperty(record(requireComponent(guide,op.component).ResourceRegistry),op.url,{value:structuredClone(op.value),enumerable:true,writable:true,configurable:true});break;
    case 'removeResource': {const registry=record(requireComponent(guide,op.component).ResourceRegistry);if(!has(registry,op.url))throw new Error('Unknown resource URL: '+op.url);delete registry[op.url];break;}
    case 'setGuideMetadata':if(['thismod','components'].includes(key(op.key)))throw new Error('Reserved guide field: '+op.key);Object.defineProperty(guide,op.key,{value:structuredClone(op.value),enumerable:true,writable:true,configurable:true});break;
    case 'removeGuideMetadata':if(!has(guide,op.key)||op.key==='thisMod')throw new Error('Unknown guide metadata field: '+op.key);delete guide[op.key];break;
    default:throw new Error('Unsupported authoring edit operation');
  }
}
/** Input is never mutated; publish only this returned guide after successful whole-guide validation. */
export function applyAuthoringOperations(value:RustAuthoringGuide,operations:readonly AuthoringEditOperation[]):RustAuthoringGuide {
  const original=decodeRustAuthoringGuide(value);try{identities(original);}catch(e){throw new AuthoringEditError(null,'Input identities: '+(e as Error).message);}
  let edited=structuredClone(original);
  for(const [index,operation] of operations.entries()) {
    const before=structuredClone(edited);
    try {
      apply(edited,operation);
      invalidateDraftReviewTree(before.thisMod,original.thisMod,edited.thisMod,operation.operation==='resolveDraft'?operation.component:undefined);
      identities(edited);
    }catch(e){throw new AuthoringEditError(index,(e as Error).message);}
  }
  try{validateRustAuthoringGuide(edited);}catch(e){throw new AuthoringEditError(null,(e as Error).message);}
  return edited;
}

/** Mirror serde's tagged, deny-unknown-fields operation intake at the API boundary. */
export function readAuthoringOperations(value:unknown):AuthoringEditOperation[] {
  if(!Array.isArray(value)||value.length>4096)throw new Error('Provide at most 4096 authoring operations');
  const shapes:Record<string,string[]>={
    resolveDraft:['component','resolution'],insertComponent:['parent','index','component'],replaceComponent:['guid','component'],removeComponent:['guid'],moveComponent:['guid','index'],
    insertInstruction:['component','index','instruction'],replaceInstruction:['component','index','instruction'],removeInstruction:['component','index'],moveInstruction:['component','index','destination'],
    setResource:['component','url','value'],removeResource:['component','url'],setGuideMetadata:['key','value'],removeGuideMetadata:['key'],
  };
  return value.map((input,index)=> {
    try {
      const r=record(structuredClone(input));
      if(typeof r.operation!=='string'||!has(shapes,r.operation))throw new Error('Unsupported authoring edit operation');
      const shape=shapes[r.operation]!;
      if(r.operation==='insertComponent'&&!has(r,'parent'))r.parent=null;
      if(Object.keys(r).length!==shape.length+1||Object.keys(r).some((k)=>k!=='operation'&&!shape.includes(k)))throw new Error('Unknown or missing authoring operation field');
      for(const field of shape) {
        if(!has(r,field))throw new Error('Missing authoring operation field '+field);
        const v=r[field];
        if(['guid','url','key'].includes(field)||(field==='component'&&!['insertComponent','replaceComponent'].includes(r.operation))) {if(typeof v!=='string')throw new Error('Expected string '+field);}
        else if(['index','destination'].includes(field)){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new Error('Expected position '+field);}
        else if(field==='parent'){if(v!==null&&typeof v!=='string')throw new Error('Expected parent GUID or null');}
        else if(['component','instruction','resolution'].includes(field))record(v);
      }
      return r as unknown as AuthoringEditOperation;
    }catch(error){throw new AuthoringEditError(index,(error as Error).message);}
  });
}
