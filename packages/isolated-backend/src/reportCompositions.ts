import { createHash, randomUUID } from "node:crypto";
import {
  strategyControlLevelLabels, strategyControlLevels, activeMetrics, composeReportPlan, isReportGap, maturityLabel,
  overallReadiness, pillarReadiness, reportAssurance, resolveIntensity,
  type ReportComposition, type ReportEmissionsSection, type ReportIntensitySection,
  type ReportProvenance, type ReportSectionGap, type ReportSrsSection, type ReportTargetsSection,
} from "@nzi/contracts";
import { listClientStrategies, listLevers } from "./reductionStrategies";
import { listClientIntensityMetrics, listJobIntensityValues } from "./intensityMetricRecords";
import { getSrsFramework, listSrsAssessments } from "./srsReadinessRecords";
import { getBenchmarkInForce, getClientTargets, type TargetActual } from "./clientTargetRecords";
import type { Queryable } from "./postgres";

/**
 * Freezing what an issued report says.
 *
 * The reviewed snapshot freezes the measurement. This freezes everything else the report
 * quotes — intensity, targets, the plan, SRS readiness — as at the moment of issue, so a
 * later edit to any of those cannot rewrite a document the client already holds.
 *
 * Nothing here recomputes a figure. Each section is assembled from what its own domain has
 * already resolved, and a domain with nothing to say produces a stated gap rather than a
 * zero: "0 tCO₂e" and "we could not read your footprint" look identical on a page and mean
 * opposite things.
 */

/** The same stable-key hash the CRP, LCA and training snapshots use, so evidence compares. */
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
};
const hashOf = (payload: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex")}`;

const dateOnly = (value: Date | string | null) =>
  value === null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

/** What the snapshot rested on, gathered once and shared by the sections that quote it. */
function provenanceFrom(snapshot: SnapshotForComposition): ReportProvenance {
  const tiers = new Map<string, number>();
  const factorSets = new Set<string>();
  for (const row of snapshot.measurements) {
    if (row.qualityTier) tiers.set(row.qualityTier, (tiers.get(row.qualityTier) ?? 0) + 1);
    if (row.factorSet) factorSets.add(row.factorSet);
  }
  return {
    factorSets: [...factorSets].sort(),
    dataHash: snapshot.dataHash,
    asAt: snapshot.createdAt.slice(0, 10),
    qualityTiers: [...tiers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tier, count]) => ({ tier, count })),
  };
}

export type SnapshotForComposition = {
  id: string;
  jobId: string;
  jobNumber: string;
  client: string;
  reportingYear: number;
  dataHash: string;
  createdAt: string;
  createdBy: string;
  measurements: Array<{ scope: string; tco2e: number; qualityTier?: string | null; factorSet?: string | null }>;
  annualComparison: Array<{ year: number; values: Array<{ scope: string; value: number }> }>;
};

function composeEmissions(snapshot: SnapshotForComposition): ReportEmissionsSection | ReportSectionGap {
  if (snapshot.measurements.length === 0) {
    return { state: "unavailable", reason: "The reviewed snapshot carried no measurements inside the reporting boundary." };
  }
  const byScope = new Map<string, number>();
  for (const row of snapshot.measurements) byScope.set(row.scope, (byScope.get(row.scope) ?? 0) + row.tco2e);

  // The prior year comes from the snapshot's own annual comparison — the same series the
  // charts read — rather than a second query that could disagree with them.
  const prior = snapshot.annualComparison
    .filter((entry) => entry.year < snapshot.reportingYear)
    .sort((a, b) => b.year - a.year)[0] ?? null;

  return {
    totalTco2e: snapshot.measurements.reduce((sum, row) => sum + row.tco2e, 0),
    byScope: [...byScope.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([scope, tco2e]) => ({ scope, tco2e })),
    priorYear: prior === null ? null : { year: prior.year, totalTco2e: prior.values.reduce((sum, value) => sum + value.value, 0) },
    provenance: provenanceFrom(snapshot),
  };
}

