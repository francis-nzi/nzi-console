// The governed batch attest over the committed v7 re-ingest runs (Francis, 30 Oct 2026): one person attests every run whose
// emission comparison against v7 flagged nothing, in one reviewed act, instead of job by job in the CRM.
//
// It is `scope.review.attest_reingest` — nothing new about what an attestation is — iterated over every job with a completed run:
//   - the actor is a PERSON: an active member of the organisation, with their own role's grant, who must hold `snapshot.review`.
//     They run as the staff principal, never as the re-ingest's own principal (that is REVIEWER_IS_PREPARER, refused by the command);
//   - a reason is required and goes into every row's approval note and every audit event;
//   - each run is one transaction: the plan is read under lock, D7.2 is re-checked by the command itself, every row is recorded as
//     its own approval, and the two record-of-account gaps are resolved alongside — exactly the command's rules;
//   - GUARDRAIL: a run with any flagged emission delta is skipped, and so is a run with a row that cannot be attested (a drifted
//     input, a missing quality tier) — each stays a manual per-job attest, where a person investigates before acknowledging;
//   - a run with nothing left to attest (already attested, or only rejected rows) is skipped, never re-approved;
//   - a dry run is every run's whole act, rolled back; each run's idempotency key is its run id, so a re-run replays, never doubles.
// The only output is run ids, job numbers and counts — never a label or a figure.
import { randomUUID } from "node:crypto";
import { commandGrantForRole, grantsAllow, staffRoles, type CommandContext, type CommandGrant, type StaffRole } from "@nzi/contracts";
import { withTenantRead, withTenantWrite, type PoolLike } from "./postgres";
import { attestReingestRowsInTransaction, planReingestAttestation } from "./reingestAttest";

export const BATCH_ATTEST_AUDIT_ACTION = "v7.batch_attest.completed";

export type BatchAttestStatus = "ATTESTED" | "SKIPPED_FLAGGED" | "SKIPPED_BLOCKED" | "NOTHING_TO_ATTEST" | "REFUSED";
export type BatchAttestRun = {
  jobNumber: string; jobId: string; runId: string; status: BatchAttestStatus;
  approved: number; gapsResolved: number; skippedApproved: number; excludedRejected: number; flagged: number; blocked: number;
  /** For REFUSED: the command's refusal codes (never its message, which may name a row). */
  codes: string[];
};
export type BatchAttestReport = {
  committed: boolean; actorId: string; runs: BatchAttestRun[];
  tally: Record<BatchAttestStatus, number>; approved: number; gapsResolved: number; auditEvents: number;
};
export type BatchAttestInput = {
  organisationId: string; actorId: string; reason: string; commit: boolean;
  /** Restrict to these job numbers (a pilot); default every job with a completed run. */
  jobNumbers?: readonly string[];
};

class DryRunRollback extends Error {}
const MIN_REASON = 8;

/** The person's own grant: their membership's role, which must hold `snapshot.review`. */
async function personContext(pool: PoolLike, input: BatchAttestInput): Promise<{ organisationId: string; actorId: string; principal: "staff"; reason: string; grant: CommandGrant }> {
  const member = (await withTenantRead(pool, input.organisationId, (db) => db.query<{ role_id: string; status: string }>(
    `SELECT role_id, status FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2`, [input.organisationId, input.actorId]))).rows[0];
  if (!member) throw new Error(`NOT_A_MEMBER: ${input.actorId} is not a member of ${input.organisationId}; a person attests.`);
  if (member.status !== "active") throw new Error(`NOT_ACTIVE: ${input.actorId}'s membership is ${member.status}.`);
  if (!(staffRoles as readonly string[]).includes(member.role_id)) throw new Error(`NOT_STAFF: ${input.actorId}'s role ${member.role_id} is not a staff role.`);
  const grant = commandGrantForRole(member.role_id as StaffRole, input.organisationId, input.actorId);
  if (!grantsAllow(grant.capabilities, "snapshot.review")) throw new Error(`NO_CAPABILITY: ${input.actorId}'s role ${member.role_id} does not hold snapshot.review.`);
  return { organisationId: input.organisationId, actorId: input.actorId, principal: "staff", reason: input.reason.trim(), grant };
}

