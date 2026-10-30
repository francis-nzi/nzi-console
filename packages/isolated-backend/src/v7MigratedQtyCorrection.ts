// The governed correction of 11 stale migrated quantities (RULING 29 Oct 2026, Francis): v7's rows were amended about ten days
// before this ran and the amendment never reached the console's migrated copy. On those rows `migrated_record.qty` is a
// pre-amendment typo; the months array and the reported emission are correct and consistent with each other. The correct
// quantity is the sum of the row's months.
//
// 0133 makes a migrated row immutable (only `enabled` may change), and says the way through is the owner's alone: DISABLE TRIGGER
// `job_scope_rows_migrated_immutable` around a reviewed backfill, re-enabled in the same transaction. This is that backfill —
// the one place it is done — and nothing else about it is loose:
//   - one transaction, on the owner (login) role, because the trigger DDL needs the table owner (the app role cannot);
//   - it refuses unless the rows are exactly the ruled set, the jobs have no completed re-ingest run, and a book-wide scan of
//     enabled rows whose qty differs from their months by more than rounding returns exactly that set;
//   - it updates the `qty` key only (jsonb_set), so the rest of the record is preserved byte for byte;
//   - it verifies every row's qty now equals its months sum, and that the trigger is enabled again, before it commits;
//   - one audit event per row: ids and the field name only — no figures as text;
//   - a dry run is the whole thing, rolled back.
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { PoolLike } from "./postgres";

export const MIGRATED_IMMUTABLE_TRIGGER = "job_scope_rows_migrated_immutable";
export const QTY_CORRECTION_ACTION = "v7.migrated_qty.corrected";
/**
 * Above this (absolute), a qty and its months sum differ by more than rounding — a genuine stale typo. Measured on staging 29 Oct:
 * rounding differences are at most 0.01 (v7-row-2750/2752, 4063); the 11 stale typos differ by at least 525. 1.0 splits them cleanly
 * (the first dry run, at 0.005, caught the two 0.01 rounding rows and refused SET_MISMATCH). Rounding is carried by the re-ingest's
 * relative months tolerance (V7_MONTHS_ROUNDING), not corrected here.
 */
export const QTY_ROUNDING_TOLERANCE = 1.0;

/** The ruled 11 — enabled migrated rows whose qty is the pre-amendment typo — grouped by their job. */
export const V7_STALE_QTY_ROWS: ReadonlyArray<{ jobId: string; rowIds: readonly string[] }> = [
  { jobId: "v7-job-2", rowIds: ["v7-row-1063", "v7-row-1066"] },
  { jobId: "v7-job-684", rowIds: ["v7-row-3617", "v7-row-3618", "v7-row-3619"] },
  { jobId: "v7-job-629", rowIds: ["v7-row-3621"] },
  { jobId: "v7-job-688", rowIds: ["v7-row-5969"] },
  { jobId: "v7-job-80", rowIds: ["v7-row-1083"] },
  { jobId: "v7-job-617", rowIds: ["v7-row-1358", "v7-row-1359"] },
  { jobId: "v7-job-259", rowIds: ["v7-row-1628"] },
];

export type QtyCorrectionInput = {
  organisationId: string; actorId: string; commit: boolean;
  /** The ruled set; defaults to `V7_STALE_QTY_ROWS`. A test passes its own. */
  rows?: ReadonlyArray<{ jobId: string; rowIds: readonly string[] }>;
};
export type QtyCorrectionReport = {
  committed: boolean; jobs: number; rows: number; corrected: number;
  /** Enabled rows outside the ruled set that also differ by more than rounding — must be none, or nothing is written. */
  unlistedMismatches: string[];
  /** Differences within rounding that the ruled scan does not count (reported, never touched). */
  withinRounding: string[];
  /** Disabled rows (never in v7's totals) that differ — reported, never touched. */
  disabledMismatches: string[];
  triggerEnabledAfter: boolean; auditEvents: number;
};

class QtyCorrectionRefused extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}
class DryRunRollback extends Error {}

type ScanRow = { job_id: string; scope_row_id: string; enabled: boolean; qty: string | null; msum: string | null; mcount: string };

const scan = async (client: PoolClient, organisationId: string): Promise<ScanRow[]> => (await client.query<ScanRow>(
  `SELECT job_id, scope_row_id, enabled, NULLIF(migrated_record->>'qty', '')::numeric::text AS qty,
          (SELECT sum((e #>> '{}')::numeric) FROM jsonb_array_elements(migrated_record->'months') e WHERE jsonb_typeof(e) = 'number')::text AS msum,
          (SELECT count(*) FROM jsonb_array_elements(migrated_record->'months') e WHERE jsonb_typeof(e) = 'number')::text AS mcount
     FROM nzi_console.job_scope_rows
    WHERE organisation_id = $1 AND origin = 'migrated' AND jsonb_typeof(migrated_record->'months') = 'array'`, [organisationId])).rows
  .filter((row) => Number(row.mcount) > 0 && row.qty !== null && row.msum !== null && row.qty !== row.msum && Number(row.qty) !== Number(row.msum));

