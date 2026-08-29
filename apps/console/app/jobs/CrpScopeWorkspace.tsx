"use client";
import { useEffect,useState } from "react";
import { useRouter } from "next/navigation";
import {
  patchBrowserCommand,
  postBrowserCommand,
  postBrowserCommandWithReason,
  putBrowserCommand,
} from "@nzi/api-client";
import type {
  DatasetOption,
  EmissionsTargetReadModel,
  FactorOption,
  IntensityTargetReadModel,
  PurchasedGoodsCategoryOption,
  SiteOption,
  ScopeQaReadiness,
  ScopeQualityTier,
  ScopeRowReadModel,
  ScopeRowWriteFields,
} from "@nzi/contracts";
import { crpScopeCategoryPath, crpScopeOptions } from "@nzi/contracts";
import type { FamilyJob } from "@nzi/mock-data";
import { AppShell, EvidenceDrawer, TopBar, WorkspaceRail } from "@nzi/ui";
import { NAV, USER } from "../lib/nav";
import { WorkflowStageControl } from "./WorkflowStageControl";
import {CrpReleaseControl} from "./CrpReleaseControl";
import {filterScopeRows,scopeRowNeedsAttention,type ScopeRegisterFilter} from "./scopeRegister";
import {PortalDataEntryReviewQueue} from "../platform/PortalDataEntryReviewQueue";

const blank = (): ScopeRowWriteFields => ({
  scope: "1",
  sourceLabel: "",
  reportLabel: null,
  notes:null,
  monthlyActivity: [],
  siteId:null,
  siteLabel:null,
  purchasedGoodsCategoryId:null,
  purchasedGoodsCategoryLabel:null,
  quantity: null,
  unit: null,
  datasetId: null,
  factorId: null,
  factorVersion: null,
  factorLabel: null,
  qualityTier: null,
  overrideTco2e: null,
  overrideReason: null,
});
const qualities: Array<{ value: ScopeQualityTier; label: string }> = [
  { value: "measured", label: "Measured" },
  { value: "estimated", label: "Estimated" },
  { value: "spend-based", label: "Spend-based" },
  { value: "survey", label: "Survey" },
];
const inputOf = (r: ScopeRowReadModel): ScopeRowWriteFields => ({
  scope: r.scope,
  sourceLabel: r.sourceLabel,
  reportLabel: r.reportLabel,
  notes:r.notes,
  monthlyActivity: r.monthlyActivity,
  siteId:r.siteId,
  siteLabel:r.siteLabel,
  purchasedGoodsCategoryId:r.purchasedGoodsCategoryId,
  purchasedGoodsCategoryLabel:r.purchasedGoodsCategoryLabel,
  quantity: r.quantity,
  unit: r.unit,
  datasetId: r.datasetId,
  factorId: r.factorId,
  factorVersion: r.factorVersion,
  factorLabel: r.factorLabel,
  qualityTier: r.qualityTier,
  overrideTco2e: r.overrideTco2e,
  overrideReason: r.overrideReason,
});
const errorText = (r: {
  state: string;
  message?: string;
  issues?: Array<{ message: string }>;
}) =>
  r.state === "validation_failed"
    ? (r.issues?.[0]?.message ?? r.message ?? "Validation failed.")
    : (r.message ?? "Command failed.");

