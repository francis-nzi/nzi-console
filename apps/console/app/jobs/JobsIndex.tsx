"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { familyHasReportingPeriod, hasActiveFilters, JOB_STATUS_ALL, jobDateIssues, jobListSpec, jobWorkflowStages, PAGE_SIZES, plausibleYearRange, reportingYearForPeriod, todayInLondon, type CommandInputMap, type JobListFilterKey, type JobListQuery } from "@nzi/contracts";
import { postBrowserCommand } from "@nzi/api-client";
import { jobFamilyMeta, type JobFamily } from "@nzi/mock-data";
import type { ClientScreenReadModel, JobListPage, JobListRow } from "@nzi/isolated-backend";
import Link from "next/link";
import { AppShell, DataList, SmartSearch, TopBar, WorkspaceRail, type DataListColumn, type DataListFilter } from "@nzi/ui";
import { NAV, USER } from "../lib/nav";
import { formatDate } from "../lib/formatDate";
import { clientJobsHref, crumbTrail, workspaceCrumbs } from "../lib/crumbTrail";
import { useTeamOptions } from "../clients/useReferenceOptions";
import { useListNavigation } from "../lib/useListNavigation";

const initialStage: Record<JobFamily, string> = { crp: jobWorkflowStages.crp[0], consultancy: jobWorkflowStages.consultancy[0], lca: jobWorkflowStages.lca[0], pcf: jobWorkflowStages.pcf[0], training: jobWorkflowStages.training[0] };

type Draft = CommandInputMap["job.create"];

const EMPTY_DATES = { startDate: "", dueDate: "", reportingPeriodStart: "", reportingPeriodEnd: "" };

const STATUS_LABELS: Record<string, string> = { draft: "Draft", open: "Open", "on-hold": "On hold", complete: "Complete", cancelled: "Cancelled" };
const addDays = (day: string, days: number) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };

