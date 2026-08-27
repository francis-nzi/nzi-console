"use client";
import {useCallback,useEffect,useState} from "react";
import type {PortalDataEntryReviewItem} from "@nzi/isolated-backend";
import {PortalBucketAdmin} from "./PortalBucketAdmin";

export function PortalDataEntryAdministration(){return <><PortalBucketAdmin/><PortalDataEntryReviewQueue/></>}
function PortalDataEntryReviewQueue(){
  const [items,setItems]=useState<PortalDataEntryReviewItem[]>([]),[state,setState]=useState<"loading"|"ready"|"error">("loading"),[pending,setPending]=useState(""),[error,setError]=useState("");
  const load=useCallback(async()=>{setState("loading");try{const response=await fetch("/api/isolated/portal-data-entry-review",{cache:"no-store"}),body=await response.json();if(!response.ok)throw new Error(body.message);setItems(Array.isArray(body.items)?body.items:[]);setState("ready")}catch{setState("error")}},[]);
  useEffect(()=>{void load()},[load]);
  async function decide(item:PortalDataEntryReviewItem,decision:"accept"|"reject"){
    const note=decision==="reject"?window.prompt("Give the client a reason for rejecting this submission:")?.trim():"";
    if(decision==="reject"&&!note)return;
    if(decision==="accept"&&!window.confirm("Import this submission as pending, uncalculated scope evidence? It will still require independent emissions review."))return;
    setPending(item.queueId);setError("");
    try{const response=await fetch("/api/isolated/portal-data-entry-review",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({queueId:item.queueId,expectedSubmittedVersion:item.submittedVersion,decision,note:note??""})}),body=await response.json();if(!response.ok)throw new Error(response.status===409?"This submission changed. The queue has been refreshed.":body.message);await load()}catch(cause){setError(cause instanceof Error?cause.message:"The review decision could not be verified.");await load()}finally{setPending("")}
  }
  return <section className="nz-panel" style={{padding:16,marginTop:14}}><span className="nz-eyebrow">Client submission review</span><h3 style={{margin:"6px 0"}}>Pending data-entry queue</h3><p className="sub">Acceptance imports the submitted values as pending, uncalculated scope evidence. Independent emissions review is still required.</p>{error?<div className="nz-banner warn" role="alert">{error}</div>:null}{state==="loading"?<div className="nz-table-empty">Loading submitted records…</div>:state==="error"?<div className="nz-banner warn" role="alert">The review queue is unavailable.</div>:items.length===0?<div className="nz-table-empty">No client submissions are awaiting review.</div>:<div style={{overflowX:"auto"}}><table className="nz-tbl"><thead><tr><th>Client / job</th><th>Scope row</th><th>Submission</th><th>Client note</th><th>Submitted</th><th>Decision</th></tr></thead><tbody>{items.map(item=><tr key={item.queueId}><td><b>{item.client}</b><div className="muted">{item.portalUser} · {item.jobNumber}</div></td><td>{item.scope}<div className="muted">{item.sourceLabel}</div></td><td className="num">{item.quantity} {item.unit}<div className="muted">v{item.submittedVersion}</div></td><td>{item.note||"—"}</td><td>{new Date(item.submittedAt).toLocaleString()}</td><td><div style={{display:"flex",gap:8}}><button className="nz-btn pri" disabled={!!pending} onClick={()=>void decide(item,"accept")}>{pending===item.queueId?"Working…":"Accept"}</button><button className="nz-btn" disabled={!!pending} onClick={()=>void decide(item,"reject")}>Reject</button></div></td></tr>)}</tbody></table></div>}</section>;
}
