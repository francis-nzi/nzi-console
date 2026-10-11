"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  countReportStages, defaultReportRegisterQuery, filterReportRegister, filterReportRegisterExceptStage, parseReportRegisterQuery,
  REPORT_STAGES, reportEligibilityLabels, reportEligibilityOf, reportLinkFor, reportRegisterQueryString, reportStageLabels,
  v7RecordLine, type ReportRegisterQuery, type ReportStage,
} from "@nzi/contracts";
import type { ReportStatusRow } from "@nzi/isolated-backend";

const STAGES: ReportStage[] = [...REPORT_STAGES, "v7-record"];
const STAGE_SET = new Set<string>(STAGES);
function isRow(value: unknown): value is ReportStatusRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ReportStatusRow>;
  return typeof row.jobId === "string" && typeof row.jobNumber === "string" && typeof row.client === "string" && STAGE_SET.has(String(row.stage))
    && typeof row.reissueReady === "boolean" && (row.ownerUserId === null || typeof row.ownerUserId === "string")
    && (row.publishedVersionId === null || typeof row.publishedVersionId === "string")
    && typeof row.title === "string" && typeof row.hasSnapshot === "boolean" && typeof row.v7Record === "boolean";
}

/** The pill tone per stage: done when the client holds it approved, estimated while it moves, need where we owe work. */
const tone: Record<ReportStage, string> = {
  "in-preparation": "need", "awaiting-review": "need", "ready-to-validate": "est", "ready-to-publish": "est",
  "awaiting-client": "est", "changes-requested": "nof", "client-approved": "done", "v7-record": "",
};

/**
 * Track A (RULING-reporting-trackA): the one register of CRP jobs and their reports, shared by the Reports page's pipeline and
 * the preparation picker — the same row, the same filters, the same link logic (`reportLinkFor`).
 *
 * - **Filters (A3)**, in the URL so a view can be shared: My clients (the default — the clients you own, a view, not a
 *   permission) or all; client; lead consultant; report stage (the counters, a funnel over the other filters); year;
 *   compose-eligibility; search over job number, v7 number, client and title. Imported jobs are badged, never hidden.
 * - **The row (A2, A5)**: job, client, year, stage, lead consultant, eligibility badge, and one action from the job's state. An
 *   imported job's v7 report is its record of account, shown from its unsealed metadata — never opened (Q1 (b)).
 * - **Honest states**: a read that fails says so and shows no counts; "no live jobs" and "nothing matches these filters" are
 *   different messages.
 */
