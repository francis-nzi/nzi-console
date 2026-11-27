// The re-point of re-ingested rows onto V7's own custom factors (cause 7; PLAN-v7-client-custom-factors §4, D-2 approved; 0240).
//
// The re-ingest carried each custom-factor row's value as its own one-per-row client factor (ruling 4: `source_system`
// `nzi-pro-v7-reingest`, keyed by the V7 row). Once V7's factors are loaded (`v7CustomFactorsLoad`), each such row moves to the
// factor its V7 row names — the V7 row's `original_id` is the factor's `legacy_custom_id` (`JCF-669-115`, or a custom id) — and the
// per-row factor is folded into it:
//   - **the target**, chosen as V7's resolver chooses: the id, on the job's client or organisation-level (D-3), this scope first,
//     then the client's own; not archived;
//   - **the move**: the row re-pointed (a lineage entry naming it, a version bump), then the one row calculation. A re-ingested row is
//     attest-only to everyone but the re-ingest's own principal, so the calculation runs as that principal and the person signs the
//     audit event — as the stray-2019 re-point (RULING 30 Oct 2026);
//   - **the gate (D-2)**: the recalculated figure must equal the figure before (± 0.005 t), or the row is not moved — its savepoint
//     rolled back — and is listed, and its per-row factor stays live. So is a row the calculation refuses (a unit or scope that does
//     not fit), and a row with no loaded factor;
//   - **the fold**: each per-row factor no enabled row still uses is archived (never deleted), pointing at the factor it was folded
//     into. A later re-ingest of the job reuses the folded-into factor (`v7Reingest`);
//   - recalculation puts an approved row back to pending, as every recalculation does; `v7:batch-attest` re-attests them;
//   - **issued figures are frozen**: a snapshot or a published report is never touched; such a job is moved only with the reason,
//     which is always required, and the report says it was issued.
// One transaction per job; a dry run is every job's whole act, rolled back; a re-run finds nothing left to move. One audit event per
// job: ids, factor ids, counts and tCO₂e — no money, rate or person beyond the actor (NZC-120).
import { randomUUID } from "node:crypto";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext } from "@nzi/contracts";
import { withTenantRead, withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { recalculateScopeRowInTransaction } from "./postgresCommands";
import { SOURCE_SYSTEM } from "./v7ClientImport";
import { V7_REINGEST_SOURCE_SYSTEM } from "./v7Reingest";
import { personContext } from "./v7BatchAttest";

export const CUSTOM_FACTOR_REPOINT_AUDIT_ACTION = "v7.custom_factor_rows.repointed";
/** D-2's gate: a row moves only if its recalculated figure is within this of its figure before. */
export const REPOINT_TOLERANCE_TCO2E = 0.005;
const MIN_REASON = 8;

export type RepointRowStatus = "MOVED" | "NOT_MOVED";
export type RepointRow = {
  rowId: string; v7RowId: string; legacyCustomId: string | null; status: RepointRowStatus;
  /** Why a row did not move: NO_LOADED_FACTOR, DOES_NOT_REPRODUCE, or the calculation's own refusal code. */
  code: string | null; fromFactorId: string; toFactorId: string | null;
  beforeTco2e: number | null; afterTco2e: number | null; wasApproved: boolean;
};
export type RepointJob = {
  jobId: string; jobNumber: string | null; issued: boolean; refused: string | null;
  rows: RepointRow[]; folded: Array<{ fromFactorId: string; intoFactorId: string }>;
  totals: { beforeTco2e: number; afterTco2e: number };
};
export type RepointReport = { committed: boolean; actorId: string; jobs: RepointJob[]; auditEvents: number };
export type RepointInput = { organisationId: string; actorId: string; reason: string; commit: boolean;
  /** Legacy job numbers; none named means every job with a row on a per-row re-ingest factor. */
  jobNumbers?: readonly string[] };

class DryRunRollback extends Error {}
const num = (value: string | null | undefined) => (value === null || value === undefined ? null : Number(value));

export async function repointCustomFactorRows(pool: PoolLike, input: RepointInput): Promise<RepointReport> {
  if (input.reason.trim().length < MIN_REASON) throw new Error(`REASON_REQUIRED: a reason of at least ${MIN_REASON} characters is required; it is recorded on every audit event.`);
  const person = await personContext(pool, { organisationId: input.organisationId, actorId: input.actorId, reason: input.reason, commit: input.commit });
  const wanted = input.jobNumbers ? new Set(input.jobNumbers) : null;
  const candidates = (await withTenantRead(pool, input.organisationId, (db) => db.query<{ job_id: string; legacy_job_number: string | null }>(
    `SELECT DISTINCT j.job_id, j.legacy_job_number FROM nzi_console.job_scope_rows r
       JOIN nzi_console.client_factors cf ON (cf.organisation_id, cf.client_factor_id) = (r.organisation_id, r.client_factor_id)
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (r.organisation_id, r.job_id)
      WHERE r.organisation_id = $1 AND r.origin = 'live' AND r.enabled AND r.factor_source = 'client' AND r.reingested_from_row_id IS NOT NULL
        AND cf.source_system = $2 AND NOT cf.archived
      ORDER BY j.legacy_job_number, j.job_id`, [input.organisationId, V7_REINGEST_SOURCE_SYSTEM]))).rows
    .filter((row) => !wanted || (row.legacy_job_number !== null && wanted.has(row.legacy_job_number)));
  const jobs: RepointJob[] = [];
  let auditEvents = 0;
  for (const candidate of candidates) {
    const out: RepointJob = { jobId: candidate.job_id, jobNumber: candidate.legacy_job_number, issued: false, refused: null, rows: [], folded: [], totals: { beforeTco2e: 0, afterTco2e: 0 } };
    try {
      await withTenantWrite(pool, input.organisationId, async (db) => {
        const context: CommandContext = { ...person, idempotencyKey: `v7-custom-factor-repoint:${candidate.job_id}:${randomUUID()}`, correlationId: `v7-custom-factor-repoint-${randomUUID()}` };
        await repointJob(db, context, candidate.job_id, out);
        if (out.rows.some((row) => row.status === "MOVED")) auditEvents += 1;
        if (!input.commit) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) {
        const issues = (error as { issues?: Array<{ code: string }> }).issues;
        if (!issues) throw error;
        out.refused = [...new Set(issues.map((issue) => issue.code))].join(" ");
        out.rows = out.rows.map((row) => ({ ...row, status: "NOT_MOVED", code: row.code ?? "JOB_REFUSED" })); out.folded = [];
      }
    }
    jobs.push(out);
  }
  return { committed: input.commit, actorId: input.actorId, jobs, auditEvents: input.commit ? auditEvents : 0 };
}

type Candidate = { scope_row_id: string; version: number; scope: string; calculated: string | null; client_factor_id: string; review_status: string;
  v7_row_id: string; original_id: string | null };

async function repointJob(db: Queryable, context: CommandContext, jobId: string, out: RepointJob): Promise<void> {
  const org = context.organisationId;
  const job = (await db.query<{ client_id: string }>(`SELECT client_id FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`, [org, jobId])).rows[0]!;
  out.issued = (await db.query(
    `SELECT 1 FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND job_id = $2
     UNION ALL SELECT 1 FROM nzi_console.report_versions WHERE organisation_id = $1 AND job_id = $2 AND status = 'published' LIMIT 1`, [org, jobId])).rows.length > 0;
  const total = async () => Number((await db.query<{ total: string }>(
    `SELECT coalesce(sum(coalesce(override_tco2e, calculated_tco2e, 0)) FILTER (WHERE enabled), 0)::text AS total FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2`,
    [org, jobId])).rows[0]!.total);
  out.totals.beforeTco2e = await total();
  const rows = (await db.query<Candidate>(
    `SELECT r.scope_row_id, r.version, r.scope, r.calculated_tco2e::text AS calculated, r.client_factor_id, r.review_status,
            r.reingested_from_row_id AS v7_row_id, nullif(btrim(v.migrated_record->>'original_id'), '') AS original_id
       FROM nzi_console.job_scope_rows r
       JOIN nzi_console.client_factors cf ON (cf.organisation_id, cf.client_factor_id) = (r.organisation_id, r.client_factor_id)
       JOIN nzi_console.job_scope_rows v ON v.organisation_id = r.organisation_id AND v.scope_row_id = r.reingested_from_row_id AND v.origin = 'migrated'
      WHERE r.organisation_id = $1 AND r.job_id = $2 AND r.origin = 'live' AND r.enabled AND r.factor_source = 'client'
        AND cf.source_system = $3 AND NOT cf.archived
      ORDER BY r.reingested_from_row_id, r.scope_row_id FOR UPDATE OF r`, [org, jobId, V7_REINGEST_SOURCE_SYSTEM])).rows;

  // The re-ingest's own principal: the only one a re-ingested row's calculation admits. The person signs the audit event.
  const system: CommandContext = { organisationId: org, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `${context.idempotencyKey}:calc`,
    correlationId: context.correlationId, reason: context.reason, grant: commandGrantForRole("admin", org, V7_REINGEST_ACTOR) };
  let savepoint = 0;
  for (const row of rows) {
    const result: RepointRow = { rowId: row.scope_row_id, v7RowId: row.v7_row_id, legacyCustomId: row.original_id, status: "NOT_MOVED", code: null,
      fromFactorId: row.client_factor_id, toFactorId: null, beforeTco2e: num(row.calculated), afterTco2e: null, wasApproved: row.review_status === "approved" };
    out.rows.push(result);
    // V7's choice: the id on the job's client or organisation-level, this scope first, then the client's own, then V7's lowest id.
    const target = row.original_id === null ? undefined : (await db.query<{ client_factor_id: string }>(
      `SELECT client_factor_id FROM nzi_console.client_factors
        WHERE organisation_id = $1 AND source_system = $2 AND legacy_custom_id = $3 AND NOT archived AND (client_id = $4 OR client_id IS NULL)
          AND (scope = $5 OR (strpos(scope, '.') = 0 AND scope = split_part($5, '.', 1)))
        ORDER BY (scope = $5) DESC, (client_id IS NOT NULL) DESC, nullif(regexp_replace(legacy_db_id, '\\D', '', 'g'), '')::bigint NULLS LAST
        LIMIT 1`, [org, SOURCE_SYSTEM, row.original_id, job.client_id, row.scope])).rows[0];
    if (!target) { result.code = "NO_LOADED_FACTOR"; continue; }
    result.toFactorId = target.client_factor_id;
    const name = `v7_repoint_${++savepoint}`;
    await db.query(`SAVEPOINT ${name}`);
    try {
      const note = { title: "Moved to the previous system's own custom factor", detail: `${row.original_id} · folded from the row's carried factor · run ${context.correlationId}` };
      const moved = (await db.query<{ version: number }>(
        `UPDATE nzi_console.job_scope_rows SET client_factor_id = $4, factor_id = $4, lineage_json = coalesce(lineage_json, '[]'::jsonb) || $5::jsonb, version = version + 1, updated_at = now()
          WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 AND version = $6 RETURNING version`,
        [org, jobId, row.scope_row_id, target.client_factor_id, JSON.stringify([note]), row.version])).rows[0];
      if (!moved) throw Object.assign(new Error("changed"), { issues: [{ code: "VERSION_CONFLICT" }] });
      await recalculateScopeRowInTransaction(db, { jobId, rowId: row.scope_row_id, expectedVersion: moved.version }, system, [note]);
      result.afterTco2e = num((await db.query<{ calculated: string | null }>(
        `SELECT calculated_tco2e::text AS calculated FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND scope_row_id = $2`, [org, row.scope_row_id])).rows[0]!.calculated);
      // D-2: it moves only if it reproduces.
      if (result.beforeTco2e === null || result.afterTco2e === null || Math.abs(result.afterTco2e - result.beforeTco2e) > REPOINT_TOLERANCE_TCO2E + 1e-12) {
        await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
        result.code = "DOES_NOT_REPRODUCE";
        continue;
      }
      await db.query(`RELEASE SAVEPOINT ${name}`);
      result.status = "MOVED";
    } catch (error) {
      const issues = (error as { issues?: Array<{ code: string }> }).issues;
      if (!issues) throw error;
      await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
      result.code = issues[0]?.code ?? "REFUSED";
      result.afterTco2e = null;
    }
  }

  // The fold: a per-row factor no enabled row still uses is archived, pointing at the factor it was folded into.
  for (const row of out.rows.filter((item) => item.status === "MOVED")) {
    const folded = await db.query(
      `UPDATE nzi_console.client_factors cf SET archived = true, folded_into_client_factor_id = $3, updated_by = $4, updated_at = now()
        WHERE cf.organisation_id = $1 AND cf.client_factor_id = $2 AND cf.source_system = $5 AND NOT cf.archived
          AND NOT EXISTS (SELECT 1 FROM nzi_console.job_scope_rows r WHERE r.organisation_id = cf.organisation_id AND r.client_factor_id = cf.client_factor_id AND r.enabled)
        RETURNING cf.client_factor_id`, [org, row.fromFactorId, row.toFactorId, context.actorId, V7_REINGEST_SOURCE_SYSTEM]);
    if (folded.rows.length) out.folded.push({ fromFactorId: row.fromFactorId, intoFactorId: row.toFactorId! });
  }
  out.totals.afterTco2e = await total();

  const moved = out.rows.filter((row) => row.status === "MOVED");
  if (moved.length === 0) return;
  await db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
     VALUES ($1, $2, $3, 'staff', $4, 'job', $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [org, randomUUID(), context.actorId, CUSTOM_FACTOR_REPOINT_AUDIT_ACTION, jobId, context.correlationId, context.reason,
      JSON.stringify({ rows: moved.map((row) => ({ rowId: row.rowId, clientFactorId: row.fromFactorId, tco2e: row.beforeTco2e })), totalTco2e: out.totals.beforeTco2e }),
      JSON.stringify({ rows: moved.map((row) => ({ rowId: row.rowId, clientFactorId: row.toFactorId, tco2e: row.afterTco2e })), totalTco2e: out.totals.afterTco2e,
        folded: out.folded, notMoved: out.rows.filter((row) => row.status === "NOT_MOVED").map((row) => ({ rowId: row.rowId, code: row.code })),
        approvedReset: moved.filter((row) => row.wasApproved).length, issued: out.issued, jobNumber: out.jobNumber })]);
}
