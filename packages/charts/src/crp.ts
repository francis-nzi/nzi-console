import { RENDERER_VERSION } from "./identity";
import type { ReportManifest } from "./manifest";
import { TOKENS_VERSION } from "./tokens";
import type {
  AnyChartData,
  EmissionsByActivityData,
  ReductionPathwayData,
  ScopeDonutData,
} from "./types";

export const CRP_RESOLVER_VERSION = 1;
export type ReviewedScopeMeasurement = {
  scope: "1" | "2" | "3";
  tco2e: number;
  factorSet: string;
  reviewed: boolean;
  included: boolean;
};
export type ReviewedCrpSnapshot = {
  id: string;
  jobId: string;
  jobNumber: string;
  client: string;
  reportingYear: number;
  generatedAt: string;
  dataHash: string;
  measurements: ReviewedScopeMeasurement[];
  pathway: {
    actual: Array<{ year: number; value: number }>;
    target: Array<{ year: number; value: number }>;
    milestones: Array<{
      year: number;
      value: number;
      label: string;
      kind: "baseline" | "interim" | "netzero";
    }>;
  };
};
export type ReviewedCrpSnapshotCore = {
  id: string;
  jobId: string;
  jobNumber: string;
  client: string;
  reportingYear: number;
  generatedAt: string;
  dataHash: string;
  target?: {baselineYear:number;baselineTco2e:number;interimYear:number;interimReductionPercent:number;netZeroYear:number}|null;
  annualComparison?:Array<{year:number;values:Array<{scope:"1"|"2"|"3";value:number}>}>;
  measurements: Array<{
    rowId: string;
    scope: "1" | "2" | "3";
    sourceLabel: string;
    tco2e: number;
    factorSet: string;
    siteId?:string|null;
    siteLabel?:string|null;
  }>;
};

export const crpProfessionalManifest: ReportManifest = {
  id: "crp_professional",
  family: "crp",
  version: 1,
  charts: [
    {
      id: "emissions_scope_donut",
      type: "emissions_scope_donut",
      specVersion: 2,
      required: true,
    },
    {
      id: "reduction_pathway",
      type: "reduction_pathway",
      specVersion: 1,
      required: true,
    },
    {
      id: "scope_year_on_year_bar",
      type: "scope_year_on_year_bar",
      specVersion: 1,
      required: true,
    },
    {
      id: "emissions_by_activity",
      type: "emissions_by_activity",
      specVersion: 1,
      required: true,
    },
    {
      id: "emissions_site_donut",
      type: "emissions_site_donut",
      specVersion: 1,
      required: true,
    },
    {
      id: "intensity_pathway",
      type: "intensity_pathway",
      specVersion: 1,
      required: true,
    },
    {
      id: "purchased_goods_breakdown",
      type: "purchased_goods_breakdown",
      specVersion: 1,
      required: true,
    },
  ],
  sections: [
    {
      id: "footprint",
      title: "Carbon footprint",
      description: "Current footprint and route to net zero.",
      layout: "two-column",
      chartIds: ["emissions_scope_donut", "reduction_pathway"],
    },
    {
      id: "performance",
      title: "Emissions performance",
      description: "Annual scope comparison and material activities.",
      layout: "two-column",
      chartIds: ["scope_year_on_year_bar", "emissions_by_activity"],
    },
    {
      id: "sites-intensity",
      title: "Operational performance",
      description: "Site contribution and turnover-intensity targets.",
      layout: "two-column",
      chartIds: ["emissions_site_donut", "intensity_pathway"],
    },
    {
      id: "purchased-goods",
      title: "Purchased Goods & Services",
      description: "Scope 3.1 emissions contribution by purchasing category.",
      layout: "full-width",
      chartIds: ["purchased_goods_breakdown"],
    },
  ],
};

export function resolveCrpCharts(
  snapshot: ReviewedCrpSnapshot,
): [ScopeDonutData, ReductionPathwayData] {
  const included = snapshot.measurements.filter(
    (row) => row.included && row.reviewed,
  );
  const unresolved = snapshot.measurements.some(
    (row) => row.included && !row.reviewed,
  );
  const factorSets = Array.from(
    new Set(included.map((row) => row.factorSet)),
  ).sort();
  const totals = new Map<string, number>([
    ["1", 0],
    ["2", 0],
    ["3", 0],
  ]);
  for (const row of included)
    totals.set(row.scope, (totals.get(row.scope) ?? 0) + row.tco2e);
  const provenance = {
    jobId: snapshot.jobId,
    dataHash: snapshot.dataHash,
    factorSets,
    generatedAt: snapshot.generatedAt,
    reviewedSnapshotId: snapshot.id,
    resolverVersion: CRP_RESOLVER_VERSION,
    tokensVersion: TOKENS_VERSION,
    rendererVersion: RENDERER_VERSION,
  };
  const state = unresolved
    ? ("degraded" as const)
    : included.length === 0
      ? ("empty" as const)
      : ("success" as const);
  const stateMessage = unresolved
    ? "Included measurements remain unreviewed. Publication is blocked."
    : included.length === 0
      ? "No reviewed emissions are available."
      : undefined;
  return [
    {
      spec: {
        id: "emissions_scope_donut",
        type: "emissions_scope_donut",
        title: `${snapshot.reportingYear} carbon footprint by scope`,
        subtitle: `${snapshot.client} · ${snapshot.jobNumber}`,
        family: "crp",
        specVersion: 2,
      },
      unit: "tCO₂e",
      state,
      stateMessage,
      segments: [
        { scope: "1", label: "Scope 1 — direct", value: totals.get("1") ?? 0 },
        {
          scope: "2",
          label: "Scope 2 — electricity",
          value: totals.get("2") ?? 0,
        },
        {
          scope: "3",
          label: "Scope 3 — value chain",
          value: totals.get("3") ?? 0,
        },
      ],
      provenance,
    },
    {
      spec: {
        id: "reduction_pathway",
        type: "reduction_pathway",
        title: "Emissions reduction pathway to net zero",
        subtitle: `${snapshot.client} · ${snapshot.jobNumber}`,
        family: "crp",
        specVersion: 1,
      },
      unit: "tCO₂e",
      state,
      stateMessage,
      actual: snapshot.pathway.actual,
      target: snapshot.pathway.target,
      milestones: snapshot.pathway.milestones,
      provenance,
    },
  ];
}

