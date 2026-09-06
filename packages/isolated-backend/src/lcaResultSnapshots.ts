// Track C — LCA/PCF reference module, slice 4: content-addressed result
// snapshots (L4; NZC-055). Same "DA freeze" discipline as
// `reviewed_crp_snapshots`/`report.snapshot.create` — a stable-JSON hash of
// the payload, an idempotent re-use when nothing has changed since the last
// freeze, immutable once written (no UPDATE/DELETE grant on this table).
// Gated on `review_status='approved'` — this session's considered ordering
// is calculate -> independent review -> freeze (an unreviewed number should
// not become the artefact a report cites), though the live product's exact
// sequence was not readable this session (see docs/ACCEPTANCE_LCA_MODULE_
// SLICE4.md's disclosure).
import { createHash, randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap, CommandOutcome, LcaFactorCitation, LcaResultSnapshot } from "@nzi/contracts";
import { CommandValidationError, runPostgresCommand } from "./postgresCommands";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { computeLcaAssessmentResult } from "./lcaCalcEngine";

/**
 * L7 — the exact factor citation used across this assessment's mapped line
 * items and transport legs, resolved at freeze time and frozen into the
 * snapshot. Deduplicated by label + version + dataset, sorted for a stable
 * hash. A professional EN 15804 / ISO 14067 report cites these verbatim.
 */
async function gatherFactorCitations(db: Queryable, organisationId: string, jobId: string, assessmentId: string): Promise<LcaFactorCitation[]> {
  const { rows: dataset } = await db.query<{ label: string; version: string; dataset: string; original_id: string }>(
    `SELECT DISTINCT f.label, d.version, d.name AS dataset, f.factor_id AS original_id
       FROM nzi_console.emission_factors f
       JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id,d.dataset_id)=(f.organisation_id,f.dataset_id)
       JOIN nzi_console.job_dataset_selections s ON (s.organisation_id,s.dataset_id)=(f.organisation_id,f.dataset_id) AND s.job_id=$2
      WHERE f.organisation_id=$1 AND f.active=true AND (
        (f.factor_id,f.dataset_id) IN (SELECT li.factor_id,li.dataset_id FROM nzi_console.lca_line_items li WHERE li.organisation_id=$1 AND li.assessment_id=$3 AND li.factor_source='dataset')
        OR (f.factor_id,f.dataset_id) IN (SELECT tl.factor_id,tl.dataset_id FROM nzi_console.lca_transport_legs tl JOIN nzi_console.lca_line_items li2 ON (li2.organisation_id,li2.line_item_id)=(tl.organisation_id,tl.line_item_id) WHERE tl.organisation_id=$1 AND li2.assessment_id=$3 AND tl.factor_source='dataset')
      )`,
    [organisationId, jobId, assessmentId],
  );
  const { rows: client } = await db.query<{ label: string; version: number; original_id: string }>(
    `SELECT DISTINCT cf.report_label AS label, cf.version, cf.client_factor_id AS original_id
       FROM nzi_console.client_factors cf
      WHERE cf.organisation_id=$1 AND cf.client_factor_id IN (
        SELECT li.client_factor_id FROM nzi_console.lca_line_items li WHERE li.organisation_id=$1 AND li.assessment_id=$2 AND li.factor_source='client'
      )`,
    [organisationId, assessmentId],
  );
  const { rows: manual } = await db.query<{ label: string }>(
    `SELECT DISTINCT COALESCE(NULLIF(TRIM(factor_label),''),'Manual entry') AS label
       FROM nzi_console.lca_line_items WHERE organisation_id=$1 AND assessment_id=$2 AND factor_source='manual'`,
    [organisationId, assessmentId],
  );
  const citations: LcaFactorCitation[] = [
    ...dataset.map((row) => ({ label: row.label, version: String(row.version), dataset: row.dataset, originalId: row.original_id })),
    ...client.map((row) => ({ label: row.label, version: `v${row.version}`, dataset: "Client factors", originalId: row.original_id })),
    ...manual.map((row) => ({ label: row.label, version: "—", dataset: "Manual entry", originalId: "—" })),
  ];
  const seen = new Set<string>();
  return citations
    .filter((c) => { const key = `${c.label}|${c.version}|${c.dataset}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => `${a.dataset}${a.label}`.localeCompare(`${b.dataset}${b.label}`));
}

const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
      : value;

export async function createLcaResultSnapshot(
  pool: PoolLike,
  input: CommandInputMap["lca.assessment.snapshot.create"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ snapshotId: string; dataHash: string; reused: boolean }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.assessment.snapshot.create", input, context, async (db) => {
    const found = await db.query<{ version: number; review_status: "pending" | "approved" | "rejected" }>(
      `SELECT a.version,a.review_status FROM nzi_console.lca_assessments a JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(a.organisation_id,a.job_id)
       WHERE a.organisation_id=$1 AND a.assessment_id=$2 AND a.job_id=$3 AND j.job_family IN ('lca','pcf')`,
      [context.organisationId, input.assessmentId, input.jobId],
    );
    const assessment = found.rows[0];
    if (!assessment) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "Assessment was not found for this job." }]);
    if (assessment.version !== input.expectedVersion) throw new VersionConflictError();
    if (assessment.review_status !== "approved") throw new CommandValidationError([{ field: "assessmentId", code: "NOT_APPROVED", message: "Only an independently reviewed and approved assessment may be frozen into a result snapshot." }]);

    const [result, factorSets] = await Promise.all([
      computeLcaAssessmentResult(db, context.organisationId, input.assessmentId),
      gatherFactorCitations(db, context.organisationId, input.jobId, input.assessmentId),
    ]);
    // Hash the persisted fields (per-functional-unit is a reporting-time
    // division, not frozen state — §4) PLUS the factor citation, so a factor
    // or dataset moving after sign-off genuinely produces a new identity.
    const payload = {
      assessmentId: input.assessmentId, assessmentVersion: assessment.version,
      totalTco2e: result.totalTco2e, moduleBreakdown: result.moduleBreakdown,
      hotspots: result.hotspots, massReconciliation: result.massReconciliation, factorSets,
    };
    const dataHash = `sha256:${createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex")}`;

    const existing = await db.query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM nzi_console.lca_result_snapshots WHERE organisation_id=$1 AND assessment_id=$2 AND data_hash=$3",
      [context.organisationId, input.assessmentId, dataHash],
    );
    if (existing.rows[0]) {
      return { data: { snapshotId: existing.rows[0].snapshot_id, dataHash, reused: true as boolean }, entityType: "lca_result_snapshot", entityId: existing.rows[0].snapshot_id, topic: "lca.result_snapshot.reused" };
    }

    const snapshotId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.lca_result_snapshots
        (organisation_id,snapshot_id,assessment_id,assessment_version,data_hash,total_tco2e,module_breakdown,hotspots,mass_reconciliation,factor_sets,calculated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
      [
        context.organisationId, snapshotId, input.assessmentId, assessment.version, dataHash, result.totalTco2e,
        JSON.stringify(result.moduleBreakdown), JSON.stringify(result.hotspots), JSON.stringify(result.massReconciliation),
        JSON.stringify(factorSets), context.actorId,
      ],
    );
    return { data: { snapshotId, dataHash, reused: false as boolean }, entityType: "lca_result_snapshot", entityId: snapshotId, topic: "lca.result_snapshot.created" };
  });
}

