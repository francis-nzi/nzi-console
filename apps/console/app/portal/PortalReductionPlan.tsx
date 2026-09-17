"use client";
import {useEffect,useState} from "react";
import {Collapsible} from "@nzi/ui";
import type {PortalPlanGroup,PortalPlanStrategy,PortalStrategiesReadModel,PortalStrategyHighlight} from "@nzi/isolated-backend";
import {formatDate} from "../lib/formatDate";
import {redirectIfPortalSessionEnded} from "./portalSessionClient";

/**
 * The client's own reduction plan: the dates they are approaching, and the plan itself.
 *
 * Read-only, like the rest of the portal — there is no add, edit, remove or toggle here. A
 * strategy is agreed with the NZI consultant and tracked on the client record, so a
 * client-side edit would fork the one plan into two.
 *
 * **Live, not frozen.** The plan resolves from the client's current strategies on every
 * load, which is the one narrow exemption from the portal's published-snapshot rule: that
 * rule protects unassured *measurements*, and a plan is not a measurement. A date is only
 * useful while it is still the date.
 *
 * The four states are kept distinct on purpose (truth before apparent availability): loading
 * is not empty, a failed fetch is not "nothing due", "nothing due" is genuinely good news,
 * and "no plan yet" is a plan being written rather than an error.
 */

const valid=(value:unknown):value is PortalStrategiesReadModel=>{
  if(!value||typeof value!=="object")return false;
  const model=value as PortalStrategiesReadModel;
  return typeof model.total==="number"&&typeof model.overdue==="number"&&typeof model.approaching==="number"&&Array.isArray(model.highlights)&&Array.isArray(model.plan);
};

/** A long plan opens collapsed so the page stays scannable; a short one is just shown. */
const EXPAND_UP_TO=8;

/**
 * Rendered two ways from one implementation: the client fetches its own data, and the staff
 * preview passes the same read model straight in. Forking a second component for the preview
 * would have been easier and wrong — the claim "this is what your client sees" is only true
 * while there is one renderer to be wrong in.
 */
export function PortalReductionPlan({model:provided}:{model?:PortalStrategiesReadModel}={}){
  const [model,setModel]=useState<PortalStrategiesReadModel|null>(provided??null),[error,setError]=useState("");
  useEffect(()=>{if(provided!==undefined){setModel(provided);return;}
    fetch("/api/portal/strategies",{cache:"no-store"}).then(async response=>{
    if(await redirectIfPortalSessionEnded(response))return;
    const body:unknown=await response.json();
    if(!response.ok)throw new Error((body as {message?:string})?.message??"Your reduction plan could not be loaded.");
    if(!valid(body))throw new Error("Your reduction plan returned an unexpected response.");
    setModel(body);
  }).catch(cause=>{setError(cause instanceof Error?cause.message:"Your reduction plan could not be loaded.")})},[provided]);

  if(error)return <section className="nz-panel"><div className="nz-portal-state failed" role="alert"><i>!</i><div>
    <b>Your reduction plan could not be loaded</b><span>{error} Nothing about your plan has changed.</span></div></div></section>;
  if(model===null)return <section className="nz-panel"><div className="nz-portal-state loading" role="status"><i>↻</i><div>
    <b>Checking your reduction plan</b><span>Looking for dates coming up or passed…</span></div></div></section>;

  // No plan yet is a plan being written, not a failure and not a zero.
  if(model.total===0)return <section className="nz-panel"><div className="nz-card-b">
    <span className="nz-eyebrow">Your reduction plan</span>
    <h2 style={{margin:"2px 0 8px",fontSize:16}}>Your reduction plan is being built with your consultant</h2>
    <p className="sub" style={{marginTop:0}}>
      Once you and your NZI consultant have agreed the actions to take, they appear here — with the
      dates you set — and you can follow them as they progress.
    </p>
  </div></section>;

  const expanded=model.plan.reduce((count,group)=>count+group.strategies.length,0)<=EXPAND_UP_TO;
  return <>
    {/* Dates first: an action that has passed its date is the most actionable thing here. */}
    {model.highlights.length>0?<section className="nz-panel"><div className="nz-card-b">
      <span className="nz-eyebrow">Your reduction plan</span>
      <h2 style={{margin:"2px 0 8px",fontSize:16}}>{headline(model)}</h2>
      <p className="sub" style={{marginTop:0}}>
        Dates you set with your NZI consultant. Talk to them if any of these need to move — a date that
        has moved is better than a date that has passed.
      </p>
      <div>{model.highlights.map((highlight,index)=><Row key={`${highlight.title}-${index}`} highlight={highlight}/>)}</div>
    </div></section>:null}

    <section className="nz-panel"><div className="nz-card-b">
      <span className="nz-eyebrow">Decarbonisation plan</span>
      <h2 style={{margin:"2px 0 8px",fontSize:16}}>{model.total} action{model.total===1?"":"s"} on your plan</h2>
      <p className="sub" style={{marginTop:0}}>
        Agreed with your NZI consultant and kept up to date by them. Grouped by the theme each action
        sits under.
        {/* Levers are many-to-many with actions (DESIGN_CONVENTIONS §3.3), so an action that serves
            two themes is listed under both. The count above is of actions, not of rows — said here
            rather than left for a reader to reconcile from a total that looks wrong. */}
        {model.plan.some(group=>group.strategies.some(strategy=>strategy.alsoUnder.length>0))
          ? " A few actions serve more than one theme, so you will see them listed under each — the count above is of actions, not of entries."
          : null}
      </p>
      <div className="nz-portal-plan">
        {model.plan.map(group=><Group key={group.key} group={group} defaultOpen={expanded}/>)}
      </div>
    </div></section>
  </>;
}

