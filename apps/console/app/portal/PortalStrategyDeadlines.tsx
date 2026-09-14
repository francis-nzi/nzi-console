"use client";
import {useEffect,useState} from "react";
import type {PortalStrategiesReadModel,PortalStrategyHighlight} from "@nzi/isolated-backend";
import {formatDate} from "../lib/formatDate";
import {redirectIfPortalSessionEnded} from "./portalSessionClient";

/**
 * The client's own reduction plan, as dates they are approaching.
 *
 * Read-only, like the rest of the portal. The four states are kept distinct on purpose
 * (truth before apparent availability): loading is not empty, a failed fetch is not "nothing
 * due", and "nothing due" is genuinely good news rather than an absence of data.
 *
 * A plan with no dates set raises nothing at all — the panel does not appear. That is the
 * honest reading: a client who has not set target dates is not behind on them.
 */

const valid=(value:unknown):value is PortalStrategiesReadModel=>{
  if(!value||typeof value!=="object")return false;
  const model=value as PortalStrategiesReadModel;
  return typeof model.total==="number"&&typeof model.overdue==="number"&&typeof model.approaching==="number"&&Array.isArray(model.highlights);
};

export function PortalStrategyDeadlines(){
  const [model,setModel]=useState<PortalStrategiesReadModel|null>(null),[error,setError]=useState("");
  useEffect(()=>{fetch("/api/portal/strategies",{cache:"no-store"}).then(async response=>{
    if(await redirectIfPortalSessionEnded(response))return;
    const body:unknown=await response.json();
    if(!response.ok)throw new Error((body as {message?:string})?.message??"Your reduction plan could not be loaded.");
    if(!valid(body))throw new Error("Your reduction plan returned an unexpected response.");
    setModel(body);
  }).catch(cause=>{setError(cause instanceof Error?cause.message:"Your reduction plan could not be loaded.")})},[]);

  if(error)return <section className="nz-panel"><div className="nz-portal-state failed" role="alert"><i>!</i><div>
    <b>Your reduction plan could not be loaded</b><span>{error} Nothing about your plan has changed.</span></div></div></section>;
  if(model===null)return <section className="nz-panel"><div className="nz-portal-state loading" role="status"><i>↻</i><div>
    <b>Checking your reduction plan</b><span>Looking for dates coming up or passed…</span></div></div></section>;
  // No plan, or a plan with nothing due: neither is a warning, and neither earns a panel.
  if(model.total===0||model.highlights.length===0)return null;

  return <section className="nz-panel">
    <div className="nz-card-b">
      <span className="nz-eyebrow">Your reduction plan</span>
      <h2 style={{margin:"2px 0 8px",fontSize:16}}>{headline(model)}</h2>
      <p className="sub" style={{marginTop:0}}>
        Dates you set with your NZI consultant. Talk to them if any of these need to move — a date that
        has moved is better than a date that has passed.
      </p>
      <div>{model.highlights.map((highlight,index)=><Row key={`${highlight.title}-${index}`} highlight={highlight}/>)}</div>
    </div>
  </section>;
}

function headline({overdue,approaching}:PortalStrategiesReadModel):string{
  const parts:string[]=[];
  if(overdue>0)parts.push(overdue===1?"1 action has passed its date":`${overdue} actions have passed their dates`);
  if(approaching>0)parts.push(`${approaching} coming up`);
  return `${parts.join(", and ")}.`;
}

function Row({highlight}:{highlight:PortalStrategyHighlight}){
  const late=highlight.deadline.state==="overdue";
  return <div style={{display:"flex",alignItems:"baseline",gap:10,padding:"9px 2px",borderTop:"1px solid #EDF1EF"}}>
    <span className={late?"nz-deadline late":"nz-deadline soon"}>{when(highlight)}</span>
    <div style={{flex:1}}>
      <b>{highlight.title}</b>
      <div className="sub">
        {[highlight.category,highlight.owner].filter(part=>part!=="").join(" · ")}
        {highlight.targetDate!==""?` · ${formatDate(highlight.targetDate)}`:""}
      </div>
    </div>
  </div>;
}

/** Days, because that is what a person acts on; the date itself is on the row beside it. */
function when({deadline}:PortalStrategyHighlight):string{
  if(deadline.state==="overdue")return `${deadline.daysOverdue} ${deadline.daysOverdue===1?"day":"days"} past`;
  if(deadline.state==="approaching")return deadline.daysRemaining===0?"Due today":`In ${deadline.daysRemaining} ${deadline.daysRemaining===1?"day":"days"}`;
  return "";
}
