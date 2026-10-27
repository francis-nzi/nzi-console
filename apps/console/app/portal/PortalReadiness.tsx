"use client";
import { useOrganisationName } from "../lib/OrganisationNameProvider";
import {useEffect,useState} from "react";
import {Collapsible,Drawer} from "@nzi/ui";
import {SrsDial,SrsMeter,SrsPillarTable,SrsRadar,SrsScaleKey} from "@nzi/charts";
import type {ReportSrsRoadmapGap,ReportSrsRoadmapPillar,SrsDashboardModel,SrsDashboardRequirement} from "@nzi/contracts";
import type {PortalReadinessReadModel} from "@nzi/isolated-backend";
import {formatDate} from "../lib/formatDate";
import {redirectIfPortalSessionEnded} from "./portalSessionClient";
import {postBrowserCommand} from "@nzi/api-client";
import {portalFeatureEnabled} from "../lib/portalFlags";

/**
 * The client's own UK SRS readiness — where they stand, and what is aimed at each gap.
 *
 * Sits with the reduction plan so the two read as one page: readiness says where you are,
 * the plan says what you are doing, and each gap here names the strategies from that plan
 * which address it.
 *
 * **Live, not frozen.** Resolved from the current completed assessment on every load, so a
 * re-assessment by the consultant shows here next time the client opens the page. The report
 * they were sent keeps its own frozen readiness; these are two reads of one assessment, for
 * two purposes.
 *
 * **SRS S2.** The headline, the four pillar dials and the radar are the same components the
 * consultant's dashboard draws, from the same model (`dashboard`), on the same five-step ladder —
 * so the client and the consultant are looking at one picture. The core questions open in
 * drawers: the question, the step reached, its evidence and its history. No owner, due date or
 * internal action link reaches this page (NZC-110); the model never carries them.
 *
 * Read-only throughout — the assessment is consultant-led, and there is no control here that
 * implies otherwise.
 */

const valid=(value:unknown):value is PortalReadinessReadModel=>{
  if(!value||typeof value!=="object")return false;
  const model=value as PortalReadinessReadModel;
  return model.state==="none"?typeof model.reason==="string"
    :model.state==="assessed"&&Array.isArray(model.roadmap?.pillars)&&typeof model.dashboard?.overall?.level==="number"
      &&Array.isArray(model.dashboard.pillars)&&Array.isArray(model.dashboard.requirements)&&Array.isArray(model.dashboard.ladder);
};

/** A short readiness has its gaps open; a long one opens collapsed so the page stays scannable. */
const EXPAND_UP_TO=6;

const shortPillar=(label:string)=>label.length<=11?label:label.replace(/\bmanagement\b/i,"mgmt").replace(/\s*&\s*targets$/i,"").slice(0,12).trim();
const signed=(delta:number|null)=>delta===null?null:delta===0?"no change":`${delta>0?"▲ +":"▼ −"}${Math.abs(delta).toFixed(1)}`;

/**
 * Rendered two ways from one implementation: the client fetches its own data, and the staff
 * preview passes the same read model straight in. Forking a second component for the preview
 * would have been easier and wrong — the claim "this is what your client sees" is only true
 * while there is one renderer to be wrong in.
 */
