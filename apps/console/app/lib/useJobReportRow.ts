"use client";

import { useEffect, useState } from "react";
import type { ReportStatusRow } from "@nzi/isolated-backend";

/**
 * The job's own row of the report status register (`?jobId=`): `undefined` while it is read, `null` if it could not be.
 * The job page's report link, the preparation breadcrumb and the empty states all read the job through this one call.
 */
export function useJobReportRow(jobId: string): ReportStatusRow | null | undefined {
  const [row, setRow] = useState<ReportStatusRow | null | undefined>(undefined);
  useEffect(() => {
    fetch(`/api/isolated/report-status?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(); const body = await response.json() as { jobs?: ReportStatusRow[] }; setRow(body.jobs?.[0] ?? null); })
      .catch(() => setRow(null));
  }, [jobId]);
  return row;
}
