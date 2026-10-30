// The owner-run half of the 2019 dataset correction (RULING 30 Oct 2026, Cowork; Step 0 rulings): read the stored factors of `uk-ghg-gb-2019`
// and `nzi-gb-2019`, build the plan from the real DESNZ 2019 file (`v7Desnz2019.ts`), and — only against the plan whose sha was signed —
// correct the values in place, recalculate the rows that use a changed factor, and re-attest them.
//
//   - values only: `kgco2e_per_unit` of existing ids. No id is added or retired, no label, level or formula is touched, and the dataset's
//     `content_sha256` is left alone — it is the v7 import's identity, and the reference loader's idempotency check reads it, so changing it
//     would make the next loader run refuse the dataset. The correction's own record is the audit event (plan sha, flat-file sha, counts);
//   - a commit needs `expectedPlanSha`: the plan is rebuilt from the database at that moment and must hash to the signed sha, or nothing is
//     written. Each UPDATE also asserts the value it replaces, so a factor that moved since the plan was read refuses;
//   - the consumers of the two datasets must be exactly the allowed jobs (J000723 — the stray rows were re-pointed first); any other job
//     citing them, or an allowed job with an issued snapshot or report version, refuses the whole act;
//   - recalculation is the one row calculation, run as the re-ingest's own principal (a re-ingested row is attest-only to everyone else);
//     only rows whose factor value changed are recalculated, so rows on unchanged factors keep their approval;
//   - the person re-attests the recalculated rows through `scope.review.attest_reingest`. The 0-flag guardrail stays: a flagged emission
//     delta against v7 refuses unless the person acknowledges exactly the flagged set by its hash (`acknowledgeFlagged`), which the dry run
//     prints beside the per-row deltas — the correction itself is what makes the rows flag, so each one is reviewed, not blanket-passed;
//   - one transaction; a dry run is the whole act rolled back and its report is what is signed.
// The audit event carries ids, counts and emission figures — no money, rate or person beyond the actor.
import { createHash, randomUUID } from "node:crypto";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { recalculateScopeRowInTransaction } from "./postgresCommands";
import { attestReingestRowsInTransaction, planReingestAttestation } from "./reingestAttest";
import { personContext } from "./v7BatchAttest";
import { planCorrection, type CorrectionPlan, type FlatFile, type StoredFactor } from "./v7Desnz2019";

export const DESNZ_2019_AUDIT_ACTION = "v7.desnz_2019.corrected";
export const DESNZ_2019_DATASETS = ["uk-ghg-gb-2019", "nzi-gb-2019"] as const;
export const DESNZ_2019_ALLOWED_JOBS = ["J000723"] as const;

export type RowDelta = { jobNumber: string; rowId: string; factorId: string; datasetId: string; quantity: number | null; unit: string | null; oldTco2e: number | null; newTco2e: number | null; deltaTco2e: number | null };
export type Desnz2019Input = {
  organisationId: string; actorId: string; reason: string; commit: boolean; flat: FlatFile;
  /** The signed plan's sha. Required to commit; checked in a dry run when given. */
  expectedPlanSha?: string;
  /** The hash of the flagged v7-delta set the person reviewed (printed by the dry run). Required to commit when any row is flagged. */
  acknowledgeFlagged?: string;
  /** The jobs allowed to cite the datasets; defaults to J000723. A test passes its own. */
  allowedJobs?: ReadonlyArray<string>;
  datasets?: ReadonlyArray<string>;
};
export type Desnz2019Report = {
  committed: boolean; plan: CorrectionPlan; consumers: string[]; factorsUpdated: number;
  rows: RowDelta[]; flaggedDeltas: string[]; flaggedSha: string | null; attestedRows: number; jobTotals: Array<{ jobNumber: string; before: number; after: number }>; auditEvents: number;
};

class DryRunRollback extends Error {}
export class Desnz2019Refused extends Error { constructor(readonly code: string, message: string) { super(`${code}: ${message}`); } }
const MIN_REASON = 8;
const num = (value: string | null | undefined) => (value === null || value === undefined ? null : Number(value));
export const flaggedSha = (ids: ReadonlyArray<string>) => createHash("sha256").update([...ids].sort().join("|")).digest("hex").slice(0, 12);