/**
 * Targets, read from the **client target model** (NZC-072) at issue time.
 *
 * Deliberately not from the reviewed snapshot. Targets are their own versioned record and a
 * client edits them between reports, so freezing them at *review* time would miss a target
 * restated between review and issue — the same drift this store exists to close, one record
 * along. The snapshot's own `target` is the superseded job-level model and is not read here.
 */
async function composeTargets(db: Queryable, input: {
  clientId: string; snapshot: SnapshotForComposition; actuals: readonly TargetActual[];
}): Promise<ReportTargetsSection | ReportSectionGap> {
  const benchmarkInForce = await getBenchmarkInForce(db, input.clientId);
  const targets = await getClientTargets(db, input.clientId, { benchmarkInForce, actuals: input.actuals });
  if (!targets.model || targets.trajectory.length === 0) {
    return { state: "unavailable", reason: "No reduction target was set for this client when the report was issued." };
  }
  return {
    benchmark: targets.benchmark === null ? null : {
      year: targets.benchmark.year, totalTco2e: targets.benchmark.totalTco2e,
      source: targets.benchmark.source, reference: targets.benchmark.reference,
    },
    // The trajectory already carries the net-zero residual; nothing here flattens it to zero.
    trajectory: targets.trajectory.map((point) => ({ year: point.year, tco2e: point.tco2e, kind: point.kind, pct: point.pct })),
    benchmarkStale: targets.benchmarkStale,
    setAt: targets.setAt,
    provenance: provenanceFrom(input.snapshot),
  };
}

/**
 * Intensity, through the one resolver every other surface uses.
 *
 * `resolveIntensity` is what the client workspace, the client portal and this report all
 * call, so a client cannot be shown a different figure here from the one their consultant
 * sees. A measure with no value recorded for the year resolves to "unavailable" with its
 * own reason — never 0, and never borrowed from another year.
 */
async function composeIntensity(db: Queryable, input: {
  clientId: string; jobId: string; snapshot: SnapshotForComposition; emissionsTco2e: number | null;
}): Promise<ReportIntensitySection | ReportSectionGap> {
  const [definitions, values] = await Promise.all([
    listClientIntensityMetrics(db, input.clientId),
    listJobIntensityValues(db, input.jobId, input.snapshot.reportingYear),
  ]);
  const live = activeMetrics(definitions);
  if (live.length === 0) {
    return { state: "unavailable", reason: "No intensity measures were set up for this client when the report was issued." };
  }
  return {
    metrics: live.map((definition) => {
      const recorded = values.find((value) => value.metricKey === definition.key) ?? null;
      const resolved = resolveIntensity({
        definition,
        emissionsTco2e: input.emissionsTco2e,
        value: recorded?.value ?? null,
      });
      return {
        key: definition.key, label: definition.label, iconKey: definition.iconKey, unit: definition.unitWording,
        value: resolved.state === "resolved" ? resolved.value : null,
        unavailableReason: resolved.state === "resolved"
          ? null
          // The resolver already words each reason; the report repeats it rather than
          // inventing a second explanation for the same gap.
          : resolved.reason,
      };
    }),
    provenance: provenanceFrom(input.snapshot),
  };
}

/**
 * SRS readiness, through the same rollup the SRS area draws.
 *
 * Readiness is not stored — it is derived from the client's answers against the framework
 * version the assessment was measured against. Recomputing it here with the shared resolver
 * is what keeps the report and the workspace from quoting different percentages; freezing
 * the *result* into the composition is what keeps an issued report from moving when the
 * client reassesses next quarter.
 */
async function composeSrs(db: Queryable, clientId: string): Promise<ReportSrsSection | ReportSectionGap> {
  const [framework, assessments] = await Promise.all([getSrsFramework(db), listSrsAssessments(db, clientId)]);
  const assessment = assessments.find((entry) => entry.status === "complete") ?? null;
  if (!framework || !assessment) {
    return {
      state: "unavailable",
      reason: framework
        ? "No completed SRS readiness assessment existed for this client when the report was issued."
        : "No SRS framework was published when the report was issued, so there was nothing to assess against.",
    };
  }
  const overall = overallReadiness(framework, assessment.items);
  return {
    frameworkVersion: assessment.frameworkVersion,
    assessedOn: assessment.assessedOn.slice(0, 10),
    overallPct: overall.percent,
    overallLabel: maturityLabel(framework, overall.levelIndex),
    pillars: pillarReadiness(framework, assessment.items).map((pillar) => ({
      label: pillar.label,
      maturity: pillar.overall.level,
      maturityLabel: maturityLabel(framework, pillar.overall.levelIndex),
    })),
  };
}

