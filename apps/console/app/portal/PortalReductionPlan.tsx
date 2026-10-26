"use client";
import { useOrganisationName } from "../lib/OrganisationNameProvider";
import {useCallback,useEffect,useRef,useState} from "react";
import {Collapsible,Drawer} from "@nzi/ui";
import {patchBrowserCommand,postBrowserCommand,type BrowserCommandResult} from "@nzi/api-client";
import {strategyStatusLabels,type StrategyStatus} from "@nzi/contracts";
import type {PortalPlanParticipation,PortalPlanGroup,PortalPlanStrategy,PortalProposal,PortalStrategiesReadModel,PortalStrategyHighlight} from "@nzi/isolated-backend";
import {formatDate} from "../lib/formatDate";
import {redirectIfPortalSessionEnded} from "./portalSessionClient";

/**
 * The client's own reduction plan: the dates they are approaching, and the plan itself.
 *
 * **Actions A2.** With `portal-plan-participation` on, the client has a hand in it: they **add** an action from the library (it
 * joins as Proposed, for their adviser to agree), **propose** one of their own (it waits "with your adviser" until it is
 * approved or not taken forward), **nominate an owner** from their own team, and — on the actions **they own** — move the
 * date, progress and status along the owner's half of the ladder. There is no delete, and nothing here agrees, declines
 * or aligns: those stay the adviser's. Off, or in the staff preview, this is the read-only plan it always was.
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

const errorText=(result:BrowserCommandResult<unknown>)=>
  result.state==="validation_failed"?(result.issues[0]?.message??result.message):result.state==="success"?"":result.message;

/** A long plan opens collapsed so the page stays scannable; a short one is just shown. */
const EXPAND_UP_TO=8;

type Panel={kind:"library"}|{kind:"propose"}|{kind:"update";strategy:PortalPlanStrategy};

/**
 * Rendered two ways from one implementation: the client fetches its own data, and the staff
 * preview passes the same read model straight in. Forking a second component for the preview
 * would have been easier and wrong — the claim "this is what your client sees" is only true
 * while there is one renderer to be wrong in. The preview never acts: it shows the same plan
 * with no controls.
 */