export function CrpScopeWorkspace({
  job,
  rows,
  qa,
  factors,
  datasets,
  target,
  intensityTarget,
  sites,
  purchasedGoodsCategories,
}: {
  job: FamilyJob;
  rows: ScopeRowReadModel[];
  qa: ScopeQaReadiness;
  factors: FactorOption[];
  datasets: DatasetOption[];
  target: EmissionsTargetReadModel | null;
  intensityTarget:IntensityTargetReadModel|null;
  sites:SiteOption[];
  purchasedGoodsCategories:PurchasedGoodsCategoryOption[];
}) {
  const qaNotice: { kind: "ok" | "warn"; text: string } = qa.readyForReporting
    ? {
        kind: "ok",
        text: `QA ready: all ${qa.enabled} enabled rows have complete calculations, quality tiers and independent approval.`,
      }
    : {
        kind: "warn",
        text: `QA pending: ${qa.calculationMissing} calculations missing · ${qa.qualityMissing} quality tiers missing · ${qa.independentReviewPending} rows awaiting independent approval.`,
      };
  const router = useRouter(),
    [selectedId, setSelectedId] = useState(rows.find(scopeRowNeedsAttention)?.id??rows[0]?.id ?? ""),
    [creating, setCreating] = useState(rows.length === 0),
    [draft, setDraft] = useState(blank()),
    [pending, setPending] = useState(false),
    [registerFilter,setRegisterFilter]=useState<ScopeRegisterFilter>("attention"),
    [notice, setNotice] = useState<{
      kind: "ok" | "warn";
      text: string;
    } | null>(qaNotice);
  const visibleRows=filterScopeRows(rows,registerFilter),attentionCount=rows.filter(scopeRowNeedsAttention).length;
  const selected = visibleRows.find((r) => r.id === selectedId)??visibleRows[0]??rows.find((r)=>r.id===selectedId)??rows[0];
  const registerFilters:Array<{id:ScopeRegisterFilter;label:string;count:number}>=[{id:"attention",label:"Needs attention",count:attentionCount},{id:"calculation",label:"Calculation",count:qa.calculationMissing},{id:"quality",label:"Quality",count:qa.qualityMissing},{id:"review",label:"Review",count:qa.independentReviewPending},{id:"rejected",label:"Rejected",count:qa.rejected},{id:"all",label:"All rows",count:rows.length}];
  const openRegister=(filter:ScopeRegisterFilter)=>{setRegisterFilter(filter);requestAnimationFrame(()=>document.getElementById("emissions-register")?.scrollIntoView({behavior:"smooth",block:"start"}));};
  const reportingYear = job.header.reportingYear ?? new Date(job.header.startDate).getUTCFullYear();
  const totalTco2e = rows.reduce((sum, row) => sum + (row.enabled ? (row.overrideTco2e ?? row.calculatedTco2e ?? 0) : 0), 0);
  const readinessChecks = [
    { label: "Reporting datasets", complete: datasets.some((dataset) => dataset.selected), detail: `${datasets.filter((dataset) => dataset.selected).length} selected` },
    { label: "Emission calculations", complete: qa.enabled > 0 && qa.calculationMissing === 0, detail: qa.calculationMissing ? `${qa.calculationMissing} outstanding` : "Complete" },
    { label: "Independent QA", complete: qa.enabled > 0 && qa.independentReviewPending === 0, detail: qa.independentReviewPending ? `${qa.independentReviewPending} awaiting review` : "Approved" },
    { label: "Reduction pathway", complete: target !== null, detail: target ? `Version ${target.version}` : "Required" },
    { label: "Intensity metric", complete: intensityTarget !== null, detail: intensityTarget ? `Version ${intensityTarget.version}` : "Optional" },
  ];
  const requiredChecks = readinessChecks.slice(0, 4);
  const completedRequired = requiredChecks.filter((check) => check.complete).length;
  const readinessPercent = Math.round((completedRequired / requiredChecks.length) * 100);
  const nextAction = qa.calculationMissing > 0
    ? `Calculate ${qa.calculationMissing} outstanding emissions source${qa.calculationMissing === 1 ? "" : "s"}`
    : qa.independentReviewPending > 0
      ? `Complete independent review for ${qa.independentReviewPending} row${qa.independentReviewPending === 1 ? "" : "s"}`
      : !target
        ? "Configure the reduction pathway"
        : "Create the reviewed reporting snapshot";
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    const r = await postBrowserCommand<{ rowId: string }>(
      `/api/isolated/jobs/${job.header.id}/scope-rows`,
      draft,
      crypto.randomUUID(),
    );
    setPending(false);
    if (r.state === "success") {
      setSelectedId(r.data.rowId);
      setCreating(false);
      setDraft(blank());
      setNotice({ kind: "ok", text: "Scope row created." });
      router.refresh();
    } else setNotice({ kind: "warn", text: errorText(r) });
  }
  const drawer = selected ? (
    <EvidenceDrawer
      kicker={`Scope row · version ${selected.version}`}
      title={selected.sourceLabel}
      subtitle={`Scope ${selected.scope}`}
    >
      <Editor
        key={selected.id}
        jobId={job.header.id}
        row={selected}
        factors={factors}
        sites={sites}
        purchasedGoodsCategories={purchasedGoodsCategories}
        reportingFrom={datasets[0]?.reportingFrom??`${reportingYear}-01-01`}
        reportingTo={datasets[0]?.reportingTo??`${reportingYear}-12-31`}
        notice={setNotice}
      />
      <div className="nz-sect">Calculation lineage</div>
      {selected.lineage.length ? (
        selected.lineage.map((x, i) => (
          <div className="nz-lin" key={i}>
            <div className="stepl">
              {x.title}
              <small>{x.detail}</small>
            </div>
          </div>
        ))
      ) : (
        <div className="muted">No calculation lineage yet.</div>
      )}
      <div className="nz-sect">Provenance</div>
      {Object.entries(selected.provenance).map(([k, v]) => (
        <div className="nz-kv" key={k}>
          <span className="k">{k}</span>
          <span className="v">{v === null ? "—" : String(v)}</span>
        </div>
      ))}
    </EvidenceDrawer>
  ) : undefined;
  return (
    <AppShell
      rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}
      drawer={drawer}
    >
      <TopBar
        searchPlaceholder="Search sources, factors…"
        crumbs={
          <>
            Jobs / <b>{job.header.number}</b> / Scope rows
          </>
        }
      />
      <div className="nz-head">
        <div className="nz-job-titleline">
          <div>
            <div className="nz-eyebrow">Carbon Reduction Plan · {reportingYear}</div>
            <h1>{job.header.number} — {job.header.title}</h1>
            <div className="sub">{job.header.client} · Lead consultant: {job.header.owner}</div>
          </div>
          <div className="nz-head-actions">
            <span className={`nz-readiness-pill ${qa.readyForReporting ? "ready" : "progress"}`}><i />{qa.readyForReporting ? "Report ready" : `${readinessPercent}% ready`}</span>
            <button className="nz-btn pri" aria-expanded={creating} aria-controls="scope-row-editor" onClick={() => setCreating(!creating)}>{creating ? "Close editor" : "+ Add emissions source"}</button>
          </div>
        </div>
      </div>
      <WorkflowStageControl job={job} />
      <div className="nz-body">
        <section className="nz-command-hero">
          <div className="nz-command-summary">
            <div className="nz-eyebrow light">Engagement command centre</div>
            <h2>{qa.readyForReporting ? "Evidence complete. Ready to create the reporting snapshot." : "One clear route from evidence to an assured report."}</h2>
            <p>Live reporting controls, calculation provenance and independent review are joined in one governed workspace.</p>
            <div className="nz-command-next"><span>Recommended next action</span><strong>{nextAction}</strong></div>
          </div>
          <div className="nz-command-score">
            <div className="nz-score-ring" style={{ "--score": `${readinessPercent * 3.6}deg` } as React.CSSProperties}><div><strong>{readinessPercent}%</strong><span>readiness</span></div></div>
            <div><b>{completedRequired} of {requiredChecks.length}</b><span>reporting gates passed</span></div>
          </div>
        </section>
        <div className="nz-command-metrics">
          <div><span>Reported emissions</span><strong>{totalTco2e.toLocaleString("en-GB", { maximumFractionDigits: 1 })}</strong><small>tCO₂e across enabled rows</small></div>
          <button type="button" onClick={()=>openRegister("calculation")}><span>Evidence coverage</span><strong>{qa.enabled ? Math.round(((qa.enabled - qa.calculationMissing) / qa.enabled) * 100) : 0}%</strong><small>{qa.enabled - qa.calculationMissing} of {qa.enabled} calculated</small></button>
          <button type="button" onClick={()=>openRegister("review")}><span>Independent assurance</span><strong>{qa.enabled ? Math.round((qa.approved / qa.enabled) * 100) : 0}%</strong><small>{qa.approved} approved · {qa.pending} pending</small></button>
          <div><span>Reporting period</span><strong>{reportingYear}</strong><small>Annual disclosure cycle</small></div>
        </div>
        <section className="nz-work-grid">
          <div className="nz-panel nz-readiness-card">
            <div className="nz-card-heading"><div><span className="nz-eyebrow">Assurance pathway</span><h3>Report readiness</h3></div><span className={`nz-st ${qa.readyForReporting ? "done" : "need"}`}>{qa.readyForReporting ? "All gates passed" : `${requiredChecks.length - completedRequired} actions remain`}</span></div>
            <div className="nz-gate-list">{readinessChecks.map((check, index) => <div className={`nz-gate ${check.complete ? "complete" : "pending"}`} key={check.label}><span className="nz-gate-icon">{check.complete ? "✓" : index + 1}</span><div><b>{check.label}</b><small>{check.detail}</small></div></div>)}</div>
          </div>
          <div className="nz-panel nz-focus-card">
            <span className="nz-eyebrow">Management focus</span><h3>{qa.readyForReporting ? "Release with confidence" : "Resolve the highest-value exceptions first"}</h3>
            <p>{qa.readyForReporting ? "All enabled evidence has been calculated and independently approved. Freeze the evidence before publication." : "The workspace keeps missing calculations, incomplete quality evidence and pending reviews visible—never silently treated as zero."}</p>
            <div className="nz-focus-stats"><button type="button" onClick={()=>openRegister("calculation")}><b>{qa.calculationMissing}</b> calculations</button><button type="button" onClick={()=>openRegister("quality")}><b>{qa.qualityMissing}</b> quality gaps</button><button type="button" onClick={()=>openRegister("review")}><b>{qa.independentReviewPending}</b> QA decisions</button></div>
            <a className="nz-btn" href="#emissions-register" onClick={()=>setRegisterFilter("attention")}>Open {attentionCount} exception{attentionCount===1?"":"s"}</a>
          </div>
        </section>
        {notice && (
          <div className={`nz-banner ${notice.kind}`} role={notice.kind === "warn" ? "alert" : "status"}>{notice.text}</div>
        )}
        <TargetPanel jobId={job.header.id} reportingYear={job.header.reportingYear??new Date(job.header.startDate).getUTCFullYear()} target={target} notice={setNotice}/>
        <IntensityPanel jobId={job.header.id} reportingYear={job.header.reportingYear??new Date(job.header.startDate).getUTCFullYear()} target={intensityTarget} notice={setNotice}/>
        <SitePanel jobId={job.header.id} sites={sites} notice={setNotice}/>
        <PurchasedGoodsPanel jobId={job.header.id} categories={purchasedGoodsCategories} notice={setNotice}/>
        <DatasetPanel
          jobId={job.header.id}
          datasets={datasets}
          notice={setNotice}
        />
        <CrpReleaseControl jobId={job.header.id} readyForReporting={qa.readyForReporting}/>
        {creating && (
          <form
            className="nz-panel nz-scope-create"
            id="scope-row-editor"
            onSubmit={create}
          >
            <div className="nz-scope-create-head"><div><span className="nz-eyebrow">New canonical evidence row</span><b>Add emissions source</b><p className="sub">Factors are limited to datasets selected for this reporting period.</p></div><span className="nz-st est">Uncalculated</span></div>
            <Fields value={draft} change={setDraft} factors={factors} sites={sites} purchasedGoodsCategories={purchasedGoodsCategories}/>
            <button className="nz-btn pri" disabled={pending}>
              {pending ? "Creating…" : "Create scope row"}
            </button>
          </form>
        )}
        <PortalDataEntryReviewQueue jobId={job.header.id}/>
        {rows.length === 0 ? (
          <div className="nz-panel nz-register-empty"><b>No emissions sources yet</b><span>Empty is not treated as zero. Add the first evidence row to begin calculation and review.</span></div>
        ) : (
          <div className="nz-panel" id="emissions-register">
            <div className="nz-register-head">
              <div><span className="nz-eyebrow">Canonical evidence register</span><h3>Emissions sources</h3><p>Every result retains factor provenance, calculation lineage and an independent decision.</p></div>
              <div className="nz-register-filters" aria-label="Filter emissions sources">{registerFilters.map(filter=><button type="button" key={filter.id} aria-pressed={registerFilter===filter.id} onClick={()=>setRegisterFilter(filter.id)}>{filter.label}<b>{filter.count}</b></button>)}</div>
            </div>
            <table className="nz-tbl">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Scope</th>
                  <th>Site</th>
                  <th>Activity</th>
                  <th>Unit</th>
                  <th>Factor</th>
                  <th>Quality</th>
                  <th>tCO₂e</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    aria-selected={r.id === selected?.id}
                    className={`row${r.id === selected?.id ? " sel" : ""}`}
                    onClick={() => setSelectedId(r.id)}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(r.id); } }}
                  >
                    <td>{r.sourceLabel}</td>
                    <td>{r.scope}</td>
                    <td>{r.siteLabel??"Unallocated"}</td>
                    <td>{r.quantity ?? "—"}</td>
                    <td>{r.unit ?? "—"}</td>
                    <td>{r.factorLabel ?? "No factor"}</td>
                    <td>
                      {qualities.find((q) => q.value === r.qualityTier)
                        ?.label ?? "—"}
                    </td>
                    <td>{r.overrideTco2e ?? r.calculatedTco2e ?? "—"}</td>
                    <td><span className={`nz-st ${r.reviewStatus === "approved" ? "done" : r.reviewStatus === "rejected" ? "nof" : "est"}`}>{r.reviewStatus}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleRows.length===0?<div className="nz-table-empty">No rows match this filter. The full evidence register still contains {rows.length} row{rows.length===1?"":"s"}.</div>:null}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function TargetPanel({jobId,reportingYear,target,notice}:{jobId:string;reportingYear:number;target:EmissionsTargetReadModel|null;notice:(n:{kind:"ok"|"warn";text:string})=>void}){
 const router=useRouter(),[value,setValue]=useState({baselineYear:target?.baselineYear??reportingYear,baselineTco2e:target?.baselineTco2e??0,interimYear:target?.interimYear??2030,interimReductionPercent:target?.interimReductionPercent??50,netZeroYear:target?.netZeroYear??2050}),[pending,setPending]=useState(false);
 async function save(){setPending(true);const result=await putBrowserCommand<{version:number}>(`/api/isolated/jobs/${jobId}/emissions-target`,{...value,expectedVersion:target?.version??0},crypto.randomUUID());setPending(false);if(result.state==="success"){notice({kind:"ok",text:`Emissions target v${result.data.version} saved. It will be frozen into the next reviewed snapshot.`});router.refresh();}else notice({kind:"warn",text:errorText(result)});}
 const field=(label:string,key:keyof typeof value,step="1")=><label className="nz-fl">{label}<input className="nz-inp" type="number" step={step} value={value[key]} onChange={e=>setValue({...value,[key]:Number(e.target.value)})}/></label>;
 return <section className="nz-panel nz-config-panel"><div className="nz-config-head"><div><span className="nz-eyebrow">Assured reporting input</span><b>Reduction pathway target</b><div className="sub">Baseline, interim reduction and net-zero milestone used by the shared report chart.</div></div><span className={`nz-st ${target?"done":"est"}`}>{target?`Version ${target.version}`:"Not configured"}</span></div><div className="nz-config-grid target">{field("Baseline year","baselineYear")}{field("Baseline tCO₂e","baselineTco2e","any")}{field("Interim year","interimYear")}{field("Interim reduction %","interimReductionPercent","any")}{field("Net-zero year","netZeroYear")}</div><div className="nz-config-actions"><button className="nz-btn pri" disabled={pending} onClick={save}>{pending?"Saving…":"Save target"}</button></div></section>;
}

