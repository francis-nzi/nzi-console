"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { reportLinkFor, v7RecordLine } from "@nzi/contracts";
import type { ReportStatusRow } from "@nzi/isolated-backend";

/**
 * Track A, A1 (RULING-reporting-trackA): the job's one link to its report, from its state — the same `reportLinkFor` the Reports
 * list and the picker use, read from the job's own row of the register. Published → the composed report; a reviewed snapshot →
 * preparation; imported v7 → its record of account, from its unsealed metadata, with no link to sealed content (Q1 (b));
 * otherwise → add evidence. Never a link to an empty preview. If the state cannot be read, nothing is offered rather than a
 * guess. (The job's "Report & publish" section is untouched — approve, validate and publish stay there.)
 */
export function JobReportLink({ jobId }: { jobId: string }) {
  const [row, setRow] = useState<ReportStatusRow | null | undefined>(undefined);
  useEffect(() => {
    fetch(`/api/isolated/report-status?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(); const body = await response.json() as { jobs?: ReportStatusRow[] }; setRow(body.jobs?.[0] ?? null); })
      .catch(() => setRow(null));
  }, [jobId]);
  if (!row) return null;
  const link = reportLinkFor(row);
  // On the job's own page, "Add evidence" would link to itself; it says where the report stands instead, beside the job's
  // own "Add emissions source" (found by the rendered check).
  if (link.kind === "add-evidence") return <span className="nz-job-report-link nz-job-report-state">No report yet — add evidence to begin</span>;
  if (link.href) return <Link className="nz-btn nz-job-report-link" href={link.href}>{link.label}</Link>;
  return <details className="nz-v7-record nz-job-report-link"><summary>{link.label}</summary><p>{v7RecordLine(row.v7Report)} Its content is kept sealed as issued; this period will be composed in the console once it is re-ingested.</p></details>;
}