/**
 * Build the composition a report version will freeze.
 *
 * Read-only: it gathers, it does not write. Freezing is a separate, deliberate step so the
 * same composition can be previewed before anyone commits a client-facing document to it.
 */
export async function composeReport(db: Queryable, input: {
  reportVersionId: string;
  clientId: string;
  snapshot: SnapshotForComposition;
  /** The assured years the pathway plots actual against, from the client's own snapshots. */
  actuals: readonly TargetActual[];
  issuedAt: string;
}): Promise<ReportComposition> {
  // Composed once and shared: intensity divides by the same footprint the emissions section
  // states, so the two can never disagree about what the total was.
  const emissions = composeEmissions(input.snapshot);
  const totalTco2e = isReportGap(emissions) ? null : emissions.totalTco2e;

  const [intensity, targets, srs, strategies, levers, requirementCodes] = await Promise.all([
    composeIntensity(db, { clientId: input.clientId, jobId: input.snapshot.jobId, snapshot: input.snapshot, emissionsTco2e: totalTco2e }),
    composeTargets(db, { clientId: input.clientId, snapshot: input.snapshot, actuals: input.actuals }),
    composeSrs(db, input.clientId),
    listClientStrategies(db, input.clientId),
    listLevers(db),
    // Requirement ids mean nothing to a reader, so the report carries codes like "S2 M2".
    db.query<{ requirement_id: string; code: string }>(
      `SELECT requirement_id, code FROM nzi_console.srs_requirements`,
    ).then((result) => new Map(result.rows.map((row) => [row.requirement_id, row.code]))),
  ]);
  return {
    reportVersionId: input.reportVersionId,
    jobId: input.snapshot.jobId,
    jobNumber: input.snapshot.jobNumber,
    client: input.snapshot.client,
    reportingYear: input.snapshot.reportingYear,
    issuedAt: input.issuedAt,
    snapshotId: input.snapshot.id,
    snapshotDataHash: input.snapshot.dataHash,
    // Who reviewed, never who assured — the platform holds no assurance engagement.
    assurance: reportAssurance({ reviewedBy: input.snapshot.createdBy, reviewedAt: input.snapshot.createdAt }),
    emissions,
    intensity,
    targets,
    plan: composeReportPlan(strategies, levers, requirementCodes),
    srs,
  };
}

/**
 * Everything a report version needs to be composed, gathered from the version itself.
 *
 * Publish knows a report version id and little else, so this walks from there to the job,
 * the client and the reviewed snapshot rather than making the caller assemble it. Keeping
 * the gathering here means the publish handler cannot accidentally compose from a different
 * snapshot than the one the version was validated against.
 */
