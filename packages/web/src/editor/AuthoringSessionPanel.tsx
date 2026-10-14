import {AuthoringPrediction} from "./AuthoringPrediction";
import {AuthoringInputs} from "./AuthoringInputs";
import { useState } from "react";
import { DirectoryBrowser } from "../components/DirectoryBrowser";
import { actions, useAppState } from "../state/store";
export function AuthoringSessionPanel() {
  const [browse,setBrowse]=useState(false);
  const state=useAppState(),session=state.authoringSession,busy=state.authoringBusy;
  const load=async(directory:string,cursor?:number)=>{if(await actions.loadAuthoringSession(directory,cursor))setBrowse(false);};
  return <section className="panel" aria-label="Saved authoring session"><div className="row">
    <button className="btn btn-sm" disabled={busy} onClick={()=>setBrowse(true)}>Open saved session…</button>
    {session&&<><label htmlFor="authoring-revision">Saved revision</label><select id="authoring-revision" disabled={busy} value={session.head.cursor} onChange={event=>void load(session.directory,Number(event.target.value))}>
      {session.head.revisions.map((revision,index)=><option key={`${revision.id}:${index}`} value={index}>{index+1}. {revision.label}</option>)}
    </select><span className="muted small">{state.authoringBackend==="rust-cli"?"Rust persistence backend":"Read-only inspection"}</span>
    {state.authoringBackend==="rust-cli"&&<><button className="btn btn-sm" disabled={busy||session.head.cursor===0} onClick={()=>void actions.persistAuthoringSession({operation:"undo"})}>Undo saved edit</button><button className="btn btn-sm" disabled={busy||session.head.cursor+1>=session.head.revisions.length} onClick={()=>void actions.persistAuthoringSession({operation:"redo"})}>Redo saved edit</button></>}
    <button className="btn btn-sm" disabled={busy} onClick={()=>void load(session.directory)}>Reload current revision</button></>}
    </div>{session&&<p className="muted small mono authoring-session-path">{session.directory}</p>}
    <AuthoringInputs/>
    <AuthoringPrediction/>
    {browse&&<DirectoryBrowser title="Choose an authoring session folder" initialPath={session?.directory} onClose={()=>setBrowse(false)} onPick={directory=>void load(directory)}/>}
  </section>;
}