export function JobsIndex({ page, query, clients }: { page: JobListPage; query: JobListQuery; clients: ClientScreenReadModel[] }) {
  const router = useRouter();
  const nav = useListNavigation(jobListSpec, query, "/jobs");
  // `?client=` scopes the portfolio to one client — the route the client trail's "Jobs"
  // crumb points at. It is an ordinary server-side filter now. The client's name is resolved
  // from the record, or from the jobs themselves when the client list is degraded; it is never invented.
  const clientId = query.filters.client?.[0] ?? null;
  const scopedClient = clientId === null ? null : {
    id: clientId,
    name: clients.find((client) => client.id === clientId)?.name
      ?? page.rows.find((job) => job.clientId === clientId)?.client
      ?? null,
  };
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
  const { summary } = page;
  // The client scope is where the page is, not a filter someone applied — Clear filters keeps it.
  const narrowed = hasActiveFilters({ ...query, filters: { ...query.filters, client: undefined } });
  const keep = clientId === null ? {} : { client: [clientId] };

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
  const reportingYear = draft.reportingPeriodEnd?.length === 10 ? reportingYearForPeriod(draft.reportingPeriodEnd) : null;
  const { min: yearMin, max: yearMax } = plausibleYearRange();
  // Only a carbon-reporting job reports on a period. A training course has a start and an end and
  // nothing it produces is labelled by a reporting year, so asking for one invents a fact.
  const hasPeriod = familyHasReportingPeriod(draft.family);

  async function createJob(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !draft.clientId) return;
    // The same function the command runs, so the form cannot disagree with the server about what a
    // plausible date is. The server still decides — this only spares a round trip.
    const issues = jobDateIssues(draft, { family: draft.family });
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
        value={draft[field] ?? ""}
        onChange={(e) => { setDraft({ ...draft, [field]: e.target.value }); setFieldIssues(({ [field]: _removed, ...rest }) => rest); }} />
      {issue ? <small className="nz-field-issue" id={describedBy} role="alert">{issue}</small> : null}
    </label>;
  };

  const columns: DataListColumn<JobListRow>[] = [
    { key: "number", header: "Job", sortKey: "number", cell: (job) => <Link href={`/jobs/${encodeURIComponent(job.id)}`} className="nz-table-link">{job.number}</Link> },
    { key: "family", header: "Family", sortKey: "family", cell: (job) => <span className="nz-st est" title={jobFamilyMeta[job.family]?.label}>{jobFamilyMeta[job.family]?.code ?? job.family}</span> },
    { key: "client", header: "Client", sortKey: "client", cell: (job) => job.client },
    { key: "title", header: "Title", sortKey: "title", cell: (job) => job.title },
    { key: "status", header: "Status", sortKey: "status", cell: (job) => STATUS_LABELS[job.status] ?? job.status },
    { key: "stage", header: "Stage", cell: (job) => job.workflowStage },
    { key: "dueDate", header: "End date", sortKey: "dueDate", cell: (job) => formatDate(job.dueDate) },
    { key: "manager", header: "Client manager", sortKey: "manager", cell: (job) => job.manager ?? <span className="muted">Unassigned</span> },
    { key: "progress", header: "Progress", numeric: true, cell: (job) => <span className="nz-job-progress"><i><span style={{ width: `${job.progressPct}%` }} /></i><b className="num">{job.progressPct}%</b></span> },
  ];
  // Ruled D5: no status chosen means every status except cancelled, and the control says so.
  const filters: DataListFilter[] = [
    { key: "manager", label: "Client manager", allLabel: "All client managers", value: query.filters.manager?.[0] ?? "", options: page.filterOptions.manager },
    { key: "family", label: "Job family", allLabel: "All families", value: query.filters.family?.[0] ?? "",
      options: page.filterOptions.family.map((option) => ({ ...option, label: jobFamilyMeta[option.value as JobFamily]?.label ?? option.label })) },
    { key: "status", label: "Status", allLabel: "All except cancelled", value: query.filters.status?.[0] ?? "",
      options: [{ value: JOB_STATUS_ALL, label: "All statuses" }, ...page.filterOptions.status.map((option) => ({ ...option, label: STATUS_LABELS[option.value] ?? option.label }))] },
  ];

  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="jobs" user={USER} />}>
    <TopBar crumbs={crumbTrail(scopedClient
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
      {/* Over the filtered set, from the server — never over the page on screen. */}
      <div className="nz-metrics"><Metric label={narrowed ? "Matching jobs" : "Jobs"} value={summary.jobs.toLocaleString("en-GB")} note={query.filters.status ? "In the chosen status" : "Excluding cancelled"}/><Metric label="Carbon reporting" value={summary.carbonReporting.toLocaleString("en-GB")} note="CRP jobs"/><Metric label="Average progress" value={summary.averageProgress === null ? "Not available" : `${summary.averageProgress}%`} note={summary.jobs ? "Portfolio completion" : "No job evidence"}/><Metric label="Due within 30 days" value={summary.dueWithin30Days.toLocaleString("en-GB")} note={summary.jobs ? (summary.dueWithin30Days ? "Requires delivery focus" : "No immediate deadlines") : "No jobs scheduled"}/></div>
      {eligibleClients.length===0&&<div className="nz-banner warn nz-job-prerequisite"><div><b>A client is required before a job can be created.</b><div>Prospects are not eligible for delivery jobs. Create or onboard a client first.</div></div><a className="nz-btn" href="/clients">Open client portfolio</a></div>}
      {notice && <div className={`nz-banner ${notice.kind}`} role="status"><div>{notice.text}</div></div>}
      {creating && <form className="nz-panel nz-job-create" onSubmit={createJob}>
        <div className="nz-job-create-head"><div><span className="nz-eyebrow">New job</span><b>Create job</b></div><span className="nz-st est">Number pending</span></div>

        <fieldset className="nz-job-block">
          <legend>About the job</legend>
          <div className="nz-job-create-grid">
            <label className="nz-fl" style={{ margin: 0 }}>Client<select className="nz-sel" required value={draft.clientId} onChange={(e) => selectClient(e.target.value)}>{eligibleClients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
            <label className="nz-fl" style={{ margin: 0 }}>Job family<select className="nz-sel" value={draft.family} onChange={(e) => { const family = e.target.value as JobFamily; setDraft({ ...draft, family, workflowStage: initialStage[family], ...(familyHasReportingPeriod(family) ? {} : { reportingPeriodStart: null, reportingPeriodEnd: null }) }); setFieldIssues({}); }}>{Object.entries(jobFamilyMeta).map(([id, meta]) => <option key={id} value={id}>{meta.code} · {meta.label}</option>)}</select></label>
            {/* The label is the caller's, in the same shape as the fields either side of it, so
                this row looks and reads like the rest of the block. */}
            <div className="nz-fl" style={{ margin: 0 }}>
              <label htmlFor="job-client-manager">Client manager</label>
              <SmartSearch id="job-client-manager" label="Client manager" options={team.options}
                emptyHint={team.emptyHint} required
                value={draft.clientManagerUserId ?? ""}
                onChange={(id, option) => setDraft({ ...draft, clientManagerUserId: id || null, owner: option?.label ?? "" })} />
            </div>
            <label className="nz-fl" style={{ margin: 0, gridColumn: "span 2" }}>Title<input className="nz-inp" required placeholder={jobFamilyMeta[draft.family].description} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
            <label className="nz-fl" style={{ margin: 0 }}>Initial stage<input className="nz-inp" required readOnly value={draft.workflowStage} aria-describedby="initial-stage-help"/><small className="nz-hint" id="initial-stage-help">Set by the selected family workflow.</small></label>
          </div>
        </fieldset>

        <fieldset className="nz-job-block">
          <legend>Dates</legend>
          <div className="nz-job-create-grid">
            {dateField("startDate", "Job start")}
            {dateField("dueDate", "Job end")}
            {hasPeriod ? <>
              {dateField("reportingPeriodStart", "Reporting period start")}
              {dateField("reportingPeriodEnd", "Reporting period end")}
              <label className="nz-fl" style={{ margin: 0 }}>Reporting year
                <input className="nz-inp" readOnly aria-describedby="reporting-year-help" value={reportingYear ?? "—"} />
                <small className="nz-hint" id="reporting-year-help">The year the reporting period ends in.</small>
              </label>
            </> : null}
          </div>
        </fieldset>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}><button type="button" className="nz-btn" disabled={saving} onClick={() => setCreating(false)}>Cancel</button><button className="nz-btn pri" disabled={saving || !draft.clientId}>{saving ? "Creating…" : "Create and assign number"}</button></div>
      </form>}
      <DataList
        label="Jobs"
        tableClassName="nz-job-table"
        rows={page.rows}
        rowKey={(job) => job.id}
        columns={columns}
        search={{ value: query.search, label: "Search jobs", placeholder: "Job number, client or title…", onChange: nav.search }}
        filters={filters}
        onFilter={(key, value) => nav.filter(key as JobListFilterKey, value)}
        extraControls={<div className="nz-datalist-dates" role="group" aria-label="End date">
          <label className="nz-fl">End date from<input className="nz-inp" type="date" value={query.filters.dueFrom?.[0] ?? ""} onChange={(event) => nav.filter("dueFrom", event.target.value)} /></label>
          <label className="nz-fl">End date to<input className="nz-inp" type="date" value={query.filters.dueTo?.[0] ?? ""} onChange={(event) => nav.filter("dueTo", event.target.value)} /></label>
          <button type="button" className="nz-btn" onClick={() => { const today = todayInLondon(); nav.filters({ dueFrom: [today], dueTo: [addDays(today, 60)] }); }}>Next 60 days</button>
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as JobListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={narrowed ? () => nav.clear(keep) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No jobs yet</b><span>Create the first governed job after an eligible client exists.</span></>
          : scopedClient && !narrowed
          ? <><b>No jobs for this client yet</b><span>This client has no delivery jobs on record.</span></>
          : <><b>No jobs match these filters</b><span>Clear the search or a filter to return to active delivery work.</span></>}
        busy={nav.pending}
      />
    </div>
  </AppShell>;
}

function Metric({label,value,note}:{label:string;value:string;note:string}){return <div className="nz-metric"><div className="l">{label}</div><div className="v num">{value}</div><div className="sub nz-metric-note">{note}</div></div>}
