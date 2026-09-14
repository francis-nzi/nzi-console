import type { ClientStrategy, Lever, StrategyStatus } from "./reductionStrategies";

/**
 * The report as a **composition**, frozen when it is issued.
 *
 * The reviewed CRP snapshot already freezes the measurement — what was emitted, with its
 * factors and provenance. But a report says more than that: it also states the client's
 * intensity, their targets, their decarbonisation plan and their SRS readiness, and none of
 * those live in the measurement snapshot. They are live records that go on changing.
 *
 * So issuing a report freezes a **composition**: the snapshot it rests on, plus the state of
 * everything else it quotes, as at the moment of issue. Without that, editing next week's
 * plan would silently rewrite a report a client has already been sent — the exact failure
 * immutability exists to prevent.
 *
 * Nothing here recomputes. Every figure arrives already resolved by the domain that owns it;
 * this module's job is to pin them together and record what they rested on.
 */

/* ── Provenance ──────────────────────────────────────────────────────────────────────── */

/**
 * What a data section rests on. Travels with the section rather than living once on a
 * methodology page, because a reader checking a number should find its basis beside it.
 */
export type ReportProvenance = {
  factorSets: string[];
  /** The hash of the data this section was built from — the snapshot's, for measurement. */
  dataHash: string;
  asAt: string;
  /** Counts per data-quality tier, so "measured" and "spend-based" are never conflated. */
  qualityTiers: Array<{ tier: string; count: number }>;
};

/* ── Assurance ───────────────────────────────────────────────────────────────────────── */

/**
 * The honest basis, and deliberately a closed union with one member.
 *
 * The platform records who **reviewed** a snapshot. It does not record an assurance
 * engagement, an assurer, a standard, or a scope of assurance — so there is no truthful way
 * for it to say "third-party assured", and this type gives no way to express it. A second
 * variant must not be added until the platform actually holds those records: a boolean would
 * have been one careless `true` away from a false assurance claim on a client document.
 */
export type ReportAssuranceBasis = {
  kind: "internal-review";
  /** The exact wording that appears on the Methodology page. */
  statement: string;
  reviewedBy: string;
  reviewedAt: string;
};

export const REPORT_ASSURANCE_STATEMENT = "Reviewed snapshot (internal review); not third-party assured";

export function reportAssurance(input: { reviewedBy: string; reviewedAt: string }): ReportAssuranceBasis {
  return { kind: "internal-review", statement: REPORT_ASSURANCE_STATEMENT, reviewedBy: input.reviewedBy, reviewedAt: input.reviewedAt };
}

/* ── Sections ────────────────────────────────────────────────────────────────────────── */

export const reportCompositionSections = [
  "cover", "executive-summary", "emissions", "intensity", "targets", "plan", "srs", "methodology",
] as const;
export type ReportCompositionSectionKey = (typeof reportCompositionSections)[number];

export const reportCompositionSectionMeta: Record<ReportCompositionSectionKey, { eyebrow: string; title: string }> = {
  cover: { eyebrow: "", title: "Carbon Reduction Plan" },
  "executive-summary": { eyebrow: "Overview", title: "Executive summary" },
  emissions: { eyebrow: "Footprint", title: "Emissions by scope" },
  intensity: { eyebrow: "Performance", title: "Emissions intensity" },
  targets: { eyebrow: "Trajectory", title: "Targets & reduction pathway" },
  plan: { eyebrow: "Plan", title: "Decarbonisation actions" },
  srs: { eyebrow: "Disclosure", title: "UK SRS readiness statement" },
  methodology: { eyebrow: "Basis", title: "Methodology & provenance" },
};

/**
 * A section that had nothing to say, and why.
 *
 * Never rendered as zeros: "0 tCO₂e" and "we could not read your footprint" look identical
 * on a page and mean opposite things.
 */
export type ReportSectionGap = { state: "unavailable"; reason: string };

export const isReportGap = (section: unknown): section is ReportSectionGap =>
  typeof section === "object" && section !== null && (section as ReportSectionGap).state === "unavailable";

export type ReportEmissionsSection = {
  totalTco2e: number;
  byScope: Array<{ scope: string; tco2e: number }>;
  priorYear: { year: number; totalTco2e: number } | null;
  provenance: ReportProvenance;
};

export type ReportIntensitySection = {
  metrics: Array<{
    key: string; label: string; iconKey: string; unit: string;
    value: number | null;
    /** Set only when `value` is null — the honest reason, not a dash. */
    unavailableReason: string | null;
  }>;
  provenance: ReportProvenance;
};

