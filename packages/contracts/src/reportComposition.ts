import { strategiesBySrsRequirement, strategyStatusLabels, type ClientStrategy, type Lever, type StrategyControlLevel, type StrategyStatus } from "./reductionStrategies";
import { gaps as resolveGaps, maturityLabel, type SrsAssessmentItem, type SrsFramework } from "./srsReadiness";

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
  /**
   * How much of this the client actually controls — an **attribute of the strategy**, not a
   * grouping. The plan is grouped by lever and stays that way; this says, per strategy,
   * whether it is theirs to do, something they buy, or something they can only influence.
   *
   * **Optional on purpose**, the same pattern the radar and roadmap use: a composition frozen
   * before this shipped carries no control level and renders without the chip. A report is
   * what it said when it was issued, and back-filling an attribute into one would be adding
   * a claim the document never made.
   */
  controlLevel?: StrategyControlLevel;
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
  /**
   * What the pillar radar draws, frozen alongside the table it sits with.
   *
   * The table's `maturity` alone cannot draw a radar: the axes need the ladder's height and
   * the target profile to read a shape against, and neither is derivable from a level. They
   * are frozen here rather than resolved at render, for the same reason as everything else
   * in a composition — an issued report must not move when the client reassesses.
   *
   * **Optional on purpose.** Compositions frozen before the radar shipped do not carry it,
   * and those reports render the table alone. A report is what it said when it was issued;
   * back-filling a chart into one would be inventing a figure it never contained.
   *
   * `series` values and `target` are indexed against `pillars` above, in the same order —
   * both come from one `pillarReadiness` call.
   */
  radar?: {
    maxLevel: number;
    series: Array<{ key: "S1" | "S2"; label: string; values: number[] }>;
    target: number[];
  };
  /**
   * What the client should work on next, and what they are already doing about it.
   *
   * Frozen like the rest of the section. The gaps come from the readiness as assessed at
   * issue, and the strategies against each gap come from the **plan this same report froze**
   * — not from the live plan. A report issued last month therefore shows last month's gaps
   * answered by last month's strategies, however much the plan has moved since. Re-issuing
   * is what updates it.
   *
   * **Optional on purpose**, exactly as `radar` is. A composition frozen before this shipped
   * carries no roadmap and renders without one. An empty `pillars` is a different fact and
   * is kept distinct: it means the client was assessed and nothing sits below its target.
   */
  roadmap?: ReportSrsRoadmap;
};

/** A strategy answering a gap, as it stood when the report was issued. */
export type ReportSrsRoadmapStrategy = { title: string; status: StrategyStatus; statusLabel: string };

export type ReportSrsRoadmapGap = {
  code: string;
  /** The requirement in words — a code alone tells a client nothing. */
  title: string;
  /** Where it stands now, and what the framework expects of it. */
  maturityLabel: string;
  targetLabel: string;
  /** How many rungs short. What `gaps()` orders by, carried so the page can show it. */
  shortfall: number;
  /** Empty when nothing on the frozen plan advanced it — stated, never filled in. */
  strategies: ReportSrsRoadmapStrategy[];
};

export type ReportSrsRoadmapPillar = { key: string; label: string; gaps: ReportSrsRoadmapGap[] };

