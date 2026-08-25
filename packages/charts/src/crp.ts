import { RENDERER_VERSION } from "./identity";
import type { ReportManifest } from "./manifest";
import { TOKENS_VERSION } from "./tokens";
import type { EmissionsByActivityData, ReductionPathwayData, ScopeDonutData } from "./types";

export const CRP_RESOLVER_VERSION = 1;
export type ReviewedScopeMeasurement = { scope: "1" | "2" | "3"; tco2e: number; factorSet: string; reviewed: boolean; included: boolean };
export type ReviewedCrpSnapshot = {
  id: string; jobId: string; jobNumber: string; client: string; reportingYear: number;
  generatedAt: string; dataHash: string; measurements: ReviewedScopeMeasurement[];
  pathway: {
    actual: Array<{ year: number; value: number }>;
    target: Array<{ year: number; value: number }>;
    milestones: Array<{ year: number; value: number; label: string; kind: "baseline" | "interim" | "netzero" }>;
  };
};
export type ReviewedCrpSnapshotCore={id:string;jobId:string;jobNumber:string;client:string;reportingYear:number;generatedAt:string;dataHash:string;measurements:Array<{rowId:string;scope:"1"|"2"|"3";sourceLabel:string;tco2e:number;factorSet:string}>};

export const crpProfessionalManifest: ReportManifest = {
  id: "crp_professional", family: "crp", version: 1,
  charts: [
    { id: "emissions_scope_donut", type: "emissions_scope_donut", specVersion: 2, required: true },
    { id: "reduction_pathway", type: "reduction_pathway", specVersion: 1, required: true },
    { id: "scope_year_on_year_bar", type: "scope_year_on_year_bar", specVersion: 1, required: true },
    { id: "emissions_by_activity", type: "emissions_by_activity", specVersion: 1, required: true },
    { id: "emissions_site_donut", type: "emissions_site_donut", specVersion: 1, required: true },
    { id: "intensity_pathway", type: "intensity_pathway", specVersion: 1, required: true },
    { id: "purchased_goods_breakdown", type: "purchased_goods_breakdown", specVersion: 1, required: true },
  ],
  sections: [
    { id: "footprint", title: "Carbon footprint", description: "Current footprint and route to net zero.", layout: "two-column", chartIds: ["emissions_scope_donut", "reduction_pathway"] },
    { id: "performance", title: "Emissions performance", description: "Annual scope comparison and material activities.", layout: "two-column", chartIds: ["scope_year_on_year_bar", "emissions_by_activity"] },
    { id: "sites-intensity", title: "Operational performance", description: "Site contribution and turnover-intensity targets.", layout: "two-column", chartIds: ["emissions_site_donut", "intensity_pathway"] },
    { id: "purchased-goods", title: "Purchased Goods & Services", description: "Scope 3.1 emissions contribution by purchasing category.", layout: "full-width", chartIds: ["purchased_goods_breakdown"] },
  ],
};

export function resolveCrpCharts(snapshot: ReviewedCrpSnapshot): [ScopeDonutData, ReductionPathwayData] {
  const included = snapshot.measurements.filter((row) => row.included && row.reviewed);
  const unresolved = snapshot.measurements.some((row) => row.included && !row.reviewed);
  const factorSets = Array.from(new Set(included.map((row) => row.factorSet))).sort();
  const totals = new Map<string, number>([["1", 0], ["2", 0], ["3", 0]]);
  for (const row of included) totals.set(row.scope, (totals.get(row.scope) ?? 0) + row.tco2e);
  const provenance = {
    jobId: snapshot.jobId, dataHash: snapshot.dataHash, factorSets, generatedAt: snapshot.generatedAt,
    reviewedSnapshotId: snapshot.id, resolverVersion: CRP_RESOLVER_VERSION,
    tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION,
  };
  const state = unresolved ? "degraded" as const : included.length === 0 ? "empty" as const : "success" as const;
  const stateMessage = unresolved ? "Included measurements remain unreviewed. Publication is blocked." : included.length === 0 ? "No reviewed emissions are available." : undefined;
  return [{
    spec: { id: "emissions_scope_donut", type: "emissions_scope_donut", title: `${snapshot.reportingYear} carbon footprint by scope`, subtitle: `${snapshot.client} · ${snapshot.jobNumber}`, family: "crp", specVersion: 2 },
    unit: "tCO₂e", state, stateMessage,
    segments: [
      { scope: "1", label: "Scope 1 — direct", value: totals.get("1") ?? 0 },
      { scope: "2", label: "Scope 2 — electricity", value: totals.get("2") ?? 0 },
      { scope: "3", label: "Scope 3 — value chain", value: totals.get("3") ?? 0 },
    ], provenance,
  }, {
    spec: { id: "reduction_pathway", type: "reduction_pathway", title: "Emissions reduction pathway to net zero", subtitle: `${snapshot.client} · ${snapshot.jobNumber}`, family: "crp", specVersion: 1 },
    unit: "tCO₂e", state, stateMessage,
    actual: snapshot.pathway.actual, target: snapshot.pathway.target, milestones: snapshot.pathway.milestones,
    provenance,
  }];
}

export function resolveCrpCoreCharts(snapshot:ReviewedCrpSnapshotCore):[ScopeDonutData,EmissionsByActivityData]{const factorSets=Array.from(new Set(snapshot.measurements.map(row=>row.factorSet).filter(Boolean))).sort(),totals=new Map<string,number>([["1",0],["2",0],["3",0]]);for(const row of snapshot.measurements)totals.set(row.scope,(totals.get(row.scope)??0)+row.tco2e);const provenance={jobId:snapshot.jobId,dataHash:snapshot.dataHash,factorSets,generatedAt:snapshot.generatedAt,reviewedSnapshotId:snapshot.id,resolverVersion:CRP_RESOLVER_VERSION,tokensVersion:TOKENS_VERSION,rendererVersion:RENDERER_VERSION};const state=snapshot.measurements.length&&factorSets.length?"success" as const:"empty" as const;return[{spec:{id:"emissions_scope_donut",type:"emissions_scope_donut",title:`${snapshot.reportingYear} carbon footprint by scope`,subtitle:`${snapshot.client} · ${snapshot.jobNumber}`,family:"crp",specVersion:2},unit:"tCO₂e",state,stateMessage:state==="empty"?"No reviewed emissions are available.":undefined,segments:[{scope:"1",label:"Scope 1 — direct",value:totals.get("1")??0},{scope:"2",label:"Scope 2 — electricity",value:totals.get("2")??0},{scope:"3",label:"Scope 3 — value chain",value:totals.get("3")??0}],provenance},{spec:{id:"emissions_by_activity",type:"emissions_by_activity",title:"Largest emissions activities",subtitle:`${snapshot.client} · ${snapshot.jobNumber}`,family:"crp",specVersion:1},unit:"tCO₂e",state,stateMessage:state==="empty"?"No reviewed activities are available.":undefined,activities:[...snapshot.measurements].sort((a,b)=>b.tco2e-a.tco2e).map(row=>({id:row.rowId,label:row.sourceLabel,scope:row.scope,value:row.tco2e})),provenance}];}
