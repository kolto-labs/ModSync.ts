import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { BrowseResult } from "../types";
import { Modal } from "./Modal";

export interface DirectoryBrowserProps {
  title?: string;
  initialPath?: string;
  /** When true, files are selectable too (returns a file path). */
  pickFiles?: boolean;
  /** Only show files with these extensions (lowercase, with dot). */
  extensions?: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}

/** Derive ancestors without rewriting POSIX backslashes or inventing relative roots. */
function folderAncestors(path:string):Array<{label:string;path:string}> {
  let rootEnd:number;
  let windows=false;
  if(/^[A-Za-z]:[\\/]/.test(path)){rootEnd=3;windows=true;}
  else if(path.startsWith('\\\\')){
    // Keep device/extended namespaces opaque; the server's parent route remains available.
    if(path.startsWith('\\\\?\\')||path.startsWith('\\\\.\\'))return [{label:path,path}];
    const parts=path.slice(2).split('\\');
    if(!parts[0]||!parts[1])return [{label:path,path}];
    rootEnd=2+parts[0].length+1+parts[1].length;
    if(path[rootEnd]==='\\')rootEnd++;
    windows=true;
  }else if(path.startsWith('/'))rootEnd=1;
  else return [{label:path,path}];
  const result=[{label:path.slice(0,rootEnd),path:path.slice(0,rootEnd)}];
  const segments=windows?/[^\\/]+/g:/[^/]+/g;
  const remaining=path.slice(rootEnd);
  for(const match of remaining.matchAll(segments))result.push({label:match[0],path:path.slice(0,rootEnd+match.index!+match[0].length)});
  result[result.length-1]!.path=path;
  return result;
}

