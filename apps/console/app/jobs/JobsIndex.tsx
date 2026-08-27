"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { jobWorkflowStages, type CommandInputMap } from "@nzi/contracts";
import { postBrowserCommand } from "@nzi/api-client";
import { jobFamilyMeta, type Client, type FamilyJob, type JobFamily } from "@nzi/mock-data";
import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { NAV, USER } from "../lib/nav";

type Filter = "all" | JobFamily;
const initialStage: Record<JobFamily, string> = { crp: jobWorkflowStages.crp[0], consultancy: jobWorkflowStages.consultancy[0], lca: jobWorkflowStages.lca[0], pcf: jobWorkflowStages.pcf[0], training: jobWorkflowStages.training[0] };

export function JobsIndex({ jobs, clients }: { jobs: FamilyJob[]; clients: Client[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const submissionKey = useRef<string | null>(null);
  const eligibleClients = clients.filter((client) => client.status !== "prospect");
  const firstClient = eligibleClients[0]?.id ?? "";
  const [draft, setDraft] = useState<CommandInputMap["job.create"]>({ clientId: firstClient, family: "crp", title: "", workflowStage: initialStage.crp, owner: "", startDate: "", dueDate: "", reportingYear: new Date().getUTCFullYear() });
  const rows = useMemo(() => filter === "all" ? jobs : jobs.filter((job) => job.header.family === filter), [filter, jobs]);
  const filters: Filter[] = ["all", "crp", "consultancy", "lca", "pcf", "training"];
  const averageProgress = jobs.length ? Math.round(jobs.reduce((sum, job) => sum + job.header.progressPct, 0) / jobs.length) : 0;
  const activeCrp = jobs.filter((job) => job.header.family === "crp").length;
  const dueSoon = jobs.filter((job) => { const due = Date.parse(job.header.dueDate); return Number.isFinite(due) && due >= Date.now() && due - Date.now() < 30 * 86400000; }).length;

  async function createJob(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if(saving||!draft.clientId)return; setSaving(true); setNotice(null); submissionKey.current ??= crypto.randomUUID();
    const input = { ...draft, reportingYear: draft.family === "crp" ? draft.reportingYear : undefined };
    const result = await postBrowserCommand<{ jobId: string; jobNumber: string }>("/api/isolated/commands/jobs", input, submissionKey.current);
    setSaving(false);
    if (result.state === "success") {
      submissionKey.current = null; setCreating(false); setNotice({ kind: "ok", text: `${result.data.jobNumber} was created and assigned atomically.` }); router.refresh(); return;
    }
    if (result.state !== "failed" || !result.retryable) submissionKey.current = null;
    setNotice({ kind: "warn", text: result.state === "validation_failed" ? result.issues[0]?.message ?? result.message : result.message });
  }

  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}>
    <TopBar searchPlaceholder="Search jobs, clients…" crumbs={<><b>Jobs</b> <span className="muted">/</span> All families</>} />
    <div className="nz-head"><div className="nz-job-titleline"><div><div className="nz-eyebrow">Delivery portfolio</div><h1>Engagements</h1><div className="sub">Every client engagement, workflow and deadline in one governed portfolio</div></div><button type="button" className="nz-btn pri" disabled={eligibleClients.length===0} title={eligibleClients.length===0?"Create or onboard a client before opening an engagement.":undefined} aria-expanded={creating} onClick={() => { setCreating((value) => !value); setNotice(null); }}>{creating ? "Close editor" : "+ New engagement"}</button></div></div>
    <div className="nz-body" style={{ paddingTop: 16 }}>
      <section className="nz-ops-hero"><div><span className="nz-eyebrow light">NZI delivery command</span><h2>{jobs.length===0?"No delivery engagements are recorded.":dueSoon?`${dueSoon} engagement${dueSoon===1?"":"s"} approaching a delivery milestone.`:"The evidenced portfolio has no immediate milestones."}</h2><p>{jobs.length===0?"Portfolio health, ownership and workflow assurance remain unavailable until the first governed engagement is created.":"Official job numbering, family-specific workflows and accountable ownership create one dependable operational view."}</p></div><div className="nz-ops-trust"><span><i>{jobs.length?"✓":"·"}</i> Official numbering</span><span><i>{jobs.length?"✓":"·"}</i> Named ownership</span><span><i>{jobs.length?"✓":"·"}</i> Audited workflow</span></div></section>
      <div className="nz-metrics"><Metric label="Active engagements" value={String(jobs.length)} note="Across all service families"/><Metric label="Carbon reporting" value={String(activeCrp)} note="CRP engagements"/><Metric label="Average progress" value={jobs.length?`${averageProgress}%`:"Not available"} note={jobs.length?"Portfolio completion":"No engagement evidence"}/><Metric label="Due within 30 days" value={String(dueSoon)} note={jobs.length?(dueSoon?"Requires delivery focus":"No immediate deadlines"):"No engagements scheduled"}/></div>
      {eligibleClients.length===0&&<div className="nz-banner warn nz-job-prerequisite"><div><b>A client is required before an engagement can be created.</b><div>Prospects are not eligible for delivery jobs. Create or onboard a client first.</div></div><a className="nz-btn" href="/clients">Open client portfolio</a></div>}
      {notice && <div className={`nz-banner ${notice.kind}`} role="status"><div>{notice.text}</div></div>}
      {creating && <form className="nz-panel nz-job-create" onSubmit={createJob}>
        <div className="nz-job-create-head"><div><span className="nz-eyebrow">New governed engagement</span><b>Create job</b><div className="sub" style={{ marginTop: 4 }}>The official number is assigned only when creation commits, so abandoned drafts never create gaps.</div></div><span className="nz-st est">Number pending</span></div>
        <div className="nz-job-create-grid">
          <label className="nz-fl" style={{ margin: 0 }}>Client<select className="nz-sel" required value={draft.clientId} onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}>{eligibleClients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
          <label className="nz-fl" style={{ margin: 0 }}>Job family<select className="nz-sel" value={draft.family} onChange={(e) => { const family = e.target.value as JobFamily; setDraft({ ...draft, family, workflowStage: initialStage[family] }); }}>{Object.entries(jobFamilyMeta).map(([id, meta]) => <option key={id} value={id}>{meta.code} · {meta.label}</option>)}</select></label>
          <label className="nz-fl" style={{ margin: 0 }}>Owner<input className="nz-inp" required value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} /></label>
          <label className="nz-fl" style={{ margin: 0, gridColumn: "span 2" }}>Title<input className="nz-inp" required placeholder={jobFamilyMeta[draft.family].description} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
          <label className="nz-fl" style={{ margin: 0 }}>Initial stage<input className="nz-inp" required readOnly value={draft.workflowStage} aria-describedby="initial-stage-help"/><small className="nz-hint" id="initial-stage-help">Set by the selected family workflow.</small></label>
          <label className="nz-fl" style={{ margin: 0 }}>Start date<input className="nz-inp" type="date" required value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} /></label>
          <label className="nz-fl" style={{ margin: 0 }}>Due date<input className="nz-inp" type="date" required value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} /></label>
          {draft.family === "crp" && <label className="nz-fl" style={{ margin: 0 }}>Reporting year<input className="nz-inp" type="number" min="2000" max="2200" required value={draft.reportingYear ?? ""} onChange={(e) => setDraft({ ...draft, reportingYear: Number(e.target.value) })} /></label>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}><button type="button" className="nz-btn" disabled={saving} onClick={() => setCreating(false)}>Cancel</button><button className="nz-btn pri" disabled={saving || !draft.clientId}>{saving ? "Creating…" : "Create and assign number"}</button></div>
      </form>}
      <div className="nz-toolbar" style={{ padding: "0 0 12px" }}><div className="nz-filters">{filters.map((id) => <button type="button" aria-pressed={filter===id} key={id} className={filter === id ? "on" : undefined} onClick={() => setFilter(id)}>{id === "all" ? `All ${jobs.length}` : jobFamilyMeta[id].code}</button>)}</div></div>
      <div className="nz-panel nz-engagement-table"><table className="nz-tbl"><thead><tr><th>Job</th><th>Family</th><th>Client</th><th>Title</th><th>Stage</th><th>Due</th><th>Owner</th><th className="num">Progress</th></tr></thead><tbody>{rows.map(({ header }) => <tr key={header.id} className="row"><td><a href={`/jobs/${header.id}`} className="nz-table-link">{header.number}</a></td><td><span className="nz-st est">{jobFamilyMeta[header.family].code}</span></td><td>{header.client}</td><td>{header.title}</td><td>{header.workflowStage}</td><td>{header.dueDate}</td><td>{header.owner}</td><td><span className="nz-job-progress"><i><span style={{width:`${header.progressPct}%`}}/></i><b className="num">{header.progressPct}%</b></span></td></tr>)}</tbody></table>{rows.length===0&&<div className="nz-engagement-empty"><b>{jobs.length===0?"No engagements yet":"No engagements match this family"}</b><span>{jobs.length===0?"Create the first governed engagement after an eligible client exists.":"Choose another family filter to return to active delivery work."}</span></div>}</div>
    </div>
  </AppShell>;
}

function Metric({label,value,note}:{label:string;value:string;note:string}){return <div className="nz-metric"><div className="l">{label}</div><div className="v num">{value}</div><div className="sub nz-metric-note">{note}</div></div>}
