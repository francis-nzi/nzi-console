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
/** B1 (`composed@3`): resolver v2 — "Largest emissions activities" aggregated per activity. Opt-in; v1 stays the default. */
export const CRP_RESOLVER_AGGREGATED = 2;

/** One bar per activity: rows of the same scope and activity label summed, largest first; ties by label. */
function activitiesByLabel(rows: ReviewedCrpSnapshotCore["measurements"]): EmissionsByActivityData["activities"] {
  const byActivity = new Map<string, EmissionsByActivityData["activities"][number]>();
  for (const row of rows) {
    const label = row.sourceLabel.trim() || "Unlabelled activity", key = `${row.scope}|${label}`;
    const current = byActivity.get(key) ?? { id: `${row.scope}:${label}`, label, scope: row.scope, value: 0 };
    current.value += row.tco2e;
    byActivity.set(key, current);
  }
  return [...byActivity.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}
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
      kind: "baseline" | "interim" | "target" | "netzero";
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
  /** A frozen snapshot carries the job target's interim + net zero; a client target (Phase 3c) its optional interim and its
   *  own end point (`targetYear` at `targetReductionPercent`). Only the milestones present are drawn. */
  intensityTarget?:{metric:"turnover"|"employee"|"floor-area";denominatorUnit:string;reportingDenominator:number|null;baselineYear:number;baselineIntensity:number;interimYear:number|null;interimReductionPercent:number|null;netZeroYear:number|null;targetYear?:number|null;targetReductionPercent?:number|null}|null;
  annualComparison?:Array<{year:number;values:Array<{scope:"1"|"2"|"3";value:number}>}>;
  measurements: Array<{
    rowId: string;
    scope: "1" | "2" | "3";
    scopeCode?:string;
    sourceLabel: string;
    tco2e: number;
    factorSet: string;
    siteId?:string|null;
    siteLabel?:string|null;
    purchasedGoodsCategoryId?:string|null;
    purchasedGoodsCategoryLabel?:string|null;
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
      // R4: drawn in the Targets section — required only while that section is in the report.
      reportSection: "targets",
    },
    {
      id: "scope_year_on_year_bar",
      type: "scope_year_on_year_bar",
      specVersion: 1,
      required: true,
      // R5: an annual comparison exists only with two or more reporting years; a single-year client has none to show.
      requiredWhen: "multi-year",
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
      reportSection: "sites",
    },
    {
      id: "intensity_pathway",
      type: "intensity_pathway",
      specVersion: 1,
      required: true,
      reportSection: "intensity",
    },
    {
      id: "purchased_goods_breakdown",
      type: "purchased_goods_breakdown",
      specVersion: 1,
      required: true,
      // R7: a breakdown of Scope 3.1 exists only when the snapshot has 3.1 emissions; without them it is absent, not a blocker.
      requiredWhen: "has-3.1",
    },
  ],
  sections: [
    {
      id: "footprint",
      title: "Carbon emissions",
      description: "Current emissions and route to net zero.",
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
        title: `${snapshot.reportingYear} carbon emissions by scope`,
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

/**
 * The CRP chart set from a reviewed snapshot. `resolverVersion` 1 (the default) is what every surface and `composed@2` has
 * always drawn; 2 (`composed@3`, B1) draws "Largest emissions activities" as one bar per activity — the rows sharing an
 * activity and scope summed — rather than one bar per measurement row. Nothing else differs between them.
 */
export function resolveCrpCoreCharts(
  snapshot: ReviewedCrpSnapshotCore,
  options: { resolverVersion?: typeof CRP_RESOLVER_VERSION | typeof CRP_RESOLVER_AGGREGATED } = {},
): AnyChartData[] {
  const resolverVersion = options.resolverVersion ?? CRP_RESOLVER_VERSION;
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
    resolverVersion,
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
        title: `${snapshot.reportingYear} carbon emissions by scope`,
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
      activities: resolverVersion === CRP_RESOLVER_AGGREGATED
        ? activitiesByLabel(snapshot.measurements)
        : [...snapshot.measurements]
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
  if(snapshot.intensityTarget){const t=snapshot.intensityTarget,denominator=t.reportingDenominator!==null&&t.reportingDenominator>0?t.reportingDenominator:null,current=denominator===null?null:snapshot.measurements.reduce((sum,row)=>sum+row.tco2e,0)/denominator,milestones=intensityMilestones(t);charts.push({spec:{id:"intensity_pathway",type:"intensity_pathway",title:"Intensity reduction pathway",subtitle:`${snapshot.client} · ${snapshot.jobNumber}`,family:"crp",specVersion:1},unit:`tCO₂e / ${t.denominatorUnit}`,...(current===null&&snapshot.reportingYear!==t.baselineYear?{state:"degraded" as const,stateMessage:`The ${snapshot.reportingYear} intensity is unavailable: the intensity Value could not be resolved.`}:{state}),metric:t.metric,actual:[{year:t.baselineYear,value:t.baselineIntensity},...(snapshot.reportingYear===t.baselineYear||current===null?[]:[{year:snapshot.reportingYear,value:current}])],target:milestones.map(({year,value})=>({year,value})),milestones,provenance});}
  if(snapshot.measurements.length){const siteTotals=new Map<string,{id:string;label:string;value:number}>();for(const row of snapshot.measurements){const id=row.siteId??"unallocated",label=row.siteLabel?.trim()||"Unallocated";const current=siteTotals.get(id)??{id,label,value:0};current.value+=row.tco2e;siteTotals.set(id,current);}charts.push({spec:{id:"emissions_site_donut",type:"emissions_site_donut",title:`${snapshot.reportingYear} emissions by site`,subtitle:`${snapshot.client} · ${snapshot.jobNumber}`,family:"crp",specVersion:1},unit:"tCO₂e",state,sites:[...siteTotals.values()].sort((a,b)=>b.value-a.value),provenance});}
  const purchased=snapshot.measurements.filter(row=>row.scopeCode==="3.1");if(purchased.length){const totals=new Map<string,{id:string;label:string;scope:"3";value:number}>();for(const row of purchased){const id=row.purchasedGoodsCategoryId??"uncategorised",label=row.purchasedGoodsCategoryLabel?.trim()||"Uncategorised";const current=totals.get(id)??{id,label,scope:"3" as const,value:0};current.value+=row.tco2e;totals.set(id,current);}charts.push({spec:{id:"purchased_goods_breakdown",type:"purchased_goods_breakdown",title:"Purchased Goods & Services emissions breakdown",subtitle:`${snapshot.client} · ${snapshot.jobNumber}`,family:"crp",specVersion:1},unit:"tCO₂e",state,basis:"category",activities:[...totals.values()].sort((a,b)=>b.value-a.value),provenance});}
  return charts;
}

type IntensityMilestoneSource = NonNullable<ReviewedCrpSnapshotCore["intensityTarget"]>;
type IntensityMilestone = { year: number; value: number; label: string; kind: "baseline" | "interim" | "target" | "netzero" };

/**
 * The intensity pathway's milestones — exactly the ones the target states, never more (Phase 3c, 3c-3 addendum (i)).
 *
 * A frozen snapshot from a job's own target (before 3c) always has an interim and a net-zero year, drawn at zero, as it
 * always was. A client intensity target has an optional interim and an optional end point at its own percentage: the end
 * point is drawn at that reduction ("Target −50%"), and only a 100% reduction is "Net zero" at zero. Nothing is drawn at zero
 * that the target did not commit to. Sorted by year; a milestone with no year or no percentage is left out.
 */
export function intensityMilestones(t: IntensityMilestoneSource): IntensityMilestone[] {
  const at = (pct: number) => t.baselineIntensity * (1 - pct / 100);
  const milestones: IntensityMilestone[] = [{ year: t.baselineYear, value: t.baselineIntensity, label: "Baseline", kind: "baseline" }];
  if (t.interimYear != null && t.interimReductionPercent != null) milestones.push({ year: t.interimYear, value: at(t.interimReductionPercent), label: `Interim -${t.interimReductionPercent}%`, kind: "interim" });
  if (t.targetYear != null && t.targetReductionPercent != null) {
    milestones.push(t.targetReductionPercent >= 100
      ? { year: t.targetYear, value: 0, label: "Net zero", kind: "netzero" }
      : { year: t.targetYear, value: at(t.targetReductionPercent), label: `Target -${t.targetReductionPercent}%`, kind: "target" });
  } else if (t.netZeroYear != null) {
    milestones.push({ year: t.netZeroYear, value: 0, label: "Net zero", kind: "netzero" });
  }
  return milestones.sort((a, b) => a.year - b.year);
}
