import { createHash, randomUUID } from "node:crypto";
import {
  strategyControlLevelLabels, strategyControlLevels, activeMetrics, composeReportPlan,
  composeSrsRoadmap, isReportGap, maturityLabel, type ClientStrategy,
  overallReadiness, pillarReadiness, reportAssurance, resolveIntensity, intensityUnit, withCurrencyDirectory,
  intensityDenominatorText, REPORTED_INTENSITY_METRICS, type IntensityTargetReadModel,
  type ReportComposition, type ReportIssuer, type ReportEmissionsSection, type ReportIntensitySection,
  type ReportProvenance, type ReportSectionGap, type ReportSrsSection, type ReportTargetsSection,
  composeScopedComparison, composeScopedEmissions, resolveFloorAreaDenominator, WHOLE_CLIENT_SCOPE, REPORT_RENDERER_LATEST,
  type ClientSiteReadModel, type IntensityMetricDefinition, type ReportingPeriod, type ReportScope, type ScopedHistoryPeriod,
} from "@nzi/contracts";
import { listClientStrategies, listLevers } from "./reductionStrategies";
import { readCurrencyDirectory } from "./commercialLookups";
import { denominatorFor, listClientIntensityMetrics, listJobIntensityValues } from "./intensityMetricRecords";
import { listJobReportedSites, resolveJobReportingPeriod } from "./siteBoundary";
import { listAssuredPeriodConflicts, listAssuredPeriodSnapshots } from "./assuredPeriodSnapshots";
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
  measurements: Array<{
    scope: string; tco2e: number; qualityTier?: string | null; factorSet?: string | null;
    /** S-2: the row's frozen site (null = organisation-level) and its labels, for a scope to filter and the sites to name. */
    siteId?: string | null; siteLabel?: string | null; sourceLabel?: string | null; reportLabel?: string | null;
  }>;
  annualComparison: Array<{ year: number; values: Array<{ scope: string; value: number }> }>;
  /**
   * The reported intensity as the review froze it (3c-3's one adapter) — the figure the intensity pathway draws. The
   * Intensity section reads its reported metric from here so the two cannot disagree (RF-1). Absent or a per-job
   * (`job-target`) shape on a snapshot frozen before 3c-3.
   */
  intensityTarget?: IntensityTargetReadModel | null;
};

/** What a scope composes against (S-2): the scope, the earlier assured periods' frozen rows, the baseline year, the conflicts. */
export type ScopeContext = {
  scope: ReportScope;
  history: readonly ScopedHistoryPeriod[];
  baselineYear: number | null;
  periodConflicts: Array<{ period: string; jobNumbers: string[] }>;
  /** Live site names, used only for a selected site the frozen rows never named (a boundary site with no rows). */
  siteNames: ReadonlyMap<string, string>;
};