/** The stored factors of the datasets, each with the count of scope rows that cite it. */
export async function readStoredFactors(db: Queryable, organisationId: string, datasets: ReadonlyArray<string>): Promise<StoredFactor[]> {
  const result = await db.query<{ dataset_id: string; factor_id: string; label: string; activity_unit: string; v: string; scopes: string[]; active: boolean; source_levels: string[] | null; used: string }>(
    `SELECT f.dataset_id, f.factor_id, f.label, f.activity_unit, f.kgco2e_per_unit::text AS v, f.scopes, f.active, f.source_levels,
            (SELECT count(*) FROM nzi_console.job_scope_rows r WHERE r.organisation_id = f.organisation_id AND r.dataset_id = f.dataset_id AND r.factor_id = f.factor_id)::text AS used
       FROM nzi_console.emission_factors f WHERE f.organisation_id = $1 AND f.dataset_id = ANY($2::text[]) ORDER BY f.dataset_id, f.factor_id`, [organisationId, [...datasets]]);
  return result.rows.map((row) => ({ datasetId: row.dataset_id, factorId: row.factor_id, label: row.label, activityUnit: row.activity_unit, value: row.v, scopes: row.scopes,
    active: row.active, sourceLevels: row.source_levels ?? [], usedRows: Number(row.used) }));
}

/** The factor report alone, read-only: the plan from the database as it stands, nothing written. */
export async function planFromDatabase(pool: PoolLike, organisationId: string, flat: FlatFile, datasets: ReadonlyArray<string> = DESNZ_2019_DATASETS): Promise<{ plan: CorrectionPlan; consumers: string[] }> {
  let out!: { plan: CorrectionPlan; consumers: string[] };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      out = { plan: planCorrection(await readStoredFactors(db, organisationId, datasets), flat), consumers: (await consumerJobs(db, organisationId, datasets)).map((job) => job.jobNumber) };
      throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return out;
}

async function consumerJobs(db: Queryable, organisationId: string, datasets: ReadonlyArray<string>) {
  const result = await db.query<{ job_id: string; legacy_job_number: string }>(
    `SELECT DISTINCT j.job_id, j.legacy_job_number FROM nzi_console.job_scope_rows r JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (r.organisation_id, r.job_id)
      WHERE r.organisation_id = $1 AND r.dataset_id = ANY($2::text[]) ORDER BY j.legacy_job_number`, [organisationId, [...datasets]]);
  return result.rows.map((row) => ({ jobId: row.job_id, jobNumber: row.legacy_job_number }));
}

