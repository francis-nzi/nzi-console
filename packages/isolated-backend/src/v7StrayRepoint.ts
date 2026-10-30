// The governed re-point of the four stray 2019 diesel-van rows (RULING 30 Oct 2026, Cowork; re-attest approved by Francis):
// J000724–J000727 are consecutive annual CRPs for one client (2020–2023). Each carries ONE row still on `uk-ghg-gb-2019` — v7 stamped
// a 2019 vintage ("ruling 3") and the re-ingest carried it. A reporting year uses its own year's factors, so each row moves to its own
// year's edition of the SAME factor id, is recalculated, and is re-attested. After this, J000723 is the only consumer of the 2019
// datasets, which is what lets the 2019 dataset replacement run without touching other years' jobs.
//
//   - ruled set only: four named rows, each guarded on the job number, reporting year, the 2019 dataset and the factor id it holds;
//   - the target is a clean 1:1: the same factor id, active, in the same unit, in the job's own-year dataset, which the job selects;
//   - the move is `jobDatasetUpdate`'s own row step (re-point, lineage entry, version bump) followed by the one row calculation. A
//     re-ingested row is attest-only to everyone except the re-ingest's own principal, so the recalculation runs as that principal —
//     and the person who ruled it signs the audit event and the re-attest;
//   - the person re-attests the recalculated row through `scope.review.attest_reingest` (snapshot.review, a reason, D7.2 re-checked).
//     A flagged emission delta against v7 stops the job: it stays a manual per-job attest;
//   - the job's now-unused 2019 selection is removed, so nothing but J000723 selects or cites the 2019 edition;
//   - a job with an issued snapshot or a report version, or an overridden row, is refused: the ruling assumed neither;
//   - one transaction per job; a dry run is every job's whole act, rolled back; a re-run finds the row already moved and does nothing.
// The audit event carries ids, datasets and the emission figures — no money, rate or person beyond the actor.
import { randomUUID } from "node:crypto";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { recalculateScopeRowInTransaction } from "./postgresCommands";
import { attestReingestRowsInTransaction, planReingestAttestation } from "./reingestAttest";
import { personContext } from "./v7BatchAttest";

export const STRAY_REPOINT_AUDIT_ACTION = "v7.stray_row.repointed";
export const STRAY_FROM_DATASET = "uk-ghg-gb-2019";
export const STRAY_FACTOR_ID = "uk-ghg-1_101_1011_8_1";
/** The ruled four: the single diesel-van row on the 2019 edition in each of Selectaglaze's 2020–2023 jobs. */
export const RULED_STRAY_ROWS: ReadonlyArray<{ jobNumber: string; rowId: string; year: number }> = [
  { jobNumber: "J000724", rowId: "84512322-bb9d-4d5e-97c2-65a8edbff794", year: 2020 },
  { jobNumber: "J000725", rowId: "22d16a49-3cd8-47b0-8d69-4a6a70a3afe9", year: 2021 },
  { jobNumber: "J000726", rowId: "3a054b5e-681c-4069-82bc-3377a4bcb3c0", year: 2022 },
  { jobNumber: "J000727", rowId: "c31826c9-41be-47c6-9502-f205aba82b20", year: 2023 },
];

export type StrayRepointStatus = "REPOINTED" | "ALREADY_REPOINTED" | "REFUSED";
export type StrayRepointRow = {
  jobNumber: string; rowId: string; status: StrayRepointStatus; codes: string[];
  fromDataset: string; toDataset: string; factorId: string; quantity: number | null; unit: string | null;
  oldFactorValue: number | null; newFactorValue: number | null;
  oldTco2e: number | null; newTco2e: number | null; deltaTco2e: number | null;
  jobTotalBefore: number | null; jobTotalAfter: number | null;
  attestedRows: number; selectionRemoved: boolean;
};
export type StrayRepointInput = {
  organisationId: string; actorId: string; reason: string; commit: boolean;
  /** The ruled set; defaults to `RULED_STRAY_ROWS`. A test passes its own. */
  rows?: ReadonlyArray<{ jobNumber: string; rowId: string; year: number }>;
};
export type StrayRepointReport = { committed: boolean; actorId: string; rows: StrayRepointRow[]; auditEvents: number };

