import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { Modal } from "../components/Modal";
import { useAppState } from "../state/store";
import type { ArchiveListResult, BrowseResult } from "../types";
import { toPlaceholder } from "./util";

const ARCHIVE_RE = /\.(zip|7z|rar|exe)$/i;

export interface BrowseSourceProps {
  onInsert: (paths: string[], origins?:string[]) => void;
  onClose: () => void;
  inspectOnly?: boolean;
  onDraft?: (action:string,paths:string[],origins:string[])=>void;
}

/**
 * Lists `/api/fs/browse` starting at the mod directory, lets the user open
 * archives through `/api/archive/list?path=` and inserts placeholder paths
 * (`<<modDirectory>>/...`) for the chosen entries.
 */
export function BrowseSource({ onInsert, onClose, inspectOnly = false, onDraft }: BrowseSourceProps) {
  const s = useAppState();
  const dirs = { modDirectory: s.settings?.modDirectory ?? "", kotorDirectory: s.settings?.kotorDirectory ?? "" };
  const request = useRef(0);
  const menuRef=useRef<HTMLDivElement>(null),contextTrigger=useRef<HTMLElement|null>(null);
  const [context,setContext]=useState<{path:string;origin:string;name:string;selection:{path:string;origin:string}[]}|null>(null);
  useEffect(()=>{if(context)menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();},[context]);
  const closeContext=()=>{setContext(null);contextTrigger.current?.focus();};
  const openContext=(path:string,origin:string,name:string,trigger:HTMLElement,selection=[{path,origin}])=>{contextTrigger.current=trigger;setContext({path,origin,name,selection});};
  const [listing, setListing] = useState<BrowseResult | null>(null);
  const [savedArchives,setSavedArchives]=useState<{name:string;bytes:number}[]>([]),[archiveOutput,setArchiveOutput]=useState("");
  const [archive, setArchive] = useState<ArchiveListResult | null>(null);
  const [expandedFolders,setExpandedFolders]=useState<Set<string>>(new Set()),[focusedArchivePath,setFocusedArchivePath]=useState("");
  const archiveRows=useRef(new Map<string,HTMLDivElement>());
  const archiveSearch=useRef({prefix:"",lastKeyAt:0});
  useEffect(()=>{setExpandedFolders(new Set());setFocusedArchivePath("");archiveSearch.current={prefix:"",lastKeyAt:0};},[archive]);
  const [path, setPath] = useState(dirs.modDirectory || "/");
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [draftAction,setDraftAction]=useState("Copy");
  const [newFolderName,setNewFolderName]=useState("");
  const validFolderName=newFolderName.trim()===newFolderName&&newFolderName.length>0&&!/[\\/\x00-\x1f*?\[\]]/.test(newFolderName)&&newFolderName!=="."&&newFolderName!=="..";
  const [origins,setOrigins]=useState<Record<string,string>>({});
  const staging=(name:string)=>/^\.tmp/i.test(name);
  const [loading, setLoading] = useState(false);

  const browse = async (p: string) => {
    const current=++request.current;
    setLoading(true);
    setError(null);
    setArchive(null);
    try {
      const res = await api.fsBrowse(p);
      if(current!==request.current)return;
      setListing(res);
      setPath(res.path);
    } catch (err) {
      if(current===request.current)setError(err instanceof Error ? err.message : String(err));
    } finally {
      if(current===request.current)setLoading(false);
    }
  };

  const outputFor=(archivePath:string,logicalName?:string)=>{
    const name=logicalName??archivePath.replace(/\\/g,'/').split('/').pop()??'',stem=name.replace(ARCHIVE_RE,'');
    return `${logicalName?'<<modDirectory>>':toPlaceholder(archivePath.replace(/\\/g,'/').replace(/\/[^/]*$/,''),dirs)}/${stem}`;
  };
  useEffect(()=>{let disposed=false;setSavedArchives([]);const session=s.authoringSession;if(session)void api.authoringInputs(session.directory,session.head.cursor).then(result=>{if(!disposed&&result.revisionId===session.revisionId)setSavedArchives(result.inputs.filter(pin=>ARCHIVE_RE.test(pin.name)&&!/^\.tmp/i.test(pin.name)));}).catch(()=>{});return()=>{disposed=true;};},[s.authoringSession?.directory,s.authoringSession?.revisionId]);
  const openSavedArchive=async(name:string)=>{const session=s.authoringSession;if(!session)return;const current=++request.current;setLoading(true);setError(null);try{const result=await api.authoringArchive(session.directory,session.head.cursor,name);if(current!==request.current)return;if(result.revisionId!==session.revisionId)throw new Error('Saved revision changed; reopen the explorer');setArchive(result);setArchiveOutput(outputFor(result.path,result.logicalName));}catch(error){if(current===request.current)setError(error instanceof Error?error.message:String(error));}finally{if(current===request.current)setLoading(false);}};
  const openArchive = async (p: string) => {
    const current=++request.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.archiveList(p);
      if(current!==request.current)return;
      setArchive(res);
      setArchiveOutput(outputFor(res.path));
    } catch (err) {
      if(current===request.current)setError(err instanceof Error ? err.message : String(err));
    } finally {
      if(current===request.current)setLoading(false);
    }
  };

  useEffect(() => {
    void browse(path);
    return()=>{request.current++;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (p: string, origin=p) => {
    setOrigins(previous=>({...previous,[p]:origin}));
    const n = new Set(picked);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    setPicked(n);
  };

  /** Placeholder path for an entry inside an archive: `<<modDirectory>>/<archive stem>/<entry>`. */
  const archiveEntryPath = (entry: string) => {
    if (!archive) return entry;
    return `${archiveOutput.replace(/\/$/,'')}/${entry.replace(/\/$/,'')}`;
  };

  const archiveEntries=useMemo(()=>archive?.entries.filter(entry=>!entry.path.split(/[\\/]/).some(staging))??[],[archive]);
  type ArchiveNode=ArchiveListResult['entries'][number]&{key:string;name:string;parent:string;children:ArchiveNode[]};
  const archiveTree=useMemo(()=>{
    const nodes=new Map<string,ArchiveNode>();let error:string|null=null;
    const ensureFolder=(key:string)=>{if(nodes.has(key)&&!nodes.get(key)!.isDirectory)error="Archive member is both a file and a folder; hierarchy authoring is unavailable";if(!nodes.has(key))nodes.set(key,{key,path:key+'/',name:key.split('/').pop()!,parent:key.includes('/')?key.slice(0,key.lastIndexOf('/')):'',children:[],isDirectory:true,size:0});};
    for(const entry of archiveEntries){const key=entry.path.replace(/\\/g,'/').replace(/\/$/,'');const parts=key.split('/');for(let depth=1;depth<parts.length;depth++)ensureFolder(parts.slice(0,depth).join('/'));const previous=nodes.get(key);if(previous&&(!previous.isDirectory||!entry.isDirectory))error="Archive contains duplicate or conflicting member paths; hierarchy authoring is unavailable";nodes.set(key,{...entry,key,name:parts[parts.length-1]!,parent:parts.slice(0,-1).join('/'),children:previous?.children??[]});}
    const roots:ArchiveNode[]=[];for(const node of nodes.values()){const parent=nodes.get(node.parent);if(parent)parent.children.push(node);else roots.push(node);}
    const order=(entries:ArchiveNode[])=>{entries.sort((a,b)=>Number(b.isDirectory)-Number(a.isDirectory)||a.name.localeCompare(b.name));for(const entry of entries)order(entry.children);};order(roots);return {roots:error?[]:roots,nodes,error};
  },[archiveEntries]);
  const visibleArchiveNodes=useMemo(()=>{const result:ArchiveNode[]=[];const visit=(entries:ArchiveNode[])=>{for(const entry of entries){result.push(entry);if(expandedFolders.has(entry.key))visit(entry.children);}};visit(archiveTree.roots);return result;},[archiveTree,expandedFolders]);
  const archiveLeaves=useMemo(()=>{
    const parents=new Set<string>();for(const entry of archiveEntries){const parts=entry.path.replace(/\/$/,'').split('/');parts.pop();while(parts.length){parents.add(parts.join('/'));parts.pop();}}
    return archiveEntries.filter(entry=>!entry.isDirectory||!parents.has(entry.path.replace(/\/$/,'')));
  },[archiveEntries]);
  const archiveOrigin=(entry:string)=>`${archive?.logicalName??archive?.path??""} [${archive?.sha256??archive?.path??""}] :: ${entry}`;
  const archiveSelection=(entry:typeof archiveEntries[number])=>{
    const prefix=entry.path.replace(/\/$/,'')+'/';
    const descendants=entry.isDirectory?archiveLeaves.filter(candidate=>candidate.path.startsWith(prefix)):[];
    return (descendants.length?descendants:[entry]).map(candidate=>({path:archiveEntryPath(candidate.path),origin:archiveOrigin(candidate.path)}));
  };
  const visibleFiles=archive?visibleArchiveNodes.filter(entry=>!entry.isDirectory).map(entry=>({path:archiveEntryPath(entry.path),origin:archiveOrigin(entry.path)})):(listing?.entries??[]).filter(entry=>!entry.isDirectory&&!staging(entry.name)).map(entry=>({path:toPlaceholder(entry.path,dirs),origin:entry.path}));
  const changeSelection=(entries:{path:string;origin:string}[],selected:boolean)=>{
    setPicked(previous=>{const next=new Set(previous);for(const entry of entries){if(selected)next.add(entry.path);else next.delete(entry.path);}return next;});
    if(selected)setOrigins(previous=>({...previous,...Object.fromEntries(entries.map(entry=>[entry.path,entry.origin]))}));
  };
  const selectionKeys=(event:React.KeyboardEvent<HTMLDivElement>)=>{
    if(inspectOnly||loading||!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='a')return;
    event.preventDefault();event.stopPropagation();changeSelection(visibleFiles,!event.shiftKey);
  };

  const focusArchive=(key:string)=>{setFocusedArchivePath(key);archiveRows.current.get(key)?.focus();};
  const typeAheadArchive=(event:React.KeyboardEvent<HTMLDivElement>,node:ArchiveNode)=>{
    if(event.ctrlKey||event.metaKey||event.altKey||event.isDefaultPrevented()||event.nativeEvent.isComposing||[...event.key].length!==1||event.key===' '||/[\p{C}]/u.test(event.key))return;
    const now=performance.now(),character=event.key.normalize('NFC').toLowerCase(),previous=now-archiveSearch.current.lastKeyAt<700?archiveSearch.current.prefix:'',prefix=previous===character?character:previous+character;
    const current=visibleArchiveNodes.findIndex(entry=>entry.key===node.key),continuing=previous!==''&&previous!==character;
    const find=(text:string,start:number)=>{for(let step=0;step<visibleArchiveNodes.length;step++){const candidate=visibleArchiveNodes[(start+step+visibleArchiveNodes.length)%visibleArchiveNodes.length]!;if(candidate.name.normalize('NFC').toLowerCase().startsWith(text))return candidate;}return undefined;};
    let effectivePrefix=prefix,match=find(prefix,current+(continuing?0:1));
    if(!match&&prefix!==character){effectivePrefix=character;match=find(character,current+1);}
    archiveSearch.current={prefix:effectivePrefix,lastKeyAt:now};event.preventDefault();event.stopPropagation();if(match)focusArchive(match.key);
  };
  const expandArchive=(node:ArchiveNode,expand:boolean)=>{
    setExpandedFolders(previous=>{const next=new Set(previous);if(expand)next.add(node.key);else next.delete(node.key);return next;});
    if(!expand&&focusedArchivePath.startsWith(node.key+'/'))focusArchive(node.key);
  };
  const renderArchiveNodes=(nodes:ArchiveNode[],depth=1):React.ReactNode=>nodes.map((node,position)=>{
    const ph=archiveEntryPath(node.path),targets=archiveSelection(node),checked=targets.every(entry=>picked.has(entry.path)),mixed=!checked&&targets.some(entry=>picked.has(entry.path)),hasChildren=node.children.length>0,expanded=expandedFolders.has(node.key);
    const ownEvent=(target:EventTarget)=>target instanceof Element&&target.closest('[role="treeitem"]')===archiveRows.current.get(node.key);
    return <div key={node.key} role="treeitem" className="archive-tree-node" aria-label={node.name} aria-level={depth} aria-posinset={position+1} aria-setsize={nodes.length} aria-expanded={hasChildren?expanded:undefined} aria-checked={inspectOnly?undefined:mixed?'mixed':checked} tabIndex={(focusedArchivePath||visibleArchiveNodes[0]?.key)===node.key?0:-1} ref={element=>{if(element)archiveRows.current.set(node.key,element);else archiveRows.current.delete(node.key);}} onFocus={event=>{if(ownEvent(event.target))setFocusedArchivePath(node.key);}} onPointerDown={event=>{if(ownEvent(event.target))archiveSearch.current={prefix:"",lastKeyAt:0};}} onContextMenu={event=>{if(!ownEvent(event.target)||inspectOnly||!onDraft)return;event.preventDefault();openContext(ph,archiveOrigin(node.path),node.path,event.currentTarget,targets);}} onKeyDown={event=>{
      if(!ownEvent(event.target))return;
      if(!inspectOnly&&onDraft&&(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)){event.preventDefault();event.stopPropagation();openContext(ph,archiveOrigin(node.path),node.path,event.currentTarget,targets);return;}
      if(['ArrowDown','ArrowUp','Home','End','ArrowRight','ArrowLeft'].includes(event.key)){archiveSearch.current={prefix:'',lastKeyAt:0};event.preventDefault();event.stopPropagation();const index=visibleArchiveNodes.findIndex(entry=>entry.key===node.key);if(event.key==='Home')focusArchive(visibleArchiveNodes[0]!.key);else if(event.key==='End')focusArchive(visibleArchiveNodes[visibleArchiveNodes.length-1]!.key);else if(event.key==='ArrowDown'||event.key==='ArrowUp')focusArchive(visibleArchiveNodes[Math.max(0,Math.min(visibleArchiveNodes.length-1,index+(event.key==='ArrowDown'?1:-1)))]!.key);else if(event.key==='ArrowRight'&&hasChildren){if(!expanded)expandArchive(node,true);else focusArchive(node.children[0]!.key);}else if(event.key==='ArrowLeft'){if(hasChildren&&expanded)expandArchive(node,false);else if(node.parent)focusArchive(node.parent);}return;}
      if(event.target===event.currentTarget&&(event.key===' '||event.key==='Enter')){archiveSearch.current={prefix:'',lastKeyAt:0};event.preventDefault();event.stopPropagation();if(event.key==='Enter'&&hasChildren)expandArchive(node,!expanded);else if(!inspectOnly)changeSelection(targets,!checked);return;}
      typeAheadArchive(event,node);
    }}><div className={`browser-entry ${checked||mixed?'selected':''}`}>
      {hasChildren?<button className="archive-disclosure" tabIndex={-1} aria-label={`${expanded?'Collapse':'Expand'} ${node.path}`} aria-expanded={expanded} onClick={()=>expandArchive(node,!expanded)}>{expanded?'▾':'▸'}</button>:<span className="archive-disclosure" aria-hidden="true"/>}
      {!inspectOnly&&<input tabIndex={-1} aria-label={`Select ${node.path}`} type="checkbox" checked={checked} aria-checked={mixed?'mixed':checked} ref={element=>{if(element)element.indeterminate=mixed;}} onChange={()=>changeSelection(targets,!checked)}/>}
      <span className="browser-icon" aria-hidden="true">{node.isDirectory?'📁':'📄'}</span><span className="grow">{node.name}</span><span className="muted small mono">{ph}</span>
      {!inspectOnly&&onDraft&&<button tabIndex={-1} className="btn btn-sm" aria-haspopup="menu" aria-label={`File actions for ${node.path}`} onClick={event=>openContext(ph,archiveOrigin(node.path),node.path,event.currentTarget,targets)}>Actions…</button>}
    </div>{hasChildren&&expanded&&<div role="group" className="archive-tree-group">{renderArchiveNodes(node.children,depth+1)}</div>}</div>;
  });

  return (
    <Modal
      title={inspectOnly ? "Inspect source files" : "Browse source"}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted small grow" role="status" aria-live="polite">{inspectOnly ? "Browse folders and archive contents" : `${picked.size} selected · paths are inserted with placeholders`}</span>
          <button className="btn" onClick={onClose}>
            {inspectOnly ? "Close" : "Cancel"}
          </button>
          {!inspectOnly && <button className="btn btn-primary" disabled={picked.size === 0} onClick={() => onInsert([...picked],[...picked].map(path=>origins[path]??path))}>
            Insert
          </button>}
        </>
      }
    >
      {context&&onDraft&&!inspectOnly&&<div className="explorer-context-menu" ref={menuRef} role="menu" aria-label={`File actions for ${context.name}`} onKeyDown={event=>{
        const items=[...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')??[])];const index=items.indexOf(document.activeElement as HTMLButtonElement);
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeContext();}if(event.key==='Tab')setContext(null);
      }}><strong>{context.name}</strong>{['Copy','Move','Rename','Delete','Extract'].map(action=><button key={action} role="menuitem" className="btn" onClick={()=>{const hasSelection=context.selection.some(entry=>picked.has(entry.path));const paths=hasSelection?[...picked]:action==='Rename'?[context.path]:context.selection.map(entry=>entry.path);if(action==='Rename'&&paths.length!==1){setError('Rename requires one selected source');closeContext();return;}onDraft(action,paths,paths.map(path=>context.selection.find(entry=>entry.path===path)?.origin??(path===context.path?context.origin:origins[path]??path)));setContext(null);}}>Draft {action}</button>)}<button role="menuitem" className="btn" onClick={closeContext}>Close file actions</button></div>}
      {!inspectOnly&&onDraft&&<div className="explorer-actionbar" role="group" aria-label="Actions for selected files">
        <label>Draft file operation<select aria-label="Draft file operation" value={draftAction} onChange={event=>setDraftAction(event.target.value)}>{["Copy","Move","Rename","Delete","Extract"].map(action=><option key={action}>{action}</option>)}</select></label>
        <button className="btn" disabled={!picked.size||(draftAction==="Rename"&&picked.size!==1)} onClick={()=>onDraft(draftAction,[...picked],[...picked].map(path=>origins[path]??path))}>Use selection for {draftAction}</button>
        <label>New folder name<input aria-label="New folder name" value={newFolderName} onChange={event=>setNewFolderName(event.target.value)}/></label>
        <button className="btn" disabled={!validFolderName||loading||(!archive&&!listing)} onClick={()=>{const parent=archive?archiveOutput:toPlaceholder(listing!.path,dirs);onDraft('CreateDirectory',[`${parent.replace(/\/$/,'')}/${newFolderName}`],[`New folder beneath ${archive?(archive.logicalName??archive.path):listing!.path}`]);}}>New folder draft</button>
        <span className="muted small">Creates a local instruction draft. Review its destination before saving.</span>
      </div>}
      {!inspectOnly&&<div className="explorer-actionbar" role="group" aria-label="Bulk source selection">
        <button className="btn btn-sm" disabled={loading||!visibleFiles.length} onClick={()=>changeSelection(visibleFiles,true)}>Select all visible files</button>
        <button className="btn btn-sm" disabled={loading||!visibleFiles.some(entry=>picked.has(entry.path))} onClick={()=>changeSelection(visibleFiles,false)}>Clear visible file selection</button>
        <button className="btn btn-sm" disabled={!picked.size} onClick={()=>setPicked(new Set())}>Clear all selection</button>
        <span className="muted small">Within the file list: Ctrl/⌘+A selects visible files; Ctrl/⌘+Shift+A clears them.</span>
      </div>}
      {picked.size>0&&<details className="explorer-provenance"><summary>Selected source paths ({picked.size})</summary><ul>{[...picked].map(path=><li key={path}><code>{origins[path]??path}</code>{origins[path]!==path&&<><br/><span className="muted">Instruction path: </span><code>{path}</code></>}</li>)}</ul></details>}
      {savedArchives.length>0&&<details className="saved-archive-picker"><summary>Saved archive inputs ({savedArchives.length})</summary><ul>{savedArchives.map(pin=><li key={pin.name}><span dir="auto">{pin.name}</span><span className="muted small">{pin.bytes.toLocaleString()} bytes</span><button className="btn btn-sm" disabled={loading} onClick={()=>void openSavedArchive(pin.name)} aria-label={`Open saved archive ${pin.name}`}>Browse verified archive</button></li>)}</ul></details>}
      {archive&&<div className="archive-projection"><strong dir="auto">{archive.logicalName??archive.path}</strong><p className="muted small">Member paths refer to files after extraction. Match this folder to the Extract instruction destination.</p><label>Archive extraction folder<input className="mono" aria-label="Archive extraction folder" readOnly={inspectOnly} value={archiveOutput} onChange={event=>{
        const output=event.target.value,prefix=`${archive.logicalName??archive.path} [${archive.sha256??archive.path}] :: `,next=new Set<string>(),mapped={...origins};
        for(const selected of picked){const origin=origins[selected];if(origin?.startsWith(prefix)){const projected=`${output.replace(/\/$/,'')}/${origin.slice(prefix.length).replace(/\/$/,'')}`;next.add(projected);if(projected!==selected)delete mapped[selected];mapped[projected]=origin;}else next.add(selected);}
        setPicked(next);setOrigins(mapped);setContext(null);setArchiveOutput(output);
      }}/></label>{archive.sha256&&<code>Verified SHA-256: {archive.sha256}</code>}</div>}
      <p className="muted small">Private importer staging files (.tmp…) are excluded. Checking an archive folder selects its leaf members; a partial selection shows a mixed checkbox.</p>
      <div className="browser-toolbar">
        <button className="btn btn-sm" onClick={() => browse(dirs.modDirectory || "/")} disabled={!dirs.modDirectory}>
          Mod dir
        </button>
        <button className="btn btn-sm" onClick={() => browse(dirs.kotorDirectory || "/")} disabled={!dirs.kotorDirectory}>
          Game dir
        </button>
        <button className="btn btn-sm" disabled={!listing?.parent && !archive} onClick={() => {if(archive){request.current++;setLoading(false);setArchive(null);setContext(null);}else if(listing?.parent)void browse(listing.parent);}}>
          ↑ Up
        </button>
        <form
          className="grow row"
          onSubmit={(e) => {
            e.preventDefault();
            browse(path);
          }}
        >
          <input aria-label="Source explorer folder" className="grow mono" value={path} onChange={(e) => {request.current++;setLoading(false);setListing(null);setPath(e.target.value);}} />
          <button className="btn btn-sm" type="submit">
            Go
          </button>
        </form>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {loading && <div className="muted">Loading…</div>}
      {!loading && archive && <>
        {archiveTree.error&&<div className="alert alert-error" role="alert">{archiveTree.error}</div>}
        <div className="explorer-actionbar" role="group" aria-label="Archive hierarchy">
          <button className="btn btn-sm" onClick={()=>setExpandedFolders(new Set([...archiveTree.nodes.values()].filter(node=>node.children.length).map(node=>node.key)))}>Expand all folders</button>
          <button className="btn btn-sm" onClick={()=>{setExpandedFolders(new Set());setFocusedArchivePath(archiveTree.roots[0]?.key??'');}}>Collapse all folders</button>
          <span className="muted small">Arrow keys navigate folders and files. Type a name to move focus. Space selects; Enter opens or closes a folder.</span>
        </div>
        <div className="browser-list archive-tree" role="tree" aria-label="Archive members" aria-multiselectable={!inspectOnly} onKeyDown={selectionKeys}>{renderArchiveNodes(archiveTree.roots)}</div>
      </>}
      {!loading && !archive && listing && (
        <div className="browser-list" onKeyDown={selectionKeys}>
          {listing.entries
            .filter(e=>!staging(e.name))
            .slice()
            .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
            .map((e) => {
              const ph = toPlaceholder(e.path, dirs);
              const isArchive = !e.isDirectory && ARCHIVE_RE.test(e.name);
              return (
                <div key={e.path} className={`browser-entry ${picked.has(ph) ? "selected" : ""}`} onContextMenu={event=>{if(inspectOnly||!onDraft)return;event.preventDefault();openContext(ph,e.path,e.name,event.currentTarget.querySelector<HTMLButtonElement>('button')??event.currentTarget);}} onKeyDown={event=>{if(!inspectOnly&&onDraft&&(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)){event.preventDefault();event.stopPropagation();openContext(ph,e.path,e.name,event.target instanceof HTMLElement?event.target:event.currentTarget);}}}>
                  {!inspectOnly && <input aria-label={`Select ${e.path}`} type="checkbox" checked={picked.has(ph)} onChange={() => toggle(ph, e.path)} onClick={(ev) => ev.stopPropagation()} />}
                  <span className="browser-icon">{e.isDirectory ? "📁" : isArchive ? "🗜" : "📄"}</span>
                  <button className="browser-entry-name grow" onClick={() => (e.isDirectory ? browse(e.path) : isArchive ? openArchive(e.path) : !inspectOnly&&toggle(ph, e.path))}>
                    {e.name}
                  </button>
                  {!inspectOnly&&onDraft&&<button className="btn btn-sm" aria-haspopup="menu" aria-expanded={context?.path===ph} aria-label={`File actions for ${e.name}`} onClick={event=>openContext(ph,e.path,e.name,event.currentTarget)}>Actions…</button>}
                  {isArchive && (
                    <button className="btn btn-sm" onClick={() => openArchive(e.path)}>
                      Open archive
                    </button>
                  )}
                  {e.isDirectory && !inspectOnly && (
                    <button className="btn btn-sm" onClick={() => toggle(`${ph}/*`)} title="Insert a wildcard for everything in this folder">
                      Add /*
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </Modal>
  );
}
