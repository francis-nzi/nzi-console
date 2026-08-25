import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { jobFamilyMeta, type FamilyJob } from "@nzi/mock-data";
import { NAV, USER } from "../lib/nav";
import { WorkflowStageControl } from "./WorkflowStageControl";

export function FamilyWorkspace({ job }: { job: FamilyJob }) {
  const { header } = job;
  const meta = jobFamilyMeta[header.family];
  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}>
    <TopBar searchPlaceholder={`Search ${meta.code} job…`} crumbs={<>Jobs <span className="muted">/</span> <b>{header.number}</b></>} />
    <div className="nz-head"><div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}><div><div style={{ display: "flex", gap: 8, alignItems: "center" }}><h1>{header.number} — {header.title}</h1><span className="nz-st est">{meta.code}</span></div><div className="sub">{header.client} · {meta.label} · owner: {header.owner}</div></div><span className="nz-status" style={{ marginLeft: "auto" }}><span className="d" />{header.workflowStage}</span></div></div>
    <WorkflowStageControl job={job} />
    <div className="nz-body" style={{ paddingTop: 18 }}><div className="nz-metrics"><Metric label="Family" value={meta.label} /><Metric label="Progress" value={`${header.progressPct}%`} /><Metric label="Due date" value={header.dueDate} /><Metric label="Official number" value={header.number} /></div><div className="nz-panel" style={{ padding: 20, marginTop: 18 }}><h2 style={{ margin: "0 0 8px", fontSize: 18 }}>{header.workflowStage}</h2><p style={{ margin: 0, color: "var(--t2)" }}>{meta.description}. This module owns its workflow, page design, detail model and report manifest while reusing shared platform services.</p><Detail job={job} /></div></div>
  </AppShell>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="nz-metric"><div className="l">{label}</div><div className="v">{value}</div></div>; }
function Detail({ job }: { job: FamilyJob }) {
  const d = job.detail;
  const rows = d.kind === "crp" ? [["Reporting period", d.reportingPeriod || "Not configured"], ["Included scopes", d.includedScopes?.join(" · ") || "Not configured"], ["Review", `${d.reviewedRows ?? 0} of ${d.totalRows ?? 0} rows`]] : d.kind === "consultancy" ? [["Scope", d.scope || "Not configured"], ["Deliverables", d.deliverables?.join(" · ") || "Not configured"], ["Effort", `${d.usedDays ?? 0} of ${d.plannedDays ?? 0} days`]] : d.kind === "lca" ? [["Assessment", d.assessment || "Not configured"], ["Boundary", d.boundary || "Not configured"], ["Inventory", `${d.bomLines ?? 0} BOM lines · ${d.scenarios ?? 0} scenarios`]] : d.kind === "pcf" ? [["Product", d.product || "Not configured"], ["Functional unit", d.functionalUnit || "Not configured"], ["Readiness", `${d.readinessPct ?? 0}% · ${d.bomLines ?? 0} BOM lines`]] : [["Course", d.course || "Not configured"], ["Delivery", `${d.sessions ?? 0} sessions · ${d.bookings ?? 0} bookings`], ["Attendance", `${d.attendancePct ?? 0}%`]];
  return <div style={{ marginTop: 18 }}>{rows.map(([label, value]) => <div className="nz-kv" key={label}><span className="k">{label}</span><span className="v">{value}</span></div>)}</div>;
}