export async function correctStaleMigratedQty(pool: PoolLike, input: QtyCorrectionInput): Promise<QtyCorrectionReport> {
  const ruled = input.rows ?? V7_STALE_QTY_ROWS;
  const ruledIds = new Set(ruled.flatMap((entry) => entry.rowIds));
  const jobIds = ruled.map((entry) => entry.jobId);
  const client = await pool.connect();
  let report: QtyCorrectionReport | null = null;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [input.organisationId]);
    try {
      // 1. No completed re-ingest run on any of the jobs: a re-ingested job has copied these quantities into live rows.
      const completed = (await client.query<{ job_id: string }>(
        `SELECT DISTINCT job_id FROM nzi_console.v7_reingest_runs WHERE organisation_id = $1 AND status = 'completed' AND job_id = ANY($2::text[])`,
        [input.organisationId, jobIds])).rows.map((row) => row.job_id);
      if (completed.length) throw new QtyCorrectionRefused("COMPLETED_RUN", `${completed.length} job(s) already have a completed re-ingest run (${completed.join(", ")}); revert it first.`);

      // 2. The book-wide scan, in the ruled terms: enabled migrated rows whose qty differs from their months by more than rounding.
      const mismatched = await scan(client, input.organisationId);
      const beyond = (row: ScanRow) => Math.abs(Number(row.qty) - Number(row.msum)) > QTY_ROUNDING_TOLERANCE;
      const enabledBeyond = mismatched.filter((row) => row.enabled && beyond(row));
      const unlisted = enabledBeyond.filter((row) => !ruledIds.has(row.scope_row_id)).map((row) => `${row.scope_row_id}@${row.job_id}`);
      const missing = [...ruledIds].filter((id) => !enabledBeyond.some((row) => row.scope_row_id === id));
      if (unlisted.length || missing.length)
        throw new QtyCorrectionRefused("SET_MISMATCH", `the scan does not return exactly the ruled ${ruledIds.size} rows — unlisted: [${unlisted.join(", ")}]; ruled but not found as stale: [${missing.join(", ")}].`);
      for (const entry of ruled) {
        const wrongJob = enabledBeyond.filter((row) => entry.rowIds.includes(row.scope_row_id) && row.job_id !== entry.jobId);
        if (wrongJob.length) throw new QtyCorrectionRefused("SET_MISMATCH", `${wrongJob[0]!.scope_row_id} belongs to ${wrongJob[0]!.job_id}, not ${entry.jobId}.`);
      }

      // 3. The correction: the sanctioned bypass, in this transaction only.
      await client.query(`ALTER TABLE nzi_console.job_scope_rows DISABLE TRIGGER ${MIGRATED_IMMUTABLE_TRIGGER}`);
      const updated = await client.query<{ scope_row_id: string }>(
        `UPDATE nzi_console.job_scope_rows r
            SET migrated_record = jsonb_set(r.migrated_record, '{qty}', to_jsonb(s.msum))
           FROM (SELECT scope_row_id, (SELECT sum((e #>> '{}')::numeric) FROM jsonb_array_elements(migrated_record->'months') e WHERE jsonb_typeof(e) = 'number') AS msum
                   FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND scope_row_id = ANY($2::text[]) AND origin = 'migrated') s
          WHERE r.organisation_id = $1 AND r.scope_row_id = s.scope_row_id AND r.origin = 'migrated'
        RETURNING r.scope_row_id`, [input.organisationId, [...ruledIds]]);
      await client.query(`ALTER TABLE nzi_console.job_scope_rows ENABLE TRIGGER ${MIGRATED_IMMUTABLE_TRIGGER}`);
      if (updated.rows.length !== ruledIds.size) throw new QtyCorrectionRefused("COUNT", `updated ${updated.rows.length} rows, expected ${ruledIds.size}.`);

      // 4. Post-conditions, asserted rather than assumed: every row now tallies, nothing else is stale, the trigger is back on.
      const after = await scan(client, input.organisationId);
      const stillStale = after.filter((row) => ruledIds.has(row.scope_row_id));
      if (stillStale.length) throw new QtyCorrectionRefused("POSTCONDITION", `${stillStale.length} corrected row(s) still differ from their months.`);
      const trigger = (await client.query<{ tgenabled: string }>(
        `SELECT tgenabled::text FROM pg_trigger WHERE tgrelid = 'nzi_console.job_scope_rows'::regclass AND tgname = $1`, [MIGRATED_IMMUTABLE_TRIGGER])).rows[0];
      if (trigger?.tgenabled !== "O") throw new QtyCorrectionRefused("POSTCONDITION", `trigger ${MIGRATED_IMMUTABLE_TRIGGER} is not enabled again.`);

      // 5. Audit — by id and field; the figures stay in the rows, not in the event text.
      const jobOf = new Map(ruled.flatMap((entry) => entry.rowIds.map((id) => [id, entry.jobId] as const)));
      for (const id of ruledIds) {
        await client.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
           VALUES ($1, $2, $3, 'system', $4, 'job_scope_row', $5, $6, $7, $8::jsonb, $9::jsonb)`,
          [input.organisationId, randomUUID(), input.actorId, QTY_CORRECTION_ACTION, id, `v7-migrated-qty:${jobOf.get(id)}`,
            "v7 amended ~10 days before this ran and the amendment never reached the console copy: the migrated quantity is set to the sum of the row's months (ruled 29 Oct 2026).",
            JSON.stringify({ field: "migrated_record.qty", state: "stale" }), JSON.stringify({ field: "migrated_record.qty", equals: "sum of months", jobId: jobOf.get(id) })]);
      }

      report = {
        committed: input.commit, jobs: ruled.length, rows: ruledIds.size, corrected: updated.rows.length,
        unlistedMismatches: unlisted,
        withinRounding: mismatched.filter((row) => !beyond(row)).map((row) => `${row.scope_row_id}@${row.job_id}${row.enabled ? "" : " (disabled)"}`),
        disabledMismatches: mismatched.filter((row) => !row.enabled && beyond(row)).map((row) => `${row.scope_row_id}@${row.job_id}`),
        triggerEnabledAfter: true, auditEvents: ruledIds.size,
      };
      if (!input.commit) throw new DryRunRollback();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (!(error instanceof DryRunRollback)) throw error;
    }
  } finally {
    client.release();
  }
  return report!;
}
