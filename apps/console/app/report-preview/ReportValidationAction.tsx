"use client";

import {useState} from "react";
import {postBrowserCommand} from "@nzi/api-client";

type ValidatedVersion={reportVersionId:string};

export function ReportValidationAction({snapshotId,manifestVersion,ready}:{snapshotId:string;manifestVersion:number;ready:boolean}){
  const [pending,setPending]=useState<"validate"|"publish"|null>(null);
  const [validated,setValidated]=useState<ValidatedVersion|null>(null);
  const [published,setPublished]=useState(false);
  const [message,setMessage]=useState(ready?"All required chart evidence resolves from this reviewed snapshot.":"Resolve the manifest blockers before validation.");

  async function validate(){
    setPending("validate");
    const result=await postBrowserCommand<ValidatedVersion>("/api/isolated/reports/validate",{reviewedSnapshotId:snapshotId,manifestVersion},crypto.randomUUID());
    setPending(null);
    if(result.state==="success"){
      setValidated(result.data);
      setMessage(`Validated immutable report version ${result.data.reportVersionId}. It is ready for controlled portal publication.`);
    }else if(result.state==="validation_failed")setMessage(result.issues?.map(issue=>issue.message).join(" ")||result.message||"Validation blocked.");
    else setMessage(result.message||"Validation failed.");
  }

  async function publish(){
    if(!validated)return;
    setPending("publish");
    const result=await postBrowserCommand<{reportVersionId:string;publishedAt:string}>("/api/isolated/reports/publish",{reportVersionId:validated.reportVersionId,expectedStatus:"validated",manifestVersion,reviewedSnapshotId:snapshotId},crypto.randomUUID());
    setPending(null);
    if(result.state==="success"){
      setPublished(true);
      setMessage(`Published immutable report version ${result.data.reportVersionId} to the client portal.`);
    }else if(result.state==="validation_failed")setMessage(result.issues?.map(issue=>issue.message).join(" ")||result.message||"Publication blocked.");
    else setMessage(result.message||"Publication failed.");
  }

  return <div className={`nz-banner ${ready?"ok":"warn"}`} style={{margin:"18px 0"}}>
    <div><b>{published?"Published to client portal":validated?"Validated and ready to publish":ready?"Ready to validate":"Publication blocked"}</b><div style={{marginTop:4}}>{message}</div></div>
    <div style={{marginLeft:"auto",display:"flex",gap:8}}>
      {!validated&&<button className="nz-btn pri" disabled={!ready||pending!==null} onClick={validate}>{pending==="validate"?"Validating...":"Create validated report version"}</button>}
      {validated&&!published&&<button className="nz-btn pri" disabled={pending!==null} onClick={publish}>{pending==="publish"?"Publishing...":"Publish to client portal"}</button>}
      {published&&<span className="nz-st done">Published</span>}
    </div>
  </div>;
}