export function PortalReadiness({model:provided}:{model?:PortalReadinessReadModel}={}){
  const org=useOrganisationName();
  const [model,setModel]=useState<PortalReadinessReadModel|null>(provided??null),[error,setError]=useState("");
  const [dialsAs,setDialsAs]=useState<"dials"|"meters">("dials");
  const [openId,setOpenId]=useState<string|null>(null);
  useEffect(()=>{if(provided!==undefined){setModel(provided);return;}
    fetch("/api/portal/readiness",{cache:"no-store"}).then(async response=>{
    if(await redirectIfPortalSessionEnded(response))return;
    const body:unknown=await response.json();
    if(!response.ok)throw new Error((body as {message?:string})?.message??"Your readiness assessment could not be loaded.");
    if(!valid(body))throw new Error("Your readiness assessment returned an unexpected response.");
    setModel(body);
  }).catch(cause=>{setError(cause instanceof Error?cause.message:"Your readiness assessment could not be loaded.")})},[provided]);

  if(error)return <section className="nz-panel"><div className="nz-portal-state failed" role="alert"><i>!</i><div>
    <b>Your readiness assessment could not be loaded</b><span>{error} Nothing about your assessment has changed.</span></div></div></section>;
  if(model===null)return <section className="nz-panel"><div className="nz-portal-state loading" role="status"><i>↻</i><div>
    <b>Checking your readiness assessment</b><span>Reading your latest completed assessment…</span></div></div></section>;

  // Not assessed is not zero. A 0 here would read as a score the client had been given.
  if(model.state==="none")return <section className="nz-panel"><div className="nz-card-b">
    <span className="nz-eyebrow">UK SRS readiness</span>
    <h2 style={{margin:"2px 0 8px",fontSize:16}}>Your readiness assessment is in progress</h2>
    <p className="sub" style={{marginTop:0}}>{model.reason}</p>
  </div></section>;

  const dashboard=model.dashboard;
  const totalGaps=model.roadmap.pillars.reduce((count,pillar)=>count+pillar.gaps.length,0);
  const expanded=totalGaps<=EXPAND_UP_TO;
  const rows=dashboard.pillars.map(pillar=>({label:pillar.label,level:pillar.level,stepName:pillar.stepName,target:pillar.targetLevel,delta:pillar.delta}));
  const open=dashboard.requirements.find(requirement=>requirement.id===openId)??null;
  // S3, R2: AI ideas for the gaps, as your adviser left them shown — labelled, examples only. In your own session, with
  // plan participation on (A2), an idea can be sent to your adviser as a proposal; the preview shows them and acts on none.
  const ideas=model.ideas??[];
  const codeToId=new Map(dashboard.requirements.map(requirement=>[requirement.code,requirement.id]));
  const ideasFor=(requirementId:string|undefined)=>requirementId?ideas.filter(idea=>idea.requirementId===requirementId):[];
  const canPropose=provided===undefined&&portalFeatureEnabled("portal-plan-participation");

  return <>
  <section className="nz-panel"><div className="nz-card-b">
    <span className="nz-eyebrow">UK SRS readiness</span>
    {/* The headline: the step reached, with its number — the same figure the consultant sees. */}
    <div className="nz-srs-hero2 portal">
      <div className="v num">{dashboard.overall.level.toFixed(1)}<small> of 4</small></div>
      <div>
        <h2 style={{margin:"0 0 4px",fontSize:16}}><span className="nz-srs-chip" data-step={dashboard.overall.step}>{dashboard.overall.step}</span> {dashboard.overall.stepName}</h2>
        <div className="d">{signed(dashboard.overall.delta)?<>{signed(dashboard.overall.delta)} since your previous assessment</>:"Your first completed assessment"}</div>
      </div>
    </div>
    <p className="sub" style={{marginTop:0}}>
      Assessed with {org.your("consultant")} on {formatDate(model.assessedOn)} against {model.frameworkLabel} version {model.frameworkVersion}.
      This is how ready your own reporting is — not a statement that anything has been filed or assured.
    </p>
    <SrsScaleKey ladder={dashboard.ladder}/>
  </div></section>

  <section className="nz-panel"><div className="nz-card-b">
    <div className="nz-srs-sechead"><h3 className="nz-portal-readiness-h">By pillar</h3><span className="sp"/>
      <span className="nz-srs-seg" role="group" aria-label="Show as">
        <button type="button" aria-pressed={dialsAs==="dials"} onClick={()=>setDialsAs("dials")}>Dials</button>
        <button type="button" aria-pressed={dialsAs==="meters"} onClick={()=>setDialsAs("meters")}>Meters</button>
      </span></div>
    {dialsAs==="dials"
      ?<div className="nz-srs-dials">{dashboard.pillars.map(pillar=><SrsDial key={pillar.key} label={pillar.label} level={pillar.level} stepName={pillar.stepName} target={pillar.targetLevel}/>)}</div>
      :<SrsMeter rows={dashboard.pillars.map(pillar=>({label:pillar.label,level:pillar.level,stepName:pillar.stepName,target:pillar.targetLevel}))}/>}
    <div className="nz-srs-radar2">
      <SrsRadar axes={dashboard.pillars.map(pillar=>({label:shortPillar(pillar.label),value:pillar.level,target:pillar.targetLevel}))} seriesLabel="Your readiness"/>
      <SrsPillarTable rows={rows} caption="Your readiness by pillar"/>
    </div>
    <p className="nz-portal-readiness-ev">{model.evidenced.count} of {model.evidenced.total} requirements have evidence recorded against them.</p>
  </div></section>

  <section className="nz-panel"><div className="nz-card-b">
    <h3 className="nz-portal-readiness-h">The questions</h3>
    <p className="sub" style={{marginTop:0}}>Each requirement your assessment covered — open one to see the question, where you stand on it, the evidence behind it and how it has moved.</p>
    <QuestionList model={dashboard} onOpen={setOpenId}/>
  </div></section>

  <section className="nz-panel"><div className="nz-card-b">
    {totalGaps===0
      ? <p className="sub">No requirement sits below what the framework expects of it. Your consultant will reassess as the standards move.</p>
      : <>
        <h3 className="nz-portal-readiness-h">What to address next</h3>
        <p className="sub" style={{marginTop:0}}>
          Furthest short first, with the actions on your plan that advance each one.
          {model.roadmap.unaddressedCount>0
            ? ` ${model.roadmap.unaddressedCount} ${model.roadmap.unaddressedCount===1?"has":"have"} no action aligned yet — worth raising with your consultant.`
            : ""}
        </p>
        <div className="nz-portal-readiness-gaps">
          {model.roadmap.pillars.map(pillar=><PillarGaps key={pillar.key} pillar={pillar} defaultOpen={expanded} ideasFor={code=>ideasFor(codeToId.get(code))} canPropose={canPropose}/>)}
        </div>
      </>}
  </div></section>

  <Drawer open={open!==null} onClose={()=>setOpenId(null)} ariaLabel={open?`${open.code} ${open.title}`:"Requirement"} className="nz-site-drawer nz-pdv-drawer" dismissOnOutsideClick>
    {open?<QuestionDrawer requirement={open} ideas={ideasFor(open.id)} canPropose={canPropose} onClose={()=>setOpenId(null)}/>:null}
  </Drawer>
  </>;
}