export async function composeForReportVersion(db: Queryable, input: {
  organisationId: string; reportVersionId: string; issuedAt: string;
}): Promise<ReportComposition> {
  const version = await db.query<{ job_id: string; reviewed_snapshot_id: string; client_id: string }>(
    `SELECT r.job_id, r.reviewed_snapshot_id, j.client_id
     FROM nzi_console.report_versions r
     JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (r.organisation_id, r.job_id)
     WHERE r.organisation_id = $1 AND r.report_version_id = $2`,
    [input.organisationId, input.reportVersionId]);
  const row = version.rows[0];
  if (!row) throw new Error(`Report version ${input.reportVersionId} was not found.`);

  const snapshotRow = await db.query<{
    snapshot_id: string; job_id: string; data_hash: string; created_at: Date | string; created_by: string;
    payload_json: {
      jobNumber: string; client: string; reportingYear: number;
      measurements: Array<{ scope: string; tco2e: number; qualityTier?: string; factorSet?: string }>;
      annualComparison?: Array<{ year: number; values: Array<{ scope: string; value: number }> }>;
    };
  }>(
    `SELECT snapshot_id, job_id, data_hash, created_at, created_by, payload_json
     FROM nzi_console.reviewed_crp_snapshots
     WHERE organisation_id = $1 AND snapshot_id = $2`,
    [input.organisationId, row.reviewed_snapshot_id]);
  const snapshot = snapshotRow.rows[0];
  if (!snapshot) throw new Error(`Reviewed snapshot ${row.reviewed_snapshot_id} was not found.`);

  const payload = snapshot.payload_json;
  const createdAt = snapshot.created_at instanceof Date ? snapshot.created_at.toISOString() : String(snapshot.created_at);

  // The assured years the pathway plots actual against — every reviewed snapshot this
  // client has, which is the same series the workspace reads.
  const assured = await db.query<{ snapshot_id: string; payload_json: { reportingYear: number; jobNumber: string; measurements: Array<{ tco2e: number }> } }>(
    `SELECT s.snapshot_id, s.payload_json
     FROM nzi_console.reviewed_crp_snapshots s
     JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (s.organisation_id, s.job_id)
     WHERE s.organisation_id = $1 AND j.client_id = $2`,
    [input.organisationId, row.client_id]);
  const actuals: TargetActual[] = assured.rows
    .map((entry) => ({
      year: Number(entry.payload_json.reportingYear),
      tco2e: (entry.payload_json.measurements ?? []).reduce((total, measurement) => total + Number(measurement.tco2e), 0),
      snapshotId: entry.snapshot_id,
      jobNumber: entry.payload_json.jobNumber,
    }))
    .sort((a, b) => a.year - b.year);

  return composeReport(db, {
    reportVersionId: input.reportVersionId,
    clientId: row.client_id,
    issuedAt: input.issuedAt,
    actuals,
    snapshot: {
      id: snapshot.snapshot_id, jobId: snapshot.job_id, jobNumber: payload.jobNumber,
      client: payload.client, reportingYear: payload.reportingYear,
      dataHash: snapshot.data_hash, createdAt, createdBy: snapshot.created_by,
      measurements: payload.measurements ?? [],
      annualComparison: payload.annualComparison ?? [],
    },
  });
}

export type FreezeCompositionResult = { compositionId: string; dataHash: string; reused: boolean };

/**
 * Freeze it against the report version.
 *
 * Content-addressed: issuing the same facts twice finds the existing row rather than
 * minting a second truth for one document.
 */
export async function freezeReportComposition(db: Queryable, input: {
  organisationId: string;
  composition: ReportComposition;
  issuedBy: string;
}): Promise<FreezeCompositionResult> {
  const dataHash = hashOf(input.composition);
  const existing = await db.query<{ composition_id: string }>(
    `SELECT composition_id FROM nzi_console.report_compositions
     WHERE organisation_id = $1 AND report_version_id = $2 AND data_hash = $3`,
    [input.organisationId, input.composition.reportVersionId, dataHash]);
  if (existing.rows[0]) return { compositionId: existing.rows[0].composition_id, dataHash, reused: true };

  const compositionId = `rcomp-${randomUUID()}`;
  await db.query(
    `INSERT INTO nzi_console.report_compositions
       (organisation_id, composition_id, report_version_id, job_id, reviewed_snapshot_id,
        snapshot_data_hash, data_hash, payload_json, issued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.organisationId, compositionId, input.composition.reportVersionId, input.composition.jobId,
      input.composition.snapshotId, input.composition.snapshotDataHash, dataHash,
      JSON.stringify(input.composition), input.issuedBy]);
  return { compositionId, dataHash, reused: false };
}

/** What an issued report actually said — read back, never rebuilt. */
export async function getReportComposition(db: Queryable, reportVersionId: string): Promise<ReportComposition | null> {
  const result = await db.query<{ payload_json: ReportComposition }>(
    `SELECT payload_json FROM nzi_console.report_compositions
     WHERE report_version_id = $1`, [reportVersionId]);
  return result.rows[0]?.payload_json ?? null;
}