function SitePanel({jobId,sites,notice}:{jobId:string;sites:SiteOption[];notice:(n:{kind:"ok"|"warn";text:string})=>void}){const router=useRouter(),[name,setName]=useState(""),[pending,setPending]=useState(false);async function add(){if(pending)return;setPending(true);const result=await postBrowserCommand<{siteId:string;name:string}>(`/api/isolated/jobs/${jobId}/sites`,{name},crypto.randomUUID());setPending(false);if(result.state==="success"){setName("");notice({kind:"ok",text:`Site ${result.data.name} added.`});router.refresh();}else notice({kind:"warn",text:errorText(result)});}return <section className="nz-panel nz-config-panel"><div className="nz-config-head"><div><span className="nz-eyebrow">Controlled dimensions</span><b>Client sites</b><div className="sub">Assign emissions rows to a controlled site list. Unassigned emissions remain visible as Unallocated.</div></div><span className="nz-st done">{sites.length} sites</span></div><div className="nz-inline-create"><label className="nz-sr-only" htmlFor="new-site">New site name</label><input id="new-site" className="nz-inp" value={name} disabled={pending} onChange={e=>setName(e.target.value)} placeholder="New site name"/><button className="nz-btn" disabled={pending||!name.trim()} onClick={add}>{pending?"Adding…":"Add site"}</button></div></section>}

