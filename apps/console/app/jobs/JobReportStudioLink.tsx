"use client";

import Link from "next/link";
import { useJobReportRow } from "../lib/useJobReportRow";
import { studioHasReport } from "./[jobId]/report/studio";

/**
 * B2-1 (RULING-report-studio-B2): the job's way into its Report Studio, beside its report link — offered only once there is a
 * validated or published version for Report Printing to draw. The job's one state-driven report link (Track A, A1) is
 * unchanged; this sits next to it until the studio becomes the report's home (B2-6).
 */
export function JobReportStudioLink({ jobId }: { jobId: string }) {
  const row = useJobReportRow(jobId);
  if (!row || !studioHasReport(row.stage)) return null;
  return <Link className="nz-btn nz-job-report-link" href={`/jobs/${encodeURIComponent(jobId)}/report/printing`} data-report-studio-link>Report Studio</Link>;
}
