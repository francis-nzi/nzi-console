"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { v7RecordLine } from "@nzi/contracts";
import type { ReportStatusRow } from "@nzi/isolated-backend";

/**
 * Track A, A4 (RULING-reporting-trackA): a job with no reviewed snapshot, said for what it is — never the bare "Nothing here
 * yet" the generic screen state used to show here (it swallowed this page's own empty branch).
 *
 * - **Imported from v7:** the period's record of account is its v7 report (shown from its unsealed metadata, Q1 (b)); there is
 *   no console snapshot to compose yet — it is slated for re-compose.
 * - **A native job with no evidence yet:** ready for its first record, with the way to add it.
 * - **Unread:** if the job's state cannot be read, say that, rather than guess which of the two it is.
 */
export function PreviewEmpty({ jobId }: { jobId: string }) {
  const [row, setRow] = useState<ReportStatusRow | null | undefined>(undefined);
  useEffect(() => {
    fetch(`/api/isolated/report-status?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(); const body = await response.json() as { jobs?: ReportStatusRow[] }; setRow(body.jobs?.[0] ?? null); })
      .catch(() => setRow(null));
  }, [jobId]);

  const shell = (icon: string, eyebrow: string, title: string, body: React.ReactNode, actions: React.ReactNode) =>
    <main className="nz-preview-canvas"><section className="nz-preview-empty"><span className="nz-state-icon" aria-hidden="true">{icon}</span><div><span className="nz-eyebrow">{eyebrow}</span><h1>{title}</h1>{body}<div className="nz-preview-empty-actions">{actions}</div></div></section></main>;
  const back = <Link className="nz-btn" href="/report-preview">Choose another job</Link>;

  if (row === undefined) return shell("…", "Report preparation", "Checking this job", <p>Reading the job's report state…</p>, back);
  if (row && row.v7Record && !row.hasSnapshot) return shell("v7", "NZ Insights Pro v7 · awaiting re-compose", `${row.jobNumber} · ${row.client}`,
    <><p>This period's record of account is its NZ Insights Pro v7 report — there is no console snapshot to compose yet. It is slated for re-compose: once its v7 figures are re-ingested and reviewed, it can be prepared here.</p>
      <p className="nz-v7-record-line">{v7RecordLine(row.v7Report)} Its content is kept sealed as issued.</p></>,
    <><Link className="nz-btn pri" href={`/jobs/${encodeURIComponent(jobId)}`}>Open the job</Link>{back}</>);
  if (row) return shell("+", "Ready for first record", `${row.jobNumber} · ${row.client}`,
    <p>Add evidence to begin. A report can be prepared once this job's emissions rows have been reviewed and a governed snapshot of them taken.</p>,
    <><Link className="nz-btn pri" href={`/jobs/${encodeURIComponent(jobId)}`}>Add evidence</Link>{back}</>);
  return shell("!", "Report preparation", "This job's report state could not be read",
    <p>No reviewed snapshot was found for job {jobId}, and whether it is imported history or a job awaiting evidence could not be checked. Nothing has been assumed.</p>,
    <><Link className="nz-btn" href={`/jobs/${encodeURIComponent(jobId)}`}>Open the job</Link>{back}</>);
}