function IntensityPanel({jobId,reportingYear,target,notice}:{jobId:string;reportingYear:number;target:IntensityTargetReadModel|null;notice:(n:{kind:"ok"|"warn";text:string})=>void}){const router=useRouter(),[value,setValue]=useState({metric:target?.metric??"turnover" as "turnover"|"employee"|"floor-area",denominatorUnit:target?.denominatorUnit??"£m revenue",reportingDenominator:target?.reportingDenominator??0,baselineYear:target?.baselineYear??reportingYear,baselineIntensity:target?.baselineIntensity??0,interimYear:target?.interimYear??2030,interimReductionPercent:target?.interimReductionPercent??50,netZeroYear:target?.netZeroYear??2050}),[pending,setPending]=useState(false);async function save(){if(pending)return;setPending(true);const result=await putBrowserCommand<{version:number}>(`/api/isolated/jobs/${jobId}/intensity-target`,{...value,expectedVersion:target?.version??0},crypto.randomUUID());setPending(false);if(result.state==="success"){notice({kind:"ok",text:`Intensity target v${result.data.version} saved for the next reviewed snapshot.`});router.refresh();}else notice({kind:"warn",text:errorText(result)});}return <section className="nz-panel nz-config-panel"><div className="nz-config-head"><div><span className="nz-eyebrow">Optional normalisation</span><b>Intensity metric target</b><div className="sub">Current intensity is reviewed tCO₂e divided by the reporting denominator.</div></div><span className={`nz-st ${target?"done":"est"}`}>{target?`Version ${target.version}`:"Not configured"}</span></div><div className="nz-config-grid intensity"><label className="nz-fl">Metric<select className="nz-sel" value={value.metric} onChange={e=>setValue({...value,metric:e.target.value as typeof value.metric})}><option value="turnover">Turnover</option><option value="employee">Employees</option><option value="floor-area">Floor area</option></select></label><label className="nz-fl">Denominator unit<input className="nz-inp" value={value.denominatorUnit} onChange={e=>setValue({...value,denominatorUnit:e.target.value})}/></label><label className="nz-fl">Reporting denominator<input className="nz-inp" type="number" step="any" value={value.reportingDenominator} onChange={e=>setValue({...value,reportingDenominator:Number(e.target.value)})}/></label><label className="nz-fl">Baseline year<input className="nz-inp" type="number" value={value.baselineYear} onChange={e=>setValue({...value,baselineYear:Number(e.target.value)})}/></label><label className="nz-fl">Baseline intensity<input className="nz-inp" type="number" step="any" value={value.baselineIntensity} onChange={e=>setValue({...value,baselineIntensity:Number(e.target.value)})}/></label><label className="nz-fl">Interim year<input className="nz-inp" type="number" value={value.interimYear} onChange={e=>setValue({...value,interimYear:Number(e.target.value)})}/></label><label className="nz-fl">Interim reduction %<input className="nz-inp" type="number" step="any" value={value.interimReductionPercent} onChange={e=>setValue({...value,interimReductionPercent:Number(e.target.value)})}/></label><label className="nz-fl">Net-zero year<input className="nz-inp" type="number" value={value.netZeroYear} onChange={e=>setValue({...value,netZeroYear:Number(e.target.value)})}/></label></div><div className="nz-config-actions"><button className="nz-btn pri" disabled={pending} onClick={save}>{pending?"Saving…":"Save intensity target"}</button></div></section>}

