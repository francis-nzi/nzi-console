import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { jobFamilyMeta, type FamilyJob } from "@nzi/mock-data";
import { NAV, USER } from "../lib/nav";

const stages = {
  consultancy: ["Scope", "Plan", "Delivery", "Client review", "Complete"],
  lca: ["Goal & scope", "Inventory", "Impact assessment", "Interpretation", "Report"],
  pcf: ["Product boundary", "BOM", "Factor mapping", "Review", "Report"],
  training: ["Course setup", "Bookings", "Delivery", "Attendance", "Certificates"],
} as const;

export function FamilyWorkspace({ job }: { job: FamilyJob }) {
  const { header, detail } = job;
  if (header.family === "crp" || detail.kind === "crp") return null;
  const meta = jobFamilyMeta[header.family];
  const workflow = stages[header.family];
  const activeIndex = workflow.findIndex((stage) => stage === header.workflowStage);
  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}>
    <TopBar searchPlaceholder={`Search ${meta.code} job…`} crumbs={<>Jobs <span className="muted">/</span> <b>{header.number}</b></>} />
    <div className="nz-head"><div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}><div><div style={{ display: "flex", gap: 8, alignItems: "center" }}><h1>{header.number} — {header.title}</h1><span className="nz-st est">{meta.code}</span></div><div className="sub">{header.client} · {meta.label} · owner: {header.owner}</div></div><span className="nz-status" style={{ marginLeft: "auto" }}><span className="d" />{header.workflowStage}</span></div></div>
    <div className="nz-stepper">{workflow.map((stage, index) => <div key={stage} className={`nz-step ${index === activeIndex ? "active" : index < activeIndex ? "done" : "todo"}`}><span className="n">{index < activeIndex ? "✓" : index + 1}</span><span className="lb">{stage}</span>{index < workflow.length - 1 && <span className="bar" />}</div>)}</div>
    <div className="nz-body" style={{ paddingTop: 18 }}><div className="nz-metrics"><Metric label="Family" value={meta.label} /><Metric label="Progress" value={`${header.progressPct}%`} /><Metric label="Due date" value={header.dueDate} /><Metric label="Official number" value={header.number} /></div><div className="nz-panel" style={{ padding: 20, marginTop: 18 }}><h2 style={{ margin: "0 0 8px", fontSize: 18 }}>{header.workflowStage}</h2><p style={{ margin: 0, color: "var(--t2)" }}>{meta.description}. This module owns its workflow, page design, detail model and report manifest while reusing shared platform services.</p><Detail job={job} /></div></div>
  </AppShell>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="nz-metric"><div className="l">{label}</div><div className="v">{value}</div></div>; }
function Detail({ job }: { job: FamilyJob }) {
  const d = job.detail;
  const rows = d.kind === "consultancy" ? [["Scope", d.scope], ["Deliverables", d.deliverables.join(" · ")], ["Effort", `${d.usedDays} of ${d.plannedDays} days`]] : d.kind === "lca" ? [["Assessment", d.assessment], ["Boundary", d.boundary], ["Inventory", `${d.bomLines} BOM lines · ${d.scenarios} scenarios`]] : d.kind === "pcf" ? [["Product", d.product], ["Functional unit", d.functionalUnit], ["Readiness", `${d.readinessPct}% · ${d.bomLines} BOM lines`]] : d.kind === "training" ? [["Course", d.course], ["Delivery", `${d.sessions} sessions · ${d.bookings} bookings`], ["Attendance", `${d.attendancePct}%`]] : [];
  return <div style={{ marginTop: 18 }}>{rows.map(([label, value]) => <div className="nz-kv" key={label}><span className="k">{label}</span><span className="v">{value}</span></div>)}</div>;
}
