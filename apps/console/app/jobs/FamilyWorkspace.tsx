import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { jobFamilyMeta, type FamilyJob } from "@nzi/mock-data";
import { NAV, USER } from "../lib/nav";
import { WorkflowStageControl } from "./WorkflowStageControl";
import { RENDERER_VERSION, TOKENS_VERSION, TrainingAttendance, type TrainingAttendanceData } from "@nzi/charts";

export function FamilyWorkspace({ job }: { job: FamilyJob }) {
  const { header } = job;
  const meta = jobFamilyMeta[header.family];
  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}>
    <TopBar searchPlaceholder={`Search ${meta.code} job…`} crumbs={<>Engagements <span className="muted">/</span> <b>{header.number}</b></>} />
    <div className="nz-head nz-family-head"><div className="nz-job-heading"><div><div className="nz-family-titleline"><span className="nz-eyebrow">{meta.label}</span><span className="nz-st est">{meta.code}</span></div><h1>{header.number} — {header.title}</h1><div className="sub">{header.client} · owner: {header.owner} · due {header.dueDate}</div></div><span className="nz-status"><span className="d" />{header.workflowStage}</span></div></div>
    <WorkflowStageControl job={job} />
    <div className="nz-body nz-family-body"><div className="nz-metrics"><Metric label="Service family" value={meta.label} note="Family-specific workflow"/><Metric label="Delivery progress" value={`${header.progressPct}%`} note={header.workflowStage}/><Metric label="Due date" value={header.dueDate} note="Contracted milestone"/><Metric label="Official number" value={header.number} note="Immutable identifier"/></div><div className="nz-family-progress"><div><span>Engagement completion</span><b>{header.progressPct}%</b></div><div className="track" role="progressbar" aria-label="Engagement completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={header.progressPct}><i style={{width:`${header.progressPct}%`}}/></div></div>{job.detail.kind==="training"?<TrainingVisual job={job}/>:null}<section className="nz-panel nz-family-detail"><div className="nz-config-head"><div><span className="nz-eyebrow">Current delivery stage</span><h2>{header.workflowStage}</h2><p>{meta.description}. This workspace owns its specialist detail model and report outputs while reusing shared identity, audit and client services.</p></div><span className="nz-st done">In delivery</span></div><Detail job={job} /></section></div>
  </AppShell>;
}

function TrainingVisual({job}:{job:FamilyJob}){if(job.detail.kind!=="training")return null;const invited=job.detail.bookings??0,attended=Math.round(invited*(job.detail.attendancePct??0)/100),data:TrainingAttendanceData={spec:{id:"training_attendance",type:"training_attendance",title:"Participation and completion",subtitle:job.detail.course??"Training programme",family:"training",specVersion:1},unit:"people",state:"success",provenance:{jobId:job.header.id,dataHash:`training:${job.header.id}:${invited}:${attended}`,factorSets:["Training attendance register"],generatedAt:"2026-08-26T00:00:00Z",reviewedSnapshotId:`training-${job.header.id}`,resolverVersion:1,tokensVersion:TOKENS_VERSION,rendererVersion:RENDERER_VERSION},cohorts:[{id:"programme",label:"Programme",invited,attended,completed:attended}]};return <div className="nz-family-chart"><TrainingAttendance data={data}/></div>}

function Metric({label,value,note}:{label:string;value:string;note:string}){return <div className="nz-metric"><div className="l">{label}</div><div className="v">{value}</div><div className="sub">{note}</div></div>}
function Detail({ job }: { job: FamilyJob }) {
  const d = job.detail;
  const rows = d.kind === "crp" ? [["Reporting period", d.reportingPeriod || "Not configured"], ["Included scopes", d.includedScopes?.join(" · ") || "Not configured"], ["Review", `${d.reviewedRows ?? 0} of ${d.totalRows ?? 0} rows`]] : d.kind === "consultancy" ? [["Scope", d.scope || "Not configured"], ["Deliverables", d.deliverables?.join(" · ") || "Not configured"], ["Effort", `${d.usedDays ?? 0} of ${d.plannedDays ?? 0} days`]] : d.kind === "lca" ? [["Assessment", d.assessment || "Not configured"], ["Boundary", d.boundary || "Not configured"], ["Inventory", `${d.bomLines ?? 0} BOM lines · ${d.scenarios ?? 0} scenarios`]] : d.kind === "pcf" ? [["Product", d.product || "Not configured"], ["Functional unit", d.functionalUnit || "Not configured"], ["Readiness", `${d.readinessPct ?? 0}% · ${d.bomLines ?? 0} BOM lines`]] : [["Course", d.course || "Not configured"], ["Delivery", `${d.sessions ?? 0} sessions · ${d.bookings ?? 0} bookings`], ["Attendance", `${d.attendancePct ?? 0}%`]];
  return <dl className="nz-family-facts">{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