function composeEmissions(snapshot: SnapshotForComposition, context: ScopeContext): ReportEmissionsSection | ReportSectionGap {
  if (snapshot.measurements.length === 0) {
    return { state: "unavailable", reason: "The reviewed snapshot carried no measurements inside the reporting boundary." };
  }
  // S-2 (R-S1 (A′)): every scoped figure is a filter of the snapshot's frozen rows — nothing is re-read, nothing apportioned.
  const scoped = composeScopedEmissions(snapshot.measurements, context.scope, context.siteNames);

  // The prior year comes from the snapshot's own annual comparison — the same series the
  // charts read — rather than a second query that could disagree with them. It is the whole
  // client's, so a site view carries its history in the comparison instead.
  const prior = context.scope.kind === "whole" ? snapshot.annualComparison
    .filter((entry) => entry.year < snapshot.reportingYear)
    .sort((a, b) => b.year - a.year)[0] ?? null : null;

  return {
    totalTco2e: scoped.totalTco2e,
    byScope: scoped.byScope,
    priorYear: prior === null ? null : { year: prior.year, totalTco2e: prior.values.reduce((sum, value) => sum + value.value, 0) },
    provenance: provenanceFrom(snapshot),
    sites: scoped.sites,
    ...(scoped.unallocated ? { unallocated: scoped.unallocated } : {}),
    comparison: composeScopedComparison({ scope: context.scope, currentYear: snapshot.reportingYear, current: snapshot.measurements, history: context.history, baselineYear: context.baselineYear }),
    ...(context.periodConflicts.length ? { periodConflicts: context.periodConflicts } : {}),
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
/**
 * S-2: the floor area of a set of the job's sites for the period. When floor area is the measure the CRP reports, the
 * review's frozen per-site areas (`denominatorBasis.sites`) are the source; otherwise the sites as they stand at issue, by
 * the same resolver the drawer uses. Null with a reason when any selected site's area cannot be resolved.
 */
function floorAreaOf(siteIds: readonly string[], basis: { frozen: IntensityTargetReadModel | null; sites: readonly ClientSiteReadModel[]; period: ReportingPeriod | null }): { m2: number | null; reason: string | null } {
  const frozenSites = basis.frozen?.metric === "floor-area" && basis.frozen.denominatorBasis?.kind === "site-floor-area" ? basis.frozen.denominatorBasis.sites : null;
  if (frozenSites) {
    const chosen = frozenSites.filter((site) => siteIds.includes(site.siteId));
    if (chosen.length !== siteIds.length || chosen.some((site) => site.floorAreaM2 === null)) return { m2: null, reason: "A selected site had no floor area when the CRP was reviewed." };
    return { m2: chosen.reduce((total, site) => total + (site.floorAreaM2 ?? 0), 0), reason: null };
  }
  if (!basis.period) return { m2: null, reason: "This year has no reporting period on record, so the sites' floor area cannot be resolved." };
  const resolved = resolveFloorAreaDenominator(basis.sites.filter((site) => siteIds.includes(site.id)), basis.period);
  return resolved.state === "resolved" && resolved.floorAreaM2 > 0 ? { m2: resolved.floorAreaM2, reason: null } : { m2: null, reason: resolved.state === "resolved" ? "The selected sites sum to no floor area." : resolved.reason };
}

export const WHOLE_CLIENT_ONLY = "Reported at whole-client level only";

async function composeIntensity(db: Queryable, input: {
  clientId: string; jobId: string; snapshot: SnapshotForComposition; emissionsTco2e: number | null; scope?: ReportScope;
}): Promise<ReportIntensitySection | ReportSectionGap> {
  const scope = input.scope ?? WHOLE_CLIENT_SCOPE;
  const [definitions, values, clientRows] = [await listClientIntensityMetrics(db, input.clientId),
    await listJobIntensityValues(db, input.jobId, input.snapshot.reportingYear),
    await db.query<{ currency: string; organisation_id: string }>(`SELECT currency, organisation_id FROM nzi_console.clients WHERE client_id = $1`, [input.clientId])];
  // The client's currency, so a currency metric is frozen reading "tCO₂e per £m" (or €m, AED m) — D3c — in the issuing
  // organisation's own symbols (E1: its `currencies`, read here and held only for the synchronous work below).
  const currency = clientRows.rows[0]?.currency ?? "GBP";
  const directory = clientRows.rows[0] ? await readCurrencyDirectory(db, clientRows.rows[0].organisation_id) : [];
  const live = activeMetrics(definitions);
  if (live.length === 0) {
    return { state: "unavailable", reason: "No intensity measures were set up for this client when the report was issued." };
  }
  // RF-1: each denominator through `denominatorFor` — the one the job's Intensity drawer and 3c-3's adapter use — over the
  // sites the job reports on (3a) and its reporting period, so a site-floor-area metric resolves here exactly as on screen.
  const [sites, reporting] = [await listJobReportedSites(db, input.clientId, input.jobId), await resolveJobReportingPeriod(db, input.jobId)];
  const period = reporting?.period ?? null;
  // The metric the CRP reports is the one the review froze (3c-3's adapter, in the snapshot) — publish does not re-decide
  // it, even if the client has reordered their metrics since. A snapshot from before 3c-3 marks nothing.
  const frozen = input.snapshot.intensityTarget?.source === "client-target" ? input.snapshot.intensityTarget : null;
  const reportedKey = frozen ? live.find((definition) => REPORTED_INTENSITY_METRICS[definition.key] === frozen.metric)?.key ?? null : null;
  return {
    metrics: withCurrencyDirectory(directory, () => live.map((definition) => {
      const recorded = values.find((value) => value.metricKey === definition.key && value.periodKey === "year");
      const reported = definition.key === reportedKey;
      if (scope.kind === "sites") {
        // S-2 (R-S1 (A′)): only floor area exists per site. Every other measure is the client's or the job's whole value —
        // dividing the sites' emissions by it would invent a figure, so it is stated, never apportioned.
        if (definition.valueSource !== "site-floor-area") {
          return { key: definition.key, label: definition.label, iconKey: definition.iconKey, unit: intensityUnit(definition, { currency }), value: null,
            unavailableReason: `${definition.label} has no per-site value, so its intensity is reported for the whole client only.`, reported, denominatorText: null, scopeNote: WHOLE_CLIENT_ONLY };
        }
        const area = floorAreaOf(scope.siteIds, { frozen: reported ? frozen : null, sites, period });
        const resolved = resolveIntensity({ definition, emissionsTco2e: input.emissionsTco2e, value: area.m2, currency });
        return { key: definition.key, label: definition.label, iconKey: definition.iconKey, unit: intensityUnit(definition, { currency }),
          value: resolved.state === "resolved" ? resolved.value : null,
          unavailableReason: resolved.state === "resolved" ? null : input.emissionsTco2e !== null && area.m2 === null && area.reason ? area.reason : resolved.reason,
          reported, denominatorText: area.m2 === null ? null : intensityDenominatorText(definition, area.m2, { currency }), scopeNote: null };
      }
      // The reported metric reads its denominator from the snapshot, so this section and the intensity pathway the same
      // document draws cannot disagree; the snapshot's figure is already over the divider, so it is restored to the
      // metric's own units here and divided by the same resolver.
      const denominator = reported
        ? { value: frozen!.reportingDenominator === null ? null : frozen!.reportingDenominator * (definition.divider || 1), reason: "The reported measure's value was unavailable when the CRP was reviewed." }
        : denominatorFor({ definition, recorded, sites, period });
      const resolved = resolveIntensity({ definition, emissionsTco2e: input.emissionsTco2e, value: denominator.value, currency });
      return {
        key: definition.key, label: definition.label, iconKey: definition.iconKey,
        // The whole unit as the report reads it ("tCO₂e per £m", "tCO₂e per 1,000 employees"), frozen — not the bare
        // wording, which printed "12.3 £m" beside a figure that is tCO₂e per £m. Compositions frozen before D3c keep theirs.
        unit: intensityUnit(definition, { currency }),
        value: resolved.state === "resolved" ? resolved.value : null,
        unavailableReason: resolved.state === "resolved"
          ? null
          // A missing denominator says why in the words of whatever could not resolve it — the floor-area boundary, or the
          // snapshot — and otherwise the resolver's own reason, rather than a second explanation for the same gap.
          : input.emissionsTco2e !== null && denominator.value === null && denominator.reason ? denominator.reason : resolved.reason,
        reported,
        denominatorText: denominator.value === null ? null : intensityDenominatorText(definition, denominator.value, { currency }),
      };
    })),
    reportedMetricKey: reportedKey,
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
async function composeSrs(
  db: Queryable,
  clientId: string,
  /**
   * The client's strategies, from the same read the plan section uses rather than queried
   * again — the roadmap must answer its gaps with the plan *this* report froze, and a second
   * query could return a plan edited between the two.
   */
  planned: readonly ClientStrategy[],
): Promise<ReportSrsSection | ReportSectionGap> {
  const [framework, assessments] = [await getSrsFramework(db), await listSrsAssessments(db, clientId)];
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
  const pillars = pillarReadiness(framework, assessment.items);
  // The climate-led standard is the one painted over the top, exactly as the workspace
  // radar draws it — the report and the screen must not disagree about which is which.
  const climate = framework.standards.find((standard) => standard.climateLed) ?? framework.standards[0] ?? null;
  const other = climate ? framework.standards.find((standard) => standard.key !== climate.key) ?? null : null;
  return {
    frameworkVersion: assessment.frameworkVersion,
    assessedOn: assessment.assessedOn.slice(0, 10),
    overallPct: overall.percent,
    overallLabel: maturityLabel(framework, overall.levelIndex),
    pillars: pillars.map((pillar) => ({
      label: pillar.label,
      maturity: pillar.overall.level,
      maturityLabel: maturityLabel(framework, pillar.overall.levelIndex),
    })),
    radar: climate ? {
      maxLevel: Math.max(1, framework.maturityLevels.length - 1),
      series: [climate, ...(other ? [other] : [])].map((standard) => ({
        key: (standard.key === climate.key ? "S2" : "S1") as "S1" | "S2",
        label: standard.label.replace(/^UK SRS \w+ — /, ""),
        values: pillars.map((pillar) => pillar.byStandard[standard.key]?.level ?? 0),
      })),
      target: pillars.map((pillar) => pillar.targetLevel),
    } : undefined,
    // Answered by the same population the plan section prints: live at issue, and marked for
    // the report. A strategy held back from the client does not get to close a gap in front
    // of them, and one already removed never appears at all.
    roadmap: composeSrsRoadmap(
      framework,
      assessment.items,
      planned.filter((strategy) => strategy.includeInReport),
    ),
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
  /** S-2: the version's scope and what it composes against. Absent = the whole client, with no history or conflicts read. */
  scopeContext?: ScopeContext;
}): Promise<ReportComposition> {
  const context: ScopeContext = input.scopeContext ?? { scope: WHOLE_CLIENT_SCOPE, history: [], baselineYear: null, periodConflicts: [], siteNames: new Map() };
  // Composed once and shared: intensity divides by the same footprint the emissions section
  // states, so the two can never disagree about what the total was — under a site scope, the
  // emissions attributable to the selected sites.
  const emissions = composeEmissions(input.snapshot, context);
  const totalTco2e = isReportGap(emissions) ? null : emissions.totalTco2e;
  if (!isReportGap(emissions)) await attachSiteFloorAreaIntensity(db, { clientId: input.clientId, snapshot: input.snapshot, emissions });

  // Read once and shared: the plan section prints these strategies and the readiness
  // roadmap answers its gaps with them. Two reads could straddle an edit and leave one
  // report disagreeing with itself about its own plan.
  const strategies = await listClientStrategies(db, input.clientId);

  // One at a time: `db` is the tenant transaction's single client (§13).
  const intensity = await composeIntensity(db, { clientId: input.clientId, jobId: input.snapshot.jobId, snapshot: input.snapshot, emissionsTco2e: totalTco2e, scope: context.scope });
  const targets = await composeTargets(db, { clientId: input.clientId, snapshot: input.snapshot, actuals: input.actuals });
  const srs = await composeSrs(db, input.clientId, strategies);
  const levers = await listLevers(db);
  // Requirement ids mean nothing to a reader, so the report carries codes like "S2 M2".
  const requirementRows = await db.query<{ requirement_id: string; code: string }>(`SELECT requirement_id, code FROM nzi_console.srs_requirements`);
  const requirementCodes = new Map(requirementRows.rows.map((row) => [row.requirement_id, row.code]));
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
    // S-2: the scope this report was issued at, its sites named from the frozen rows.
    scope: context.scope.kind === "whole" ? { kind: "whole" }
      : { kind: "sites", siteIds: context.scope.siteIds, siteLabels: isReportGap(emissions) ? context.scope.siteIds.map((id) => context.siteNames.get(id) ?? id) : (emissions.sites ?? []).map((site) => site.label) },
    // F-0 (RULING-reporting-F Q4): the layout this report is issued under, frozen with it, so a later layout cannot redraw it.
    renderer: REPORT_RENDERER_LATEST,
  };
}

/**
 * S-2: each site's floor-area intensity, for the per-site subsections — only when the client measures floor area, and only
 * for real sites (the organisation-level line has no floor). The same resolution as the scoped Intensity section.
 */
async function attachSiteFloorAreaIntensity(db: Queryable, input: { clientId: string; snapshot: SnapshotForComposition; emissions: ReportEmissionsSection }): Promise<void> {
  if (!input.emissions.sites?.length) return;
  const floor = activeMetrics(await listClientIntensityMetrics(db, input.clientId)).find((definition) => definition.valueSource === "site-floor-area");
  if (!floor) return;
  const [sites, reporting, clientRows] = [await listJobReportedSites(db, input.clientId, input.snapshot.jobId), await resolveJobReportingPeriod(db, input.snapshot.jobId),
    await db.query<{ currency: string }>(`SELECT currency FROM nzi_console.clients WHERE client_id = $1`, [input.clientId])];
  const frozen = input.snapshot.intensityTarget?.source === "client-target" && input.snapshot.intensityTarget.metric === "floor-area" ? input.snapshot.intensityTarget : null;
  const unit = intensityUnit(floor as IntensityMetricDefinition, { currency: clientRows.rows[0]?.currency ?? "GBP" });
  for (const site of input.emissions.sites) {
    if (site.siteId === null) continue;
    const area = floorAreaOf([site.siteId], { frozen, sites, period: reporting?.period ?? null });
    site.floorAreaIntensity = area.m2 === null
      ? { value: null, unit, floorAreaM2: null, reason: area.reason }
      : { value: (site.totalTco2e * (floor.divider || 1)) / area.m2, unit, floorAreaM2: area.m2, reason: null };
  }
}

/**
 * The assured years the pathway plots actual against (RF-2): one snapshot per reporting period, latest version — the
 * selection the workspace's chain reads, from the one shared reader — so a year frozen twice is counted once. The report's
 * own period is the snapshot it was validated against, not whichever version of its job is latest.
 */
export async function composeAssuredActuals(db: Queryable, input: {
  clientId: string;
  snapshot: { id: string; jobId: string; jobNumber: string; reportingYear: number; measurements: ReadonlyArray<{ tco2e: number }> };
}): Promise<TargetActual[]> {
  const assured = await listAssuredPeriodSnapshots(db, input.clientId, { excludeJobId: input.snapshot.jobId });
  return [
    ...assured.map((entry) => ({ year: entry.reportingYear, tco2e: entry.totalTco2e, snapshotId: entry.snapshotId, jobNumber: entry.jobNumber })),
    {
      year: Number(input.snapshot.reportingYear),
      tco2e: input.snapshot.measurements.reduce((total, measurement) => total + Number(measurement.tco2e), 0),
      snapshotId: input.snapshot.id,
      jobNumber: input.snapshot.jobNumber,
    },
  ].sort((a, b) => a.year - b.year);
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
  const version = await db.query<{ job_id: string; reviewed_snapshot_id: string; client_id: string; scope_kind: "whole" | "sites"; scope_site_ids: string[] | null } & IssuerColumns>(
    `SELECT r.job_id, r.reviewed_snapshot_id, j.client_id, r.scope_kind, r.scope_site_ids, ${ISSUER_COLUMNS}
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
      measurements: SnapshotForComposition["measurements"];
      annualComparison?: Array<{ year: number; values: Array<{ scope: string; value: number }> }>;
      intensityTarget?: IntensityTargetReadModel | null;
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

  const actuals = await composeAssuredActuals(db, {
    clientId: row.client_id,
    snapshot: { id: snapshot.snapshot_id, jobId: snapshot.job_id, jobNumber: payload.jobNumber, reportingYear: payload.reportingYear, measurements: payload.measurements ?? [] },
  });

  // S-2: what the version's scope composes against — the earlier assured periods' frozen rows (the RF-2 reader), the client's
  // baseline year, any period two jobs both report (flagged), and site names for a selected site no frozen row names.
  const scope: ReportScope = row.scope_kind === "sites" && row.scope_site_ids ? { kind: "sites", siteIds: row.scope_site_ids } : WHOLE_CLIENT_SCOPE;
  const [history, benchmark, periodConflicts, siteRows] = [await listAssuredPeriodSnapshots(db, row.client_id, { excludeJobId: snapshot.job_id }),
    await getBenchmarkInForce(db, row.client_id), await listAssuredPeriodConflicts(db, row.client_id),
    await db.query<{ site_id: string; name: string }>(`SELECT site_id, name FROM nzi_console.client_sites WHERE client_id = $1`, [row.client_id])];
  const siteNames = new Map(siteRows.rows.map((site) => [site.site_id, site.name]));

  const composed = await composeReport(db, {
    reportVersionId: input.reportVersionId,
    clientId: row.client_id,
    issuedAt: input.issuedAt,
    actuals,
    scopeContext: {
      scope,
      history: history.map((period) => ({ year: period.reportingYear, rows: period.rows, sitesKnown: period.sitesKnown })),
      baselineYear: benchmark?.year ?? null,
      periodConflicts,
      siteNames,
    },
    snapshot: {
      id: snapshot.snapshot_id, jobId: snapshot.job_id, jobNumber: payload.jobNumber,
      client: payload.client, reportingYear: payload.reportingYear,
      dataHash: snapshot.data_hash, createdAt, createdBy: snapshot.created_by,
      measurements: payload.measurements ?? [],
      annualComparison: payload.annualComparison ?? [],
      intensityTarget: payload.intensityTarget ?? null,
    },
  });
  // D3: the issuer the version froze at validation travels with what the report says.
  const issuer = issuerOf(row);
  return issuer ? { ...composed, issuer } : composed;
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

/** What an issued report actually said — read back, never rebuilt. A composition frozen before D3 carries no issuer; its report
 *  version's backfilled columns (exactly what it printed) stand in, so it renders as it always did. */
export async function getReportComposition(db: Queryable, reportVersionId: string): Promise<ReportComposition | null> {
  const result = await db.query<{ payload_json: ReportComposition } & IssuerColumns>(
    `SELECT c.payload_json, ${ISSUER_COLUMNS.replace(/r\./g, "v.")}
       FROM nzi_console.report_compositions c
       JOIN nzi_console.report_versions v ON (v.organisation_id, v.report_version_id) = (c.organisation_id, c.report_version_id)
      WHERE c.report_version_id = $1`, [reportVersionId]);
  const row = result.rows[0];
  if (!row) return null;
  const issuer = row.payload_json.issuer ?? issuerOf(row);
  return issuer ? { ...row.payload_json, issuer } : row.payload_json;
}

export type IssuerColumns = { issuer_display_name: string | null; issuer_short_name: string | null; issuer_footer: string | null; issuer_logo_asset_id: string | null };
const ISSUER_COLUMNS = "r.issuer_display_name, r.issuer_short_name, r.issuer_footer, r.issuer_logo_asset_id";
export const issuerOf = (row: Partial<IssuerColumns>): ReportIssuer | null => !row.issuer_display_name ? null : {
  displayName: row.issuer_display_name, shortName: row.issuer_short_name ?? row.issuer_display_name,
  footer: row.issuer_footer ?? row.issuer_display_name, logoAssetId: row.issuer_logo_asset_id ?? null,
};
