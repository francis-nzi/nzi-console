import { createHash, randomUUID } from "node:crypto";
import {
  actionControlLevelLabels, actionControlLevels, activeMetrics, composeReportPlan, isReportGap, maturityLabel,
  overallReadiness, pillarReadiness, reportAssurance, resolveIntensity,
  type ReportComposition, type ReportEmissionsSection, type ReportIntensitySection,
  type ReportProvenance, type ReportSectionGap, type ReportSrsSection, type ReportTargetsSection,
} from "@nzi/contracts";
import { listClientActions } from "./actionLevers";
import { listClientIntensityMetrics, listJobIntensityValues } from "./intensityMetricRecords";
import { getSrsFramework, listSrsAssessments } from "./srsReadinessRecords";
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
  target: { baselineYear: number; baselineTco2e: number; milestones: Array<{ year: number; reductionPct: number; tco2e: number }>; residualTco2e: number | null } | null;
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

function composeTargets(snapshot: SnapshotForComposition): ReportTargetsSection | ReportSectionGap {
  if (!snapshot.target) {
    return { state: "unavailable", reason: "No reduction target was set for this client when the report was issued." };
  }
  return {
    baselineYear: snapshot.target.baselineYear,
    baselineTco2e: snapshot.target.baselineTco2e,
    milestones: snapshot.target.milestones,
    // Net zero carries its residual. A pathway that lands on a flat zero claims something
    // the target model does not say.
    residualTco2e: snapshot.target.residualTco2e,
    provenance: provenanceFrom(snapshot),
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
  issuedAt: string;
}): Promise<ReportComposition> {
  // Composed once and shared: intensity divides by the same footprint the emissions section
  // states, so the two can never disagree about what the total was.
  const emissions = composeEmissions(input.snapshot);
  const totalTco2e = isReportGap(emissions) ? null : emissions.totalTco2e;

  const [intensity, srs, actions] = await Promise.all([
    composeIntensity(db, { clientId: input.clientId, jobId: input.snapshot.jobId, snapshot: input.snapshot, emissionsTco2e: totalTco2e }),
    composeSrs(db, input.clientId),
    listClientActions(db, input.clientId),
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
    targets: composeTargets(input.snapshot),
    plan: composeReportPlan(actions, actionControlLevelLabels, actionControlLevels),
    srs,
  };
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