/** Modal directory/file browser built on `/api/fs/roots` and `/api/fs/browse`. */
export function DirectoryBrowser({ title, initialPath, pickFiles, extensions, onPick, onClose }: DirectoryBrowserProps) {
  const request=useRef(0),displayedRequest=useRef<number|null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [listing, setListing] = useState<BrowseResult | null>(null);
  const [path, setPath] = useState(initialPath ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [history,setHistory]=useState<{paths:string[];cursor:number}>({paths:[],cursor:-1});
  const historyRef=useRef(history);

  const browse = async (p: string, historyIndex?:number) => {
    const prior=historyRef.current;
    if(historyIndex!==undefined&&(!Number.isInteger(historyIndex)||historyIndex<0||historyIndex>=prior.paths.length||prior.paths[historyIndex]!==p))return;
    const current=++request.current;
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    try {
      const res = await api.fsBrowse(p);
      if(current!==request.current)return;
      displayedRequest.current=current;
      const next=historyIndex!==undefined
        ? {paths:prior.paths.map((value,index)=>index===historyIndex?res.path:value),cursor:historyIndex}
        : prior.paths[prior.cursor]===res.path?prior:{paths:[...prior.paths.slice(0,prior.cursor+1),res.path],cursor:prior.cursor+1};
      historyRef.current=next;setHistory(next);
      setListing(res);
      setPath(res.path);
    } catch (err) {
      if(current===request.current)setError(err instanceof Error ? err.message : String(err));
    } finally {
      if(current===request.current)setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const initialRequest=request.current;
    (async () => {
      try {
        const r = await api.fsRoots();
        if (cancelled) return;
        setRoots(r.roots);
        if(request.current===initialRequest)await browse(initialPath || r.roots[0] || "/");
      } catch (err) {
        if (!cancelled && request.current === initialRequest) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate the latest request sequence, not a captured earlier value.
      request.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entries = (listing?.entries ?? [])
    .filter((e) => e.isDirectory || (pickFiles && (!extensions || extensions.some((x) => e.name.toLowerCase().endsWith(x)))))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));

  const usableListing=Boolean(listing)&&!loading&&!error&&displayedRequest.current===request.current;
  const selectedValid=Boolean(selectedFile&&entries.some(entry=>!entry.isDirectory&&entry.path===selectedFile));
  const ancestors=listing?folderAncestors(listing.path):[];
  const pick=(filePath?:string)=>{
    if(!usableListing||displayedRequest.current!==request.current||!listing)return;
    const target=filePath??selectedFile;
    if(pickFiles){if(!target||!entries.some(entry=>!entry.isDirectory&&entry.path===target))return;onPick(target);}
    else onPick(listing.path);
  };

  return (
    <Modal
      title={title ?? (pickFiles ? "Choose a file" : "Choose a directory")}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted mono grow ellipsis" title={selectedFile ?? path}>
            {selectedFile ?? path}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!usableListing || (pickFiles && !selectedValid)}
            onClick={() => pick()}
          >
            {pickFiles ? "Select file" : "Select this folder"}
          </button>
        </>
      }
    >
      <div className="browser-toolbar">
        <button type="button" className="btn" aria-label="Go back to previous folder" title="Previous successfully visited folder" disabled={loading||history.cursor<=0} onClick={()=>{const prior=historyRef.current;if(!loading&&prior.cursor>0)void browse(prior.paths[prior.cursor-1],prior.cursor-1);}}>Back</button>
        <button type="button" className="btn" aria-label="Go forward to next folder" title="Next successfully visited folder" disabled={loading||history.cursor<0||history.cursor>=history.paths.length-1} onClick={()=>{const prior=historyRef.current;if(!loading&&prior.cursor>=0&&prior.cursor<prior.paths.length-1)void browse(prior.paths[prior.cursor+1],prior.cursor+1);}}>Forward</button>
        <select value="" onChange={(e) => e.target.value && browse(e.target.value)} aria-label="Roots">
          <option value="">Roots…</option>
          {roots.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!usableListing||!listing?.parent} aria-label="Go to parent folder" onClick={() => usableListing&&listing?.parent && browse(listing.parent)}>
          ↑ Up
        </button>
        <form
          className="grow row"
          onSubmit={(e) => {
            e.preventDefault();
            browse(path);
          }}
        >
          <input aria-label="Folder path" className="grow mono" value={path} onChange={(e) => {request.current++;setLoading(false);setListing(null);setPath(e.target.value);}} placeholder="Type a path and press Enter" />
          <button className="btn" type="submit">
            Go
          </button>
        </form>
      </div>
      {listing&&<nav aria-label="Folder ancestry"><ol style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:4,listStyle:'none',padding:0}}>
        {ancestors.map((ancestor,index)=><li key={ancestor.path} style={{minWidth:0,overflowWrap:'anywhere'}}>
          {index>0&&<span aria-hidden="true"> / </span>}
          {index===ancestors.length-1?<span aria-current="page"><bdi>{ancestor.label}</bdi></span>:<button type="button" className="btn btn-sm" disabled={!usableListing} aria-label={`Open ancestor folder ${ancestor.path}`} onClick={()=>{if(usableListing&&displayedRequest.current===request.current)void browse(ancestor.path);}}><bdi>{ancestor.label}</bdi></button>}
        </li>)}
      </ol></nav>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="browser-list" aria-label="Folder contents" aria-busy={loading}>
        {loading && <div className="muted" role="status">Loading…</div>}
        {usableListing && entries.length === 0 && <div className="muted" role="status">Empty folder</div>}
        {!loading&&!error&&!listing&&<div className="muted">Enter a folder path to browse.</div>}
        {entries.map((e) => (
          <div
            key={e.path}
            className={`browser-entry ${selectedFile === e.path ? "selected" : ""}`}
          >
            <span className="browser-icon" aria-hidden="true">{e.isDirectory ? "📁" : "📄"}</span>
            <button type="button" className="browser-entry-name grow" disabled={!usableListing}
              aria-label={`${e.isDirectory?'Open folder':'Select file'} ${e.name}`} aria-pressed={e.isDirectory?undefined:selectedFile===e.path}
              onClick={()=>{if(!usableListing||displayedRequest.current!==request.current)return;if(e.isDirectory)void browse(e.path);else setSelectedFile(e.path);}}
              onDoubleClick={()=>{if(!e.isDirectory)pick(e.path);}}><bdi>{e.name}</bdi></button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** Use the Electron picker when present, else open the in-app browser. */
export async function pickDirectoryNative(): Promise<string | undefined | null> {
  if (window.modsync?.pickDirectory) return window.modsync.pickDirectory();
  return null; // caller falls back to DirectoryBrowser
}
