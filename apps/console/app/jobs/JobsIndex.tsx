"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { jobDateIssues, jobWorkflowStages, plausibleYearRange, reportingYearForPeriod, type CommandInputMap } from "@nzi/contracts";
import { postBrowserCommand } from "@nzi/api-client";
import { jobFamilyMeta, type FamilyJob, type JobFamily } from "@nzi/mock-data";
import type { ClientScreenReadModel } from "@nzi/isolated-backend";
import Link from "next/link";
import { AppShell, SmartSearch, TopBar, WorkspaceRail } from "@nzi/ui";
import { NAV, USER } from "../lib/nav";
import { formatDate } from "../lib/formatDate";
import { clientJobsHref, crumbTrail, workspaceCrumbs } from "../lib/crumbTrail";
import { useTeamOptions } from "../clients/useReferenceOptions";

type Filter = "all" | JobFamily;
const initialStage: Record<JobFamily, string> = { crp: jobWorkflowStages.crp[0], consultancy: jobWorkflowStages.consultancy[0], lca: jobWorkflowStages.lca[0], pcf: jobWorkflowStages.pcf[0], training: jobWorkflowStages.training[0] };

type Draft = CommandInputMap["job.create"];

const EMPTY_DATES = { startDate: "", dueDate: "", reportingPeriodStart: "", reportingPeriodEnd: "" };