export function resolveCrpCoreCharts(
  snapshot: ReviewedCrpSnapshotCore,
): AnyChartData[] {
  const factorSets = Array.from(
      new Set(
        snapshot.measurements.map((row) => row.factorSet).filter(Boolean),
      ),
    ).sort(),
    totals = new Map<string, number>([
      ["1", 0],
      ["2", 0],
      ["3", 0],
    ]);
  for (const row of snapshot.measurements)
    totals.set(row.scope, (totals.get(row.scope) ?? 0) + row.tco2e);
  const provenance = {
    jobId: snapshot.jobId,
    dataHash: snapshot.dataHash,
    factorSets,
    generatedAt: snapshot.generatedAt,
    reviewedSnapshotId: snapshot.id,
    resolverVersion: CRP_RESOLVER_VERSION,
    tokensVersion: TOKENS_VERSION,
    rendererVersion: RENDERER_VERSION,
  };
  const state =
    snapshot.measurements.length && factorSets.length
      ? ("success" as const)
      : ("empty" as const);
  const charts: AnyChartData[] = [
    {
      spec: {
        id: "emissions_scope_donut",
        type: "emissions_scope_donut",
        title: `${snapshot.reportingYear} carbon footprint by scope`,
        subtitle: `${snapshot.client} · ${snapshot.jobNumber}`,
        family: "crp",
        specVersion: 2,
      },
      unit: "tCO₂e",
      state,
      stateMessage:
        state === "empty" ? "No reviewed emissions are available." : undefined,
      segments: [
        { scope: "1", label: "Scope 1 — direct", value: totals.get("1") ?? 0 },
        {
          scope: "2",
          label: "Scope 2 — electricity",
          value: totals.get("2") ?? 0,
        },
        {
          scope: "3",
          label: "Scope 3 — value chain",
          value: totals.get("3") ?? 0,
        },
      ],
      provenance,
    },
    {
      spec: {
        id: "emissions_by_activity",
        type: "emissions_by_activity",
        title: "Largest emissions activities",
        subtitle: `${snapshot.client} · ${snapshot.jobNumber}`,
        family: "crp",
        specVersion: 1,
      },
      unit: "tCO₂e",
      state,
      stateMessage:
        state === "empty" ? "No reviewed activities are available." : undefined,
      activities: [...snapshot.measurements]
        .sort((a, b) => b.tco2e - a.tco2e)
        .map((row) => ({
          id: row.rowId,
          label: row.sourceLabel,
          scope: row.scope,
          value: row.tco2e,
        })),
      provenance,
    },
  ];
  if(snapshot.target){const t=snapshot.target,interim=t.baselineTco2e*(1-t.interimReductionPercent/100),actualTotal=snapshot.measurements.reduce((sum,row)=>sum+row.tco2e,0);charts.splice(1,0,{spec:{id:"reduction_pathway",type:"reduction_pathway",title:"Emissions reduction pathway to net zero",subtitle:`${snapshot.client} · ${snapshot.jobNumber}`,family:"crp",specVersion:1},unit:"tCO₂e",state,actual:[{year:t.baselineYear,value:t.baselineTco2e},...(snapshot.reportingYear===t.baselineYear?[]:[{year:snapshot.reportingYear,value:actualTotal}])],target:[{year:t.baselineYear,value:t.baselineTco2e},{year:t.interimYear,value:interim},{year:t.netZeroYear,value:0}],milestones:[{year:t.baselineYear,value:t.baselineTco2e,label:"Baseline",kind:"baseline"},{year:t.interimYear,value:interim,label:`Interim -${t.interimReductionPercent}%`,kind:"interim"},{year:t.netZeroYear,value:0,label:"Net zero",kind:"netzero"}],provenance});}
  if((snapshot.annualComparison?.length??0)>1){charts.splice(charts.length-1,0,{spec:{id:"scope_year_on_year_bar",type:"scope_year_on_year_bar",title:"Annual emissions comparison by scope",subtitle:`${snapshot.client} · ${snapshot.jobNumber}`,family:"crp",specVersion:1},unit:"tCO₂e",state,years:snapshot.annualComparison!,provenance});}
  if(snapshot.measurements.length){const siteTotals=new Map<string,{id:string;label:string;value:number}>();for(const row of snapshot.measurements){const id=row.siteId??"unallocated",label=row.siteLabel?.trim()||"Unallocated";const current=siteTotals.get(id)??{id,label,value:0};current.value+=row.tco2e;siteTotals.set(id,current);}charts.push({spec:{id:"emissions_site_donut",type:"emissions_site_donut",title:`${snapshot.reportingYear} emissions by site`,subtitle:`${snapshot.client} · ${snapshot.jobNumber}`,family:"crp",specVersion:1},unit:"tCO₂e",state,sites:[...siteTotals.values()].sort((a,b)=>b.value-a.value),provenance});}
  return charts;
}
