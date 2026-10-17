"use client";

import Link from "next/link";
import { reportLinkFor, v7RecordLine } from "@nzi/contracts";
import { reportFeatureEnabled } from "../lib/reportFlags";
import { useJobReportRow } from "../lib/useJobReportRow";

/**
 * Track A, A1 (RULING-reporting-trackA): the job's one link to its report, from its state — the same `reportLinkFor` the Reports
 * list and the picker use, read from the job's own row of the register. Published → the composed report; a reviewed snapshot →
 * preparation; imported v7 → its record of account, from its unsealed metadata, with no link to sealed content (Q1 (b));
 * otherwise → add evidence. Never a link to an empty preview. If the state cannot be read, nothing is offered rather than a
 * guess. (Under the job shell with the Report Studio on, the job's "Report & publish" stage is the report's state and "Open in
 * Report Studio" — the snapshot is approved in Review & QA, and validated and published in the studio.)
 */
export function JobReportLink({ jobId }: { jobId: string }) {
  const row = useJobReportRow(jobId);
  if (!row) return null;
  // The one path: "Prepare report" opens the Report Studio wherever it is on.
  const link = reportLinkFor(row, { studio: reportFeatureEnabled("report-sections") });
  // On the job's own page, "Add evidence" would link to itself; it says where the report stands instead, beside the job's
  // own "Add emissions source" (found by the rendered check).
  if (link.kind === "add-evidence") return <span className="nz-job-report-link nz-job-report-state">No report yet — add evidence to begin</span>;
  // Addendum #1: preparing or opening the report is the job's primary way into reporting, so it looks primary — as the
  // register row's action does.
  if (link.kind === "prepare" || link.kind === "published") return <Link className="nz-btn pri nz-job-report-link" href={link.href}>{link.label}</Link>;
  return <details className="nz-v7-record nz-job-report-link"><summary>{link.label}</summary><p>{v7RecordLine(row.v7Report)} Its content is kept sealed as issued; this period will be composed in the console once it is re-ingested.</p></details>;
}
