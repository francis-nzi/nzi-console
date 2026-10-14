"use client";

import {useState} from "react";
import {postBrowserCommand} from "@nzi/api-client";
import {defaultReportSectionPlan,reportPlanSectionTitle,type ReportScope,type ReportPlanSectionKey,type ReportSectionPlan,type reportScopeChoices} from "@nzi/contracts";
import {ReportScopeSelector} from "./ReportScopeSelector";
import {SectionPlanEditor} from "../reports/SectionPlanEditor";

type ValidatedVersion={reportVersionId:string};
/** F-1b: the version this screen holds — what publish pins — with its section plan and where the plan came from. */
type HeldPlan={version:number;sectionPlan:ReportSectionPlan;origin:string};
const samePlan=(a:ReportSectionPlan,b:ReportSectionPlan)=>a.length===b.length&&a.every((entry,index)=>entry.key===b[index]!.key&&entry.included===b[index]!.included);
const originText=(origin:string)=>origin==="default"?"The standard order.":origin==="edited"?"Chosen for this report.":origin.startsWith("profile:")?`From the client's report profile (version ${origin.slice(8)}).`:"";

/**
 * R4 (RULING-report-studio-consolidation): before validation the preparer chooses which optional sections this report carries.
 * A required chart whose data the snapshot does not hold blocks only while its section is in the report, so leaving the section
 * out clears it — the server judges the same plan (`report.validate`). Any other manifest blocker still blocks.
 */