export async function correctDesnz2019(pool: PoolLike, input: Desnz2019Input): Promise<Desnz2019Report> {
  if (input.reason.trim().length < MIN_REASON) throw new Error(`REASON_REQUIRED: a reason of at least ${MIN_REASON} characters is required; it is recorded on the re-attest and the audit event.`);
  if (input.commit && !input.expectedPlanSha) throw new Error("PLAN_SHA_REQUIRED: a commit needs --expect-sha, the sha of the correction report that was signed.");
  const person = await personContext(pool, { organisationId: input.organisationId, actorId: input.actorId, reason: input.reason, commit: input.commit });
  let report!: Desnz2019Report;
  try {
    await withTenantWrite(pool, input.organisationId, async (db) => {
      report = await correctOne(db, input, person);
      if (!input.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return report;
}

async function correctOne(db: Queryable, input: Desnz2019Input, person: Awaited<ReturnType<typeof personContext>>): Promise<Desnz2019Report> {
  const org = input.organisationId;
  const datasets = input.datasets ?? DESNZ_2019_DATASETS;
  const allowed = new Set(input.allowedJobs ?? DESNZ_2019_ALLOWED_JOBS);

  const plan = planCorrection(await readStoredFactors(db, org, datasets), input.flat);
  if (input.expectedPlanSha && plan.sha256 !== input.expectedPlanSha)
    throw new Desnz2019Refused("PLAN_SHA_MISMATCH", `the plan built from the database hashes to ${plan.sha256}, not the signed ${input.expectedPlanSha}; nothing was written.`);

  // The consumers are exactly the allowed jobs, and none has issued figures.
  const consumers = await consumerJobs(db, org, datasets);
  const strangers = consumers.filter((job) => !allowed.has(job.jobNumber));
  if (strangers.length > 0) throw new Desnz2019Refused("OTHER_CONSUMERS", `${strangers.map((job) => job.jobNumber).join(", ")} also cite the 2019 datasets; re-point them first.`);
  for (const job of consumers) {
    const issued = Number((await db.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND job_id = $2)
            + (SELECT count(*) FROM nzi_console.report_versions WHERE organisation_id = $1 AND job_id = $2) AS n`, [org, job.jobId])).rows[0]!.n);
    if (issued > 0) throw new Desnz2019Refused("FIGURES_ISSUED", `${job.jobNumber} has an issued snapshot or a report version; its figures would change under it.`);
  }

  // The rows that will move: every row on a changed factor, with the figure it carries now.
  const changed = plan.lines.filter((line) => line.changes && line.newValue !== null);
  const changedKeys = new Set(changed.map((line) => `${line.datasetId}\t${line.factorId}`));
  const rowsBefore = new Map<string, RowDelta & { jobId: string; version: number }>();
  const jobTotals = new Map<string, { jobNumber: string; before: number; after: number }>();
  for (const job of consumers) {
    const total = async () => num((await db.query<{ total: string }>(
      `SELECT coalesce(sum(coalesce(override_tco2e, calculated_tco2e, 0)) FILTER (WHERE enabled), 0)::text AS total FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2`, [org, job.jobId])).rows[0]!.total)!;
    jobTotals.set(job.jobId, { jobNumber: job.jobNumber, before: await total(), after: 0 });
    const rows = await db.query<{ scope_row_id: string; version: number; dataset_id: string; factor_id: string; quantity: string | null; unit: string | null; calculated: string | null; origin: string; enabled: boolean; factor_source: string; override: string | null }>(
      `SELECT scope_row_id, version, dataset_id, factor_id, quantity::text, unit, calculated_tco2e::text AS calculated, origin, enabled, factor_source, override_tco2e::text AS override
         FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = ANY($3::text[]) FOR UPDATE`, [org, job.jobId, [...datasets]]);
    for (const row of rows.rows) {
      if (!changedKeys.has(`${row.dataset_id}\t${row.factor_id}`)) continue;
      if (row.origin !== "live" || !row.enabled || row.factor_source !== "dataset") throw new Desnz2019Refused("NOT_A_LIVE_DATASET_ROW", `${row.scope_row_id} is not an enabled live dataset row.`);
      if (row.override !== null) throw new Desnz2019Refused("ROW_OVERRIDDEN", `${row.scope_row_id} carries an override; a recalculation would not move it.`);
      rowsBefore.set(row.scope_row_id, { jobId: job.jobId, version: row.version, jobNumber: job.jobNumber, rowId: row.scope_row_id, factorId: row.factor_id, datasetId: row.dataset_id,
        quantity: num(row.quantity), unit: row.unit, oldTco2e: num(row.calculated), newTco2e: null, deltaTco2e: null });
    }
  }

  // Nothing differs from the real 2019 numbers (a re-run after the correction): nothing to write, nothing to audit.
  if (changed.length === 0)
    return { committed: input.commit, plan, consumers: consumers.map((job) => job.jobNumber), factorsUpdated: 0, rows: [], flaggedDeltas: [], flaggedSha: null, attestedRows: 0,
      jobTotals: [...jobTotals.values()].map((totals) => ({ ...totals, after: totals.before })), auditEvents: 0 };

  // 1. The values, in place, each asserting the value it replaces.
  let factorsUpdated = 0;
  for (const line of changed) {
    const updated = await db.query(
      `UPDATE nzi_console.emission_factors SET kgco2e_per_unit = $4::numeric
        WHERE organisation_id = $1 AND dataset_id = $2 AND factor_id = $3 AND kgco2e_per_unit = $5::numeric RETURNING factor_id`,
      [org, line.datasetId, line.factorId, line.newValue, line.oldValue]);
    if (updated.rows.length !== 1) throw new Desnz2019Refused("FACTOR_MOVED", `${line.datasetId} / ${line.factorId} no longer holds ${line.oldValue}; nothing was written.`);
    factorsUpdated += 1;
  }

  // 2. Recalculate the rows on changed factors, as the re-ingest's own principal.
  const system = (rowId: string): CommandContext => ({ organisationId: org, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `v7-desnz2019-calc:${rowId}`,
    correlationId: `v7-desnz2019-${randomUUID()}`, reason: input.reason.trim(), grant: commandGrantForRole("admin", org, V7_REINGEST_ACTOR) });
  for (const [rowId, before] of rowsBefore) {
    await recalculateScopeRowInTransaction(db, { jobId: before.jobId, rowId, expectedVersion: before.version }, system(rowId),
      [{ title: "Factor value corrected to the DESNZ 2019 edition", detail: `${before.datasetId} / ${before.factorId} · v7 2019 dataset correction (ruled 30 Oct 2026)` }]);
    before.newTco2e = num((await db.query<{ calculated: string }>(`SELECT calculated_tco2e::text AS calculated FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND scope_row_id = $2`, [org, rowId])).rows[0]!.calculated);
    before.deltaTco2e = before.oldTco2e === null || before.newTco2e === null ? null : before.newTco2e - before.oldTco2e;
  }

  // 3. The person re-attests, job by job, with every flagged delta reviewed: acknowledged only as the exact set whose hash they gave.
  const context = (jobId: string): CommandContext => ({ ...person, idempotencyKey: `v7-desnz2019:${jobId}`, correlationId: `v7-desnz2019-${randomUUID()}` });
  let attestedRows = 0; const flaggedAll: string[] = [];
  const attestations: Array<{ jobId: string; plan: Awaited<ReturnType<typeof planReingestAttestation>> }> = [];
  for (const job of consumers) {
    if (![...rowsBefore.values()].some((row) => row.jobId === job.jobId)) continue;
    const attestPlan = await planReingestAttestation(db, context(job.jobId), job.jobId, true);
    flaggedAll.push(...(attestPlan.deltas?.flagged ?? []));
    if (attestPlan.blocked.length > 0) throw new Desnz2019Refused("ROW_BLOCKED", `${job.jobNumber}: ${attestPlan.blocked.length} row(s) cannot be attested.`);
    const expected = new Set([...rowsBefore.values()].filter((row) => row.jobId === job.jobId).map((row) => row.rowId));
    const got = new Set(attestPlan.attest.map((row) => row.rowId));
    if (expected.size !== got.size || [...expected].some((id) => !got.has(id)))
      throw new Desnz2019Refused("UNEXPECTED_ATTEST_SET", `${job.jobNumber}: the re-attest would approve ${got.size} row(s), not exactly the ${expected.size} recalculated.`);
    attestations.push({ jobId: job.jobId, plan: attestPlan });
  }
  const sha = flaggedAll.length ? flaggedSha(flaggedAll) : null;
  if (flaggedAll.length > 0 && input.commit && input.acknowledgeFlagged !== sha)
    throw new Desnz2019Refused("DELTAS_FLAGGED", `${flaggedAll.length} emission delta(s) against v7 are flagged (hash ${sha}); review them in the dry run and pass --acknowledge-flagged ${sha}.`);
  for (const { jobId, plan: attestPlan } of attestations) {
    if (flaggedAll.length > 0 && !input.commit && input.acknowledgeFlagged !== sha) continue; // a dry run reports; it does not claim an approval it was not given
    const outcome = await attestReingestRowsInTransaction(db, {
      jobId, runId: attestPlan.runId!, rows: attestPlan.attest.map((row) => ({ rowId: row.rowId, expectedReviewVersion: row.version })),
      gapKeys: attestPlan.gaps.map((gap) => gap.gapKey), acknowledgedDeltas: [...(attestPlan.deltas?.flagged ?? [])],
    }, context(jobId));
    attestedRows += outcome.data.approved;
  }
  for (const [jobId, totals] of jobTotals) {
    totals.after = num((await db.query<{ total: string }>(
      `SELECT coalesce(sum(coalesce(override_tco2e, calculated_tco2e, 0)) FILTER (WHERE enabled), 0)::text AS total FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2`, [org, jobId])).rows[0]!.total)!;
  }

  // 4. The audit: ids, counts and emission figures.
  const rows = [...rowsBefore.values()].map(({ jobId: _jobId, version: _version, ...row }) => row);
  await db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
     VALUES ($1, $2, $3, 'staff', $4, 'emission_factor_dataset', $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [org, randomUUID(), input.actorId, DESNZ_2019_AUDIT_ACTION, datasets.join("+"), `v7-desnz2019-${randomUUID()}`, input.reason.trim(),
      JSON.stringify({ flatSha256: plan.flatSha256, stored: plan.lines.length }),
      JSON.stringify({ planSha256: plan.sha256, factorsUpdated, rowsRecalculated: rows.length, attestedRows, flaggedDeltas: flaggedAll.length, jobs: consumers.map((job) => job.jobNumber),
        totals: [...jobTotals.values()] })]);

  return { committed: input.commit, plan, consumers: consumers.map((job) => job.jobNumber), factorsUpdated, rows, flaggedDeltas: flaggedAll, flaggedSha: sha, attestedRows,
    jobTotals: [...jobTotals.values()], auditEvents: 1 };
}