export type ReportSrsRoadmap = {
  pillars: ReportSrsRoadmapPillar[];
  /** Gaps with nothing aligned to them. Said plainly: it is the useful signal, not a flaw. */
  unaddressedCount: number;
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
    // Frozen with everything else the plan says: a strategy re-classified next quarter does
    // not change what the client was told about the one they hold.
    controlLevel: strategy.controlLevel,
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

/* ── The readiness radar ─────────────────────────────────────────────────────────────── */

/** What `SrsPillarRadar` needs, assembled from a frozen composition. */
export type ReportSrsRadarChart = {
  pillars: string[];
  series: Array<{ key: "S1" | "S2"; label: string; values: number[] }>;
  target: number[];
  maxLevel: number;
};

/**
 * The report's readiness radar, from what the report froze — or `null` when it froze none.
 *
 * A composition issued before the radar shipped carries no `radar` block, and gets no chart:
 * an issued report is what it said at the time, and back-filling a graphic into one would be
 * showing the client a figure their document never contained. The caller renders the pillar
 * table either way.
 *
 * Assembling the payload here rather than in the view keeps it testable without a browser,
 * and keeps the one place that decides what the chart is fed next to the type that froze it.
 */
export function reportSrsRadarChart(srs: ReportSrsSection): ReportSrsRadarChart | null {
  const radar = srs.radar;
  if (!radar || srs.pillars.length === 0 || radar.series.length === 0) return null;
  return {
    pillars: srs.pillars.map((pillar) => shortPillarLabel(pillar.label)),
    series: radar.series,
    target: radar.target,
    maxLevel: radar.maxLevel,
  };
}

/**
 * Axis labels have to fit a 300px radar. The full name stays in the table beside it, so
 * this is presentation and is never what gets frozen.
 */
export function shortPillarLabel(label: string): string {
  if (label.length <= 11) return label;
  return label.replace(/\bmanagement\b/i, "mgmt").replace(/\s*&\s*targets$/i, "").slice(0, 12).trim();
}

/* ── The readiness roadmap ───────────────────────────────────────────────────────────── */

/**
 * The gaps below target, and what the client is doing about each one.
 *
 * Shared by both surfaces, which is the point: the report freezes the result at issue, the
 * portal composes it live on every load. One builder means the client cannot be shown one
 * ordering in their document and a different one on their portal.
 *
 * Two existing pieces, joined — deliberately no new rules:
 *
 * - **Ordering is `gaps()`.** It already sorts worst-shortfall first, then by the framework's
 *   own order so the list is stable between assessments. Re-sorting here would be a second
 *   opinion about what matters most, and the two would drift.
 * - **The alignment is `strategiesBySrsRequirement()`**, the same inversion the readiness
 *   screen reads. It excludes withdrawn strategies, so a gap cannot look answered by work
 *   the client stopped doing.
 *
 * `plan` must be the strategies **this report froze** — active and `include_in_report`, the
 * same population the plan section shows. Passing the live plan would make a report's
 * roadmap drift away from its own plan section, which is the failure freezing exists to stop.
 *
 * Pillars appear in the order their worst gap appears, so the pillar needing most attention
 * leads. That is `gaps()`'s ordering read through a grouping, not a second ranking.
 */
export function composeSrsRoadmap(
  framework: SrsFramework,
  items: readonly SrsAssessmentItem[],
  plan: readonly ClientStrategy[],
): ReportSrsRoadmap {
  const byRequirement = strategiesBySrsRequirement(plan);
  const pillarLabels = new Map(framework.pillars.map((pillar) => [pillar.key, pillar.label]));
  const pillars: ReportSrsRoadmapPillar[] = [];
  const index = new Map<string, ReportSrsRoadmapPillar>();
  let unaddressedCount = 0;

  for (const gap of resolveGaps(framework, items)) {
    const strategies = (byRequirement.get(gap.requirement.id) ?? []).map((strategy) => ({
      title: strategy.title,
      status: strategy.status,
      statusLabel: strategyStatusLabels[strategy.status],
    }));
    if (strategies.length === 0) unaddressedCount += 1;

    const key = gap.requirement.pillarKey;
    let pillar = index.get(key);
    if (!pillar) {
      // First time this pillar appears is its rank: the gaps arrive worst-first.
      pillar = { key, label: pillarLabels.get(key) ?? key, gaps: [] };
      index.set(key, pillar);
      pillars.push(pillar);
    }
    pillar.gaps.push({
      code: gap.requirement.code,
      title: gap.requirement.title,
      // `maturity` is null when the requirement was never assessed, which is not the same as
      // level 0 — `maturityLabel` words the floor, and the shortfall beside it says how far.
      maturityLabel: maturityLabel(framework, gap.maturity ?? 0),
      targetLabel: maturityLabel(framework, gap.targetMaturity),
      shortfall: gap.shortfall,
      strategies,
    });
  }

  return { pillars, unaddressedCount };
}