function PurchasedGoodsPanel({jobId,categories,notice}:{jobId:string;categories:PurchasedGoodsCategoryOption[];notice:(n:{kind:"ok"|"warn";text:string})=>void}){const router=useRouter(),[name,setName]=useState(""),[pending,setPending]=useState(false);async function add(){if(pending)return;setPending(true);const result=await postBrowserCommand<{categoryId:string;name:string}>(`/api/isolated/jobs/${jobId}/purchased-goods-categories`,{name},crypto.randomUUID());setPending(false);if(result.state==="success"){setName("");notice({kind:"ok",text:`Purchased-goods category ${result.data.name} added.`});router.refresh();}else notice({kind:"warn",text:errorText(result)});}return <section className="nz-panel nz-config-panel"><div className="nz-config-head"><div><span className="nz-eyebrow">Controlled dimensions</span><b>Purchased Goods &amp; Services categories</b><div className="sub">Controlled client categories are available on Scope 3.1 rows and drive the report breakdown.</div></div><span className="nz-st done">{categories.length} categories</span></div><div className="nz-inline-create"><label className="nz-sr-only" htmlFor="new-purchased-category">New purchasing category</label><input id="new-purchased-category" className="nz-inp" value={name} disabled={pending} onChange={e=>setName(e.target.value)} placeholder="New purchasing category"/><button className="nz-btn" disabled={pending||!name.trim()} onClick={add}>{pending?"Adding…":"Add category"}</button></div></section>}