export async function batchAttestReingestRuns(pool: PoolLike, input: BatchAttestInput): Promise<BatchAttestReport> {
  if (input.reason.trim().length < MIN_REASON) throw new Error(`REASON_REQUIRED: a reason of at least ${MIN_REASON} characters is required; it is recorded on every approval.`);
  const base = await personContext(pool, input);
  const wanted = input.jobNumbers ? new Set(input.jobNumbers) : null;
  const candidates = (await withTenantRead(pool, input.organisationId, (db) => db.query<{ job_id: string; legacy_job_number: string | null; run_id: string }>(
    `SELECT r.job_id, j.legacy_job_number, r.run_id
       FROM nzi_console.v7_reingest_runs r JOIN nzi_console.jobs j ON j.organisation_id = r.organisation_id AND j.job_id = r.job_id
      WHERE r.organisation_id = $1 AND r.status = 'completed' ORDER BY j.legacy_job_number, r.job_id`, [input.organisationId]))).rows
    .filter((row) => !wanted || (row.legacy_job_number !== null && wanted.has(row.legacy_job_number)));
  if (wanted) {
    const found = new Set(candidates.map((row) => row.legacy_job_number));
    const unknown = [...wanted].filter((number) => !found.has(number));
    if (unknown.length) throw new Error(`NO_COMPLETED_RUN: ${unknown.join(", ")} ${unknown.length === 1 ? "has" : "have"} no completed re-ingest run.`);
  }

  const runs: BatchAttestRun[] = [];
  for (const candidate of candidates) {
    const run: BatchAttestRun = { jobNumber: candidate.legacy_job_number ?? candidate.job_id, jobId: candidate.job_id, runId: candidate.run_id, status: "NOTHING_TO_ATTEST",
      approved: 0, gapsResolved: 0, skippedApproved: 0, excludedRejected: 0, flagged: 0, blocked: 0, codes: [] };
    const context: CommandContext = { ...base, idempotencyKey: `v7-batch-attest:${candidate.run_id}`, correlationId: `v7-batch-attest-${randomUUID()}` };
    try {
      await withTenantWrite(pool, input.organisationId, async (db) => {
        const plan = await planReingestAttestation(db, context, candidate.job_id, true);
        run.skippedApproved = plan.skippedApproved; run.excludedRejected = plan.excludedRejected.length;
        run.flagged = plan.deltas?.flagged.length ?? 0; run.blocked = plan.blocked.length;
        // The guardrail: a flagged run, and a run with an unattestable row, are a person's per-job call — not this act's.
        if (run.flagged > 0) { run.status = "SKIPPED_FLAGGED"; return; }
        if (run.blocked > 0) { run.status = "SKIPPED_BLOCKED"; return; }
        if (plan.attest.length === 0 && plan.gaps.length === 0) return;
        // Exactly the preview, sent back: the command re-plans under the same lock and refuses if anything differs.
        const outcome = await attestReingestRowsInTransaction(db, {
          jobId: candidate.job_id, runId: candidate.run_id,
          rows: plan.attest.map((row) => ({ rowId: row.rowId, expectedReviewVersion: row.version })),
          gapKeys: plan.gaps.map((gap) => gap.gapKey), acknowledgedDeltas: [],
        }, context);
        run.status = "ATTESTED"; run.approved = outcome.data.approved; run.gapsResolved = outcome.data.gapsResolved;
        if (!input.commit) throw new DryRunRollback();
      });
    } catch (error) {
      if (error instanceof DryRunRollback) { /* the dry run's whole act, rolled back */ }
      else {
        const issues = (error as { issues?: Array<{ code: string }> }).issues;
        if (!issues) throw error;
        run.status = "REFUSED"; run.codes = [...new Set(issues.map((issue) => issue.code))];
      }
    }
    runs.push(run);
  }

  const tally: Record<BatchAttestStatus, number> = { ATTESTED: 0, SKIPPED_FLAGGED: 0, SKIPPED_BLOCKED: 0, NOTHING_TO_ATTEST: 0, REFUSED: 0 };
  for (const run of runs) tally[run.status] += 1;
  const approved = runs.reduce((n, run) => n + run.approved, 0), gapsResolved = runs.reduce((n, run) => n + run.gapsResolved, 0);
  let auditEvents = runs.filter((run) => run.status === "ATTESTED").length;
  if (input.commit) {
    // The act's own record: counts only, alongside the command's per-run audit events.
    await withTenantWrite(pool, input.organisationId, (db) => db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
       VALUES ($1, $2, $3, 'staff', $4, 'organisation', $1, $5, $6, $7::jsonb)`,
      [input.organisationId, randomUUID(), input.actorId, BATCH_ATTEST_AUDIT_ACTION, `v7-batch-attest-${randomUUID()}`, input.reason.trim(),
        JSON.stringify({ runsConsidered: runs.length, ...tally, approvedRows: approved, resolvedGaps: gapsResolved })]));
    auditEvents += 1;
  }
  return { committed: input.commit, actorId: input.actorId, runs, tally, approved, gapsResolved, auditEvents };
}