export function ReportRegisterView({ mode }: { mode: "pipeline" | "picker" }) {
  const [jobs, setJobs] = useState<ReportStatusRow[] | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState<ReportRegisterQuery>(defaultReportRegisterQuery);

  // The URL is the filter's state: read once on arrival, rewritten (without a navigation) on every change.
  useEffect(() => { setQuery(parseReportRegisterQuery(new URLSearchParams(window.location.search), STAGES)); }, []);
  const update = (patch: Partial<ReportRegisterQuery>) => setQuery((current) => {
    const next = { ...current, ...patch };
    const url = `${window.location.pathname}${reportRegisterQueryString(next)}${mode === "picker" ? "" : window.location.hash}`;
    window.history.replaceState(null, "", url);
    return next;
  });

  useEffect(() => {
    fetch("/api/isolated/report-status", { cache: "no-store" })
      .then((response) => response.json().then((body) => ({ response, body })))
      .then(({ response, body }) => {
        if (!response.ok) throw new Error(body.message ?? "The report pipeline is unavailable.");
        if (!Array.isArray(body.jobs) || !body.jobs.every(isRow)) throw new Error("The report pipeline returned an invalid response.");
        setJobs(body.jobs); setViewer(typeof body.viewerUserId === "string" ? body.viewerUserId : null);
      })
      .catch((cause) => { setError(cause instanceof Error ? cause.message : "The report pipeline is unavailable."); setJobs(null); });
  }, []);

  const options = useMemo(() => {
    const rows = jobs ?? [];
    const unique = <T,>(values: T[]) => [...new Set(values)];
    return {
      clients: unique(rows.map((row) => `${row.clientId}\u0000${row.client}`)).map((pair) => pair.split("\u0000") as [string, string]).sort((a, b) => a[1].localeCompare(b[1])),
      leads: unique(rows.map((row) => row.leadConsultant).filter((name): name is string => !!name)).sort((a, b) => a.localeCompare(b)),
      years: unique(rows.map((row) => row.reportingYear).filter((year): year is number => year !== null)).sort((a, b) => b - a),
    };
  }, [jobs]);

  if (error) return <section className="nz-report-pipeline" aria-label="Report pipeline"><div className="nz-banner warn" role="alert"><div><b>Report pipeline unavailable</b><div>{error} No stage counts are shown.</div></div></div></section>;
  if (jobs === null) return <div className="nz-register-loading" role="status"><i aria-hidden="true" /> <span><b>Loading the report pipeline</b><small>Deriving each CRP job's stage…</small></span></div>;

  // "My clients" needs to know who is looking; without that, all clients are shown and the toggle says why it is off.
  const effective: ReportRegisterQuery = viewer ? query : { ...query, whose: "all" };
  const scoped = filterReportRegisterExceptStage(jobs, effective, viewer);
  const counts = countReportStages(scoped);
  const visible = filterReportRegister(jobs, effective, viewer);
  const filtered = effective.clientId !== null || effective.leadConsultant !== null || effective.year !== null || effective.eligibility !== "all" || effective.search.trim() !== "" || effective.stage !== "all";

  return <section className="nz-report-pipeline" aria-label={mode === "picker" ? "Choose a CRP job" : "Report pipeline"}>
    <div className="nz-reportreg-filters" role="search" aria-label="Filter CRP jobs">
      <div className="nz-filters" role="group" aria-label="Whose clients">
        <button type="button" aria-pressed={effective.whose === "mine"} className={effective.whose === "mine" ? "on" : undefined} onClick={() => update({ whose: "mine" })} disabled={!viewer} title={viewer ? undefined : "Your sign-in could not be read, so every client is shown."}>My clients</button>
        <button type="button" aria-pressed={effective.whose === "all"} className={effective.whose === "all" ? "on" : undefined} onClick={() => update({ whose: "all" })}>All clients</button>
      </div>
      <label><span>Search</span><input type="search" value={query.search} placeholder="Job number, client or plan title…" onChange={(event) => update({ search: event.target.value })} /></label>
      <label><span>Client</span><select value={query.clientId ?? ""} onChange={(event) => update({ clientId: event.target.value || null })}><option value="">All</option>{options.clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label><span>Lead consultant</span><select value={query.leadConsultant ?? ""} onChange={(event) => update({ leadConsultant: event.target.value || null })}><option value="">All</option>{options.leads.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      <label><span>Year</span><select value={query.year ?? ""} onChange={(event) => update({ year: event.target.value ? Number(event.target.value) : null })}><option value="">All</option>{options.years.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
      <label><span>Report</span><select value={query.eligibility} onChange={(event) => update({ eligibility: event.target.value as ReportRegisterQuery["eligibility"] })}><option value="all">All</option>{(Object.keys(reportEligibilityLabels) as Array<keyof typeof reportEligibilityLabels>).map((key) => <option key={key} value={key}>{reportEligibilityLabels[key]}</option>)}</select></label>
    </div>
    <div className="nz-pipeline-stages" role="group" aria-label="Filter by report stage">
      <button type="button" aria-pressed={effective.stage === "all"} className={effective.stage === "all" ? "on" : undefined} onClick={() => update({ stage: "all" })}><b className="num">{scoped.length}</b><span>All CRP jobs</span></button>
      {STAGES.map((id) => <button type="button" key={id} aria-pressed={effective.stage === id} className={effective.stage === id ? "on" : undefined} onClick={() => update({ stage: id })}><b className="num">{counts[id]}</b><span>{reportStageLabels[id]}</span></button>)}
    </div>
    {visible.length === 0
      ? <div className="nz-register-empty"><i>0</i><div>{jobs.length === 0
        ? <><b>No live CRP jobs</b><span>Jobs appear here from the moment they are created.</span></>
        : filtered || effective.whose === "mine"
          ? <><b>No jobs match these filters</b><span>{effective.whose === "mine" && !filtered ? "You own no client with a live CRP job — choose All clients to see the rest." : "Clear a filter, or choose All clients, to widen the list."}</span></>
          : <><b>No live CRP jobs</b><span>Jobs appear here from the moment they are created.</span></>}</div></div>
      : <div className="nz-panel nz-pipeline-table"><table className="nz-tbl"><thead><tr><th>Job / client</th><th>Year</th><th>Stage</th><th>Lead consultant</th><th><span className="nz-sr-only">Report</span></th></tr></thead><tbody>
        {visible.map((job) => <ReportRegisterRow key={job.jobId} job={job} />)}
      </tbody></table></div>}
  </section>;
}

/** A2: one job's row — the same on the Reports page and in the picker. */
function ReportRegisterRow({ job }: { job: ReportStatusRow }) {
  const link = reportLinkFor(job);
  const eligibility = reportEligibilityOf(job);
  return <tr>
    <td>
      <Link className="nz-register-job" href={`/jobs/${job.jobId}`}>{job.jobNumber}</Link>
      {job.legacyJobNumber && job.legacyJobNumber !== job.jobNumber ? <span className="muted"> · v7 {job.legacyJobNumber}</span> : null}
      <div className="muted">{job.client}{job.title ? ` · ${job.title}` : ""}</div>
      <span className={`nz-register-eligibility ${eligibility}`}>{reportEligibilityLabels[eligibility]}</span>
    </td>
    <td>{job.reportingYear ?? <span className="muted">Not set</span>}</td>
    <td><span className={`nz-st ${tone[job.stage]}`}>{reportStageLabels[job.stage]}</span>{job.reissueReady ? <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>A re-issue is validated and ready to publish</div> : null}
      {job.scopes ? <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>{job.scopes.map((scope) => `${scope.scopeLabel}: ${reportStageLabels[scope.stage].toLowerCase()}`).join(" · ")}</div> : null}</td>
    <td>{job.leadConsultant ?? <span className="muted">Not set</span>}</td>
    <td>{link.href
      ? <Link className={`nz-btn${link.kind === "prepare" ? " pri" : ""}`} href={link.href}>{link.label}</Link>
      : <details className="nz-v7-record"><summary>{link.label}</summary><p>{v7RecordLine(job.v7Report)} Its content is kept sealed as issued; this period will be composed in the console once it is re-ingested.</p></details>}</td>
  </tr>;
}