type SnapshotRow = {
  snapshot_id: string; assessment_id: string; scenario_id: string | null; assessment_version: number; data_hash: string;
  total_tco2e: string; module_breakdown: LcaResultSnapshot["moduleBreakdown"]; hotspots: LcaResultSnapshot["hotspots"];
  mass_reconciliation: LcaResultSnapshot["massReconciliation"]; factor_sets: LcaFactorCitation[];
};
const mapSnapshot = (row: SnapshotRow): LcaResultSnapshot => ({
  id: row.snapshot_id, assessmentId: row.assessment_id, scenarioId: row.scenario_id, assessmentVersion: row.assessment_version,
  dataHash: row.data_hash, totalTco2e: Number(row.total_tco2e), moduleBreakdown: row.module_breakdown, hotspots: row.hotspots,
  massReconciliation: row.mass_reconciliation, factorSets: Array.isArray(row.factor_sets) ? row.factor_sets : [],
});
const SNAPSHOT_COLUMNS = "snapshot_id,assessment_id,scenario_id,assessment_version,data_hash,total_tco2e::text,module_breakdown,hotspots,mass_reconciliation,factor_sets";

export async function listLcaResultSnapshots(db: Queryable, assessmentId: string): Promise<LcaResultSnapshot[]> {
  const { rows } = await db.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM nzi_console.lca_result_snapshots WHERE assessment_id=$1 ORDER BY calculated_at DESC`,
    [assessmentId],
  );
  return rows.map(mapSnapshot);
}

export type LcaReportReadModel = {
  snapshot: LcaResultSnapshot;
  jobId: string;
  jobNumber: string;
  client: string;
  assessmentName: string;
  sku: string | null;
  standard: string;
  isPcf: boolean;
  functionalUnitValue: number;
  functionalUnitUnit: string;
  lifecycleBoundary: string;
  referenceYear: number | null;
  geography: string | null;
  calculatedBy: string;
  calculatedAt: string;
};

/** L7 — the LCA/PCF report, built entirely from one frozen snapshot + its assessment header. */
export async function getLcaReport(db: Queryable, jobId: string, snapshotId: string): Promise<LcaReportReadModel | null> {
  const { rows } = await db.query<SnapshotRow & {
    calculated_by: string; calculated_at: Date | string; job_id: string; job_number: string; client: string;
    assessment_name: string; sku: string | null; standard: string; lifecycle_boundary: string;
    reference_year: number | null; geography: string | null; functional_unit_value: string; functional_unit_unit: string;
  }>(
    `SELECT ${SNAPSHOT_COLUMNS}, s.calculated_by, s.calculated_at,
        a.job_id, j.job_number, cl.name AS client, a.name AS assessment_name, a.sku, a.standard, a.lifecycle_boundary,
        a.reference_year, a.geography, a.functional_unit_value::text, a.functional_unit_unit
     FROM nzi_console.lca_result_snapshots s
     JOIN nzi_console.lca_assessments a ON (a.organisation_id,a.assessment_id)=(s.organisation_id,s.assessment_id)
     JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(a.organisation_id,a.job_id)
     LEFT JOIN nzi_console.clients cl ON (cl.organisation_id,cl.client_id)=(a.organisation_id,a.client_id)
     WHERE s.snapshot_id=$1 AND a.job_id=$2 AND j.job_family IN ('lca','pcf')`,
    [snapshotId, jobId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    snapshot: mapSnapshot(row),
    jobId: row.job_id, jobNumber: row.job_number, client: row.client ?? "—",
    assessmentName: row.assessment_name, sku: row.sku, standard: row.standard,
    isPcf: row.standard === "ISO 14067" && row.lifecycle_boundary === "cradle_to_gate",
    functionalUnitValue: Number(row.functional_unit_value), functionalUnitUnit: row.functional_unit_unit,
    lifecycleBoundary: row.lifecycle_boundary, referenceYear: row.reference_year, geography: row.geography,
    calculatedBy: row.calculated_by, calculatedAt: new Date(row.calculated_at).toISOString(),
  };
}