/** The core questions, grouped by pillar — each a button that opens its drawer. Read-only: nothing here edits. */
function QuestionList({model,onOpen}:{model:SrsDashboardModel;onOpen:(id:string)=>void}){
  const groups:Array<{key:string;label:string;requirements:SrsDashboardRequirement[]}>=[];
  for(const requirement of model.requirements){
    let group=groups.find(entry=>entry.key===requirement.pillarKey);
    if(!group){group={key:requirement.pillarKey,label:requirement.pillarLabel,requirements:[]};groups.push(group);}
    group.requirements.push(requirement);
  }
  return <div className="nz-portal-readiness-gaps nz-srs-questions">{groups.map(group=><Collapsible key={group.key} title={group.label} count={`${group.requirements.length}`}>
    <ul className="nz-srs-qlist">{group.requirements.map(requirement=><li key={requirement.id}>
      <button type="button" onClick={()=>onOpen(requirement.id)}>
        <span className="nz-tag">{requirement.code}</span>
        <span className="t">{requirement.title}</span>
        {requirement.maturity===null
          ?<span className="muted">Not answered</span>
          :<span className="s"><span className="nz-srs-chip" data-step={requirement.maturity}>{requirement.maturity}</span> {requirement.stepName}</span>}
      </button>
    </li>)}</ul>
  </Collapsible>)}</div>;
}

type Idea={requirementId:string;title:string;how:string};

function QuestionDrawer({requirement,ideas,canPropose,onClose}:{requirement:SrsDashboardRequirement;ideas:Idea[];canPropose:boolean;onClose:()=>void}){
  const evidenceKind={document:"Document",data:"From your own reported data",note:"Note"} as const;
  return <div className="nz-pdv-drawer-b">
    <div className="nz-pdv-drawer-h">
      <span className="nz-eyebrow">{requirement.pillarLabel} · {requirement.code}</span>
      <h2>{requirement.title}</h2>
    </div>
    {requirement.helpText?<div className="nz-pdv-sec"><h3>The question</h3><p>{requirement.helpText}</p></div>:null}
    <div className="nz-pdv-sec"><h3>Where you stand</h3>
      <dl className="nz-pdv-facts">
        <div><dt>Step reached</dt><dd>{requirement.maturity===null?"Not answered in this assessment"
          :<><span className="nz-srs-chip" data-step={requirement.maturity}>{requirement.maturity}</span> {requirement.stepName}</>}</dd></div>
        <div><dt>Expected</dt><dd>Step {requirement.target}</dd></div>
        {requirement.source==="auto"?<div><dt>Answered from</dt><dd>Your own assured record</dd></div>:null}
      </dl>
    </div>
    <div className="nz-pdv-sec"><h3>Evidence</h3>
      {requirement.evidence
        ?<p><b>{evidenceKind[requirement.evidence.kind]}</b>{requirement.evidence.ref?` · ${requirement.evidence.ref}`:""}{requirement.evidence.note?<><br/>{requirement.evidence.note}</>:null}</p>
        :<p>No evidence is recorded against this requirement yet.</p>}
    </div>
    {ideas.length>0?<div className="nz-pdv-sec"><Ideas ideas={ideas} code={requirement.code} canPropose={canPropose}/></div>:null}
    <div className="nz-pdv-sec"><h3>History</h3>
      {requirement.history.length===0?<p>This is its first assessment.</p>
        :<table className="nz-srs-table"><caption className="nz-sr-only">Step reached at each completed assessment</caption>
          <thead><tr><th scope="col">Assessed</th><th scope="col">Step</th></tr></thead>
          <tbody>{requirement.history.map(point=><tr key={point.assessedOn}><th scope="row">{formatDate(point.assessedOn)}</th>
            <td>{point.maturity===null?"Not answered":<><span className="nz-srs-chip" data-step={point.maturity}>{point.maturity}</span> {point.stepName}</>}</td></tr>)}</tbody>
        </table>}
    </div>
    <div className="nz-pdv-sec"><button type="button" className="nz-btn" onClick={onClose}>Close</button></div>
  </div>;
}