class DryRunRollback extends Error {}
class Refusal extends Error { constructor(readonly code: string, message: string) { super(`${code}: ${message}`); } }
const MIN_REASON = 8;
const num = (value: string | null | undefined) => (value === null || value === undefined ? null : Number(value));

export async function repointStrayRows(pool: PoolLike, input: StrayRepointInput): Promise<StrayRepointReport> {
  if (input.reason.trim().length < MIN_REASON) throw new Error(`REASON_REQUIRED: a reason of at least ${MIN_REASON} characters is required; it is recorded on the re-attest and every audit event.`);
  const person = await personContext(pool, { organisationId: input.organisationId, actorId: input.actorId, reason: input.reason, commit: input.commit });
  const ruled = input.rows ?? RULED_STRAY_ROWS;
  const rows: StrayRepointRow[] = [];
  let auditEvents = 0;
  for (const entry of ruled) {
    const toDataset = `uk-ghg-gb-${entry.year}`;
    const out: StrayRepointRow = { jobNumber: entry.jobNumber, rowId: entry.rowId, status: "REFUSED", codes: [], fromDataset: STRAY_FROM_DATASET, toDataset, factorId: STRAY_FACTOR_ID,
      quantity: null, unit: null, oldFactorValue: null, newFactorValue: null, oldTco2e: null, newTco2e: null, deltaTco2e: null, jobTotalBefore: null, jobTotalAfter: null, attestedRows: 0, selectionRemoved: false };
    try {
      await withTenantWrite(pool, input.organisationId, async (db) => {
        await repointOne(db, input, person, entry, toDataset, out);
        if (out.status === "REPOINTED") auditEvents += 1;
        if (!input.commit) throw new DryRunRollback();
      });
    } catch (error) {
      if (error instanceof DryRunRollback) { /* the dry run's whole act, rolled back */ }
      else {
        const issues = (error as { issues?: Array<{ code: string }> }).issues;
        out.status = "REFUSED"; out.attestedRows = 0; out.selectionRemoved = false;
        if (error instanceof Refusal) out.codes = [error.code];
        else if (issues) out.codes = [...new Set(issues.map((issue) => issue.code))];
        else throw error;
      }
    }
    rows.push(out);
  }
  return { committed: input.commit, actorId: input.actorId, rows, auditEvents };
}