export function ReportValidationAction({snapshotId,manifestVersion,sectionNeeds,otherBlockers,choices}:{snapshotId:string;manifestVersion:number;sectionNeeds:Array<{chartId:string;section:string}>;otherBlockers:string[];choices:ReturnType<typeof reportScopeChoices>}){
  const [plan,setPlan]=useState<ReportSectionPlan>(defaultReportSectionPlan);
  const planEdited=!samePlan(plan,defaultReportSectionPlan);
  const stillNeeded=sectionNeeds.filter(need=>plan.some(entry=>entry.key===need.section&&entry.included));
  const ready=otherBlockers.length===0&&stillNeeded.length===0;
  // S-2: the view this version will issue — chosen at validate (ruled), whole client unless a site scope is picked.
  const [scope,setScope]=useState<ReportScope>({kind:"whole"});
  const scopeReady=scope.kind==="whole"||scope.siteIds.length>0;
  const [pending,setPending]=useState<"validate"|"publish"|"order"|null>(null);
  const [validated,setValidated]=useState<ValidatedVersion|null>(null);
  // F-1b: the held version and its saved plan, and the order being edited before it is saved.
  const [held,setHeld]=useState<HeldPlan|null>(null);
  const [draft,setDraft]=useState<ReportSectionPlan|null>(null);
  const orderDirty=held!==null&&draft!==null&&!samePlan(held.sectionPlan,draft);

  async function loadPlan(reportVersionId:string){
    const response=await fetch(`/api/isolated/report-versions/${encodeURIComponent(reportVersionId)}/section-plan`,{cache:"no-store"}).catch(()=>null);
    const body=response?.ok?await response.json().catch(()=>null) as {plan?:HeldPlan}|null:null;
    // Without the plan the screen cannot know which version it would publish, so it says so rather than guessing.
    if(!body?.plan){setMessage("The validated version's section order could not be read — reload before publishing.");return;}
    setHeld({version:body.plan.version,sectionPlan:body.plan.sectionPlan,origin:body.plan.origin});
    setDraft(body.plan.sectionPlan);
  }

  async function saveOrder(){
    if(!validated||!held||!draft||pending)return;
    setPending("order");
    const result=await postBrowserCommand<{version:number;origin:string}>("/api/isolated/reports/section-plan",{reportVersionId:validated.reportVersionId,expectedVersion:held.version,sectionPlan:draft},crypto.randomUUID());
    setPending(null);
    if(result.state==="success"){
      setHeld({version:result.data.version,sectionPlan:draft,origin:result.data.origin});
      setMessage("Section order saved. Publishing issues the report in this order.");
    }else if(result.state==="validation_failed")setMessage(result.issues?.map(issue=>issue.message).join(" ")||result.message||"The section order was not saved.");
    else setMessage(result.message||"The section order was not saved.");
  }
  const [published,setPublished]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  const status=message??(ready?"All required chart evidence for the sections in this report resolves from this reviewed snapshot."
    :otherBlockers.length?`Resolve the manifest blockers before validation: ${otherBlockers.join(" ")}`
    :`This snapshot has no data for ${[...new Set(stillNeeded.map(need=>reportPlanSectionTitle(need.section as ReportPlanSectionKey)))].join(" or ")}. Leave ${stillNeeded.length===1?"that section":"those sections"} out of this report below, or add the data and re-freeze.`);

  async function validate(){
    if(pending)return;
    setPending("validate");
    // The plan chosen here, when the preparer changed it; otherwise the server takes the client's report profile, else the default.
    const result=await postBrowserCommand<ValidatedVersion>("/api/isolated/reports/validate",{reviewedSnapshotId:snapshotId,manifestVersion,scope,...(planEdited?{sectionPlan:plan}:{})},crypto.randomUUID());
    setPending(null);
    if(result.state==="success"){
      setValidated(result.data);
      setMessage(`Validated immutable report version ${result.data.reportVersionId}. Check the section order, then publish.`);
      await loadPlan(result.data.reportVersionId);
    }else if(result.state==="validation_failed")setMessage(result.issues?.map(issue=>issue.message).join(" ")||result.message||"Validation blocked.");
    else setMessage(result.message||"Validation failed.");
  }

  async function publish(){
    if(!validated||!held||orderDirty||pending)return;
    setPending("publish");
    // report.publish pins the version the caller saw: the one this screen holds — 1 when validated, moved by each saved
    // reorder — so a version that moved elsewhere is refused rather than published.
    const result=await postBrowserCommand<{reportVersionId:string;publishedAt:string}>("/api/isolated/reports/publish",{reportVersionId:validated.reportVersionId,expectedStatus:"validated",expectedVersion:held.version,manifestVersion,reviewedSnapshotId:snapshotId},crypto.randomUUID());
    setPending(null);
    if(result.state==="success"){
      setPublished(true);
      setMessage(`Published immutable report version ${result.data.reportVersionId} to the client portal.`);
    }else if(result.state==="validation_failed")setMessage(result.issues?.map(issue=>issue.message).join(" ")||result.message||"Publication blocked.");
    else setMessage(result.message||"Publication failed.");
  }

  return <section className={`nz-validation-gate ${ready?"ready":"blocked"}`} aria-labelledby="validation-gate-title">
    <div className="nz-validation-copy"><ol className="nz-validation-steps" aria-label="Publication gate progress"><li className="complete"><i>1</i>Evidence frozen</li><b aria-hidden="true">→</b><li className={validated?"complete":ready?"active":""} aria-current={!validated?"step":undefined}><i>2</i>Manifest validated</li><b aria-hidden="true">→</b><li className={published?"complete":validated?"active":""} aria-current={validated&&!published?"step":undefined}><i>3</i>Client publication</li></ol><h3 id="validation-gate-title">{published?"Published to client portal":validated?"Validated and ready to publish":ready?"Ready to validate":"Publication blocked"}</h3><p role={ready?"status":"alert"}>{status}</p>{validated&&<div className="nz-version-proof"><span>Immutable version</span><b>{validated.reportVersionId}</b></div>}
      {/* F-1b: inside the copy column, so the gate's status line keeps its width beside the actions. */}
      {!validated?<div className="nz-report-order">
        <div><b>Sections in this report</b> <span className="note">{planEdited?"Chosen for this report.":"The standard order, or the client's report profile if one is set."}</span></div>
        <SectionPlanEditor plan={plan} onChange={setPlan} disabled={pending!==null} label="Sections in this report"/>
      </div>:null}
      {validated&&!published&&held&&draft?<div className="nz-report-order">
        <div><b>Section order</b> <span className="note">{originText(held.origin)}</span></div>
        <SectionPlanEditor plan={draft} onChange={setDraft} disabled={pending!==null}/>
        {orderDirty?<button type="button" className="nz-btn" disabled={pending!==null} onClick={saveOrder}>{pending==="order"?"Saving order…":"Save section order"}</button>:null}
      </div>:null}</div>
    {!validated?<ReportScopeSelector choices={choices} scope={scope} onChange={setScope} disabled={pending!==null}/>:null}
    <div className="nz-validation-actions">
      {!validated&&<button type="button" className="nz-btn pri" disabled={!ready||!scopeReady||pending!==null} onClick={validate}>{pending==="validate"?"Validating…":"Create validated report version"}</button>}
      {validated&&!published&&<button type="button" className="nz-btn pri" disabled={pending!==null||!held||orderDirty} title={orderDirty?"Save the section order first, so the report issues in the order shown.":undefined} onClick={publish}>{pending==="publish"?"Publishing…":"Publish exact version to portal"}</button>}
      {published&&<span className="nz-st done">Published</span>}
    </div>
  </section>;
}
