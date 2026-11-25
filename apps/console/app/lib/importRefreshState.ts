import "server-only";
import { readImportPolicy, readV7DriftBanner, withTenantRead, type StaffPrincipal } from "@nzi/isolated-backend";
import { grantsAllow } from "@nzi/contracts";
import type { ImportRefreshState } from "../jobs/importRefreshView";
import { isolatedPool } from "./isolatedDatabase";

/**
 * What the job's refresh panel needs before it shows anything: whether the job came from the previous system, whether the caller
 * may commit (import.refresh, and Admin when the organisation's import policy requires it), and whether they resolve rows
 * (import.manage — the Phase 2 controls, in Import reconciliation). The caller's `import.refresh` is the route's to check first.
 */
export async function readImportRefreshState(principal: StaffPrincipal, jobId: string): Promise<ImportRefreshState> {
  return withTenantRead(isolatedPool(), principal.organisationId, async (db) => {
    const job = (await db.query<{ job_id: string; source_system: string | null; legacy_job_number: string | null }>(
      `SELECT job_id, source_system, legacy_job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [principal.organisationId, jobId])).rows[0];
    if (!job || job.source_system !== "nzi-pro-v7" || !job.legacy_job_number) return { applies: false };
    // Fails closed: an unreadable policy fails the read, never reads as "an Admin is not needed".
    const policy = await readImportPolicy(db, principal.organisationId);
    // Part C: the latest stored check against the previous system — never a call to it from here.
    const drift = await readV7DriftBanner(db, principal.organisationId, job.job_id);
    return {
      drift: drift ? { tone: drift.tone, line: drift.line, checkedAt: drift.checkedAt } : null,
      applies: true, jobId: job.job_id, legacyJobNumber: job.legacy_job_number, writeEnabled: process.env.NZI_WRITE_API_ENABLED === "true",
      commitNeedsAdmin: policy.refreshCommitRequiresAdmin, isAdmin: principal.role === "admin", canResolve: grantsAllow(principal.capabilities, "import.manage"),
    };
  });
}
