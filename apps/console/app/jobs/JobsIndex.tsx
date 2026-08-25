"use client";
import { useMemo, useState } from "react";
import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { jobFamilyMeta, type Client, type FamilyJob, type JobFamily } from "@nzi/mock-data";
import { NAV, USER } from "../lib/nav";

type Filter = "all" | JobFamily;
export function JobsIndex({ jobs, clients }: { jobs: FamilyJob[]; clients: Client[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [family, setFamily] = useState<JobFamily>("crp");
  const rows = useMemo(() => filter === "all" ? jobs : jobs.filter((job) => job.header.family === filter), [filter, jobs]);
  const filters: Filter[] = ["all", "crp", "consultancy", "lca", "pcf", "training"];
  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}>
    <TopBar searchPlaceholder="Search jobs, clients…" crumbs={<><b>Jobs</b> <span className="muted">/</span> All families</>} />
    <div className="nz-head"><div style={{ display: "flex", alignItems: "flex-start" }}><div><h1>Jobs</h1><div className="sub">One shared job spine · family-aware workflows · official J000000 numbering</div></div><button className="nz-btn pri" style={{ marginLeft: "auto" }} onClick={() => setCreating((value) => !value)}>{creating ? "Close" : "New job"}</button></div></div>
    <div className="nz-body" style={{ paddingTop: 16 }}>
      {creating && <div className="nz-panel" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}><div><b>Create job</b><div className="sub" style={{ marginTop: 4 }}>The official number is assigned only when creation commits. Drafts remain unnumbered.</div></div><span className="nz-st est">Number pending</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: 14, marginTop: 16 }}>
          <label className="nz-fl" style={{ margin: 0 }}>Client<select className="nz-sel" defaultValue={clients[0]?.id}>{clients.filter((c) => c.status !== "prospect").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="nz-fl" style={{ margin: 0 }}>Job family<select className="nz-sel" value={family} onChange={(e) => setFamily(e.target.value as JobFamily)}>{Object.entries(jobFamilyMeta).map(([id, meta]) => <option key={id} value={id}>{meta.code} · {meta.label}</option>)}</select></label>
          <label className="nz-fl" style={{ margin: 0 }}>Owner<select className="nz-sel"><option>A. Shaw</option><option>M. Osei</option></select></label>
          <label className="nz-fl" style={{ margin: 0, gridColumn: "span 2" }}>Title<input className="nz-inp" placeholder={jobFamilyMeta[family].description} /></label>
          {family === "crp" && <label className="nz-fl" style={{ margin: 0 }}>Reporting year<input className="nz-inp" defaultValue="2025" /></label>}
          {family === "consultancy" && <label className="nz-fl" style={{ margin: 0 }}>Planned days<input className="nz-inp" placeholder="e.g. 15" /></label>}
          {(family === "lca" || family === "pcf") && <label className="nz-fl" style={{ margin: 0 }}>{family === "lca" ? "Assessment boundary" : "Functional unit"}<input className="nz-inp" placeholder="Define the assessment basis" /></label>}
          {family === "training" && <label className="nz-fl" style={{ margin: 0 }}>Course<input className="nz-inp" placeholder="Select or name course" /></label>}
        </div><div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}><button className="nz-btn">Save unnumbered draft</button><button className="nz-btn pri">Create and assign number</button></div>
      </div>}
      <div className="nz-toolbar" style={{ padding: "0 0 12px" }}><div className="nz-filters">{filters.map((id) => <button key={id} className={filter === id ? "on" : undefined} onClick={() => setFilter(id)}>{id === "all" ? `All ${jobs.length}` : jobFamilyMeta[id].code}</button>)}</div></div>
      <div className="nz-panel"><table className="nz-tbl"><thead><tr><th>Job</th><th>Family</th><th>Client</th><th>Title</th><th>Stage</th><th>Due</th><th>Owner</th><th className="num">Progress</th></tr></thead><tbody>{rows.map(({ header }) => <tr key={header.id} className="row"><td><a href={`/jobs/${header.id}`} style={{ color: "var(--emerald)", fontWeight: 600 }}>{header.number}</a></td><td><span className="nz-st est">{jobFamilyMeta[header.family].code}</span></td><td>{header.client}</td><td>{header.title}</td><td>{header.workflowStage}</td><td>{header.dueDate}</td><td>{header.owner}</td><td className="num">{header.progressPct}%</td></tr>)}</tbody></table></div>
    </div>
  </AppShell>;
}
