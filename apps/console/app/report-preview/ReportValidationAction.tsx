"use client";

import {useState} from "react";
import {postBrowserCommand} from "@nzi/api-client";
import type {ReportScope,reportScopeChoices} from "@nzi/contracts";
import {ReportScopeSelector} from "./ReportScopeSelector";

type ValidatedVersion={reportVersionId:string};

export function ReportValidationAction({snapshotId,manifestVersion,ready,choices}:{snapshotId:string;manifestVersion:number;ready:boolean;choices:ReturnType<typeof reportScopeChoices>}){
  // S-2: the view this version will issue — chosen at validate (ruled), whole client unless a site scope is picked.
  const [scope,setScope]=useState<ReportScope>({kind:"whole"});
  const scopeReady=scope.kind==="whole"||scope.siteIds.length>0;
  const [pending,setPending]=useState<"validate"|"publish"|null>(null);
  const [validated,setValidated]=useState<ValidatedVersion|null>(null);
  const [published,setPublished]=useState(false);
  const [message,setMessage]=useState(ready?"All required chart evidence resolves from this reviewed snapshot.":"Resolve the manifest blockers before validation.");

  async function validate(){
    if(pending)return;
    setPending("validate");
    const result=await postBrowserCommand<ValidatedVersion>("/api/isolated/reports/validate",{reviewedSnapshotId:snapshotId,manifestVersion,scope},crypto.randomUUID());
    setPending(null);
    if(result.state==="success"){
      setValidated(result.data);
      setMessage(`Validated immutable report version ${result.data.reportVersionId}. It is ready for controlled portal publication.`);
    }else if(result.state==="validation_failed")setMessage(result.issues?.map(issue=>issue.message).join(" ")||result.message||"Validation blocked.");
    else setMessage(result.message||"Validation failed.");
  }

  async function publish(){
    if(!validated||pending)return;
    setPending("publish");
    // report.publish pins the version the caller saw. The version this screen just validated is version 1 (a report version
    // is inserted at 1, and only a publish moves it) — sent, so a version that moved since is refused rather than published.
    const result=await postBrowserCommand<{reportVersionId:string;publishedAt:string}>("/api/isolated/reports/publish",{reportVersionId:validated.reportVersionId,expectedStatus:"validated",expectedVersion:1,manifestVersion,reviewedSnapshotId:snapshotId},crypto.randomUUID());
    setPending(null);
    if(result.state==="success"){
      setPublished(true);
      setMessage(`Published immutable report version ${result.data.reportVersionId} to the client portal.`);
    }else if(result.state==="validation_failed")setMessage(result.issues?.map(issue=>issue.message).join(" ")||result.message||"Publication blocked.");
    else setMessage(result.message||"Publication failed.");
  }

  return <section className={`nz-validation-gate ${ready?"ready":"blocked"}`} aria-labelledby="validation-gate-title">
    <div className="nz-validation-copy"><ol className="nz-validation-steps" aria-label="Publication gate progress"><li className="complete"><i>1</i>Evidence frozen</li><b aria-hidden="true">→</b><li className={validated?"complete":ready?"active":""} aria-current={!validated?"step":undefined}><i>2</i>Manifest validated</li><b aria-hidden="true">→</b><li className={published?"complete":validated?"active":""} aria-current={validated&&!published?"step":undefined}><i>3</i>Client publication</li></ol><h3 id="validation-gate-title">{published?"Published to client portal":validated?"Validated and ready to publish":ready?"Ready to validate":"Publication blocked"}</h3><p role={ready?"status":"alert"}>{message}</p>{validated&&<div className="nz-version-proof"><span>Immutable version</span><b>{validated.reportVersionId}</b></div>}</div>
    {!validated?<ReportScopeSelector choices={choices} scope={scope} onChange={setScope} disabled={pending!==null}/>:null}
    <div className="nz-validation-actions">
      {!validated&&<button type="button" className="nz-btn pri" disabled={!ready||!scopeReady||pending!==null} onClick={validate}>{pending==="validate"?"Validating…":"Create validated report version"}</button>}
      {validated&&!published&&<button type="button" className="nz-btn pri" disabled={pending!==null} onClick={publish}>{pending==="publish"?"Publishing…":"Publish exact version to portal"}</button>}
      {published&&<span className="nz-st done">Published</span>}
    </div>
  </section>;
}
