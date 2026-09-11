"use client";

import {useCallback,useEffect,useState} from "react";
import {postBrowserCommand} from "@nzi/api-client";
import {crpProfessionalManifest} from "@nzi/charts";
import type {ClientContactReadModel,ReviewedCrpSnapshotReadModel} from "@nzi/contracts";
import type {ReportVersionRegisterItem} from "@nzi/isolated-backend";
import {accessFor,useStaffMe,type EditAccess} from "../lib/useEditAccess";

const message=(result:{state:string;message?:string;issues?:Array<{message:string}>})=>result.state==="validation_failed"?(result.issues?.[0]?.message??"Validation failed."):(result.message??"Command failed.");

/**
 * Controlled release (NZC-022 separation of duties): a reviewed snapshot is prepared
 * by one person and approved by another; only an approved snapshot can be validated
 * and published, and never by its preparer. The signee is one of the client's
 * report-signee contacts and is frozen onto the validated version.
 */
export function CrpReleaseControl({jobId,readyForReporting}:{jobId:string;readyForReporting:boolean}){
  const [snapshots,setSnapshots]=useState<ReviewedCrpSnapshotReadModel[]>([]),[reports,setReports]=useState<ReportVersionRegisterItem[]>([]),[signees,setSignees]=useState<ClientContactReadModel[]|null>(null),[signeeId,setSigneeId]=useState(""),[loading,setLoading]=useState(true),[pending,setPending]=useState(false),[notice,setNotice]=useState<{ok:boolean;text:string}|null>(null);
  const me=useStaffMe();
  const load=useCallback(async()=>{setLoading(true);try{const [snapshotResponse,reportResponse,signeeResponse]=await Promise.all([fetch(`/api/isolated/jobs/${jobId}/reviewed-snapshots`,{cache:"no-store"}),fetch("/api/isolated/report-versions",{cache:"no-store"}),fetch(`/api/isolated/jobs/${jobId}/report-signees`,{cache:"no-store"})]),snapshotBody=await snapshotResponse.json(),reportBody=await reportResponse.json(),signeeBody=await signeeResponse.json().catch(()=>({}));if(!snapshotResponse.ok||!reportResponse.ok)throw new Error(snapshotBody.message??reportBody.message??"Publication evidence is unavailable.");setSnapshots(Array.isArray(snapshotBody.snapshots)?snapshotBody.snapshots:[]);setReports(Array.isArray(reportBody.reports)?reportBody.reports.filter((report:ReportVersionRegisterItem)=>report.jobId===jobId):[]);const list:ClientContactReadModel[]=signeeResponse.ok&&Array.isArray(signeeBody.signees)?signeeBody.signees:[];setSignees(list);setSigneeId(current=>current&&list.some(item=>item.id===current)?current:list[0]?.id??"");}catch(error){setNotice({ok:false,text:error instanceof Error?error.message:"Publication evidence is unavailable."});}finally{setLoading(false);}},[jobId]);
  useEffect(()=>{void load();},[load]);
  const snapshot=snapshots[0],validated=snapshot?reports.find(report=>report.snapshotId===snapshot.id&&report.status==="validated"):undefined,published=snapshot?reports.find(report=>report.snapshotId===snapshot.id&&report.status==="published"):undefined;
  const approved=Boolean(snapshot?.approvedBy);
  const signedIn=me&&me!=="signed-out"?me:null;
  const preparedByMe=Boolean(signedIn&&snapshot&&snapshot.createdBy===signedIn.userId);
  const gate=(capability:"snapshot.review"|"report.publish"):EditAccess=>!signedIn?{state:"checking",reason:"Checking your permissions…"}:preparedByMe?{state:"denied",reason:capability==="snapshot.review"?"You prepared this snapshot, so another person must approve it.":"You prepared this snapshot, so another person must validate and publish it."}:accessFor(signedIn,capability);
  const approveAccess=gate("snapshot.review"),releaseAccess=gate("report.publish");
  async function approve(){if(!snapshot||pending)return;setPending(true);setNotice(null);const result=await postBrowserCommand<{approvedAt:string}>(`/api/isolated/reviewed-snapshots/${encodeURIComponent(snapshot.id)}/approve`,{},crypto.randomUUID());setPending(false);if(result.state!=="success")return setNotice({ok:false,text:message(result)});setNotice({ok:true,text:"Snapshot approved. It can now be validated and published by someone other than its preparer."});await load();}
  async function validate(){if(!snapshot||pending)return;setPending(true);setNotice(null);const result=await postBrowserCommand<{reportVersionId:string}>("/api/isolated/reports/validate",{reviewedSnapshotId:snapshot.id,manifestVersion:crpProfessionalManifest.version,signeeContactId:signeeId||null},crypto.randomUUID());setPending(false);if(result.state!=="success")return setNotice({ok:false,text:message(result)});setNotice({ok:true,text:"The approved snapshot passed the governed report manifest and an immutable validated version was created."});await load();}
  async function publish(){if(!snapshot||!validated||pending)return;setPending(true);setNotice(null);const result=await postBrowserCommand<{reportVersionId:string}>("/api/isolated/reports/publish",{reportVersionId:validated.reportVersionId,expectedStatus:"validated",manifestVersion:validated.manifestVersion,reviewedSnapshotId:snapshot.id},crypto.randomUUID());setPending(false);if(result.state!=="success")return setNotice({ok:false,text:message(result)});setNotice({ok:true,text:"The exact validated version was published to authorised client portal users."});await load();}
  const status=published?"Published":validated?"Validated":approved?"Approved":snapshot?"Awaiting approval":"Snapshot required";
  const blockedApprove=pending||!snapshot||approved||approveAccess.state!=="allowed";
  const blockedValidate=pending||!snapshot||!approved||Boolean(validated)||Boolean(published)||releaseAccess.state!=="allowed";
  const blockedPublish=pending||!validated||Boolean(published)||releaseAccess.state!=="allowed";
  const reason=!snapshot?null:!approved?(approveAccess.state!=="allowed"?approveAccess.reason:null):!published&&releaseAccess.state!=="allowed"?releaseAccess.reason:null;
  return <section className="nz-panel nz-config-panel" aria-busy={loading||pending}><div className="nz-config-head"><div><span className="nz-eyebrow">Controlled release</span><b>Approve, validate and publish</b><div className="sub">The latest reviewed snapshot is approved by someone other than its preparer, then must pass the shared CRP manifest before its exact immutable version can be released.</div></div><span className={`nz-st ${published?"done":validated||approved?"est":"need"}`}>{status}</span></div>
    {loading?<div className="nz-register-loading" role="status"><i/><span><b>Loading release evidence</b><small>Checking snapshots and report versions…</small></span></div>:<div className="nz-release-lineage"><div><span>Reviewed snapshot</span><b>{snapshot?`v${snapshot.version} · ${snapshot.id.slice(0,8)}`:"Not created"}</b></div><i>→</i><div><span>Approval</span><b>{approved?`Approved${snapshot?.approvedAt?` · ${snapshot.approvedAt.slice(0,10).split("-").reverse().join("/")}`:""}`:snapshot?"Awaiting a second person":"—"}</b></div><i>→</i><div><span>Manifest</span><b>CRP professional v{crpProfessionalManifest.version}</b></div><i>→</i><div><span>Release</span><b>{published?.reportVersionId??validated?.reportVersionId??"Not validated"}</b></div></div>}
    {snapshot&&approved&&!validated&&!published?<label className="nz-fl" style={{margin:"12px 16px 0"}}><span>Report signee</span>
      <select className="nz-sel" value={signeeId} onChange={event=>setSigneeId(event.target.value)} disabled={pending||signees===null} aria-label="Report signee">
        {signees?.length?null:<option value="">{signees===null?"Loading signees…":"No report-signee contacts"}</option>}
        {signees?.map(contact=><option key={contact.id} value={contact.id}>{contact.fullName}{contact.jobTitle?` — ${contact.jobTitle}`:""}</option>)}
        {signees?.length?<option value="">No signee on this report</option>:null}
      </select>
      <span className="nz-hint">Only the client&apos;s contacts marked <b>Report signee</b> are offered. The signee is frozen onto the validated version and shown on the published report.</span>
    </label>:null}
    {notice&&<div className={`nz-banner ${notice.ok?"ok":"warn"}`} role={notice.ok?"status":"alert"}>{notice.text}</div>}
    {reason?<div className="nz-hint" role="note" style={{margin:"10px 16px 0"}}>{reason}</div>:null}
    <div className="nz-config-actions"><button className="nz-btn" disabled={blockedApprove} onClick={approve}>{approved?"Approved":pending?"Working…":"Approve snapshot"}</button><button className="nz-btn" disabled={blockedValidate} onClick={validate}>{pending?"Working…":"Validate approved snapshot"}</button><button className="nz-btn pri" disabled={blockedPublish} onClick={publish}>{published?"Published":pending?"Working…":"Publish validated version"}</button></div>
    {!snapshot&&<div className="nz-hint">{readyForReporting?"Create a reviewed snapshot from approved scope rows to begin release.":"Complete calculation and independent QA before creating a reviewed snapshot."}</div>}
  </section>;
}