export function JobsIndex({ jobs: allJobs, clients, clientId = null }: { jobs: FamilyJob[]; clients: ClientScreenReadModel[]; clientId?: string | null }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  // `?client=` scopes the portfolio to one client — the route the client trail's "Jobs"
  // crumb points at. The client's name is resolved from the record, or from the jobs
  // themselves when the client list is degraded; it is never invented.
  const scopedClient = clientId === null ? null : {
    id: clientId,
    name: clients.find((client) => client.id === clientId)?.name
      ?? allJobs.find((job) => job.header.clientId === clientId)?.header.client
      ?? null,
  };
  const jobs = scopedClient === null ? allJobs : allJobs.filter((job) => job.header.clientId === scopedClient.id);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  // Field -> message, so a complaint appears beside the control it is about rather than as one
  // banner naming four things at once.
  const [fieldIssues, setFieldIssues] = useState<Record<string, string>>({});
  const submissionKey = useRef<string | null>(null);
  const team = useTeamOptions();
  const eligibleClients = clients.filter((client) => client.status !== "prospect");
  // Creating from a client's own jobs list starts on that client.
  const firstClient = (scopedClient && eligibleClients.some((client) => client.id === scopedClient.id) ? scopedClient.id : eligibleClients[0]?.id) ?? "";
  const [draft, setDraft] = useState<Draft>({ clientId: firstClient, family: "crp", title: "", workflowStage: initialStage.crp, owner: "", clientManagerUserId: null, ...EMPTY_DATES });
  const rows = useMemo(() => filter === "all" ? jobs : jobs.filter((job) => job.header.family === filter), [filter, jobs]);
  const filters: Filter[] = ["all", "crp", "consultancy", "lca", "pcf", "training"];
  const averageProgress = jobs.length ? Math.round(jobs.reduce((sum, job) => sum + job.header.progressPct, 0) / jobs.length) : 0;
  const activeCrp = jobs.filter((job) => job.header.family === "crp").length;
  const dueSoon = jobs.filter((job) => { const due = Date.parse(job.header.dueDate); return Number.isFinite(due) && due >= Date.now() && due - Date.now() < 30 * 86400000; }).length;

  /**
   * The job's client manager defaults to the client's own (NZC-092) and stays changeable.
   *
   * Fill-blank-only, the same rule the Add-client form uses for its owner: picking a different
   * manager and then changing the client must not reach back and undo the choice. The id and the
   * label move together — the id is what a later rename reaches, the label is what survives if the
   * person leaves the roster.
   */
  function selectClient(nextClientId: string) {
    setDraft((current) => {
      const client = clients.find((candidate) => candidate.id === nextClientId);
      const chosen = current.owner.trim() !== "" || current.clientManagerUserId;
      if (chosen || !client) return { ...current, clientId: nextClientId };
      return {
        ...current, clientId: nextClientId,
        owner: client.profile.clientManager?.trim() ?? "",
        clientManagerUserId: client.profile.clientManagerUserId ?? null,
      };
    });
  }

  /** Derived, never entered — the calendar year the reporting period ends in (NZC-092). */
  const reportingYear = draft.reportingPeriodEnd.length === 10 ? reportingYearForPeriod(draft.reportingPeriodEnd) : null;
  const { min: yearMin, max: yearMax } = plausibleYearRange();

  async function createJob(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !draft.clientId) return;
    // The same function the command runs, so the form cannot disagree with the server about what a
    // plausible date is. The server still decides — this only spares a round trip.
    const issues = jobDateIssues(draft);
    if (issues.length > 0) {
      setFieldIssues(Object.fromEntries(issues.map((issue) => [issue.field, issue.message])));
      setNotice({ kind: "warn", text: "Check the dates below." });
      return;
    }
    setFieldIssues({});
    setSaving(true); setNotice(null); submissionKey.current ??= crypto.randomUUID();
    const result = await postBrowserCommand<{ jobId: string; jobNumber: string }>("/api/isolated/commands/jobs", draft, submissionKey.current);
    setSaving(false);
    if (result.state === "success") {
      submissionKey.current = null; setCreating(false); setNotice({ kind: "ok", text: `${result.data.jobNumber} was created and assigned atomically.` }); router.refresh(); return;
    }
    if (result.state !== "failed" || !result.retryable) submissionKey.current = null;
    if (result.state === "validation_failed") {
      setFieldIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setNotice({ kind: "warn", text: result.issues[0]?.message ?? "Some details need attention." });
      return;
    }
    setNotice({ kind: "warn", text: result.message });
  }

  const dateField = (field: keyof typeof EMPTY_DATES, label: string) => {
    const issue = fieldIssues[field];
    const describedBy = issue ? `${field}-issue` : undefined;
    return <label className="nz-fl" style={{ margin: 0 }}>{label}
      <input className="nz-inp" type="date" required min={`${yearMin}-01-01`} max={`${yearMax}-12-31`}
        aria-invalid={issue ? true : undefined} aria-describedby={describedBy}
        value={draft[field]}
        onChange={(e) => { setDraft({ ...draft, [field]: e.target.value }); setFieldIssues(({ [field]: _removed, ...rest }) => rest); }} />
      {issue ? <small className="nz-field-issue" id={describedBy} role="alert">{issue}</small> : null}
    </label>;
  };

  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}>
    <TopBar searchPlaceholder="Search jobs, clients…" crumbs={crumbTrail(scopedClient
      ? [{ label: "Clients", href: "/clients" },
         { label: scopedClient.name ?? "This client", href: `/clients/${encodeURIComponent(scopedClient.id)}` },
         { label: "Jobs", href: clientJobsHref(scopedClient.id), current: true }]
      : workspaceCrumbs("Jobs", "/jobs"))} />
    <div className="nz-head"><div className="nz-job-titleline"><div><div className="nz-eyebrow">Delivery portfolio</div><h1>Jobs</h1><div className="sub">{scopedClient
      ? <>Jobs for {scopedClient.name ?? "this client"} · <Link href="/jobs" className="nz-table-link">show every client</Link></>
      : "Every client job, workflow and deadline in one governed portfolio"}</div></div><button type="button" className="nz-btn pri" disabled={eligibleClients.length===0} title={eligibleClients.length===0?"Create or onboard a client before opening a job.":undefined} aria-expanded={creating} onClick={() => { setCreating((value) => !value); setNotice(null); }}>{creating ? "Close editor" : "+ New job"}</button></div></div>
    <div className="nz-body" style={{ paddingTop: 16 }}>
      {/* The dark "NZI delivery command" band and its ✓ trust pills are gone (Part 1, Task B). They
          restated the platform's own assurances above the work rather than showing any of it, so
          the page now opens on the four numbers and the table. */}
      <div className="nz-metrics"><Metric label="Active jobs" value={String(jobs.length)} note="Across all service families"/><Metric label="Carbon reporting" value={String(activeCrp)} note="CRP jobs"/><Metric label="Average progress" value={jobs.length?`${averageProgress}%`:"Not available"} note={jobs.length?"Portfolio completion":"No job evidence"}/><Metric label="Due within 30 days" value={String(dueSoon)} note={jobs.length?(dueSoon?"Requires delivery focus":"No immediate deadlines"):"No jobs scheduled"}/></div>
      {eligibleClients.length===0&&<div className="nz-banner warn nz-job-prerequisite"><div><b>A client is required before a job can be created.</b><div>Prospects are not eligible for delivery jobs. Create or onboard a client first.</div></div><a className="nz-btn" href="/clients">Open client portfolio</a></div>}
      {notice && <div className={`nz-banner ${notice.kind}`} role="status"><div>{notice.text}</div></div>}
      {creating && <form className="nz-panel nz-job-create" onSubmit={createJob}>
        <div className="nz-job-create-head"><div><span className="nz-eyebrow">New job</span><b>Create job</b></div><span className="nz-st est">Number pending</span></div>

        <fieldset className="nz-job-block">
          <legend>About the job</legend>
          <div className="nz-job-create-grid">
            <label className="nz-fl" style={{ margin: 0 }}>Client<select className="nz-sel" required value={draft.clientId} onChange={(e) => selectClient(e.target.value)}>{eligibleClients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
            <label className="nz-fl" style={{ margin: 0 }}>Job family<select className="nz-sel" value={draft.family} onChange={(e) => { const family = e.target.value as JobFamily; setDraft({ ...draft, family, workflowStage: initialStage[family] }); }}>{Object.entries(jobFamilyMeta).map(([id, meta]) => <option key={id} value={id}>{meta.code} · {meta.label}</option>)}</select></label>
            <SmartSearch label="Client manager" options={team.options} emptyHint={team.emptyHint} required
              value={draft.clientManagerUserId ?? ""}
              onChange={(id, option) => setDraft({ ...draft, clientManagerUserId: id || null, owner: option?.label ?? "" })} />
            <label className="nz-fl" style={{ margin: 0, gridColumn: "span 2" }}>Title<input className="nz-inp" required placeholder={jobFamilyMeta[draft.family].description} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
            <label className="nz-fl" style={{ margin: 0 }}>Initial stage<input className="nz-inp" required readOnly value={draft.workflowStage} aria-describedby="initial-stage-help"/><small className="nz-hint" id="initial-stage-help">Set by the selected family workflow.</small></label>
          </div>
        </fieldset>

        <fieldset className="nz-job-block">
          <legend>Dates</legend>
          <div className="nz-job-create-grid">
            {dateField("startDate", "Job start")}
            {dateField("dueDate", "Job end")}
            {dateField("reportingPeriodStart", "Reporting period start")}
            {dateField("reportingPeriodEnd", "Reporting period end")}
            <label className="nz-fl" style={{ margin: 0 }}>Reporting year
              <input className="nz-inp" readOnly aria-describedby="reporting-year-help" value={reportingYear ?? "—"} />
              <small className="nz-hint" id="reporting-year-help">The year the reporting period ends in.</small>
            </label>
          </div>
        </fieldset>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}><button type="button" className="nz-btn" disabled={saving} onClick={() => setCreating(false)}>Cancel</button><button className="nz-btn pri" disabled={saving || !draft.clientId}>{saving ? "Creating…" : "Create and assign number"}</button></div>
      </form>}
      <div className="nz-toolbar" style={{ padding: "0 0 12px" }}><div className="nz-filters">{filters.map((id) => <button type="button" aria-pressed={filter===id} key={id} className={filter === id ? "on" : undefined} onClick={() => setFilter(id)}>{id === "all" ? `All ${jobs.length}` : jobFamilyMeta[id].code}</button>)}</div></div>
      <div className="nz-panel nz-job-table"><table className="nz-tbl"><thead><tr><th>Job</th><th>Family</th><th>Client</th><th>Title</th><th>Stage</th><th>Due</th><th>Client manager</th><th className="num">Progress</th></tr></thead><tbody>{rows.map(({ header }) => <tr key={header.id} className="row"><td><a href={`/jobs/${header.id}`} className="nz-table-link">{header.number}</a></td><td><span className="nz-st est">{jobFamilyMeta[header.family].code}</span></td><td>{header.client}</td><td>{header.title}</td><td>{header.workflowStage}</td><td>{formatDate(header.dueDate)}</td><td>{header.owner}</td><td><span className="nz-job-progress"><i><span style={{width:`${header.progressPct}%`}}/></i><b className="num">{header.progressPct}%</b></span></td></tr>)}</tbody></table>{rows.length===0&&<div className="nz-list-empty"><b>{jobs.length!==0?"No jobs match this family":scopedClient?"No jobs for this client yet":"No jobs yet"}</b><span>{jobs.length!==0?"Choose another family filter to return to active delivery work.":scopedClient?"This client has no delivery jobs on record.":"Create the first governed job after an eligible client exists."}</span></div>}</div>
    </div>
  </AppShell>;
}

function Metric({label,value,note}:{label:string;value:string;note:string}){return <div className="nz-metric"><div className="l">{label}</div><div className="v num">{value}</div><div className="sub nz-metric-note">{note}</div></div>}
