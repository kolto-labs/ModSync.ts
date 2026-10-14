import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { ACTION_TYPES } from '../types';
import { actions, getState, useAppState } from '../state/store';
import {newGuid} from './util';
import { BrowseSource } from './BrowseSource';
type RecordValue=Record<string,unknown>;
function record(value:unknown):value is RecordValue {return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function findComponent(value:unknown,guid:string,depth=0):RecordValue|undefined {
  if(depth>64||!Array.isArray(value))return undefined;
  for(const component of value){if(!record(component))continue;if(component.Guid===guid)return component;const child=findComponent(component.Options,guid,depth+1);if(child)return child;}
  return undefined;
}
// Raw JSON comparison keeps every unknown property and array position.
function rawSignature(value:unknown):string {
  const ordered=(input:unknown):unknown=>Array.isArray(input)?input.map(ordered):record(input)?Object.fromEntries(Object.keys(input).sort().map(key=>[key,ordered(input[key])])):input;
  return JSON.stringify(ordered(value));
}
// Browser-memory only: no autosave, eviction or session/game filesystem writes.
// Retain the original base signature so returning to a changed record conflicts.
const retainedCanonicalDrafts=new Map<string,{draft:RecordValue;base:string}>();
const retainedNewInstructionContexts=new Map<string,{instruction:RecordValue;insertAt:number;insertionBase:string}>();
const retainedNewInstructionProvenance=new Map<string,string[]>();
const detachedDrafts=new Set<string>(),detachedNewContexts=new Set<string>();
const recoveryGenerations=new Map<string,number>();
const memoryListeners=new Set<()=>void>();
let inventoryVersion=0,recoveryVersion=0;
function subscribeMemory(listener:()=>void){memoryListeners.add(listener);return ()=>{memoryListeners.delete(listener);};}
function publishMemory(recovery=false){inventoryVersion++;if(recovery)recoveryVersion++;for(const listener of memoryListeners)listener();}
function draftIdentity(key:string):{kind:string;directory:string;owner:string;guid:string}|undefined {
  try{const value:unknown=JSON.parse(key);if(!Array.isArray(value)||!value.every(item=>typeof item==='string'))return;
    if(value.length===3&&value[0]==='component')return {kind:value[0],directory:value[1],owner:value[2],guid:value[2]};
    if(value.length===4&&['instruction','new-instruction'].includes(value[0]))return {kind:value[0],directory:value[1],owner:value[2],guid:value[3]};
  }catch{return;}
}
function contextIdentity(key:string):{directory:string;owner:string}|undefined {
  try{const value:unknown=JSON.parse(key);if(Array.isArray(value)&&value.length===2&&value.every(item=>typeof item==='string'))return {directory:value[0],owner:value[1]};}catch{return;}
}
function matchingRecord(guide:unknown,identity:{kind:string;owner:string;guid:string}):RecordValue|undefined {
  const owner=record(guide)?findComponent(guide.thisMod,identity.owner):undefined;
  if(!owner)return;
  if(identity.kind==='component'||identity.kind==='new-instruction')return owner;
  return Array.isArray(owner.Instructions)?owner.Instructions.find((value):value is RecordValue=>record(value)&&value.Guid===identity.guid):undefined;
}
function DraftRecovery({guide,directory,busy}:{guide:unknown;directory:string;busy:boolean}) {
  const version=useSyncExternalStore(subscribeMemory,()=>inventoryVersion,()=>inventoryVersion);
  useLayoutEffect(()=>{
    let changed=false;
    for(const key of retainedCanonicalDrafts.keys()){
      const identity=draftIdentity(key);if(!identity||identity.directory!==directory||identity.kind==='new-instruction')continue;
      if(!matchingRecord(guide,identity)&&!detachedDrafts.has(key)){detachedDrafts.add(key);changed=true;}
    }
    for(const key of retainedNewInstructionContexts.keys()){
      const identity=contextIdentity(key);if(!identity||identity.directory!==directory)continue;
      if(!(record(guide)&&findComponent(guide.thisMod,identity.owner))&&!detachedNewContexts.has(key)){detachedNewContexts.add(key);changed=true;}
    }
    if(changed)publishMemory(true);
  },[guide,directory,version]);
  const entries:{key:string;kind:string;owner:string;guid:string;draft:RecordValue;canRestore:boolean;context:boolean;provenance:string[]}[]=[];
  for(const key of detachedDrafts){const identity=draftIdentity(key),entry=retainedCanonicalDrafts.get(key);if(identity?.directory===directory&&entry)entries.push({key,kind:identity.kind,owner:identity.owner,guid:identity.guid,draft:entry.draft,canRestore:Boolean(matchingRecord(guide,identity)),context:false,provenance:[]});}
  for(const key of detachedNewContexts){const identity=contextIdentity(key),entry=retainedNewInstructionContexts.get(key);if(identity?.directory!==directory||!entry)continue;
    const bodyKey=JSON.stringify(['new-instruction',directory,identity.owner,entry.instruction.Guid]);
    entries.push({key,kind:'new instruction',owner:identity.owner,guid:String(entry.instruction.Guid),draft:retainedCanonicalDrafts.get(bodyKey)?.draft??entry.instruction,canRestore:Boolean(record(guide)&&findComponent(guide.thisMod,identity.owner)),context:true,provenance:retainedNewInstructionProvenance.get(bodyKey)??[]});
  }
  if(!entries.length)return null;
  const discard=(entry:typeof entries[number])=>{
    if(busy||getState().authoringBusy||getState().authoringSession?.directory!==directory||(entry.context?!detachedNewContexts.has(entry.key):!detachedDrafts.has(entry.key)))return;
    if(entry.context){retainedNewInstructionContexts.delete(entry.key);detachedNewContexts.delete(entry.key);recoveryGenerations.set(entry.key,(recoveryGenerations.get(entry.key)??0)+1);const bodyKey=JSON.stringify(['new-instruction',directory,entry.owner,entry.guid]);retainedCanonicalDrafts.delete(bodyKey);retainedNewInstructionProvenance.delete(bodyKey);}
    else {retainedCanonicalDrafts.delete(entry.key);detachedDrafts.delete(entry.key);}
    publishMemory(true);
  };
  const restore=(entry:typeof entries[number])=>{
    if(busy||!entry.canRestore||(entry.context?!detachedNewContexts.has(entry.key):!detachedDrafts.has(entry.key)))return;
    // Recheck current canonical state at the click boundary; never write it.
    const live=getState();if(live.authoringBusy||live.authoringSession?.directory!==directory)return;
    const identity={kind:entry.context?'new-instruction':entry.kind,owner:entry.owner,guid:entry.guid};
    if(!matchingRecord(live.file?.rustAuthoringGuide,identity))return;
    if(entry.context)detachedNewContexts.delete(entry.key);else detachedDrafts.delete(entry.key);
    recoveryGenerations.set(entry.key,(recoveryGenerations.get(entry.key)??0)+1);publishMemory(true);
  };
  return <section className="panel" aria-label="Removed-record draft recovery"><h3>Retained drafts from removed records</h3>
    <p className="muted">These browser-memory drafts never reattach automatically. Restore only loads the local editor when the exact saved owner and GUID exist again; it does not save or recreate a record. Reloading the browser clears this memory.</p>
    {entries.map(entry=><details className="authoring-instruction" key={entry.key}><summary>{entry.kind} · {String(entry.draft.Name??entry.draft.Action??'Draft')} · {entry.guid}</summary>
      <p className="mono">Owner {entry.owner}</p><textarea aria-label={`Retained raw draft ${entry.guid}`} className="mono" rows={8} readOnly value={JSON.stringify(entry.draft,null,2)}/>
      {entry.provenance.length>0&&<ul>{entry.provenance.map((value,index)=><li key={index}><code>{value}</code></li>)}</ul>}
      {!entry.canRestore&&<p className="muted">The exact canonical identity is unavailable. The raw draft remains retained for inspection.</p>}
      <button type="button" className="btn" disabled={busy||!entry.canRestore} onClick={()=>restore(entry)}>Restore local draft {entry.guid}</button>
      <button type="button" className="btn" disabled={busy} onClick={()=>discard(entry)}>Discard retained draft {entry.guid}</button>
    </details>)}
  </section>;
}
function useCanonicalDraft(canonical:RecordValue,draftKey?:string) {
  useSyncExternalStore(subscribeMemory,()=>recoveryVersion,()=>recoveryVersion);
  const generation=draftKey?recoveryGenerations.get(draftKey)??0:0;
  const [mountedGeneration]=useState(generation);
  const quarantined=Boolean(draftKey&&detachedDrafts.has(draftKey))||generation!==mountedGeneration;
  const signature=rawSignature(canonical);
  const [draft,setDraft]=useState<RecordValue>(()=>structuredClone(draftKey&&!detachedDrafts.has(draftKey)?retainedCanonicalDrafts.get(draftKey)?.draft??canonical:canonical));
  const [base,setBase]=useState(()=>draftKey&&!detachedDrafts.has(draftKey)?retainedCanonicalDrafts.get(draftKey)?.base??signature:signature);
  const draftSignature=rawSignature(draft);
  const dirty=draftSignature!==base;
  const recordChanged=signature!==base;
  const stale=recordChanged||quarantined;
  const conflict=recordChanged&&draftSignature!==base&&draftSignature!==signature;
  useEffect(()=>{
    if(recordChanged&&!conflict&&!quarantined){setDraft(structuredClone(canonical));setBase(signature);}
  },[canonical,signature,recordChanged,conflict,quarantined]);
  useLayoutEffect(()=>{
    if(!draftKey||quarantined)return;
    const prior=retainedCanonicalDrafts.get(draftKey);
    if(dirty){if(prior?.base!==base||rawSignature(prior.draft)!==draftSignature){retainedCanonicalDrafts.set(draftKey,{draft:structuredClone(draft),base});publishMemory();}}
    else if(retainedCanonicalDrafts.delete(draftKey))publishMemory();
  },[draftKey,draft,base,dirty,draftSignature,quarantined]);
  const reload=()=>{
    if(quarantined)return;
    if(draftKey&&retainedCanonicalDrafts.delete(draftKey))publishMemory();
    setDraft(structuredClone(canonical));setBase(signature);
  };
  return {draft,setDraft,dirty,stale,conflict,quarantined,reload};
}
function revisionIsCurrent(rendered:ReturnType<typeof useAppState>):boolean {
  const current=getState();
  return !current.authoringBusy&&current.authoringBackend==='rust-cli'&&Boolean(rendered.authoringSession)&&current.authoringSession?.directory===rendered.authoringSession?.directory&&current.authoringSession?.revisionId===rendered.authoringSession?.revisionId;
}
type ComponentChoice={guid:string;label:string};
function componentChoices(value:unknown,ancestry:string[]=[],depth=0):ComponentChoice[] {
  if(depth>64||!Array.isArray(value))return [];
  return value.flatMap(component=>{
    if(!record(component))return [];
    const name=typeof component.Name==='string'?component.Name:'Unnamed component';
    const path=[...ancestry,name];
    const own=typeof component.Guid==='string'?[{guid:component.Guid,label:`${path.join(' / ')} · ${component.Guid}`}]:[];
    return [...own,...componentChoices(component.Options,path,depth+1)];
  });
}
function guidIdentity(value:string){return value.replace(/[A-Z]/g,character=>character.toLowerCase());}
function selectionLabel(value:unknown){return value===true?'selected':value===false||value===undefined?'not selected':`legacy selection value: ${JSON.stringify(value)}`;}
function ComponentReferences({field,draft,choices,onChange}:{field:string;draft:RecordValue;choices:ComponentChoice[];onChange:(value:string[])=>void}) {
  const raw=draft[field];
  const valid=raw===undefined||raw===null||typeof raw==='string'||Array.isArray(raw)&&raw.every(value=>typeof value==='string');
  const refs=typeof raw==='string'?[raw]:valid&&Array.isArray(raw)?raw as string[]:[];
  const available=choices.filter(choice=>!refs.some(ref=>guidIdentity(ref)===guidIdentity(choice.guid)));
  return <fieldset className="authoring-instruction"><legend>{field}</legend>
    {!valid?<p role="alert">This field has an unsupported saved value. It is preserved; reference editing is unavailable.</p>:<>
      {(typeof raw==='string'||raw===null)&&<p className="muted">Legacy {raw===null?'null':'single-reference'} representation is retained. Adding or removing a reference explicitly replaces this field with an array.</p>}
      {refs.length===0?<p className="muted">No references</p>:<ol>{refs.map((ref,index)=>{
        const choice=choices.find(item=>guidIdentity(item.guid)===guidIdentity(ref));
        return <li key={`${index}:${ref}`}><span>{choice?.label??`Unavailable target · ${ref}`}</span><button type="button" className="btn btn-sm" aria-label={`Remove ${field} reference ${ref}`} onClick={()=>onChange(refs.filter((_,position)=>position!==index))}>Remove</button></li>;
      })}</ol>}
      <label>Add {field} reference<select aria-label={`Add ${field} reference`} value="" onChange={event=>{const choice=available.find(item=>item.guid===event.target.value);if(choice)onChange([...refs,choice.guid]);}}>
        <option value="">Choose component…</option>{available.map(choice=><option key={choice.guid} value={choice.guid}>{choice.label}</option>)}
      </select></label>
    </>}
  </fieldset>;
}
function ComponentEdit({component,components}:{component:RecordValue;components:unknown}) {
  const state=useAppState();
  const draftKey=state.authoringSession?JSON.stringify(['component',state.authoringSession.directory,component.Guid]):undefined;
  const {draft,setDraft,dirty,stale,conflict,quarantined,reload}=useCanonicalDraft(component,draftKey);
  const [localEditing,setLocalEditing]=useState(dirty);
  const malformedConstraints=(['Dependencies','Restrictions','InstallAfter','InstallBefore'] as const).filter(key=>draft[key]!==undefined&&draft[key]!==null&&typeof draft[key]!=='string'&&(!Array.isArray(draft[key])||!(draft[key] as unknown[]).every(value=>typeof value==='string')));
  const unsupportedText=(['Name','Author','Description','Directions','Tier'] as const).filter(key=>draft[key]!==undefined&&typeof draft[key]!=='string');
  const validSelection=draft.IsSelected===undefined||typeof draft.IsSelected==='boolean';
  const tierPresets=['1 - Essential','2 - Recommended','3 - Suggested','4 - Optional'];
  const category=draft.Category;
  const validCategory=category===undefined||category===null||typeof category==='string'||Array.isArray(category)&&category.every(value=>typeof value==='string');
  const categories=typeof category==='string'?[category]:Array.isArray(category)?category.filter((value):value is string=>typeof value==='string'):[];
  const categorySuggestions=Array.isArray(components)?[...new Set(components.filter(record).flatMap(component=>typeof component.Category==='string'?[component.Category]:Array.isArray(component.Category)?component.Category.filter((value):value is string=>typeof value==='string'):[]).filter(value=>value.length>0))].filter(value=>!categories.includes(value)):[];
  const canPersist=state.authoringBackend==='rust-cli'&&Boolean(state.authoringSession)&&!state.authoringBusy&&!stale&&validCategory&&validSelection&&unsupportedText.length===0&&malformedConstraints.length===0;
  const choices=componentChoices(components).filter(choice=>typeof component.Guid!=='string'||guidIdentity(choice.guid)!==guidIdentity(component.Guid));
  const editable=localEditing&&!state.authoringBusy&&!quarantined;
  return <details className="authoring-instruction"><summary>Component details, selection and constraints</summary>
    {quarantined&&<p role="alert">A retained removed-record draft requires explicit restore or discard in the recovery panel before editing.</p>}
    {dirty&&draftKey&&<p role="status">Unsaved component draft retained in this browser session. Save a revision to preserve it across a browser reload.</p>}
    {conflict&&<p role="alert">The saved component changed while this local draft was being edited. Save is blocked; discard local changes to reload the saved component.</p>}
    {!localEditing&&<button type="button" className="btn" disabled={state.authoringBusy||quarantined} onClick={()=>setLocalEditing(true)}>Edit local component draft</button>}
    <fieldset disabled={!editable}>
      {unsupportedText.length>0&&<section aria-label="Legacy component text fields"><p role="alert">This editor cannot safely interpret the saved representation of {unsupportedText.join(', ')}. Raw values are retained; Save is blocked until these text fields are explicitly replaced. Backend legacy conversions are not inferred here.</p><details><summary>Raw component text fields</summary><pre className="mono">{JSON.stringify(Object.fromEntries(unsupportedText.map(key=>[key,draft[key]])),null,2)}</pre></details></section>}
      {(['Name','Author','Description','Directions','Tier'] as const).map(key=><label key={key}>{key}<textarea aria-label={`Component ${key}`} rows={key==='Description'||key==='Directions'?3:1} value={typeof draft[key]==='string'?draft[key] as string:''} onChange={event=>setDraft(previous=>({...previous,[key]:event.target.value}))}/></label>)}
      <label>Set tier from reference presets<select aria-label="Set component tier from reference presets" value="" onChange={event=>{const value=event.target.value;if(tierPresets.includes(value))setDraft(previous=>({...previous,Tier:value}));}}><option value="">Choose tier…</option>{tierPresets.map(tier=><option key={tier} value={tier}>{tier}</option>)}</select></label>
      <p className="muted">Choosing a preset explicitly replaces Tier in this local draft. Existing custom tier text is retained until you edit it or choose a preset.</p>
      <label>Categories (one per line)<textarea aria-label="Component categories" rows={Math.max(2,Math.min(6,categories.length))} value={categories.join('\n')} onChange={event=>setDraft(previous=>({...previous,Category:event.target.value.split('\n').filter(Boolean)}))}/></label>
      <p className="muted">Category order and spelling are retained. Editing this field explicitly replaces its saved representation with a string array.</p>
      <label>Add a category used in this guide<select aria-label="Add guide category" value="" disabled={!validCategory} onChange={event=>{const value=event.target.value;if(validCategory&&categorySuggestions.includes(value))setDraft(previous=>{const raw=previous.Category;const entries=typeof raw==='string'?[raw]:raw===undefined||raw===null?[]:Array.isArray(raw)&&raw.every(item=>typeof item==='string')?raw:undefined;if(!entries||entries.includes(value))return previous;return {...previous,Category:[...entries,value]};});}}><option value="">Choose saved category…</option>{categorySuggestions.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
      <p className="muted">Choosing a suggestion appends its exact label. Case variants remain separate; existing categories retain their spelling and order. Add custom categories in the text field above.</p>
      {!validCategory&&<section><p role="alert">Unsupported category data is retained; Save is blocked until Category is explicitly replaced. The text field shows only string entries.</p><details><summary>Raw category data</summary><pre className="mono">{JSON.stringify(category,null,2)}</pre></details></section>}
      {validSelection?<label><input type="checkbox" checked={draft.IsSelected===true} onChange={event=>setDraft(previous=>({...previous,IsSelected:event.target.checked}))}/>Selected for installation</label>:<section aria-label="Legacy installation selection"><p role="alert">IsSelected is retained in a legacy representation. This editor does not infer the engine's conversion; Save is blocked until selection is explicitly replaced.</p><pre className="mono">{JSON.stringify(draft.IsSelected,null,2)}</pre><div className="row"><button type="button" className="btn btn-sm" onClick={()=>setDraft(previous=>({...previous,IsSelected:true}))}>Replace with selected</button><button type="button" className="btn btn-sm" onClick={()=>setDraft(previous=>({...previous,IsSelected:false}))}>Replace with not selected</button></div></section>}
      {malformedConstraints.length>0&&<section aria-label="Unsupported component constraint data"><p role="alert">Unsupported saved constraint data is retained. Save is blocked until each listed field is explicitly replaced.</p>{malformedConstraints.map(field=><details key={field}><summary>Raw {field}</summary><pre className="mono">{JSON.stringify(draft[field],null,2)}</pre><button type="button" className="btn btn-sm" onClick={()=>setDraft(previous=>({...previous,[field]:[]}))}>Replace {field} with an empty reference list</button><p className="muted">This explicitly removes the displayed raw value from the local draft. The saved component changes only when you save a revision.</p></details>)}</section>}
      {(['Dependencies','Restrictions','InstallAfter','InstallBefore'] as const).map(field=><ComponentReferences key={field} field={field} draft={draft} choices={choices} onChange={value=>setDraft(previous=>({...previous,[field]:value}))}/>)}
      <p className="muted">References retain their saved order and identity. Nested option ordering is not yet supported by independent TypeScript prediction.</p>
      <button type="button" className="btn btn-primary" disabled={!canPersist} onClick={()=>{if(canPersist&&revisionIsCurrent(state))void actions.persistAuthoringSession({operation:'edit',label:'Edit component details and constraints',operations:[{operation:'replaceComponent',guid:component.Guid,component:draft}]});}}>Save component revision</button>
    </fieldset>
    {localEditing&&<><p className="muted">Local changes remain in this draft until saved through the configured Rust backend.</p><button type="button" className="btn" disabled={state.authoringBusy||quarantined} onClick={()=>{reload();setLocalEditing(false);}}>Discard local component changes</button></>}
  </details>;
}
function InstructionEdit({componentGuid,index,instruction,newInstruction=false,insertionChanged=false,options,onCancel,onSaved}:{componentGuid:string;index:number;instruction:RecordValue;newInstruction?:boolean;insertionChanged?:boolean;options:unknown;onCancel?:()=>void;onSaved?:()=>void}) {
  const state=useAppState();
  const draftKey=state.authoringSession?JSON.stringify([newInstruction?'new-instruction':'instruction',state.authoringSession.directory,componentGuid,instruction.Guid]):undefined;
  const [browse,setBrowse]=useState(false),[provenance,setProvenance]=useState<string[]>(()=>newInstruction&&draftKey?[...retainedNewInstructionProvenance.get(draftKey)??[]]:[]);
  useLayoutEffect(()=>{if(newInstruction&&draftKey){retainedNewInstructionProvenance.set(draftKey,[...provenance]);publishMemory();}},[newInstruction,draftKey,provenance]);
  const {draft,setDraft,dirty,stale,conflict,quarantined,reload}=useCanonicalDraft(instruction,draftKey);
  const canPersist=state.authoringBackend==='rust-cli'&&Boolean(state.authoringSession)&&!state.authoringBusy;
  const editable=(newInstruction||canPersist)&&!state.authoringBusy&&!quarantined;
  const savedOwner=state.file?.rustAuthoringGuide?findComponent(state.file.rustAuthoringGuide.thisMod,componentGuid):undefined;
  const savedList=savedOwner&&savedOwner.Instructions===undefined?[]:savedOwner?.Instructions;
  const listMapped=Array.isArray(savedList)&&savedList.every(record)&&Number.isInteger(index)&&index>=0&&(newInstruction?index<=savedList.length:typeof instruction.Guid==='string'&&savedList[index]?.Guid===instruction.Guid);
  const mutationAllowed=canPersist&&!stale&&!insertionChanged&&listMapped;
  const instructionTargetIsCurrent=()=>{
    if(!mutationAllowed||!revisionIsCurrent(state))return false;
    const liveGuide=getState().file?.rustAuthoringGuide;
    const liveOwner=liveGuide?findComponent(liveGuide.thisMod,componentGuid):undefined;
    const liveList=liveOwner&&liveOwner.Instructions===undefined?[]:liveOwner?.Instructions;
    return Array.isArray(liveList)&&liveList.every(record)&&rawSignature(liveList)===rawSignature(savedList)&&(newInstruction?index<=liveList.length:liveList[index]?.Guid===instruction.Guid);
  };
  // The saved-session API does not expose Rust's allow_processes/runner capability.
  // Fail closed rather than treat a local checkbox or guide metadata as execution trust.
  const externalProgramsTrusted=false;
  const action=typeof draft.Action==='string'?draft.Action:'';
  const knownAction=ACTION_TYPES.some(candidate=>candidate===action)&&action!=='Unset';
  const malformedLists=(['Source','Dependencies','Restrictions'] as const).filter(key=>draft[key]!==undefined&&draft[key]!==null&&typeof draft[key]!=='string'&&(!Array.isArray(draft[key])||!(draft[key] as unknown[]).every(value=>typeof value==='string')));
  const unsupportedFields=(['Destination','Arguments'] as const).filter(key=>draft[key]!==undefined&&typeof draft[key]!=='string');
  const unsupportedOverwrite=draft.Overwrite!==undefined&&typeof draft.Overwrite!=='boolean';
  const externalAction=action==='Execute'||action==='Run';
  const optionChoices:ComponentChoice[]=Array.isArray(options)?options.filter(record).filter(option=>typeof option.Guid==='string').map(option=>({guid:option.Guid as string,label:`${typeof option.Name==='string'?option.Name:'Unnamed option'} · ${option.Guid} · ${selectionLabel(option.IsSelected)}`})):[];
  const chooseRefs=typeof draft.Source==='string'?[draft.Source]:Array.isArray(draft.Source)?draft.Source:draft.Source===undefined||draft.Source===null?[]:undefined;
  const validChoose=action!=='Choose'||(chooseRefs!==undefined&&chooseRefs.every(ref=>typeof ref==='string'&&optionChoices.some(option=>guidIdentity(option.guid)===guidIdentity(ref))));
  const validDirectory=action!=='CreateDirectory'||(Array.isArray(draft.Source)&&draft.Source.length===0&&(draft.Arguments===undefined||draft.Arguments==='')&&typeof draft.Destination==='string'&&draft.Destination.trim().length>0);
  const recordAllowed=mutationAllowed&&knownAction&&malformedLists.length===0&&unsupportedFields.length===0&&!unsupportedOverwrite&&validDirectory&&validChoose&&(!externalAction||externalProgramsTrusted);
  const source=typeof draft.Source==='string'?[draft.Source]:Array.isArray(draft.Source)?draft.Source.filter((path):path is string=>typeof path==='string'):[];
  const text=(key:string)=>typeof draft[key]==='string'?draft[key] as string:'';
  const set=(key:string,value:unknown)=>setDraft(previous=>({...previous,[key]:value}));

  const moveAllowed=!newInstruction&&!dirty&&mutationAllowed&&Array.isArray(savedList)&&savedList.every(record)&&typeof instruction.Guid==='string'&&savedList[index]?.Guid===instruction.Guid;
  const moveInstruction=(destination:number)=>{
    if(!moveAllowed||!revisionIsCurrent(state))return;
    const liveGuide=getState().file?.rustAuthoringGuide;
    const liveOwner=liveGuide?findComponent(liveGuide.thisMod,componentGuid):undefined;
    const liveList=liveOwner&&liveOwner.Instructions===undefined?[]:liveOwner?.Instructions;
    if(!Array.isArray(liveList)||!liveList.every(record)||liveList[index]?.Guid!==instruction.Guid||rawSignature(liveList)!==rawSignature(savedList)||destination<0||destination>=liveList.length)return;
    void actions.persistAuthoringSession({operation:'edit',label:`Move instruction ${index+1} to ${destination+1}`,operations:[{operation:'moveInstruction',component:componentGuid,index,destination}]});
  };
  const save=async()=>{if(!recordAllowed||!instructionTargetIsCurrent())return;const saved=await actions.persistAuthoringSession({operation:'edit',label:`${newInstruction?'Add':'Edit'} instruction ${index+1}`,operations:[{operation:newInstruction?'insertInstruction':'replaceInstruction',component:componentGuid,index,instruction:draft}]});if(saved&&newInstruction)onSaved?.();};
  return <section className="authoring-instruction" aria-label={`Authoring instruction ${index+1}`}>
    <div className="row"><strong>{newInstruction?'New instruction · position ':''}{index+1}. {text('Action')}</strong><span className="muted mono small">{text('Guid')}</span></div>
    {!newInstruction&&<div className="row"><button type="button" className="btn btn-sm" disabled={!moveAllowed||index===0} onClick={()=>moveInstruction(index-1)}>Move instruction up</button><button type="button" className="btn btn-sm" disabled={!moveAllowed||!Array.isArray(savedList)||index>=savedList.length-1} onClick={()=>moveInstruction(index+1)}>Move instruction down</button>{dirty&&<span className="muted">Save or discard this local draft before changing its order.</span>}</div>}
    {quarantined&&<p role="alert">A retained removed-record draft requires explicit restore or discard in the recovery panel before editing.</p>}
    {dirty&&draftKey&&<p role="status">Unsaved instruction draft retained in this browser session. Save a revision to preserve it across a browser reload.</p>}
    {conflict&&<p role="alert">The saved instruction changed while this local draft was being edited. Save and removal are blocked until the draft is discarded.</p>}
    {insertionChanged&&<p role="alert">The saved instruction list changed. Confirm the insertion point against the current list before inserting this draft.</p>}
    {!listMapped&&<section><p role="alert">This draft cannot be mapped to the complete saved instruction list at its exact position. Saving, removal and reordering are blocked; the original records are retained.</p><details><summary>Raw saved instruction list</summary><pre className="mono">{JSON.stringify(savedList,null,2)??'Missing instruction list'}</pre></details></section>}
    <fieldset disabled={!editable} style={{border:0,padding:0}}>
      <label>Action<select aria-label="Action" value={text('Action')} onChange={event=>{const next=event.target.value;if((next==='Execute'||next==='Run')&&!externalProgramsTrusted)return;if(next==='Choose'||next==='DelDuplicate')setBrowse(false);set('Action',next);}}>{!ACTION_TYPES.some(candidate=>candidate===action)&&<option value={action}>Unsupported action: {typeof draft.Action==='string'?draft.Action:JSON.stringify(draft.Action)??'missing'}</option>}{ACTION_TYPES.map(action=><option key={action} value={action} disabled={(action==='Execute'||action==='Run')&&!externalProgramsTrusted}>{action}</option>)}</select></label>
      {!knownAction&&<section aria-label="Unsupported instruction"><p role="alert">This action has no supported execution semantics. Its original value and metadata are retained. Saving is blocked until a supported action is explicitly selected; removal and discard remain available.</p><details><summary>Raw instruction record</summary><pre className="mono">{JSON.stringify(draft,null,2)}</pre></details></section>}
      {malformedLists.length>0&&<section aria-label="Unsupported instruction lists"><p role="alert">Unsupported list data in {malformedLists.join(', ')} is retained unchanged. Saving is blocked until these fields are explicitly replaced with string entries. The text controls show only string entries; inspect the complete record before replacing a field.</p><details><summary>Raw instruction list data</summary><pre className="mono">{JSON.stringify(draft,null,2)}</pre></details></section>}
      {(unsupportedFields.length>0||unsupportedOverwrite)&&<section aria-label="Unsupported instruction field shapes"><p role="alert">This editor cannot safely interpret {([...unsupportedFields,...(unsupportedOverwrite?['Overwrite']:[])]).join(', ')} in its saved representation. Raw values are retained; Save is blocked until each field is explicitly replaced. Legacy Overwrite conversions supported by the engine are not inferred here.</p><details><summary>Raw instruction field data</summary><pre className="mono">{JSON.stringify(draft,null,2)}</pre></details></section>}
      <p className="muted">Execute and Run require explicit external-program trust from the runtime backend. That capability is unavailable in this editor, so choosing or saving those actions is disabled.</p>
      {externalAction&&<p role="status">Prediction never starts this program; it only validates its source and reports unknown file effects. Destination is not used. Independent TypeScript physical execution remains unavailable.</p>}
      {action==='CreateDirectory'&&<p role="status">CreateDirectory needs empty Source and Arguments and a child Destination whose parent already exists. Prediction projects the directory virtually; independent TypeScript physical creation remains unavailable.</p>}
      {!validDirectory&&<p role="alert">Folder action cannot be saved until Source and Arguments are empty and Destination is supplied. Existing paths, roots, spelling and symlinks are validated by the engine.</p>}
      {action==='Choose'?<section aria-label="Choose direct options">
        <p className="muted">Choose sources are direct option GUIDs, not file paths. This instruction executes its saved selected options at this point in the build, in option-list order. Adding a reference does not change an option's installation selection.</p>
        <ComponentReferences field="Source" draft={draft} choices={optionChoices} onChange={value=>set('Source',value)}/>
        {!validChoose&&<p role="alert">One or more saved sources are not direct options of this component. Their identities are preserved; remove unavailable references before saving.</p>}
      </section>:<>      <label>{action==='CreateDirectory'?'Source paths (must be empty)':action==='DelDuplicate'?'Candidate extensions (one per line)':'Source paths'}<textarea aria-label={action==='DelDuplicate'?'Candidate extensions':'Source paths'} className="mono" rows={Math.max(2,Math.min(6,source.length))} value={source.join('\n')} onChange={event=>set('Source',event.target.value.split('\n').filter(Boolean))}/></label>
      {action!=='DelDuplicate'&&<button className="btn btn-sm" onClick={()=>setBrowse(true)}>Browse instruction source…</button>}
      </>}
      <label>{externalAction?'Destination (not used by Execute/Run)':action==='CreateDirectory'?'New child directory path':'Destination'}<input aria-label="Destination" className="mono" value={text('Destination')} onChange={event=>set('Destination',event.target.value)}/></label>
      <label>{externalAction?'Program arguments':action==='CreateDirectory'?'Arguments (must be empty)':action==='DelDuplicate'?'Duplicate extension to delete':action==='Patcher'?'Namespace index or INI filename':'Arguments'}<input aria-label="Arguments" className="mono" value={text('Arguments')} onChange={event=>set('Arguments',event.target.value)}/></label>
      {action==='DelDuplicate'&&<p className="muted">Source contains candidate extensions, such as .dds, .tpc and .tga, rather than file paths. Empty Source uses those three defaults. Arguments specifies the extension to delete when names duplicate; empty Arguments targets extensionless candidates. Destination is the directory to inspect.</p>}
      {action==='Patcher'&&<p className="muted">Arguments accepts a zero-based namespace index, an INI filename within tslpatchdata, or an empty value for the default. Enter the filename directly, including spaces; do not add command-line quotes. Configuration and namespace bounds are checked by the engine.</p>}
      {unsupportedOverwrite?<div className="row"><span>Overwrite: <code>{JSON.stringify(draft.Overwrite)}</code></span><button type="button" className="btn btn-sm" onClick={()=>set('Overwrite',true)}>Replace with true</button><button type="button" className="btn btn-sm" onClick={()=>set('Overwrite',false)}>Replace with false</button></div>:<label><input type="checkbox" checked={draft.Overwrite===undefined||draft.Overwrite===true} onChange={event=>set('Overwrite',event.target.checked)}/>Overwrite</label>}
      {(['Dependencies','Restrictions'] as const).map(key=>draft[key]===undefined||draft[key]===null||typeof draft[key]==='string'||Array.isArray(draft[key])&&(draft[key] as unknown[]).every(value=>typeof value==='string')?<ComponentReferences key={key} field={key} draft={draft} choices={componentChoices(state.file?.rustAuthoringGuide?.thisMod)} onChange={value=>set(key,value)}/>:<label key={key}>{key} (legacy representation; editing replaces this field)<textarea aria-label={key} className="mono" rows={2} value={(typeof draft[key]==='string'?[draft[key] as string]:Array.isArray(draft[key])?(draft[key] as unknown[]).filter((value):value is string=>typeof value==='string'):[]).join('\n')} onChange={event=>set(key,event.target.value.split('\n').filter(Boolean))}/></label>)}
      <div className="row"><button className="btn btn-primary" disabled={!recordAllowed} onClick={()=>void save()}>{newInstruction?"Insert instruction revision":"Save instruction revision"}</button>{newInstruction?<button className="btn" onClick={onCancel}>Discard local instruction</button>:<button className="btn" disabled={!mutationAllowed} onClick={()=>{if(instructionTargetIsCurrent())void actions.persistAuthoringSession({operation:'edit',label:`Remove instruction ${index+1}`,operations:[{operation:'removeInstruction',component:componentGuid,index}]});}}>Remove instruction</button>}</div>
    </fieldset>
    {!newInstruction&&<button type="button" className="btn" disabled={state.authoringBusy||quarantined} onClick={()=>{reload();setProvenance([]);setBrowse(false);}}>Discard local instruction changes and reload</button>}
    {provenance.length>0&&<details><summary>Source selection provenance</summary><ul>{provenance.map(path=><li key={path}><code>{path}</code></li>)}</ul></details>}
    {!editable&&action!=='Choose'&&action!=='DelDuplicate'&&<button className="btn btn-sm" onClick={()=>setBrowse(true)}>Inspect instruction sources…</button>}
    {browse&&action!=='Choose'&&action!=='DelDuplicate'&&<BrowseSource onDraft={editable?(action,paths,origins)=>{setDraft(previous=>({...previous,Action:action,Source:action==='CreateDirectory'?[]:paths,Arguments:action==='CreateDirectory'?'':previous.Arguments,Destination:action==='CreateDirectory'?paths[0]:action==='Delete'?'':action==='Rename'?paths[0].split(/[\\/]/).pop()??'':previous.Destination}));setProvenance(origins);setBrowse(false);}:undefined} inspectOnly={!editable} onClose={()=>setBrowse(false)} onInsert={(paths,origins)=>{if(editable){set('Source',[...source,...paths]);setProvenance(previous=>[...new Set([...previous,...origins??paths])]);setBrowse(false);}}}/>}
  </section>;
}
export function RustInstructionBuilder({componentGuid,optionDepth=0,ownerNames=[]}:{componentGuid?:string;optionDepth?:number;ownerNames?:string[]}) {
  const state=useAppState(),guide=state.file?.rustAuthoringGuide;
  const sessionIdentity=state.authoringSession?.directory??'loaded';
  const contextKey=state.authoringSession&&componentGuid?JSON.stringify([state.authoringSession.directory,componentGuid]):undefined;
  useSyncExternalStore(subscribeMemory,()=>recoveryVersion,()=>recoveryVersion);
  const contextGeneration=contextKey?recoveryGenerations.get(contextKey)??0:0;
  const [mountedContextGeneration,setMountedContextGeneration]=useState(contextGeneration);
  const initialContext=contextKey&&!detachedNewContexts.has(contextKey)?retainedNewInstructionContexts.get(contextKey):undefined;
  const [newInstruction,setNewInstruction]=useState<RecordValue|null>(()=>initialContext?structuredClone(initialContext.instruction):null),[insertAt,setInsertAt]=useState(initialContext?.insertAt??0),[insertionBase,setInsertionBase]=useState(initialContext?.insertionBase??''),[newDraftIdentity,setNewDraftIdentity]=useState(initialContext?`${sessionIdentity}:${componentGuid}`:'');
  const [mountedOptions,setMountedOptions]=useState<Set<string>>(()=>new Set());
  const component=guide&&componentGuid?findComponent(guide.thisMod,componentGuid):undefined;
  const instructions=component&&Array.isArray(component.Instructions)?component.Instructions.filter(record):[];
  const instructionSignature=rawSignature(instructions);
  useLayoutEffect(()=>{
    const retained=contextKey&&!detachedNewContexts.has(contextKey)?retainedNewInstructionContexts.get(contextKey):undefined;
    setNewInstruction(retained?structuredClone(retained.instruction):null);
    setInsertAt(retained?.insertAt??0);setInsertionBase(retained?.insertionBase??'');
    setNewDraftIdentity(`${sessionIdentity}:${componentGuid}`);setMountedContextGeneration(contextGeneration);
  },[contextKey,componentGuid,sessionIdentity,contextGeneration]);
  useEffect(()=>setMountedOptions(new Set()),[componentGuid,sessionIdentity]);
  useLayoutEffect(()=>{
    if(contextKey&&newInstruction&&!detachedNewContexts.has(contextKey)&&mountedContextGeneration===contextGeneration&&newDraftIdentity===`${sessionIdentity}:${componentGuid}`){
      retainedNewInstructionContexts.set(contextKey,{instruction:structuredClone(newInstruction),insertAt,insertionBase});publishMemory();
    }
  },[contextKey,newInstruction,newDraftIdentity,sessionIdentity,componentGuid,insertAt,insertionBase,contextGeneration,mountedContextGeneration]);
  const finishNewDraft=(guid:string)=>{
    if(contextKey&&retainedNewInstructionContexts.get(contextKey)?.instruction.Guid===guid)retainedNewInstructionContexts.delete(contextKey);
    if(state.authoringSession){const key=JSON.stringify(['new-instruction',sessionIdentity,componentGuid,guid]);retainedCanonicalDrafts.delete(key);retainedNewInstructionProvenance.delete(key);}
    setNewInstruction(previous=>previous?.Guid===guid?null:previous);publishMemory();
  };
  const recoverySurface=optionDepth===0&&guide&&state.authoringSession?<DraftRecovery guide={guide} directory={sessionIdentity} busy={state.authoringBusy}/>:null;
  if(!guide||!componentGuid||!component)return <>{recoverySurface}</>;
  const directOptions=Array.isArray(component.Options)?component.Options.filter(record):[];
  const contextBlocked=Boolean(contextKey&&detachedNewContexts.has(contextKey))||mountedContextGeneration!==contextGeneration;
  const visibleNewInstruction=newInstruction&&newDraftIdentity===`${sessionIdentity}:${componentGuid}`&&!contextBlocked?newInstruction:null;
  const duplicateInstruction=(instruction:RecordValue,index:number)=>{
    const current=getState();
    if(newInstruction||contextBlocked||current.authoringBusy||current.file!==state.file||current.authoringSession?.directory!==state.authoringSession?.directory||current.authoringSession?.revisionId!==state.authoringSession?.revisionId)return;
    const rawList=component.Instructions;
    if(!Array.isArray(rawList)||!rawList.every(record)||rawList[index]!==instruction||typeof instruction.Guid!=='string')return;
    const duplicate=structuredClone(instruction);
    duplicate.Guid=newGuid();
    setInsertAt(index+1);setInsertionBase(instructionSignature);setNewDraftIdentity(`${sessionIdentity}:${componentGuid}`);setNewInstruction(duplicate);
  };
  const occupiedGuid=Boolean(visibleNewInstruction&&instructions.some(instruction=>instruction.Guid===visibleNewInstruction.Guid));
  const insertionChanged=insertionBase!==instructionSignature||occupiedGuid;
  return <section className="rust-instruction-builder" aria-label="Authoritative instruction builder"><h2>Instruction builder · {String(component.Name??'')}</h2>
    {recoverySurface}
    {ownerNames.length>0&&<p className="muted">Option of {ownerNames.join(' / ')}. Options execute only when a reached Choose instruction references them and their saved installation selection applies.</p>}
    <ComponentEdit key={`${sessionIdentity}:${componentGuid}:${recoveryGenerations.get(JSON.stringify(['component',sessionIdentity,component.Guid]))??0}`} component={component} components={guide.thisMod}/>
    {instructions.map((instruction,index)=><div key={`${sessionIdentity}:${componentGuid}:${String(instruction.Guid??index)}:${recoveryGenerations.get(JSON.stringify(['instruction',sessionIdentity,componentGuid,instruction.Guid]))??0}`}><InstructionEdit componentGuid={componentGuid} index={index} instruction={instruction} options={component.Options}/><button type="button" className="btn btn-sm" disabled={Boolean(newInstruction)||state.authoringBusy||contextBlocked||!Array.isArray(component.Instructions)||!component.Instructions.every(record)||typeof instruction.Guid!=='string'} onClick={()=>duplicateInstruction(instruction,index)}>Duplicate saved instruction {index+1} as local draft</button></div>)}
    {visibleNewInstruction&&<><p role="status">New instruction draft and its insertion context are retained during navigation in this browser session. Reloading the browser clears them.</p>{occupiedGuid&&<p role="alert">This draft GUID already exists in the saved instruction list. The draft is retained and insertion is blocked.</p>}<label>New instruction insertion point<select aria-label="New instruction insertion point" value={Math.min(insertAt,instructions.length)} disabled={state.authoringBusy} onChange={event=>setInsertAt(Number(event.target.value))}>{Array.from({length:instructions.length+1},(_,index)=><option value={index} key={index}>{index===0?'Before first instruction':`After instruction ${index}`}</option>)}</select></label>
      {insertionChanged&&!occupiedGuid&&<button type="button" className="btn" disabled={state.authoringBusy} onClick={()=>{setInsertAt(Math.min(insertAt,instructions.length));setInsertionBase(instructionSignature);}}>Confirm insertion point in current saved list</button>}
      <InstructionEdit key={String(visibleNewInstruction.Guid)} componentGuid={componentGuid} index={Math.min(insertAt,instructions.length)} instruction={visibleNewInstruction} options={component.Options} newInstruction insertionChanged={insertionChanged} onCancel={()=>finishNewDraft(String(visibleNewInstruction.Guid))} onSaved={()=>finishNewDraft(String(visibleNewInstruction.Guid))}/></>}
    <button className="btn btn-sm" disabled={Boolean(newInstruction)||state.authoringBusy||contextBlocked} onClick={()=>{if(contextBlocked||getState().authoringBusy)return;setInsertAt(instructions.length);setInsertionBase(instructionSignature);setNewDraftIdentity(`${sessionIdentity}:${componentGuid}`);setNewInstruction({Guid:newGuid(),Action:'Unset',Source:[],Destination:'',Arguments:'',Overwrite:true,Dependencies:[],Restrictions:[]});}}>Add instruction draft</button>
    {contextBlocked&&<p role="alert">Resolve the retained removed-owner draft in the recovery panel before starting another instruction.</p>}
    {directOptions.length>0&&<section aria-label="Direct installation options"><h3>Installation options</h3>
      <p className="muted">Expand an option to inspect or edit its canonical details and instructions. Collapsing an opened option retains its local drafts. Listed order is preserved.</p>
      {directOptions.map((option,index)=>{
        const guid=typeof option.Guid==='string'?option.Guid:'';
        return <details className="authoring-instruction" key={`${sessionIdentity}:${guid||index}`} onToggle={event=>{
          if(event.target!==event.currentTarget||!event.currentTarget.open||!guid)return;
          setMountedOptions(previous=>previous.has(guid)?previous:new Set([...previous,guid]));
        }}><summary>{index+1}. {String(option.Name??'Unnamed option')} · {guid||'Missing GUID'} · {selectionLabel(option.IsSelected)}</summary>
          {!guid?<p role="alert">This option lacks a canonical GUID and cannot be edited.</p>:optionDepth>=64?<p role="alert">Nested option editor depth limit reached; saved data remains preserved.</p>:mountedOptions.has(guid)&&<RustInstructionBuilder componentGuid={guid} optionDepth={optionDepth+1} ownerNames={[...ownerNames,String(component.Name??component.Guid)]}/>}
        </details>;
      })}
    </section>}

  </section>;
}
