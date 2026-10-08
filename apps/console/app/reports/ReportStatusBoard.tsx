"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { countReportStages, REPORT_STAGES, reportStageLabels, type ReportStage } from "@nzi/contracts";
import type { ReportStatusRow } from "@nzi/isolated-backend";

const STAGES = new Set<string>([...REPORT_STAGES, "v7-record"]);
function isRow(value: unknown): value is ReportStatusRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ReportStatusRow>;
  return typeof row.jobId === "string" && typeof row.jobNumber === "string" && typeof row.client === "string" && STAGES.has(String(row.stage))
    && typeof row.reissueReady === "boolean" && (row.ownerUserId === null || typeof row.ownerUserId === "string")
    && (row.publishedVersionId === null || typeof row.publishedVersionId === "string");
}

/** The pill tone per stage: done when the client holds it approved, estimated while it moves, need where we owe work. */
const tone: Record<ReportStage, string> = {
  "in-preparation": "need", "awaiting-review": "need", "ready-to-validate": "est", "ready-to-publish": "est",
  "awaiting-client": "est", "changes-requested": "nof", "client-approved": "done", "v7-record": "",
};

/**
 * R-ST1 (ruled): the report pipeline across the portfolio — every live CRP job at its derived stage, including the ones
 * with no report version yet, which show as their stage and never as zero. Read-only oversight: nothing here edits; each
 * row links to where the work is done. "My clients" filters to the clients you own — a view, not a permission.
 */
export function ReportStatusBoard() {
  const [jobs, setJobs] = useState<ReportStatusRow[] | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [mine, setMine] = useState(false);
  const [stage, setStage] = useState<ReportStage | "all">("all");

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

  if (error) return <section className="nz-report-pipeline" aria-label="Report pipeline"><div className="nz-banner warn" role="alert"><div><b>Report pipeline unavailable</b><div>{error} No stage counts are shown.</div></div></div></section>;
  if (jobs === null) return <div className="nz-register-loading" role="status"><i aria-hidden="true" /> <span><b>Loading the report pipeline</b><small>Deriving each CRP job's stage…</small></span></div>;

  const scoped = mine && viewer ? jobs.filter((job) => job.ownerUserId === viewer) : jobs;
  const counts = countReportStages(scoped);
  const visible = stage === "all" ? scoped : scoped.filter((job) => job.stage === stage);
  const stages: ReportStage[] = [...REPORT_STAGES, "v7-record"];

  return <section className="nz-report-pipeline" aria-label="Report pipeline">
    <div className="nz-toolbar" style={{ padding: "0 0 12px" }}>
      <div className="nz-filters" role="group" aria-label="Whose clients">
        <button type="button" aria-pressed={!mine} className={!mine ? "on" : undefined} onClick={() => setMine(false)}>All clients</button>
        <button type="button" aria-pressed={mine} className={mine ? "on" : undefined} onClick={() => setMine(true)} disabled={!viewer}>My clients</button>
      </div>
    </div>
    <div className="nz-pipeline-stages" role="group" aria-label="Filter by stage">
      <button type="button" aria-pressed={stage === "all"} className={stage === "all" ? "on" : undefined} onClick={() => setStage("all")}><b className="num">{scoped.length}</b><span>All CRP jobs</span></button>
      {stages.map((id) => <button type="button" key={id} aria-pressed={stage === id} className={stage === id ? "on" : undefined} onClick={() => setStage(id)}><b className="num">{counts[id]}</b><span>{reportStageLabels[id]}</span></button>)}
    </div>
    {visible.length === 0
      ? <div className="nz-register-empty"><i>0</i><div><b>{scoped.length === 0 ? (mine ? "You own no client with a live CRP job" : "No live CRP jobs") : "No job is at this stage"}</b><span>{scoped.length === 0 ? "Jobs appear here from the moment they are created." : "Choose another stage to see where the work is."}</span></div></div>
      : <div className="nz-panel nz-pipeline-table"><table className="nz-tbl"><thead><tr><th>Job / client</th><th>Year</th><th>Stage</th><th><span className="nz-sr-only">Open</span></th></tr></thead><tbody>
        {visible.map((job) => <tr key={job.jobId}>
          <td><Link className="nz-register-job" href={`/jobs/${job.jobId}`}>{job.jobNumber}</Link><div className="muted">{job.client}</div></td>
          <td>{job.reportingYear ?? <span className="muted">Not set</span>}</td>
          <td><span className={`nz-st ${tone[job.stage]}`}>{reportStageLabels[job.stage]}</span>{job.reissueReady ? <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>A re-issue is validated and ready to publish</div> : null}</td>
          <td>{job.publishedVersionId ? <Link className="nz-btn" href={`/reports/${job.publishedVersionId}`}>Open report</Link> : <Link className="nz-btn" href={`/jobs/${job.jobId}`}>Open job</Link>}</td>
        </tr>)}
      </tbody></table></div>}
  </section>;
}