export function PortalReductionPlan({model:provided}:{model?:PortalStrategiesReadModel}={}){
  const org=useOrganisationName();
  const [model,setModel]=useState<PortalStrategiesReadModel|null>(provided??null),[error,setError]=useState("");
  const [panel,setPanel]=useState<Panel|null>(null),[notice,setNotice]=useState<string|null>(null);
  const load=useCallback(()=>fetch("/api/portal/strategies",{cache:"no-store"}).then(async response=>{
    if(await redirectIfPortalSessionEnded(response))return;
    const body:unknown=await response.json();
    if(!response.ok)throw new Error((body as {message?:string})?.message??"Your reduction plan could not be loaded.");
    if(!valid(body))throw new Error("Your reduction plan returned an unexpected response.");
    setModel(body);
  }).catch(cause=>{setError(cause instanceof Error?cause.message:"Your reduction plan could not be loaded.")}),[]);
  useEffect(()=>{if(provided!==undefined){setModel(provided);return;}void load();},[provided,load]);

  if(error)return <section className="nz-panel"><div className="nz-portal-state failed" role="alert"><i>!</i><div>
    <b>Your reduction plan could not be loaded</b><span>{error} Nothing about your plan has changed.</span></div></div></section>;
  if(model===null)return <section className="nz-panel"><div className="nz-portal-state loading" role="status"><i>↻</i><div>
    <b>Checking your reduction plan</b><span>Looking for dates coming up or passed…</span></div></div></section>;

  // A2: the client acts only in their own session, and only when participation is on. The preview shows; it never acts.
  const participation=model.participation??null;
  const interactive=provided===undefined&&participation!==null;
  const saved=(text:string)=>{setPanel(null);setNotice(text);void load();};
  const actions=interactive?<div className="nz-portal-plan-actions">
    <button type="button" className="nz-btn" onClick={()=>{setNotice(null);setPanel({kind:"library"});}}>Add an action from the library</button>
    <button type="button" className="nz-btn" onClick={()=>{setNotice(null);setPanel({kind:"propose"});}}>Propose your own action</button>
  </div>:null;
  const drawer=interactive&&participation?<Drawer open={panel!==null} onClose={()=>setPanel(null)} className="nz-site-drawer nz-pdv-drawer" dismissOnOutsideClick
    ariaLabel={panel?.kind==="library"?"Add an action from the library":panel?.kind==="propose"?"Propose an action":panel?.kind==="update"?`Update ${panel.strategy.title}`:"Your plan"}>
    {panel?.kind==="library"?<LibraryPanel participation={participation} onClose={()=>setPanel(null)} onSaved={saved}/>:null}
    {panel?.kind==="propose"?<ProposePanel participation={participation} onClose={()=>setPanel(null)} onSaved={saved}/>:null}
    {panel?.kind==="update"?<UpdatePanel key={`${panel.strategy.id}-${panel.strategy.version}`} strategy={panel.strategy} participation={participation} onClose={()=>setPanel(null)} onSaved={saved}/>:null}
  </Drawer>:null;
  const proposals=participation&&participation.proposals.length>0?<Proposals proposals={participation.proposals}/>:null;
  const banner=notice?<div className="nz-banner" role="status">{notice}</div>:null;

  // No plan yet is a plan being written, not a failure and not a zero.
  if(model.total===0)return <>
    {banner}
    <section className="nz-panel"><div className="nz-card-b">
      <span className="nz-eyebrow">Your reduction plan</span>
      <h2 style={{margin:"2px 0 8px",fontSize:16}}>Your reduction plan is being built with your consultant</h2>
      <p className="sub" style={{marginTop:0}}>
        Once you and {org.your("consultant")} have agreed the actions to take, they appear here — with the
        dates you set — and you can follow them as they progress.
        {interactive?" You can suggest actions now: add one from the library, or propose your own.":""}
      </p>
      {actions}
    </div></section>
    {proposals}
    {drawer}
  </>;

  const expanded=model.plan.reduce((count,group)=>count+group.strategies.length,0)<=EXPAND_UP_TO;
  return <>
    {banner}
    {/* Dates first: an action that has passed its date is the most actionable thing here. */}
    {model.highlights.length>0?<section className="nz-panel"><div className="nz-card-b">
      <span className="nz-eyebrow">Your reduction plan</span>
      <h2 style={{margin:"2px 0 8px",fontSize:16}}>{headline(model)}</h2>
      <p className="sub" style={{marginTop:0}}>
        Dates you set with {org.your("consultant")}. Talk to them if any of these need to move — a date that
        has moved is better than a date that has passed.
      </p>
      <div>{model.highlights.map((highlight,index)=><Row key={`${highlight.title}-${index}`} highlight={highlight}/>)}</div>
    </div></section>:null}

    <section className="nz-panel"><div className="nz-card-b">
      <span className="nz-eyebrow">Decarbonisation plan</span>
      <h2 style={{margin:"2px 0 8px",fontSize:16}}>{model.total} action{model.total===1?"":"s"} on your plan</h2>
      <p className="sub" style={{marginTop:0}}>
        {interactive
          ?<>Agreed with {org.your("consultant")}. Give each action an owner from your team; the owner keeps its date and progress up to date here.</>
          :<>Agreed with {org.your("consultant")} and kept up to date by them. Grouped by the theme each action sits under.</>}
      </p>
      {actions}
      <div className="nz-portal-plan">
        {model.plan.map(group=><Group key={group.key} group={group} defaultOpen={expanded}
          onUpdate={interactive?(strategy)=>{setNotice(null);setPanel({kind:"update",strategy});}:null}/>)}
      </div>
    </div></section>
    {proposals}
    {drawer}
  </>;
}

function Group({group,defaultOpen,onUpdate}:{group:PortalPlanGroup;defaultOpen:boolean;onUpdate:((strategy:PortalPlanStrategy)=>void)|null}){
  return <Collapsible title={group.label} count={`${group.strategies.length}`} defaultOpen={defaultOpen}>
    {group.strategies.map(strategy=><Strategy key={strategy.id} strategy={strategy} onUpdate={onUpdate}/>)}
  </Collapsible>;
}

function Strategy({strategy,onUpdate}:{strategy:PortalPlanStrategy;onUpdate:((strategy:PortalPlanStrategy)=>void)|null}){
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
    {/* The owner is one of the client's own team (A1); a consultant is never named here. */}
    {strategy.owner!==""||onUpdate?<div className="nz-portal-plan-owner">
      <span className="sub">{strategy.owner!==""?<>Owner: <b>{strategy.owner}</b>{strategy.yours?" (you)":""}</>:"No owner yet"}</span>
      {onUpdate?<button type="button" className="nz-btn sm" onClick={()=>onUpdate(strategy)}>{strategy.yours?"Update":"Set owner"}</button>:null}
    </div>:null}
    {/* The client-facing half of the shared spine: what this action moves in your reporting. */}
    {strategy.srsRequirements.length>0?<div className="nz-portal-plan-srs">
      <span className="l">Supports your UK SRS reporting</span>
      <ul>{strategy.srsRequirements.map(requirement=><li key={requirement.code}>
        <b>{requirement.code}</b> {requirement.title}
      </li>)}</ul>
    </div>:null}
  </article>;
}