function PillarGaps({pillar,defaultOpen,ideasFor,canPropose}:{pillar:ReportSrsRoadmapPillar;defaultOpen:boolean;ideasFor:(code:string)=>Idea[];canPropose:boolean}){
  return <Collapsible title={pillar.label} count={`${pillar.gaps.length}`} defaultOpen={defaultOpen}>
    {pillar.gaps.map(gap=><Gap key={gap.code} gap={gap} ideas={ideasFor(gap.code)} canPropose={canPropose}/>)}
  </Collapsible>;
}

function Gap({gap,ideas,canPropose}:{gap:ReportSrsRoadmapGap;ideas:Idea[];canPropose:boolean}){
  return <div className="nz-portal-gap">
    <div className="hd">
      <span className="nz-tag">{gap.code}</span>
      <b>{gap.title}</b>
      <span className="lv">{gap.maturityLabel} → {gap.targetLabel}</span>
    </div>
    {/* The other axis of what the client already holds: their plan, read per gap. */}
    {gap.strategies.length>0
      ? <ul>{gap.strategies.map(strategy=><li key={strategy.title}>
        {strategy.title} <span className="st">{strategy.statusLabel}</span>
      </li>)}</ul>
      : <p className="none">No action aligned yet.</p>}
    {ideas.length>0?<Ideas ideas={ideas} code={gap.code} canPropose={canPropose}/>:null}
  </div>;
}

/**
 * Ideas from AI for one gap (S3, R2) — always labelled as AI and framed as examples, never as advice or as part of your
 * plan. With plan participation on, an idea can be sent to your adviser as your own proposal (A2): it joins nothing until
 * they take it forward.
 */
function Ideas({ideas,code,canPropose}:{ideas:Idea[];code:string;canPropose:boolean}){
  const [sent,setSent]=useState<Record<string,"sending"|"sent"|string>>({});
  async function propose(idea:Idea){
    setSent(now=>({...now,[idea.title]:"sending"}));
    const result=await postBrowserCommand("/api/portal/strategies/proposals",{title:idea.title,scope:"governance",note:`${idea.how} (An idea suggested by AI for ${code}.)`},crypto.randomUUID());
    setSent(now=>({...now,[idea.title]:result.state==="success"?"sent":(result.state==="validation_failed"?(result.issues[0]?.message??result.message):result.message)}));
  }
  return <div className="nz-portal-ideas">
    <span className="l"><span className="nz-tag nz-ai-tag">AI</span> Ideas suggested by AI — examples to discuss with your adviser, not advice</span>
    <ul>{ideas.map(idea=><li key={idea.title}>
      <b>{idea.title}</b><p>{idea.how}</p>
      {canPropose?(sent[idea.title]==="sent"?<p className="hint">Sent to your adviser as your proposal.</p>
        :<><button type="button" className="nz-btn sm" disabled={sent[idea.title]==="sending"} onClick={()=>void propose(idea)}>{sent[idea.title]==="sending"?"Sending…":"Suggest this to your adviser"}</button>
          {sent[idea.title]&&sent[idea.title]!=="sending"?<span className="hint" role="alert"> {sent[idea.title]}</span>:null}</>):null}
    </li>)}</ul>
  </div>;
}