/**
 * Targets, frozen from the **client target model** (NZC-072) as it stood at issue.
 *
 * Not from the reviewed snapshot. Targets are a record of their own, versioned and edited
 * between reports — exactly the kind of live record this whole store exists to pin. Reading
 * them from the snapshot would freeze them at *review* time instead, so a target restated
 * between review and issue would be missing from the document that quotes it.
 */
export type ReportTargetsSection = {
  /** The baseline the targets were measured against, read — never typed. */
  benchmark: { year: number; totalTco2e: number; source: string; reference: string | null } | null;
  /**
   * The pathway, as the chart draws it. The net-zero point carries its **residual**: the
   * model's own figure, which is not generally zero, and drawing it to zero would claim
   * something the client never set.
   */
  trajectory: Array<{ year: number; tco2e: number; kind: string; pct: number }>;
  /**
   * NZC-068 — the baseline moved after these targets were set, so they are **held**, not
   * silently restated. A report issued in that state says so rather than presenting a
   * pathway measured against a benchmark that no longer applies.
   */
  benchmarkStale: boolean;
  setAt: string | null;
  provenance: ReportProvenance;
};

/** The residual the pathway actually lands on — never assumed to be zero. */
export const reportResidualTco2e = (targets: ReportTargetsSection): number | null =>
  targets.trajectory.find((point) => point.kind === "net-zero")?.tco2e ?? null;

export type ReportPlanStrategy = {
  title: string;
  scope: string;
  category: string;
  status: StrategyStatus;
  progressPct: number;
  owner: string;
  targetDate: string | null;
  /** What this strategy advances, by requirement code — "S2 M2" rather than an id. */
  srsRequirementCodes: string[];
};

export type ReportPlanSection = {
  /** Grouped as the workspace groups it — by lever, the theme a strategy sits under. */
  groups: Array<{ leverId: string; label: string; strategies: ReportPlanStrategy[] }>;
  summary: { total: number; planned: number; inProgress: number; complete: number };
  /**
   * How many live strategies were deliberately kept out of the report.
   *
   * Stated rather than hidden: a plan section showing four of a client's nine strategies
   * should say that four is a selection, not the whole plan.
   */
  excludedCount: number;
  /** Said on the page: the plan is qualitative, and its percentages are not carbon. */
  qualitativeOnly: true;
};

export type ReportSrsSection = {
  frameworkVersion: number;
  assessedOn: string;
  overallPct: number;
  overallLabel: string;
  pillars: Array<{ label: string; maturity: number; maturityLabel: string }>;
};

export type ReportComposition = {
  reportVersionId: string;
  jobId: string;
  jobNumber: string;
  client: string;
  reportingYear: number;
  issuedAt: string;
  /** The assured measurement this report rests on. */
  snapshotId: string;
  snapshotDataHash: string;
  assurance: ReportAssuranceBasis;
  emissions: ReportEmissionsSection | ReportSectionGap;
  intensity: ReportIntensitySection | ReportSectionGap;
  targets: ReportTargetsSection | ReportSectionGap;
  plan: ReportPlanSection | ReportSectionGap;
  srs: ReportSrsSection | ReportSectionGap;
};

/* ── Composing ───────────────────────────────────────────────────────────────────────── */

/**
 * The plan as it stood when the report was issued.
 *
 * Actions removed afterwards stay in the issued report — that is what freezing means — but
 * actions already removed at issue time were never part of it.
 */
