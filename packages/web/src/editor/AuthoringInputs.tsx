import {useEffect,useRef,useState} from "react";
import {api} from "../api/client";
import {useAppState,reportError} from "../state/store";
type InputPin={name:string;bytes:number;sha256:string;verified:boolean};
export function AuthoringInputs(){
  const {authoringSession:session}=useAppState();const revision=useRef(session?.revisionId);revision.current=session?.revisionId;const [inputs,setInputs]=useState<InputPin[]>([]),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null);
  useEffect(()=>{let disposed=false;setInputs([]);setError(null);setBusy(null);if(session)void api.authoringInputs(session.directory,session.head.cursor).then(result=>{if(disposed)return;if(result.revisionId!==session.revisionId){setError("Session changed; reload the revision");return;}setInputs(result.inputs);}).catch(error=>{if(!disposed)setError(error instanceof Error?error.message:String(error));});return()=>{disposed=true;};},[session]);
  const verify=async(pin:InputPin)=>{if(!session||busy)return;setBusy(pin.name);try{const result=await api.verifyAuthoringInput(session.directory,session.head.cursor,pin.name);if(revision.current!==session.revisionId)return;if(result.revisionId!==session.revisionId)throw new Error("Session changed; reload the revision");setInputs(previous=>previous.map(input=>input.sha256===pin.sha256?{...input,verified:true}:input));}catch(error){reportError(error,"Archive verification failed");}finally{if(revision.current===session.revisionId)setBusy(null);}};
  if(!session)return null;
  return <details className="authoring-inputs"><summary>Saved archive inputs ({inputs.length})</summary>{error&&<p className="alert alert-error">{error}</p>}<ul>{inputs.map(pin=><li key={pin.name}><span>{pin.name}</span><span className="muted small">{pin.bytes.toLocaleString()} bytes</span><code title={pin.sha256}>{pin.sha256.slice(0,12)}…</code><button className="btn btn-sm" disabled={busy!==null||pin.verified||/^\.tmp/i.test(pin.name)} onClick={()=>void verify(pin)}>{/^\.tmp/i.test(pin.name)?"Unavailable staging input":pin.verified?"Verified":busy===pin.name?"Verifying…":"Verify bytes"}</button></li>)}</ul></details>;
}
