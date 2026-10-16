"use client";

import Link from "next/link";
import { reportLinkFor } from "@nzi/contracts";
import { reportFeatureEnabled } from "../lib/reportFlags";
import { useJobReportRow } from "../lib/useJobReportRow";
import { studioHasReport } from "./[jobId]/report/studio";

/**
 * B2-1 (RULING-report-studio-B2): the job's way into its Report Studio, beside its report link — offered only once there is
 * an approved snapshot to draft from or a version to draw, and only where the studio is on (`report-sections`). The one path
 * (CORRECTION-report-studio-live-path): where the job's report link already opens the studio ("Prepare report"), this would
 * be a second button to the same place, so it steps aside; beside "View composed report" it stays.
 */
export function JobReportStudioLink({ jobId }: { jobId: string }) {
  const row = useJobReportRow(jobId);
  if (!row || !studioHasReport(row.stage) || !reportFeatureEnabled("report-sections")) return null;
  if (reportLinkFor(row, { studio: true }).kind === "prepare") return null;
  return <Link className="nz-btn nz-job-report-link" href={`/jobs/${encodeURIComponent(jobId)}/report/printing`} data-report-studio-link>Report Studio</Link>;
}