function DatasetPanel({
  jobId,
  datasets,
  notice,
}: {
  jobId: string;
  datasets: DatasetOption[];
  notice: (n: { kind: "ok" | "warn"; text: string }) => void;
}) {
  const router = useRouter(),
    available = datasets.filter((d) => !d.selected),
    [datasetId, setDatasetId] = useState(available[0]?.datasetId ?? ""),
    [reason, setReason] = useState(""),
    [pending, setPending] = useState(false),
    selected = available.find((d) => d.datasetId === datasetId);
  async function add() {
    if (!selected) return;
    setPending(true);
    const r = await postBrowserCommandWithReason<{ warnings: string[] }>(
      `/api/isolated/jobs/${jobId}/datasets/manual`,
      {
        scope: "all",
        datasetId: selected.datasetId,
        reportingFrom: selected.reportingFrom,
        reportingTo: selected.reportingTo,
      },
      crypto.randomUUID(),
      reason,
    );
    setPending(false);
    if (r.state === "success") {
      notice({
        kind: r.data.warnings.length ? "warn" : "ok",
        text: r.data.warnings.length
          ? `Dataset added with exceptions: ${r.data.warnings.join(" ")}`
          : "Dataset manually added with an audited justification.",
      });
      router.refresh();
    } else notice({ kind: "warn", text: errorText(r) });
  }
  return (
    <section className="nz-panel nz-config-panel">
      <div className="nz-config-head">
        <div>
          <b>Reporting datasets</b>
          <div className="sub">
            {datasets.filter((d) => d.selected).length} selected automatically
            or by approved exception.
          </div>
        </div>
        {datasets[0] && (
          <span className="nz-st done">
            {datasets[0].reportingFrom} → {datasets[0].reportingTo} ·{" "}
            {datasets[0].jobCountryCode}
          </span>
        )}
      </div>
      {available.length > 0 && (
        <div className="nz-dataset-add">
          <select
            className="nz-sel"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
          >
            {available.map((d) => (
              <option key={d.datasetId} value={d.datasetId}>
                {d.name} · {d.version} · {d.countryCode}
              </option>
            ))}
          </select>
          <input
            className="nz-inp"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required justification for manual addition"
          />
          <button
            className="nz-btn"
            disabled={pending || !reason.trim()}
            onClick={add}
          >
            Add dataset
          </button>
        </div>
      )}
      {selected?.warnings.length ? (
        <div className="nz-banner warn" style={{ marginTop: 10 }}>
          {selected.warnings.join(" ")} Adding it will retain these warnings for
          review.
        </div>
      ) : null}
    </section>
  );
}

