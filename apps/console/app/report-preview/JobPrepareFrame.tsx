"use client";

import type { ReactNode } from "react";
import { prepareReportCrumbs } from "../lib/crumbs";
import { PrepareFrame } from "./PrepareFrame";
import { useJobReportRow } from "../lib/useJobReportRow";

/**
 * The snapshot preview's frame when a job is named (`?jobId=`): the trail is the job's own — Clients / <Client> / Jobs /
 * <Job No> / Prepare report — once the job is read; until then, or if it cannot be, Reports / Prepare. The preview itself is
 * rendered on the server and passed in.
 */
export function JobPrepareFrame({ jobId, children }: { jobId: string; children: ReactNode }) {
  const row = useJobReportRow(jobId);
  return <PrepareFrame crumbs={prepareReportCrumbs(row ? { id: row.jobId, number: row.jobNumber, clientId: row.clientId, client: row.client } : null)}>{children}</PrepareFrame>;
}