async function repointOne(db: Queryable, input: StrayRepointInput, person: Awaited<ReturnType<typeof personContext>>,
  entry: { jobNumber: string; rowId: string; year: number }, toDataset: string, out: StrayRepointRow): Promise<void> {
  const org = input.organisationId;
  const job = (await db.query<{ job_id: string; reporting_year: number | null }>(
    `SELECT job_id, reporting_year FROM nzi_console.jobs WHERE organisation_id = $1 AND legacy_job_number = $2 FOR UPDATE`, [org, entry.jobNumber])).rows[0];
  if (!job) throw new Refusal("JOB_NOT_FOUND", `${entry.jobNumber} was not found.`);
  if (job.reporting_year !== entry.year) throw new Refusal("YEAR_MISMATCH", `${entry.jobNumber} does not report ${entry.year}.`);
  const row = (await db.query<{ version: number; dataset_id: string | null; factor_id: string | null; factor_source: string; origin: string; enabled: boolean; quantity: string | null; unit: string | null;
    calculated: string | null; override: string | null }>(
    `SELECT version, dataset_id, factor_id, factor_source, origin, enabled, quantity::text, unit, calculated_tco2e::text AS calculated, override_tco2e::text AS override
       FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 FOR UPDATE`, [org, job.job_id, entry.rowId])).rows[0];
  if (!row) throw new Refusal("ROW_NOT_FOUND", `${entry.rowId} is not a row of ${entry.jobNumber}.`);
  out.quantity = num(row.quantity); out.unit = row.unit; out.oldTco2e = num(row.calculated);
  const total = async () => num((await db.query<{ total: string }>(
    `SELECT coalesce(sum(coalesce(override_tco2e, calculated_tco2e, 0)) FILTER (WHERE enabled), 0)::text AS total FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2`, [org, job.job_id])).rows[0]!.total);
  out.jobTotalBefore = await total();
  if (row.dataset_id === toDataset && row.factor_id === STRAY_FACTOR_ID) { out.status = "ALREADY_REPOINTED"; out.newTco2e = out.oldTco2e; out.jobTotalAfter = out.jobTotalBefore; return; }
  if (row.dataset_id !== STRAY_FROM_DATASET || row.factor_id !== STRAY_FACTOR_ID) throw new Refusal("NOT_THE_RULED_ROW", `${entry.rowId} is not on ${STRAY_FROM_DATASET} / ${STRAY_FACTOR_ID}.`);
  if (row.origin !== "live" || !row.enabled || row.factor_source !== "dataset") throw new Refusal("NOT_A_LIVE_DATASET_ROW", `${entry.rowId} is not an enabled live dataset row.`);
  if (row.override !== null) throw new Refusal("ROW_OVERRIDDEN", `${entry.rowId} carries an override; the ruling assumed none.`);
  const issued = (await db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND job_id = $2)
          + (SELECT count(*) FROM nzi_console.report_versions WHERE organisation_id = $1 AND job_id = $2) AS n`, [org, job.job_id])).rows[0]!.n;
  if (Number(issued) > 0) throw new Refusal("FIGURES_ISSUED", `${entry.jobNumber} has an issued snapshot or a report version; its figures would change under it.`);

  const factorAt = (dataset: string) => db.query<{ kgco2e: string; unit: string; active: boolean; version: string; label: string }>(
    `SELECT f.kgco2e_per_unit::text AS kgco2e, f.activity_unit AS unit, f.active, d.version, f.label
       FROM nzi_console.emission_factors_display f JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
      WHERE f.organisation_id = $1 AND f.dataset_id = $2 AND f.factor_id = $3`, [org, dataset, STRAY_FACTOR_ID]).then((result) => result.rows[0]);
  const was = await factorAt(STRAY_FROM_DATASET), target = await factorAt(toDataset);
  out.oldFactorValue = num(was?.kgco2e);
  if (!target || !target.active) throw new Refusal("TARGET_FACTOR_MISSING", `${STRAY_FACTOR_ID} is not active in ${toDataset}.`);
  if (row.unit === null || row.unit.trim().toLowerCase() !== target.unit.trim().toLowerCase()) throw new Refusal("UNIT_CHANGED", `${toDataset} prices ${STRAY_FACTOR_ID} per ${target.unit}.`);
  out.newFactorValue = num(target.kgco2e);
  const selected = (await db.query(`SELECT 1 FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = $3`, [org, job.job_id, toDataset])).rows[0];
  if (!selected) throw new Refusal("TARGET_NOT_SELECTED", `${entry.jobNumber} does not select ${toDataset}.`);

  // 1. The move: the dataset-update row step — re-point, a lineage entry naming it, a version bump.
  const note = { title: "Re-pointed to the reporting year's edition", detail: `${STRAY_FROM_DATASET} → ${toDataset} · v7 stray-row correction (ruled 30 Oct 2026)` };
  const moved = (await db.query<{ version: number }>(
    `UPDATE nzi_console.job_scope_rows SET dataset_id = $4, factor_version = $5, factor_label = $6, lineage_json = coalesce(lineage_json, '[]'::jsonb) || $7::jsonb,
            version = version + 1, updated_at = now()
      WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 AND version = $8 RETURNING version`,
    [org, job.job_id, entry.rowId, toDataset, target.version, target.label, JSON.stringify([note]), row.version])).rows[0];
  if (!moved) throw new Refusal("VERSION_CONFLICT", `${entry.rowId} changed under the correction.`);

  // 2. The one row calculation, as the re-ingest's own principal (the only one a re-ingested row admits).
  const system: CommandContext = { organisationId: org, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `v7-stray-repoint-calc:${entry.rowId}`,
    correlationId: `v7-stray-repoint-${randomUUID()}`, reason: input.reason.trim(), grant: commandGrantForRole("admin", org, V7_REINGEST_ACTOR) };
  await recalculateScopeRowInTransaction(db, { jobId: job.job_id, rowId: entry.rowId, expectedVersion: moved.version }, system, [note]);
  out.newTco2e = num((await db.query<{ calculated: string }>(`SELECT calculated_tco2e::text AS calculated FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND scope_row_id = $2`, [org, entry.rowId])).rows[0]!.calculated);
  out.deltaTco2e = out.oldTco2e === null || out.newTco2e === null ? null : out.newTco2e - out.oldTco2e;

  // 3. Nothing on the job cites the 2019 edition any more, so its selection goes.
  const stillCiting = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = $3`, [org, job.job_id, STRAY_FROM_DATASET])).rows[0]!.n);
  if (stillCiting === 0) {
    const removed = await db.query(`DELETE FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = $3 RETURNING dataset_id`, [org, job.job_id, STRAY_FROM_DATASET]);
    out.selectionRemoved = removed.rows.length > 0;
  }

  // 4. The person re-attests the recalculated row (it went back to pending): exactly the preview, sent back; flagged deltas stop the job.
  const context: CommandContext = { ...person, idempotencyKey: `v7-stray-repoint:${entry.rowId}`, correlationId: `v7-stray-repoint-${randomUUID()}` };
  const plan = await planReingestAttestation(db, context, job.job_id, true);
  if ((plan.deltas?.flagged.length ?? 0) > 0) throw new Refusal("DELTAS_FLAGGED", `${plan.deltas!.flagged.length} emission delta(s) against v7 are flagged; a manual per-job attest.`);
  if (plan.blocked.length > 0) throw new Refusal("ROW_BLOCKED", `${plan.blocked.length} row(s) cannot be attested.`);
  if (plan.attest.length !== 1 || plan.attest[0]!.rowId !== entry.rowId) throw new Refusal("UNEXPECTED_ATTEST_SET", `the re-attest would approve ${plan.attest.length} row(s), not just ${entry.rowId}.`);
  const outcome = await attestReingestRowsInTransaction(db, {
    jobId: job.job_id, runId: plan.runId!, rows: plan.attest.map((attest) => ({ rowId: attest.rowId, expectedReviewVersion: attest.version })),
    gapKeys: plan.gaps.map((gap) => gap.gapKey), acknowledgedDeltas: [],
  }, context);
  out.attestedRows = outcome.data.approved;
  out.jobTotalAfter = await total();

  // 5. The audit: ids, datasets and emission figures.
  await db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
     VALUES ($1, $2, $3, 'staff', $4, 'scope_row', $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [org, randomUUID(), input.actorId, STRAY_REPOINT_AUDIT_ACTION, entry.rowId, context.correlationId, input.reason.trim(),
      JSON.stringify({ datasetId: STRAY_FROM_DATASET, factorId: STRAY_FACTOR_ID, tco2e: out.oldTco2e, jobTotal: out.jobTotalBefore }),
      JSON.stringify({ datasetId: toDataset, factorId: STRAY_FACTOR_ID, tco2e: out.newTco2e, jobTotal: out.jobTotalAfter, selectionRemoved: out.selectionRemoved, jobNumber: entry.jobNumber })]);
  out.status = "REPOINTED";
}