/** A2, R2: what the client proposed — with their adviser, or not taken forward with the reason. Never a staff name. */
function Proposals({proposals}:{proposals:PortalProposal[]}){
  return <section className="nz-panel"><div className="nz-card-b">
    <span className="nz-eyebrow">Your proposals</span>
    <h2 style={{margin:"2px 0 8px",fontSize:16}}>Actions you proposed</h2>
    {proposals.map(proposal=><article className="nz-portal-plan-item" key={proposal.id}>
      <div className="nz-portal-plan-head">
        <b>{proposal.title}</b>
        <span className={proposal.state==="pending"?"nz-st need":"nz-st est"}>{proposal.state==="pending"?"Proposed — with your adviser":"Not taken forward"}</span>
      </div>
      <p className="sub" style={{margin:"2px 0"}}>{proposal.scopeLabel} · proposed {formatDate(proposal.proposedOn)}{proposal.decidedOn?` · answered ${formatDate(proposal.decidedOn)}`:""}</p>
      {proposal.note!==""?<p className="sub" style={{margin:"2px 0"}}>{proposal.note}</p>:null}
      {proposal.state==="declined"&&proposal.reason?<p className="sub nz-portal-proposal-reason"><b>Why:</b> {proposal.reason}</p>:null}
    </article>)}
  </div></section>;
}

function PanelHead({kicker,title,sub}:{kicker:string;title:string;sub?:string}){
  return <div className="nz-pdv-drawer-h"><span className="nz-eyebrow">{kicker}</span><h2>{title}</h2>{sub?<p className="sub" style={{margin:0}}>{sub}</p>:null}</div>;
}

function LibraryPanel({participation,onClose,onSaved}:{participation:PortalPlanParticipation;onClose:()=>void;onSaved:(text:string)=>void}){
  const [pending,setPending]=useState<string|null>(null),[error,setError]=useState<string|null>(null);
  async function add(id:string,title:string){
    setPending(id);setError(null);
    const result=await postBrowserCommand<{clientStrategyId:string}>("/api/portal/strategies",{strategyId:id},crypto.randomUUID());
    setPending(null);
    if(result.state!=="success"){setError(errorText(result));return;}
    onSaved(`${title} is on your plan as Proposed — your adviser will agree it with you.`);
  }
  return <div className="nz-pdv-drawer-b">
    <PanelHead kicker="Your plan" title="Add an action from the library" sub="It joins your plan as Proposed, for your adviser to agree."/>
    {error?<div className="nz-banner warn" role="alert">{error}</div>:null}
    {participation.library.length===0?<p className="sub">Every action in the library is already on your plan.</p>
      :<ul className="nz-portal-library">{participation.library.map(entry=><li key={entry.id}>
        <div><b>{entry.title}</b><div className="sub">{entry.scopeLabel}{entry.category?` · ${entry.category}`:""}</div>
          {entry.description?<p className="sub" style={{margin:"2px 0 0"}}>{entry.description}</p>:null}</div>
        <button type="button" className="nz-btn sm" disabled={pending!==null} onClick={()=>void add(entry.id,entry.title)}>{pending===entry.id?"Adding…":"Add"}</button>
      </li>)}</ul>}
    <div className="nz-pdv-sec"><button type="button" className="nz-btn" onClick={onClose}>Close</button></div>
  </div>;
}