function Group({group,defaultOpen}:{group:PortalPlanGroup;defaultOpen:boolean}){
  return <Collapsible title={group.label} count={`${group.strategies.length}`} defaultOpen={defaultOpen}>
    {group.strategies.map(strategy=><Strategy key={strategy.id} strategy={strategy}/>)}
  </Collapsible>;
}

function Strategy({strategy}:{strategy:PortalPlanStrategy}){
  const due=strategy.deadline.state;
  return <article className="nz-portal-plan-item">
    <div className="nz-portal-plan-head">
      <b>{strategy.title}</b>
      {/* A date only appears when one was set. None is shown as nothing, never as a guess. */}
      {strategy.targetDate!==null?<span className={due==="overdue"?"nz-deadline late":due==="approaching"?"nz-deadline soon":"nz-portal-plan-date"}>
        {formatDate(strategy.targetDate)}{due==="overdue"?" · passed":due==="approaching"?" · coming up":""}
      </span>:null}
    </div>
    {strategy.description!==""?<p className="sub">{strategy.description}</p>:null}
    <div className="nz-portal-plan-chips">
      <span className="nz-st est">{strategy.scopeLabel}</span>
      <span className="nz-st est">{strategy.controlLevelLabel}</span>
      {strategy.category!==""?<span className="nz-st est">{strategy.category}</span>:null}
      <span className={strategy.status==="complete"?"nz-st done":strategy.status==="in_progress"?"nz-st need":"nz-st est"}>{strategy.statusLabel}</span>
    </div>
    <div className="nz-prog">
      <span className="track"><span className="fill" style={{width:`${strategy.progressPct}%`}}/></span>
      <span className="num">{strategy.progressPct}%</span>
    </div>
    {/* The same action under another theme is not a second action. Saying so on the row is what
        stops it reading as a duplicated entry — and as a plan padded to look busier. */}
    {strategy.alsoUnder.length>0?<p className="nz-portal-plan-also">
      Also listed under {strategy.alsoUnder.join(" and ")} — it is the same action, counted once.
    </p>:null}
    {/* The client-facing half of the shared spine: what this action moves in your reporting. */}
    {strategy.srsRequirements.length>0?<div className="nz-portal-plan-srs">
      <span className="l">Supports your UK SRS reporting</span>
      <ul>{strategy.srsRequirements.map(requirement=><li key={requirement.code}>
        <b>{requirement.code}</b> {requirement.title}
      </li>)}</ul>
    </div>:null}
  </article>;
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
        {highlight.category}
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