export function composeReportPlan(
  strategies: readonly ClientStrategy[],
  levers: readonly Lever[],
  /** Requirement id → code, so the report shows "S2 M2" rather than a generated id. */
  requirementCodes: ReadonlyMap<string, string>,
): ReportPlanSection | ReportSectionGap {
  const live = strategies.filter((strategy) => strategy.active);
  // `include_in_report` is read HERE, at issue, and frozen with everything else. A later
  // toggle cannot reach back into a report the client already holds.
  const included = live.filter((strategy) => strategy.includeInReport);
  const excludedCount = live.length - included.length;

  if (included.length === 0) {
    return {
      state: "unavailable",
      reason: live.length === 0
        ? "No reduction strategies were on this client's plan when the report was issued."
        : `None of this client's ${live.length} reduction strategies were marked for inclusion when the report was issued.`,
    };
  }

  const summary = { total: included.length, planned: 0, inProgress: 0, complete: 0 };
  for (const strategy of included) {
    if (strategy.status === "planned") summary.planned += 1;
    else if (strategy.status === "in_progress") summary.inProgress += 1;
    else summary.complete += 1;
  }

  const asReportStrategy = (strategy: ClientStrategy): ReportPlanStrategy => ({
    title: strategy.title, scope: strategy.scope, category: strategy.category,
    status: strategy.status, progressPct: strategy.progressPct,
    owner: strategy.owner, targetDate: strategy.targetDate,
    srsRequirementCodes: strategy.srsRequirementIds
      .map((id) => requirementCodes.get(id))
      .filter((code): code is string => code !== undefined)
      .sort(),
  });

  const groups = [...levers]
    .filter((lever) => lever.active)
    .sort((a, b) => a.ordering - b.ordering || a.title.localeCompare(b.title))
    .map((lever) => ({
      leverId: lever.id,
      label: lever.title,
      strategies: included.filter((strategy) => strategy.leverIds.includes(lever.id)).map(asReportStrategy),
    }))
    .filter((group) => group.strategies.length > 0);

  // A strategy whose only lever was withdrawn still belongs in the report the client was
  // sent. Grouped separately rather than dropped, for the same reason the workspace does it.
  const liveLeverIds = new Set(levers.filter((lever) => lever.active).map((lever) => lever.id));
  const unallocated = included.filter((strategy) => !strategy.leverIds.some((id) => liveLeverIds.has(id)));
  if (unallocated.length > 0) {
    groups.push({ leverId: "__unallocated", label: "Other", strategies: unallocated.map(asReportStrategy) });
  }

  return { groups, summary, excludedCount, qualitativeOnly: true };
}

/**
 * The headline on the cover and in the executive summary.
 *
 * It states a year-on-year movement only when there is a prior year to compare against.
 * "Down 0%" against nothing is a claim, not a neutral default.
 */
export function reportHeadline(emissions: ReportEmissionsSection | ReportSectionGap, reportingYear: number): string {
  if (isReportGap(emissions)) return "No assured footprint was available when this report was issued.";
  const total = emissions.totalTco2e.toLocaleString("en-GB", { maximumFractionDigits: 0 });
  if (emissions.priorYear === null) {
    return `FY${reportingYear} assured footprint: ${total} tCO₂e. This is the first assured year, so there is no prior year to compare against.`;
  }
  if (emissions.priorYear.totalTco2e === 0) return `FY${reportingYear} assured footprint: ${total} tCO₂e.`;
  const change = ((emissions.totalTco2e - emissions.priorYear.totalTco2e) / emissions.priorYear.totalTco2e) * 100;
  const direction = change < 0 ? "down" : "up";
  return `FY${reportingYear} assured footprint: ${total} tCO₂e, ${direction} ${Math.abs(change).toFixed(1)}% against FY${emissions.priorYear.year}.`;
}

/**
 * Everything a reader needs to judge the report, gathered for the Methodology page.
 *
 * Built from what the sections actually carry rather than written once by hand, so a page
 * claiming "DEFRA 2024" cannot outlive the factor set the figures were built on.
 */
export function reportMethodologyRows(composition: ReportComposition): Array<{ label: string; value: string }> {
  const factorSets = new Set<string>();
  const tiers = new Map<string, number>();
  for (const section of [composition.emissions, composition.intensity, composition.targets]) {
    if (isReportGap(section)) continue;
    for (const set of section.provenance.factorSets) factorSets.add(set);
    for (const { tier, count } of section.provenance.qualityTiers) tiers.set(tier, (tiers.get(tier) ?? 0) + count);
  }
  const rows = [
    { label: "Standard", value: "GHG Protocol · UK SRS S2 aligned" },
    { label: "Factor set", value: factorSets.size > 0 ? [...factorSets].join(" · ") : "Not recorded" },
    {
      label: "Data quality",
      value: tiers.size > 0
        ? [...tiers.entries()].map(([tier, count]) => `${tier} ${count}`).join(" · ")
        : "Not recorded",
    },
    // The one row that must never be softened.
    { label: "Assurance basis", value: composition.assurance.statement },
    { label: "Reviewed by", value: composition.assurance.reviewedBy },
    { label: "Issued", value: composition.issuedAt.slice(0, 10) },
    { label: "Evidence hash", value: composition.snapshotDataHash },
  ];
  return rows;
}