function ProposePanel({participation,onClose,onSaved}:{participation:PortalPlanParticipation;onClose:()=>void;onSaved:(text:string)=>void}){
  const [title,setTitle]=useState(""),[scope,setScope]=useState(participation.scopes[0]?.value??"1"),[note,setNote]=useState("");
  const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
  const key=useRef<string|null>(null);
  async function propose(){
    setPending(true);setError(null);key.current??=crypto.randomUUID();
    const result=await postBrowserCommand<{clientStrategyId:string}>("/api/portal/strategies/proposals",{title,scope,note},key.current);
    setPending(false);
    if(result.state!=="success"){key.current=null;setError(errorText(result));return;}
    key.current=null;
    onSaved("Proposal sent. It shows here as with your adviser until they take it forward.");
  }
  return <div className="nz-pdv-drawer-b">
    <PanelHead kicker="Your plan" title="Propose your own action" sub="Something you plan to do that is not in the library. Your adviser reviews it before it joins your plan."/>
    <label className="nz-fl"><span>What will you do?</span>
      <input className="nz-inp" value={title} maxLength={200} onChange={event=>setTitle(event.target.value)} placeholder="e.g. Switch the delivery vans to electric"/></label>
    <label className="nz-fl"><span>What is it mainly about?</span>
      <select className="nz-sel" value={scope} onChange={event=>setScope(event.target.value)}>
        {participation.scopes.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
    <label className="nz-fl"><span>Anything your adviser should know (optional)</span>
      <textarea className="nz-notes" rows={4} maxLength={2000} value={note} onChange={event=>setNote(event.target.value)}/></label>
    {error?<div className="nz-banner warn" role="alert">{error}</div>:null}
    <div className="nz-pdv-sec nz-portal-plan-actions">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-btn pri" disabled={pending||title.trim()===""} onClick={()=>void propose()}>{pending?"Sending…":"Send to your adviser"}</button>
    </div>
  </div>;
}

/**
 * One action: anyone on the client's team nominates its owner; the owner (and only the owner) moves its date, progress
 * and status — along the moves the owner may make (`nextStatuses`), so nothing offered here is refused on save.
 */
function UpdatePanel({strategy,participation,onClose,onSaved}:{strategy:PortalPlanStrategy;participation:PortalPlanParticipation;onClose:()=>void;onSaved:(text:string)=>void}){
  const [owner,setOwner]=useState(strategy.ownerContactId??"");
  const [status,setStatus]=useState<StrategyStatus>(strategy.status);
  const [progress,setProgress]=useState(strategy.progressPct);
  const [date,setDate]=useState(strategy.targetDate??"");
  const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
  const work=strategy.yours&&strategy.nextStatuses.length>1;
  // Status and progress are one fact seen two ways: complete is 100%, and 100% is complete.
  const chooseStatus=(next:StrategyStatus)=>{setStatus(next);setProgress(next==="complete"?100:progress===100?99:progress);};
  const chooseProgress=(next:number)=>{setProgress(next);if(next===100&&strategy.nextStatuses.includes("complete"))setStatus("complete");else if(status==="complete"&&next<100)setStatus("in_progress");};
  const ownerOptions=participation.contacts;
  const heldOwner=strategy.ownerContactId&&!ownerOptions.some(contact=>contact.id===strategy.ownerContactId)?{id:strategy.ownerContactId,name:strategy.owner||"A team member no longer listed"}:null;
  async function save(){
    setPending(true);setError(null);
    const body:Record<string,unknown>={clientStrategyId:strategy.id,expectedVersion:strategy.version};
    if((owner||null)!==strategy.ownerContactId)body.ownerContactId=owner||null;
    if(strategy.yours){
      if(status!==strategy.status)body.status=status;
      if(progress!==strategy.progressPct)body.progressPct=progress;
      if((date||null)!==strategy.targetDate)body.targetDate=date||null;
    }
    const result=await patchBrowserCommand<{version:number}>("/api/portal/strategies",body,crypto.randomUUID());
    setPending(false);
    if(result.state!=="success"){setError(errorText(result));return;}
    onSaved(`${strategy.title} updated.`);
  }
  return <div className="nz-pdv-drawer-b">
    <PanelHead kicker={`${strategy.scopeLabel} · ${strategy.statusLabel}`} title={strategy.title}/>
    <label className="nz-fl"><span>Owner</span>
      <select className="nz-sel" value={owner} onChange={event=>setOwner(event.target.value)}>
        <option value="">No owner yet</option>
        {ownerOptions.map(contact=><option key={contact.id} value={contact.id}>{contact.name}</option>)}
        {heldOwner?<option value={heldOwner.id}>{heldOwner.name}</option>:null}
      </select>
      <small className="hint">Someone on your team who is a contact with your adviser. The owner keeps this action up to date.</small></label>
    {strategy.yours?<>
      <label className="nz-fl"><span>Status</span>
        <select className="nz-sel" value={status} disabled={!work} onChange={event=>chooseStatus(event.target.value as StrategyStatus)}>
          {strategy.nextStatuses.map(value=><option key={value} value={value}>{strategyStatusLabels[value]}</option>)}
        </select>
        <small className="hint">{work?"Agreeing or declining an action is your adviser's; the rest of the way is yours."
          :strategy.status==="proposed"?"Your adviser agrees this action with you first; then you can start it here.":"This action is moved on by your adviser."}</small></label>
      <label className="nz-fl"><span>Progress — {progress}%</span>
        <input type="range" min={0} max={100} step={5} value={progress} disabled={!work} onChange={event=>chooseProgress(Number(event.target.value))}/></label>
      <label className="nz-fl"><span>{status==="complete"?"Completed":"Target date"}</span>
        <input className="nz-inp" type="date" value={date} onChange={event=>setDate(event.target.value)}/></label>
    </>:<p className="sub">Only the action&rsquo;s owner updates its date and progress. If it is yours, make yourself the owner and save — then you can update it.</p>}
    {error?<div className="nz-banner warn" role="alert">{error}</div>:null}
    <div className="nz-pdv-sec nz-portal-plan-actions">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-btn pri" disabled={pending} onClick={()=>void save()}>{pending?"Saving…":"Save"}</button>
    </div>
  </div>;
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