function Fields({
  value,
  change,
  factors,
  sites,
  purchasedGoodsCategories,
}: {
  value: ScopeRowWriteFields;
  change: (v: ScopeRowWriteFields) => void;
  factors: FactorOption[];
  sites:SiteOption[];
  purchasedGoodsCategories:PurchasedGoodsCategoryOption[];
}) {
  const available = factors.filter((f) =>
      f.scopes.includes(value.scope.split(".")[0]!),
    ),
    selected =
      value.datasetId && value.factorId
        ? `${value.datasetId}|${value.factorId}`
        : "";
  return (
    <div className="nz-scope-fields">
      <label className="nz-fl">
        Source
        <input
          className="nz-inp"
          required
          value={value.sourceLabel}
          onChange={(e) => change({ ...value, sourceLabel: e.target.value })}
        />
      </label>
      <label className="nz-fl">
        Report label
        <input className="nz-inp" value={value.reportLabel ?? ""} placeholder={value.sourceLabel || "Defaults to source"} onChange={(e) => change({ ...value, reportLabel: e.target.value || null })} />
      </label>
      <label className="nz-fl">
        Scope
        <select
          className="nz-sel"
          required
          value={value.scope}
          onChange={(e) => change({ ...value, scope: e.target.value })}
        >
          {crpScopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <small className="muted">{crpScopeCategoryPath(value.scope).join(" › ")}</small>
      </label>
      <label className="nz-fl">
        Quality
        <select
          className="nz-sel"
          value={value.qualityTier ?? ""}
          onChange={(e) =>
            change({
              ...value,
              qualityTier: (e.target.value as ScopeQualityTier) || null,
            })
          }
        >
          <option value="">Not set</option>
          {qualities.map((q) => (
            <option key={q.value} value={q.value}>
              {q.label}
            </option>
          ))}
        </select>
      </label>
      <label className="nz-fl">Site<select className="nz-sel" value={value.siteId??""} onChange={e=>{const site=sites.find(item=>item.id===e.target.value);change({...value,siteId:site?.id??null,siteLabel:site?.name??null});}}><option value="">Unallocated</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      {value.scope==="3.1"&&<label className="nz-fl">Purchased-goods category<select className="nz-sel" value={value.purchasedGoodsCategoryId??""} onChange={e=>{const category=purchasedGoodsCategories.find(item=>item.id===e.target.value);change({...value,purchasedGoodsCategoryId:category?.id??null,purchasedGoodsCategoryLabel:category?.name??null});}}><option value="">Uncategorised</option>{purchasedGoodsCategories.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}
      <label className="nz-fl">
        Quantity
        <input
          className="nz-inp"
          type="number"
          min="0"
          step="any"
          value={value.quantity ?? ""}
          disabled={(value.monthlyActivity?.length??0)>0}
          onChange={(e) =>
            change({
              ...value,
              quantity: e.target.value === "" ? null : Number(e.target.value),
            })
          }
        />
      </label>
      <label className="nz-fl">
        Unit
        <input
          className="nz-inp"
          value={value.unit ?? ""}
          onChange={(e) => change({ ...value, unit: e.target.value || null })}
        />
      </label>
      <label className="nz-fl">
        Emission factor
        <select
          className="nz-sel"
          value={selected}
          onChange={(e) => {
            const f = available.find(
              (x) => `${x.datasetId}|${x.factorId}` === e.target.value,
            );
            change({
              ...value,
              datasetId: f?.datasetId ?? null,
              factorId: f?.factorId ?? null,
              factorLabel: f?.label ?? null,
              factorVersion: f?.datasetVersion ?? null,
              unit: f?.activityUnit ?? value.unit,
            });
          }}
        >
          <option value="">No factor</option>
          {available.map((f) => (
            <option
              key={`${f.datasetId}|${f.factorId}`}
              value={`${f.datasetId}|${f.factorId}`}
            >
              {f.label} · {f.activityUnit}
              {f.synthetic ? " · DEMO" : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function reportingMonthKeys(from:string,to:string){const result:string[]=[];const cursor=new Date(`${from.slice(0,7)}-01T00:00:00Z`),end=to.slice(0,7);while(cursor.toISOString().slice(0,7)<=end){result.push(cursor.toISOString().slice(0,7));cursor.setUTCMonth(cursor.getUTCMonth()+1);}return result;}
function MonthlyActivityEditor({value,change,reportingFrom,reportingTo}:{value:ScopeRowWriteFields;change:(value:ScopeRowWriteFields)=>void;reportingFrom:string;reportingTo:string}){
  const slots=value.monthlyActivity??[],months=reportingMonthKeys(reportingFrom,reportingTo),populated=slots.filter(slot=>slot.quantity!==null).length;
  const update=(next:typeof slots)=>change({...value,monthlyActivity:next,quantity:next.some(slot=>slot.quantity!==null)?next.reduce((sum,slot)=>sum+(slot.quantity??0),0):null});
  if(!slots.length)return <div><div className="nz-sect">Monthly activity</div><p className="muted" style={{fontSize:12}}>Optional monthly capture follows the reporting period. The annual quantity is derived from populated months.</p><button type="button" className="nz-btn" onClick={()=>update(months.map(month=>({month,quantity:null})))}>Enter monthly activity</button></div>;
  return <div><div className="nz-sect">Monthly activity <span className="muted">{populated}/{slots.length} populated</span></div><div style={{display:"flex",gap:8,marginBottom:10}}><button type="button" className="nz-btn" disabled={slots[0]?.quantity===null} onClick={()=>update(slots.map(slot=>({...slot,quantity:slots[0]?.quantity??null})))}>Copy first month to all</button><button type="button" className="nz-btn" onClick={()=>update(slots.map(slot=>({...slot,quantity:null})))}>Clear months</button><button type="button" className="nz-btn" onClick={()=>change({...value,monthlyActivity:[]})}>Use annual entry</button></div><div className="nz-scope-fields">{slots.map((slot,index)=><label className="nz-fl" key={slot.month}>{new Date(`${slot.month}-01T00:00:00Z`).toLocaleDateString("en-GB",{month:"short",year:"numeric",timeZone:"UTC"})}<input className="nz-inp" type="number" min="0" step="any" value={slot.quantity??""} onChange={event=>{const next=[...slots];next[index]={...slot,quantity:event.target.value===""?null:Number(event.target.value)};update(next);}}/></label>)}</div></div>;
}

function Editor({
  jobId,
  row,
  factors,
  sites,
  purchasedGoodsCategories,
  reportingFrom,
  reportingTo,
  notice,
}: {
  jobId: string;
  row: ScopeRowReadModel;
  factors: FactorOption[];
  sites:SiteOption[];
  purchasedGoodsCategories:PurchasedGoodsCategoryOption[];
  reportingFrom:string;
  reportingTo:string;
  notice: (n: { kind: "ok" | "warn"; text: string }) => void;
}) {
  const router = useRouter(),
    [value, setValue] = useState(inputOf(row)),
    [enabled, setEnabled] = useState(row.enabled),
    [pending, setPending] = useState(false),
    [reviewerNote, setReviewerNote] = useState(row.reviewerNote ?? ""),
    [history,setHistory]=useState<Array<{id:string;at:string;actor:string;action:string;correlationId:string}>>([]),
    [historyState,setHistoryState]=useState<"loading"|"ready"|"failed">("loading");
  useEffect(()=>{const controller=new AbortController();fetch(`/api/isolated/jobs/${jobId}/scope-rows/${row.id}/history`,{cache:"no-store",signal:controller.signal}).then(response=>response.ok?response.json():Promise.reject()).then(body=>{if(!Array.isArray(body.events))throw new Error();setHistory(body.events.filter((event:unknown)=>event&&typeof event==="object"&&"id" in event&&"at" in event&&"actor" in event&&"action" in event&&"correlationId" in event));setHistoryState("ready")}).catch(error=>{if(error?.name!=="AbortError")setHistoryState("failed")});return()=>controller.abort();},[jobId,row.id]);
  async function save() {
    setPending(true);
    const r = await patchBrowserCommand<{ version: number }>(
      `/api/isolated/jobs/${jobId}/scope-rows/${row.id}`,
      { ...value, enabled, expectedVersion: row.version },
      crypto.randomUUID(),
    );
    setPending(false);
    if (r.state === "success") {
      notice({
        kind: "ok",
        text: "Saved; calculation and review reset pending.",
      });
      router.refresh();
    } else notice({ kind: "warn", text: errorText(r) });
  }
  async function calculate() {
    setPending(true);
    const r = await postBrowserCommand<{ calculatedTco2e: number }>(
      `/api/isolated/jobs/${jobId}/scope-rows/${row.id}/calculate`,
      { expectedVersion: row.version },
      crypto.randomUUID(),
    );
    setPending(false);
    if (r.state === "success") {
      notice({
        kind: "ok",
        text: `Calculated ${r.data.calculatedTco2e.toLocaleString("en-GB")} tCO₂e with recorded lineage.`,
      });
      router.refresh();
    } else notice({ kind: "warn", text: errorText(r) });
  }
  async function review(decision: "approved" | "rejected") {
    setPending(true);
    const r = await postBrowserCommand<{ decision: string; version: number }>(
      `/api/isolated/jobs/${jobId}/scope-rows/${row.id}/review`,
      { decision, expectedReviewVersion: row.version, reviewerNote },
      crypto.randomUUID(),
    );
    setPending(false);
    if (r.state === "success") {
      notice({
        kind: decision === "approved" ? "ok" : "warn",
        text: `Row ${decision} with immutable reviewer evidence.`,
      });
      router.refresh();
    } else notice({ kind: "warn", text: errorText(r) });
  }
  async function snapshot() {
    setPending(true);
    const r = await postBrowserCommand<{
      snapshotId: string;
      version: number;
      reused: boolean;
    }>(
      `/api/isolated/jobs/${jobId}/reviewed-snapshots`,
      {},
      crypto.randomUUID(),
    );
    setPending(false);
    if (r.state === "success") {
      notice({
        kind: "ok",
        text: r.data.reused
          ? `Reviewed snapshot v${r.data.version} is already current.`
          : `Immutable reviewed snapshot v${r.data.version} created.`,
      });
      router.refresh();
    } else notice({ kind: "warn", text: errorText(r) });
  }
  return (
    <>
      <div
        className={`nz-banner ${row.calculatedTco2e === null ? "warn" : "ok"}`}
      >
        {row.calculatedTco2e === null
          ? "Save changes, then calculate."
          : "Calculated evidence is available."}
      </div>
      <Fields value={value} change={setValue} factors={factors} sites={sites} purchasedGoodsCategories={purchasedGoodsCategories}/>
      <MonthlyActivityEditor value={value} change={setValue} reportingFrom={reportingFrom} reportingTo={reportingTo}/>
      <div className="nz-sect">Evidence notes</div>
      <textarea className="nz-notes" style={{width:"100%"}} value={value.notes??""} onChange={event=>setValue({...value,notes:event.target.value||null})} placeholder="Method, source context, assumptions or follow-up notes"/>
      <div className="nz-sect">Reasoned override</div>
      <p className="muted" style={{ fontSize: 12 }}>
        Leave blank to use the calculated result. An override is recorded in the row lineage and always requires a reason.
      </p>
      <label className="nz-fl">
        Override tCO₂e
        <input className="nz-inp" type="number" min="0" step="any" value={value.overrideTco2e ?? ""} onChange={(e) => setValue({ ...value, overrideTco2e: e.target.value === "" ? null : Number(e.target.value) })} />
      </label>
      <label className="nz-fl">
        Override reason
        <textarea className="nz-notes" value={value.overrideReason ?? ""} onChange={(e) => setValue({ ...value, overrideReason: e.target.value || null })} placeholder="Required when an override value is entered" />
      </label>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        Enabled
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          className="nz-btn"
          disabled={pending || row.calculatedTco2e !== null}
          onClick={calculate}
        >
          Calculate
        </button>
        <button className="nz-btn pri" disabled={pending} onClick={save}>
          Save and invalidate calculation
        </button>
      </div>
      <div className="nz-sect">Independent review</div>
      <div
        className={`nz-banner ${row.reviewStatus === "approved" ? "ok" : "warn"}`}
      >
        {row.reviewStatus === "approved"
          ? `Approved by ${row.reviewedBy} at ${row.reviewedAt}.`
          : row.reviewStatus === "rejected"
            ? `Rejected: ${row.reviewerNote}`
            : "Pending independent reviewer decision."}
      </div>
      <textarea
        className="nz-notes"
        style={{ width: "100%" }}
        value={reviewerNote}
        onChange={(e) => setReviewerNote(e.target.value)}
        placeholder="Reviewer note (required for rejection)"
      />
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 8,
        }}
      >
        <button
          className="nz-btn"
          disabled={pending || !reviewerNote.trim()}
          onClick={() => review("rejected")}
        >
          Reject
        </button>
        <button
          className="nz-btn pri"
          disabled={pending || (row.calculatedTco2e === null && row.overrideTco2e === null) || !row.qualityTier}
          onClick={() => review("approved")}
        >
          Approve row
        </button>
      </div>
      <div className="nz-sect">Activity history</div>
      {historyState==="loading"?<p className="muted" role="status">Loading immutable row history…</p>:historyState==="failed"?<div className="nz-banner warn" role="alert">Row history is unavailable. No events have been inferred.</div>:history.length===0?<p className="muted">No row events are recorded yet.</p>:<div>{history.map(event=><div className="nz-lin" key={event.id}><div className="stepl"><b>{event.action.replaceAll("_"," ")}</b><small>{new Date(event.at).toLocaleString("en-GB")} · {event.actor}</small><small className="num">{event.correlationId}</small></div></div>)}</div>}
      <div className="nz-sect">Reporting snapshot</div>
      <p className="muted" style={{ fontSize: 12 }}>
        Creates an immutable, content-addressed snapshot only when every enabled
        row passes QA.
      </p>
      <button className="nz-btn pri" disabled={pending} onClick={snapshot}>
        Create reviewed snapshot
      </button>
    </>
  );
}
