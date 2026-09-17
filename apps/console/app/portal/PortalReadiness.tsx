"use client";
import {useEffect,useState} from "react";
import {Collapsible} from "@nzi/ui";
import {CRP_RESOLVER_VERSION,RENDERER_VERSION,SrsMaturityBullets,SrsPillarRadar,TOKENS_VERSION} from "@nzi/charts";
import type {ReportSrsRoadmapGap,ReportSrsRoadmapPillar} from "@nzi/contracts";
import type {PortalReadinessReadModel} from "@nzi/isolated-backend";
import {formatDate} from "../lib/formatDate";
import {redirectIfPortalSessionEnded} from "./portalSessionClient";

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
 * Read-only throughout — the assessment is consultant-led, and there is no control here that
 * implies otherwise.
 */

const valid=(value:unknown):value is PortalReadinessReadModel=>{
  if(!value||typeof value!=="object")return false;
  const model=value as PortalReadinessReadModel;
  return model.state==="none"?typeof model.reason==="string"
    :model.state==="assessed"&&typeof model.overallPct==="number"&&Array.isArray(model.pillars)&&Array.isArray(model.roadmap?.pillars);
};

/** A short readiness has its gaps open; a long one opens collapsed so the page stays scannable. */
const EXPAND_UP_TO=6;

/**
 * Rendered two ways from one implementation: the client fetches its own data, and the staff
 * preview passes the same read model straight in. Forking a second component for the preview
 * would have been easier and wrong — the claim "this is what your client sees" is only true
 * while there is one renderer to be wrong in.
 */
export function PortalReadiness({model:provided}:{model?:PortalReadinessReadModel}={}){
  const [model,setModel]=useState<PortalReadinessReadModel|null>(provided??null),[error,setError]=useState("");
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

  // Not assessed is not zero. A 0% here would read as a score the client had been given.
  if(model.state==="none")return <section className="nz-panel"><div className="nz-card-b">
    <span className="nz-eyebrow">UK SRS readiness</span>
    <h2 style={{margin:"2px 0 8px",fontSize:16}}>Your readiness assessment is in progress</h2>
    <p className="sub" style={{marginTop:0}}>{model.reason}</p>
  </div></section>;

  const totalGaps=model.roadmap.pillars.reduce((count,pillar)=>count+pillar.gaps.length,0);
  const expanded=totalGaps<=EXPAND_UP_TO;
  const provenance={
    jobId:"",dataHash:"",factorSets:[],generatedAt:model.assessedOn,reviewedSnapshotId:"",
    resolverVersion:CRP_RESOLVER_VERSION,tokensVersion:TOKENS_VERSION,rendererVersion:RENDERER_VERSION,
  };

  return <section className="nz-panel"><div className="nz-card-b">
    <span className="nz-eyebrow">UK SRS readiness</span>
    <h2 style={{margin:"2px 0 8px",fontSize:16}}>{model.overallLabel} — {Math.round(model.overallPct)}% ready</h2>
    <p className="sub" style={{marginTop:0}}>
      Assessed with your NZI consultant on {formatDate(model.assessedOn)} against {model.frameworkLabel} version {model.frameworkVersion}.
      This is how ready your own reporting is — not a statement that anything has been filed or assured.
    </p>

    <div className="nz-portal-readiness-charts">
      {model.radar.series.length>0?<SrsPillarRadar showChrome={false} width={280} data={{
        spec:{id:`portal-srs-radar-${model.assessedOn}`,type:"srs_pillar_radar",title:"Readiness by pillar",family:"crp",specVersion:1},
        unit:"level",state:"success",provenance,
        pillars:model.radar.pillars,series:model.radar.series,target:model.radar.target,maxLevel:model.maxLevel,
      }}/>:null}
      <div style={{flex:1,minWidth:250}}>
        <SrsMaturityBullets showChrome={false} data={{
          spec:{id:`portal-srs-bullets-${model.assessedOn}`,type:"srs_maturity_bullets",title:"Maturity by pillar",family:"crp",specVersion:1},
          unit:"level",state:"success",provenance,maxLevel:model.maxLevel,
          rows:model.pillars.map(pillar=>({label:pillar.label,value:pillar.level,valueLabel:pillar.levelLabel,comparison:null,target:pillar.targetLevel})),
        }}/>
      </div>
    </div>
    <p className="nz-portal-readiness-ev">{model.evidenced.count} of {model.evidenced.total} requirements have evidence recorded against them.</p>

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
          {model.roadmap.pillars.map(pillar=><PillarGaps key={pillar.key} pillar={pillar} defaultOpen={expanded}/>)}
        </div>
      </>}
  </div></section>;
}

function PillarGaps({pillar,defaultOpen}:{pillar:ReportSrsRoadmapPillar;defaultOpen:boolean}){
  return <Collapsible title={pillar.label} count={`${pillar.gaps.length}`} defaultOpen={defaultOpen}>
    {pillar.gaps.map(gap=><Gap key={gap.code} gap={gap}/>)}
  </Collapsible>;
}

function Gap({gap}:{gap:ReportSrsRoadmapGap}){
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
  </div>;
}
