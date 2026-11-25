import "server-only";
import { checkV7Drift, runV7DriftChecks, v7FiguresClientFromEnv, V7FiguresConnectionRefused, withTenantRead, type StaffPrincipal, type V7FiguresClient } from "@nzi/isolated-backend";
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
