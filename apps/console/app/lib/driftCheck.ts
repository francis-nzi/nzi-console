import "server-only";
import {
  checkV7Drift, runV7DriftChecks, v7FiguresClientFromEnv, V7FiguresConnectionRefused, v7RowFiguresClientFromEnv, withTenantRead,
  type StaffPrincipal, type V7FiguresClient, type V7RowFiguresClient,
} from "@nzi/isolated-backend";
import { isolatedPool } from "./isolatedDatabase";

/**
 * The drift guard in the console (BRIEF-v7-import-j000663 Part C; CONTRACT-v7-import-figures v1). V7's credential lives in this
 * service's environment only (NZI_V7_FIGURES_URL, NZI_V7_FIGURES_TOKEN). A URL the guard refuses (not HTTPS, or the console's own
 * address) makes every check `unknown` ("refused") and is logged by name, never by value.
 */
export function liveFiguresClient(): V7FiguresClient {
  try { return v7FiguresClientFromEnv(process.env); } catch (error) {
    if (!(error instanceof V7FiguresConnectionRefused)) throw error;
    console.error(JSON.stringify({ event: "v7-figures.refused", reason: error.message }));
    return async () => ({ ok: false, reason: "refused" });
  }
}

/**
 * The contract's endpoint 2 (the previous system's own row figures), for the rows modal and the spanning job's bring-in: the same
 * credential and guard as endpoint 1, through the process's pace. Refused URL → every read is `refused`, logged by name.
 */
export function liveRowFiguresClient(): V7RowFiguresClient {
  try { return v7RowFiguresClientFromEnv(process.env); } catch (error) {
    if (!(error instanceof V7FiguresConnectionRefused)) throw error;
    console.error(JSON.stringify({ event: "v7-figures.refused", reason: error.message }));
    return async () => ({ ok: false, reason: "refused" });
  }
}

/**
 * Straight after a bring-in (Datasets Part 2, increment 2): a check of the job against the previous system's totals, stored (0237's
 * `bring-in` trigger), so its banner and the publish gate read what was just brought in. Never throws: the bring-in has happened.
 */
export async function checkAfterBringIn(principal: StaffPrincipal, jobId: string, correlationId: string): Promise<void> {
  try {
    await checkV7Drift(isolatedPool(), liveFiguresClient(), principal.organisationId, jobId,
      { trigger: "bring-in", requestedBy: principal.userId, correlationId, principal: "staff" });
  } catch (error) {
    console.error(JSON.stringify({ event: "v7-drift.bring-in-check-failed", jobId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * Just before a publish (ruled 25 Nov: "Before publish"): a fresh check of the report's job, stored, so the publish command's gate reads
 * it. A job not imported from the previous system is skipped. Never throws for the check itself: the gate decides on what was stored.
 */
export async function checkBeforePublish(principal: StaffPrincipal, reportVersionId: unknown, correlationId: string): Promise<void> {
  if (typeof reportVersionId !== "string" || !reportVersionId) return;
  const job = await withTenantRead(isolatedPool(), principal.organisationId, async (db) => (await db.query<{ job_id: string; imported: boolean }>(
    `SELECT v.job_id, (j.job_family = 'crp' AND j.legacy_job_number IS NOT NULL) AS imported FROM nzi_console.report_versions v
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (v.organisation_id, v.job_id) WHERE v.organisation_id = $1 AND v.report_version_id = $2`,
    [principal.organisationId, reportVersionId])).rows[0]);
  if (!job?.imported) return;
  try {
    await checkV7Drift(isolatedPool(), liveFiguresClient(), principal.organisationId, job.job_id,
      { trigger: "publish", requestedBy: principal.userId, correlationId, principal: "staff" });
  } catch (error) {
    console.error(JSON.stringify({ event: "v7-drift.publish-check-failed", jobId: job.job_id, error: error instanceof Error ? error.name : "unknown" }));
  }
}

const holder = globalThis as typeof globalThis & { nziDriftRuns?: Set<string> };

/** "Check now" from the Admin list: one paced run per organisation in this process, outliving the request. False when one is running. */
export function kickDriftRun(principal: StaffPrincipal, correlationId: string): boolean {
  const running = holder.nziDriftRuns ??= new Set<string>();
  if (running.has(principal.organisationId)) return false;
  running.add(principal.organisationId);
  void runV7DriftChecks(isolatedPool(), liveFiguresClient(), principal.organisationId, { trigger: "admin", requestedBy: principal.userId, correlationId, principal: "staff" })
    .then((result) => console.log(JSON.stringify({ event: "v7-drift.run", ...result })))
    .catch((error: unknown) => console.error(JSON.stringify({ event: "v7-drift.run-stopped", error: error instanceof Error ? error.name : "unknown" })))
    .finally(() => running.delete(principal.organisationId));
  return true;
}
