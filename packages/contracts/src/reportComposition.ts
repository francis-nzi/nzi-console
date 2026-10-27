import { strategiesBySrsRequirement, strategyIsReportable, strategyStatusLabels, type ClientStrategy, type FrozenStrategyStatus, type Lever, type StrategyControlLevel } from "./reductionStrategies";
import { gaps as resolveGaps, maturityLabel, type SrsAssessmentItem, type SrsFramework } from "./srsReadiness";
import type { ReportAuditAppendix, ReportSources } from "./reportSources";

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
  "cover", "executive-summary", "emissions", "sites", "intensity", "targets", "plan", "srs", "methodology",
  // B2-3 (RULING-report-B2-3, F2): the mockup's further sections — drawn by `composed@4` only.
  "scope-analysis", "category-analysis", "glossary", "audit", "appendix-sites",
] as const;
export type ReportCompositionSectionKey = (typeof reportCompositionSections)[number];

/**
 * B2-3 (RULING-report-B2-3, call 1): the reference block — the Glossary and the two appendices — which follows Methodology in
 * exactly this order and is followed by nothing. Each may be left out; none may move.
 */
export const reportReferenceSections = ["glossary", "audit", "appendix-sites"] as const satisfies readonly ReportCompositionSectionKey[];
export const isReportReferenceSection = (key: string): boolean => (reportReferenceSections as readonly string[]).includes(key);
/** The sections only `composed@4` (and later) draws; `composed@1/2/3` never do, whatever a plan holds. */
export const reportComposed4Sections: readonly ReportCompositionSectionKey[] = ["scope-analysis", "category-analysis", ...reportReferenceSections];

/** Section headings as `composed@1/2/3` print them — pinned byte for byte with those renderers; never edit (fork instead). */
export const reportCompositionSectionMeta: Record<ReportCompositionSectionKey, { eyebrow: string; title: string }> = {
  cover: { eyebrow: "", title: "Carbon Reduction Plan" },
  "executive-summary": { eyebrow: "Overview", title: "Executive summary" },
  emissions: { eyebrow: "Emissions", title: "Emissions by scope" },
  sites: { eyebrow: "Boundary", title: "Sites & reporting boundary" },
  intensity: { eyebrow: "Performance", title: "Emissions intensity" },
  targets: { eyebrow: "Trajectory", title: "Targets & reduction pathway" },
  plan: { eyebrow: "Plan", title: "Decarbonisation actions" },
  srs: { eyebrow: "Disclosure", title: "UK SRS readiness statement" },
  methodology: { eyebrow: "Basis", title: "Methodology & provenance" },
  // Never drawn by composed@1/2/3; named here only so the table is complete (the plan editors list them).
  "scope-analysis": { eyebrow: "Analysis", title: "Analysis by scope" },
  "category-analysis": { eyebrow: "Analysis", title: "Emissions by scope & category" },
  glossary: { eyebrow: "Reference", title: "Glossary" },
  audit: { eyebrow: "Appendix 1", title: "Full emissions audit" },
  "appendix-sites": { eyebrow: "Appendix 2", title: "Emissions by site & scope" },
};

/** B2-3 (RULING-report-B2-3, call 4): the headings `composed@4` prints — the mockup's titles. */
export const reportSectionMetaV4: Record<ReportCompositionSectionKey, { eyebrow: string; title: string }> = {
  cover: { eyebrow: "", title: "Carbon Reduction Plan" },
  "executive-summary": { eyebrow: "Overview", title: "Executive Summary" },
  sites: { eyebrow: "Boundary", title: "Sites & Reporting Boundary" },
  emissions: { eyebrow: "Overview", title: "Carbon Emissions Overview" },
  intensity: { eyebrow: "Performance", title: "Intensity Metric Analysis" },
  targets: { eyebrow: "Trajectory", title: "Targets & Reduction Pathway" },
  "scope-analysis": { eyebrow: "Analysis", title: "Analysis by Scope" },
  "category-analysis": { eyebrow: "Analysis", title: "Emissions by Scope & Category" },
  plan: { eyebrow: "Plan", title: "Carbon Reduction Actions" },
  srs: { eyebrow: "Disclosure", title: "UK SRS Readiness Statement" },
  methodology: { eyebrow: "Assurance", title: "Standards, Methodology & Sign-off" },
  glossary: { eyebrow: "Reference", title: "Glossary" },
  audit: { eyebrow: "Appendix 1", title: "Full Emissions Audit" },
  "appendix-sites": { eyebrow: "Appendix 2", title: "Emissions by Site & Scope" },
};

/** A section's heading as the composition's own renderer prints it — so the studio's rail and the document agree. */
export const reportSectionMetaFor = (composition: { renderer?: string }): Record<ReportCompositionSectionKey, { eyebrow: string; title: string }> =>
  drawsMockupSectionSet(composition) ? reportSectionMetaV4 : reportCompositionSectionMeta;

/** `composed@4` and its successors `composed@5` and `composed@6` draw the mockup's section set and read their plans complete. */
export const drawsMockupSectionSet = (composition: { renderer?: string }): boolean => {
  const renderer = reportRendererOf(composition);
  return renderer === "composed@4" || renderer === "composed@5" || renderer === "composed@6";
};

/** `composed@5` and `composed@6` are the mockup's own document (`ComposedV5`): pages, cover, narrative with locked tokens. */
export const drawsMockupDocument = (composition: { renderer?: string }): boolean => {
  const renderer = reportRendererOf(composition);
  return renderer === "composed@5" || renderer === "composed@6";
};

/* ── Renderer version (F-0; RULING-reporting-F Q4) ───────────────────────────────────── */

/**
 * The layouts an issued composition can name. A composition's data is frozen; this freezes **which layout draws it**, so a
 * later change to the view cannot quietly move a report the client was already sent.
 *
 * The bump rule (binding): if a change to the composed view or its section/chart components would alter the markup of any
 * already-issued composition, its golden pin fails — the pin is **not** updated; the change forks to `composed@N+1`, and the
 * `composed@N` path stays until no live report uses it. New compositions stamp the latest.
 */
export const reportRenderers = ["composed@1", "composed@2", "composed@3", "composed@4", "composed@5", "composed@6"] as const;
export type ReportRenderer = (typeof reportRenderers)[number];
/**
 * F-2 (chart parity, RULING-reporting-F4 D2): `composed@2` is `composed@1` with the manifest's charts — scope donut,
 * year-on-year, by-activity, purchased goods and intensity pathway drawn from the composition's frozen `chartBasis` by the
 * resolver the portal uses today, and the reduction pathway drawn from the report's own Targets section (the client target
 * model — never the superseded job-level target the portal's chart draws, and never a flat zero over a residual). A fork,
 * not an edit: every `composed@1` report draws exactly as before.
 *
 * B1 (RULING-report-studio-consolidation R3/R6; REVIEW-report-srcline-and-B1-rulings, both calls confirmed): `composed@3` is
 * `composed@2` with one source line per chart and section — the snapshot and its datasets by id, from the composition's
 * frozen `sources` — in place of the per-row factor strings; "Largest emissions activities" one bar per activity (resolver
 * v2); the full per-row provenance as an audit appendix closing Methodology (frozen `audit`); and, on a preview, "preview —
 * not issued" where an issued report states its issue date. A fork: every `composed@1/2` report draws exactly as before.
 *
 * B2-3 (RULING-report-B2-3): `composed@4` is the mockup's document — its section set (Analysis by Scope, Emissions by Scope &
 * Category, and the reference block after Methodology: Glossary, the Full Emissions Audit as its own section, Appendix 2 by
 * site & scope), its titles, the cover's metacard (with the frozen reporting period) and the sign-off (the frozen client
 * signee and issuer). A fork: every `composed@1/2/3` report draws exactly as before, with the plan it always had.
 *
 * BUILD-report-studio-composed5: `composed@5` is the mockup (`_handoff/MOCKUP-report-studio.html`) rendered — its own document
 * (pages, cover, narrative with locked data tokens, charts, tables), bound to the frozen composition and never to the mockup's
 * sample figures; no turnover amount anywhere (NZC-120). A fork: every `composed@1/2/3/4` report draws exactly as before.
 *
 * B2-4 (RULING-report-studio-B2-4 (a)): `composed@6` is `composed@5` drawing a **frozen narrative** — each narrative block's body
 * as validate froze it (the job's working sections), its tokens resolved from the frozen composition — in place of the template.
 * Not a file fork: a branch inside `ComposedV5`, reached only with the renderer `composed@6` **and** the narrative present. Every
 * `composed@1–5` report draws exactly as before.
 */
export const REPORT_RENDERER_LATEST: ReportRenderer = "composed@6";

/**
 * The renderer a composition is stamped with: `composed@6` exactly when it carries a narrative, else `composed@5`. One rule, at
 * the one compose path, so a `composed@6` composition without a narrative cannot be made — a version validated before B2-4
 * (no frozen narrative) composes, previews and publishes as `composed@5`, as the rollout requires.
 */
export function reportRendererFor(input: { narrative?: readonly ReportNarrativeElement[] | null }): ReportRenderer {
  return input.narrative ? REPORT_RENDERER_LATEST : "composed@5";
}

/**
 * F-2: the charts' input, frozen at publish — the reviewed snapshot's chart fields as the portal passes them to
 * `resolveCrpCoreCharts` today, cut to the report's scope by the same filter its figures were (R-S1 (A′)). Structurally the
 * resolver's `ReviewedCrpSnapshotCore`, kept here so contracts does not depend on the chart package. It carries no job-level
 * target: the report's targets are the client's (its Targets section), and its pathway is drawn from those.
 */
export type ReportChartBasis = {
  id: string; jobId: string; jobNumber: string; client: string; reportingYear: number; generatedAt: string; dataHash: string;
  intensityTarget: Record<string, unknown> | null;
  annualComparison: Array<{ year: number; values: Array<{ scope: "1" | "2" | "3"; value: number }> }>;
  measurements: Array<{
    rowId: string; scope: "1" | "2" | "3"; scopeCode?: string; sourceLabel: string; siteId?: string | null; siteLabel?: string | null;
    purchasedGoodsCategoryId?: string | null; purchasedGoodsCategoryLabel?: string | null; tco2e: number; factorSet: string;
  }>;
};

/**
 * The layout a composition was issued under. One frozen before F-0 carries none, and was issued under the layout that is
 * `composed@1`. A name this code does not know returns null — drawn with a different layout it would no longer be the
 * report that was issued, so the view says so instead.
 */
export function reportRendererOf(composition: { renderer?: string }): ReportRenderer | null {
  const renderer = composition.renderer ?? "composed@1";
  return (reportRenderers as readonly string[]).includes(renderer) ? renderer as ReportRenderer : null;
}

/* ── Section plan (F-0 draws from it; F-1 stores and freezes it) ────────────────────── */

/**
 * The R2 narrative sections (`reportSections.ts`), as plan keys (RULING-reporting-F Q6). Namespaced: the narrative has its own
 * "executive-summary" (the prose), distinct from the composed data section of that name (the figures).
 */
export const reportNarrativePlanKeys = [
  "narrative:executive-summary", "narrative:net-zero-commitment", "narrative:background",
  "narrative:intensity-analysis", "narrative:category-analysis", "narrative:reduction-actions",
] as const;
export type ReportNarrativePlanKey = (typeof reportNarrativePlanKeys)[number];

/** Every key a plan orders (Q6): the composed data sections and the narrative, so the key set never has to change shape. */
export type ReportPlanSectionKey = ReportCompositionSectionKey | ReportNarrativePlanKey;
export const reportPlanSectionKeys: readonly ReportPlanSectionKey[] = [...reportCompositionSections, ...reportNarrativePlanKeys];
export const isReportDataSection = (key: string): key is ReportCompositionSectionKey => (reportCompositionSections as readonly string[]).includes(key);
export const isReportNarrativeSection = (key: string): key is ReportNarrativePlanKey => (reportNarrativePlanKeys as readonly string[]).includes(key);

/**
 * ACCEPT-composed5-checkpoint2, decision 3: the narrative sections `composed@5` draws as sections of their own — Net Zero
 * Commitment and Background & Organisation — so a plan may include, leave out and move them like any optional section. The
 * other four narratives ride inside their host data sections (the Executive Summary, Intensity, Category, Actions) and stay
 * where they are. `composed@1/2/3/4` never draw any narrative, whatever a plan holds.
 */
export const reportStandaloneNarrativeSections: readonly ReportNarrativePlanKey[] = ["narrative:net-zero-commitment", "narrative:background"];
export const isReportStandaloneNarrativeSection = (key: string): boolean => (reportStandaloneNarrativeSections as readonly string[]).includes(key);

/** Which sections a report shows, in order. */
export type ReportSectionPlanEntry = { key: ReportPlanSectionKey; included: boolean };
export type ReportSectionPlan = readonly ReportSectionPlanEntry[];

/** The narrative's place in a report, and its title there. */
export const reportNarrativeSectionMeta: Record<ReportNarrativePlanKey, { title: string }> = {
  "narrative:executive-summary": { title: "Executive summary (narrative)" },
  "narrative:net-zero-commitment": { title: "Net zero commitment" },
  "narrative:background": { title: "Background" },
  "narrative:intensity-analysis": { title: "Intensity analysis" },
  "narrative:category-analysis": { title: "Category analysis" },
  "narrative:reduction-actions": { title: "Reduction actions" },
};
/** B2-4: the data section each riding narrative is drawn inside (composed@5 decision 3) — it is drawn when its host is. */
export const reportNarrativeHost: Readonly<Partial<Record<ReportNarrativePlanKey, ReportCompositionSectionKey>>> = {
  "narrative:executive-summary": "executive-summary", "narrative:intensity-analysis": "intensity",
  "narrative:category-analysis": "category-analysis", "narrative:reduction-actions": "plan",
};

/**
 * B2-4 (RULING-report-studio-B2-4, "freeze a body for the sections the version includes"): the narrative sections a report with
 * this plan draws, as catalogue keys — a standalone one (Net Zero Commitment, Background) when the plan includes it, a riding one
 * when the plan includes its host. Validate freezes a body for exactly these; an excluded section needs none.
 */
export function reportNarrativeDrawnKeys(plan: ReportSectionPlan): Set<string> {
  const included = new Set(plan.filter((entry) => entry.included).map((entry) => entry.key as string));
  return new Set(reportNarrativePlanKeys
    .filter((key) => isReportStandaloneNarrativeSection(key) ? included.has(key) : included.has(reportNarrativeHost[key] ?? ""))
    .map((key) => key.slice("narrative:".length)));
}

export const reportPlanSectionTitle = (key: ReportPlanSectionKey): string =>
  isReportDataSection(key) ? reportCompositionSectionMeta[key].title : reportNarrativeSectionMeta[key].title;

/**
 * The default plan up to `composed@3` — **frozen** (RULING-report-B2-3: the critical guarantee). A `composed@1/2/3` composition
 * issued before F-1 froze no plan and renders with this, so it never starts drawing the sections `composed@4` added. Never
 * edit: a change here would redraw issued reports.
 */
export const legacyReportSectionPlanV3: ReportSectionPlan = ([
  "cover", "executive-summary", "narrative:executive-summary", "narrative:net-zero-commitment", "narrative:background",
  "emissions", "narrative:category-analysis", "sites", "intensity", "narrative:intensity-analysis", "targets", "plan",
  "narrative:reduction-actions", "srs", "methodology",
] as const).map((key) => ({ key, included: !isReportNarrativeSection(key) }));

/**
 * The report's default plan — `composed@4`'s canonical order, the mockup's (RULING-report-B2-3): the narrative beside the
 * sections it speaks to (**not included**: not drawn until B2-4), the main body ending at Methodology, then the reference block.
 * Every new key is included by default, as in the mockup; each optional one may be left out.
 */
export const defaultReportSectionPlan: ReportSectionPlan = ([
  "cover", "executive-summary", "narrative:executive-summary", "narrative:net-zero-commitment", "narrative:background",
  "sites", "emissions", "intensity", "narrative:intensity-analysis", "targets", "scope-analysis", "category-analysis",
  "narrative:category-analysis", "plan", "narrative:reduction-actions", "srs", "methodology", ...reportReferenceSections,
  // composed@5 (decision 3): the two standalone narrative sections are on by default, as in the mockup; the narrative that
  // rides inside a data section is not a plan choice.
] as const).map((key) => ({ key, included: !isReportNarrativeSection(key) || isReportStandaloneNarrativeSection(key) }));

/**
 * B2-3 (RULING-report-B2-3): a stored plan written before a key existed, read complete — deterministically. Each key the plan
 * lacks is put at its default place: straight after the nearest key before it (in the default order) that the plan holds, and
 * a reference section at its fixed place in the trailing block. Nothing the plan held is removed or reordered, and a complete
 * plan is returned as it is. Applied to stored plans that feed new work (a profile, a validated version, a `composed@4`
 * composition) — **never** to an issued `composed@1/2/3` composition, which keeps the plan it was issued with.
 */
export function normaliseReportPlanKeys(plan: ReportSectionPlan): ReportSectionPlan {
  const held = new Set(plan.map((entry) => entry.key));
  if (defaultReportSectionPlan.every((entry) => held.has(entry.key))) return plan;
  const next = [...plan];
  for (const [index, entry] of defaultReportSectionPlan.entries()) {
    if (held.has(entry.key)) continue;
    let at = 0;
    if (isReportReferenceSection(entry.key)) {
      // After Methodology and any reference section that precedes this one; the block's order is fixed.
      const anchors = ["methodology", ...reportReferenceSections.slice(0, reportReferenceSections.indexOf(entry.key as never))];
      at = Math.max(...anchors.map((key) => next.findIndex((item) => item.key === key))) + 1;
    } else {
      for (let back = index - 1; back >= 0; back--) {
        const found = next.findIndex((item) => item.key === defaultReportSectionPlan[back]!.key);
        if (found >= 0) { at = found + 1; break; }
      }
    }
    next.splice(at, 0, { key: entry.key, included: entry.included });
    held.add(entry.key);
  }
  return next;
}

/**
 * The plan a composition renders with. `composed@1/2/3`: the one frozen into it at publish (F-1), or — issued before F-1 — the
 * **frozen v3 default**, exactly as always. `composed@4`: its own plan (or the default), read complete.
 */
export const reportSectionPlanOf = (composition: ReportComposition): ReportSectionPlan =>
  drawsMockupSectionSet(composition)
    ? normaliseReportPlanKeys(composition.sectionPlan ?? defaultReportSectionPlan)
    : composition.sectionPlan ?? legacyReportSectionPlanV3;

/**
 * The exclusion interlock (RULING-reporting-F Q5, binding). A section may be **left out** of a report only once the client
 * portal draws the frozen composition (F-4): until then the portal re-resolves from the snapshot, so an "excluded" section
 * would still reach the client — the honesty trap F must not create. So F-1 is **reorder-only**, enforced here, at the one
 * validator every command and the UI share. The exclusion machinery (the plan's `included`, the layout skipping it, the
 * Methodology stating it) was built in F-1, and F-4b moves the portal onto the frozen composition.
 *
 * **ON (RULING-reporting-F4b-flip-and-dashboard, decision 3).** It was held until **every** client surface honoured exclusion,
 * and both gates are now met: GATE 1, F-4c (#459: the portal dashboard hides what the default report omits), and GATE 2, the
 * client-target backfill (committed on staging 11 Oct 2026, 208 clients, verified). An optional section may now be left out
 * at validate, at the client's profile and at update; the mandatory sections never. `allowExclusion: false` still refuses,
 * so the interlock itself stays testable.
 */
export const REPORT_SECTION_EXCLUSION_AVAILABLE = true;

/** Narrative sections may be included once the composed report draws them (Q6: with F-2/F-4). That PR flips this. */
export const REPORT_NARRATIVE_SECTIONS_AVAILABLE = false;

/** The sections a plan may never leave out: the cover and the basis, and a carbon report's footprint and its summary (Q1). */
export const reportMandatorySections: readonly ReportCompositionSectionKey[] = ["cover", "executive-summary", "emissions", "methodology"];

export type ReportSectionPlanIssue = { field: string; code: string; message: string };

/**
 * A plan a report may carry (Q1). Complete — every key once, nothing unknown — with the cover first and the methodology last;
 * the mandatory sections included; narrative only once it is drawn; exclusion only once the portal honours it (Q5).
 * `options` exists so the machinery can be tested ahead of the flips; commands pass nothing.
 */
export function reportSectionPlanIssues(
  plan: unknown,
  options: { allowExclusion?: boolean; allowNarrative?: boolean } = {},
): ReportSectionPlanIssue[] {
  const allowExclusion = options.allowExclusion ?? REPORT_SECTION_EXCLUSION_AVAILABLE;
  const allowNarrative = options.allowNarrative ?? REPORT_NARRATIVE_SECTIONS_AVAILABLE;
  if (!Array.isArray(plan)) return [{ field: "sectionPlan", code: "INVALID", message: "A section plan is a list of sections." }];
  const issues: ReportSectionPlanIssue[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of plan.entries()) {
    const key = (entry as { key?: unknown })?.key, included = (entry as { included?: unknown })?.included;
    if (typeof key !== "string" || !(reportPlanSectionKeys as readonly string[]).includes(key)) {
      issues.push({ field: `sectionPlan[${index}].key`, code: "UNKNOWN_SECTION", message: `Section ${index + 1} is not a report section.` });
      continue;
    }
    if (typeof included !== "boolean") issues.push({ field: `sectionPlan[${index}].included`, code: "INVALID", message: `Say whether ${reportPlanSectionTitle(key as ReportPlanSectionKey)} is included.` });
    if (seen.has(key)) issues.push({ field: `sectionPlan[${index}].key`, code: "DUPLICATE_SECTION", message: `${reportPlanSectionTitle(key as ReportPlanSectionKey)} appears more than once.` });
    seen.add(key);
  }
  for (const key of reportPlanSectionKeys) {
    if (!seen.has(key)) issues.push({ field: "sectionPlan", code: "MISSING_SECTION", message: `${reportPlanSectionTitle(key)} is missing from the plan.` });
  }
  if (issues.length) return issues;
  const entries = plan as ReportSectionPlanEntry[];
  if (entries[0]!.key !== "cover") issues.push({ field: "sectionPlan[0]", code: "COVER_FIRST", message: "The cover comes first." });
  // B2-3 (RULING-report-B2-3, call 1): the main body ends at Methodology; after it comes exactly the reference block — the
  // Glossary, the Full Emissions Audit, Appendix 2 — in that order, and nothing else. Strict about everything else.
  const methodologyAt = entries.findIndex((entry) => entry.key === "methodology");
  const trailing = entries.slice(methodologyAt + 1).map((entry) => entry.key as string);
  if (trailing.some((key) => !isReportReferenceSection(key))) {
    issues.push({ field: `sectionPlan[${methodologyAt}]`, code: "METHODOLOGY_LAST", message: "Methodology & provenance ends the report's main body: only the Glossary and the appendices follow it." });
  } else if (trailing.join(",") !== reportReferenceSections.join(",")) {
    issues.push({ field: `sectionPlan[${methodologyAt + 1}]`, code: "REFERENCE_BLOCK", message: "After Methodology & provenance come the Glossary, the Full Emissions Audit and Appendix 2, in that order." });
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.included) {
      // Decision 3: a standalone narrative section is drawn by the renderer new reports stamp (composed@5), so it may be
      // included; the narrative that rides inside a data section still may not be, on its own.
      if (isReportNarrativeSection(entry.key) && !allowNarrative && !isReportStandaloneNarrativeSection(entry.key)) {
        issues.push({ field: `sectionPlan[${index}].included`, code: "NARRATIVE_NOT_YET_DRAWN", message: `${reportPlanSectionTitle(entry.key)} is not drawn in the composed report yet, so it cannot be included.` });
      }
      continue;
    }
    if (isReportNarrativeSection(entry.key)) continue;
    if (reportMandatorySections.includes(entry.key)) {
      issues.push({ field: `sectionPlan[${index}].included`, code: "MANDATORY_SECTION", message: `${reportPlanSectionTitle(entry.key)} is always part of the report.` });
    } else if (!allowExclusion) {
      issues.push({ field: `sectionPlan[${index}].included`, code: "EXCLUSION_NOT_YET_AVAILABLE", message: `Sections can be reordered but not yet left out: the client portal does not honour a left-out section until it shows the issued report itself.` });
    }
  }
  return issues;
}

const samePlan = (a: ReportSectionPlan, b: ReportSectionPlan) =>
  a.length === b.length && a.every((entry, index) => entry.key === b[index]!.key && entry.included === b[index]!.included);

/** Where a version's plan came from (Q3): `default`, the client's profile at a version, or `edited` for a one-off. */
export type ReportSectionPlanOrigin = "default" | "edited" | `profile:${number}`;

/**
 * The origin a plan carries, by what it equals — so a house style reads as the profile's even when re-chosen by hand, and a
 * one-off reads as edited. Precedence (Q3): default ← the client's active profile ← the version's own plan.
 */
export function reportSectionPlanOrigin(plan: ReportSectionPlan, profile: { version: number; sectionPlan: ReportSectionPlan } | null): ReportSectionPlanOrigin {
  if (profile && samePlan(plan, profile.sectionPlan)) return `profile:${profile.version}`;
  if (samePlan(plan, defaultReportSectionPlan)) return "default";
  return "edited";
}

/** The plan a version starts with at validate (Q3): the one asked for, else the client's active profile, else the default. */
export function resolveReportSectionPlan(
  requested: ReportSectionPlan | null | undefined,
  profile: { version: number; sectionPlan: ReportSectionPlan } | null,
): { plan: ReportSectionPlan; origin: ReportSectionPlanOrigin } {
  const plan = requested ?? profile?.sectionPlan ?? defaultReportSectionPlan;
  return { plan, origin: reportSectionPlanOrigin(plan, profile) };
}

/**
 * The data sections a plan leaves out at the issuer's choice, by title — stated on the Methodology page, so an exclusion is
 * never silent. The narrative is not counted: until it is drawn it is not left out, it is not yet there.
 */
export function reportOmittedSections(plan: ReportSectionPlan): string[] {
  return plan.filter((entry) => !entry.included && isReportDataSection(entry.key)).map((entry) => reportPlanSectionTitle(entry.key));
}

/** The cover and the methodology hold their places (Q1), as does the reference block after it (B2-3); every other data section may move. */
export const isMovableReportSection = (key: ReportPlanSectionKey): boolean =>
  (isReportDataSection(key) && key !== "cover" && key !== "methodology" && !isReportReferenceSection(key)) || isReportStandaloneNarrativeSection(key);

/**
 * F-1b: move one data section a step earlier or later among the movable data sections — what the editors' up/down buttons
 * do. The narrative stays where it is (it is not drawn yet, Q6), the cover and the methodology never move, and a move past
 * the end is no move. Returns a new plan; the input is untouched.
 */
export function moveReportSection(plan: ReportSectionPlan, key: ReportPlanSectionKey, direction: "earlier" | "later"): ReportSectionPlan {
  if (!isMovableReportSection(key)) return plan;
  const movable = plan.map((entry, index) => ({ entry, index })).filter(({ entry }) => isMovableReportSection(entry.key));
  const at = movable.findIndex(({ entry }) => entry.key === key);
  const other = movable[direction === "earlier" ? at - 1 : at + 1];
  if (at < 0 || !other) return plan;
  const next = [...plan];
  [next[movable[at]!.index], next[other.index]] = [next[other.index]!, next[movable[at]!.index]!];
  return next;
}

/** A data section a plan may leave out (Q1): every one but the cover, the executive summary, the emissions and the methodology. */
export const isOptionalReportSection = (key: ReportPlanSectionKey): boolean =>
  (isReportDataSection(key) && !reportMandatorySections.includes(key)) || isReportStandaloneNarrativeSection(key);

/**
 * F-4b: include or leave out one optional data section — what the editors' switch does. A mandatory section, a narrative
 * section (not drawn yet, Q6) or any change while exclusion is unavailable is no change; the validator refuses the same.
 * Returns a new plan; the input is untouched.
 */
export function setReportSectionIncluded(
  plan: ReportSectionPlan, key: ReportPlanSectionKey, included: boolean, options: { allowExclusion?: boolean } = {},
): ReportSectionPlan {
  if (!(options.allowExclusion ?? REPORT_SECTION_EXCLUSION_AVAILABLE) || !isOptionalReportSection(key)) return plan;
  return plan.map((entry) => (entry.key === key ? { ...entry, included } : entry));
}

/**
 * The client's issuer line ("Prepared for the Board of …"): words, never money (NZC-120) — no currency symbol or code beside
 * a figure. Trimmed, and short enough to sit on a cover.
 */
export const REPORT_ISSUER_LINE_MAX = 160;
/**
 * NZC-120's money check, shared: a currency symbol, or a currency code beside a figure. The issuer line and the report narrative
 * (B2-4) refuse what it matches — words that name an amount never reach a client page.
 */
export const isMoneyShaped = (text: string): boolean =>
  /[£$€¥₹]|\b(GBP|USD|EUR|AED|CHF|JPY|AUD|CAD|NZD|SAR|INR)\s?\d|\d\s?(GBP|USD|EUR|AED|CHF|JPY|AUD|CAD|NZD|SAR|INR)\b/i.test(text);
export function reportIssuerLineIssues(line: unknown): ReportSectionPlanIssue[] {
  if (line === null || line === undefined) return [];
  if (typeof line !== "string" || !line.trim()) return [{ field: "issuerLine", code: "INVALID", message: "An issuer line is words, or none at all." }];
  if (line !== line.trim()) return [{ field: "issuerLine", code: "INVALID", message: "An issuer line has no leading or trailing spaces." }];
  if (line.length > REPORT_ISSUER_LINE_MAX) return [{ field: "issuerLine", code: "TOO_LONG", message: `An issuer line is at most ${REPORT_ISSUER_LINE_MAX} characters.` }];
  if (isMoneyShaped(line)) {
    return [{ field: "issuerLine", code: "MONEY_SHAPED", message: "An issuer line names who the report is for, never an amount." }];
  }
  return [];
}

/** The client's report profile (R-D1): a default plan and an optional issuer line, versioned; withdrawal is a version too. */
export type ClientReportProfile = {
  clientId: string; version: number; active: boolean;
  sectionPlan: ReportSectionPlan | null; issuerLine: string | null;
  reason: string | null; setBy: string; setAt: string;
};

/**
 * Where each section lands: its printed number and its page.
 *
 * Numbering follows the plan rather than being written into the view. A section renders when the plan includes it and the
 * composition has it (`present`: the Sites section exists only where a site breakdown was frozen). The cover is page 1 and
 * carries no number; every section after it is numbered 01, 02, … in plan order, one page each, so a section that is not
 * there never leaves a hole in the numbering.
 */
export function reportSectionLayout(
  plan: ReportSectionPlan,
  present: (key: ReportPlanSectionKey) => boolean,
): Array<{ key: ReportPlanSectionKey; number: string | null; page: number }> {
  const shown = plan.filter((entry) => entry.included && present(entry.key));
  let numbered = 0;
  return shown.map((entry, index) => ({
    key: entry.key,
    number: entry.key === "cover" ? null : String(++numbered).padStart(2, "0"),
    page: index + 1,
  }));
}

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
  /** The emissions this report covers: the whole client's, or — under a site scope — only those attributable to its sites. */
  totalTco2e: number;
  byScope: Array<{ scope: string; tco2e: number }>;
  /** Whole-client only; under a site scope the comparison carries the history and this is null. */
  priorYear: { year: number; totalTco2e: number } | null;
  provenance: ReportProvenance;
  /**
   * S-2 (R-S1 (A′)): the frozen rows by site, for the Sites section and its per-site subsections. At whole-client scope it
   * ends with an "Unallocated / organisation-level" entry (siteId null) inside the total; under a site scope it holds only the
   * selected sites. Absent on compositions frozen before S-2.
   */
  sites?: ReportSiteEmissions[];
  /**
   * S-2, sub-ruling 1: under a site scope, the organisation-level emissions this view excludes — **never apportioned**, never
   * in the site total, stated prominently. Absent at whole-client scope (where unallocated is a line in `sites`).
   */
  unallocated?: { tco2e: number; statement: string };
  /** S-2, sub-ruling 4: year-on-year for this scope, its columns following the assured periods that exist. */
  comparison?: ReportEmissionsComparison;
  /** S-2, sub-ruling 4: a reporting period covered by more than one job's snapshot — flagged, never summed or silently picked. */
  periodConflicts?: Array<{ period: string; jobNumbers: string[] }>;
};

export type ReportSiteEmissions = {
  /** null: the "Unallocated / organisation-level" line (whole-client scope only). */
  siteId: string | null;
  label: string;
  totalTco2e: number;
  byScope: Array<{ scope: string; tco2e: number }>;
  /** The site's rows by activity, largest first. */
  activities: Array<{ label: string; scope: string; tco2e: number }>;
  /** Floor-area intensity for the site when floor area resolves for it; otherwise a stated gap. Sites only. */
  floorAreaIntensity?: { value: number | null; unit: string; floorAreaM2: number | null; reason: string | null };
  /** composed@5 (ACCEPT-composed5-checkpoint3): the site's first day in service, from the client's site record. null: before records. */
  inServiceFrom?: string | null;
  /** composed@5: the site's floor area for the reporting period (m²), whether or not a floor-area measure is reported. null: not recorded. */
  floorAreaM2?: number | null;
};

/**
 * A comparison column. D3 (R5): the grain is baseline + up to four prior periods + current — the most recent prior is `previous`
 * as before; an older one is `earlier-<year>`. A composition frozen before D3 carries at most baseline, previous and current.
 */
export type ReportComparisonColumn = { key: "baseline" | "previous" | "current" | `earlier-${number}`; year: number; label: string };
export type ReportEmissionsComparison = {
  columns: ReportComparisonColumn[];
  /** Per scope, a value per column — null where that period cannot be attributed to this scope's sites (said in `notes`). */
  rows: Array<{ scope: "1" | "2" | "3"; values: Array<number | null> }>;
  totals: Array<number | null>;
  /** % change of the current period against the baseline column, when both are known. */
  changeVsBaselinePct: number | null;
  notes: string[];
  /**
   * composed@5 (ACCEPT-composed5-checkpoint3): each current site's own figure per column (the organisation-level line as
   * `siteId: null`), from the same frozen periods — null where the site has no row in a period, or the period was frozen
   * before its rows carried a site. Absent on compositions frozen before composed@5.
   */
  sites?: Array<{ siteId: string | null; values: Array<number | null> }>;
  /**
   * composed@5 (ACCEPT-composed5-checkpoint4): each current GHG category's own figure per column, by its code ("3.1") — null
   * where the category has no row in a period, or the period's rows carry no code. Absent before composed@5.
   */
  categories?: Array<{ scope: string; scopeCode: string; values: Array<number | null> }>;
};

/** The scope a composition was issued at (S-2): the whole client, or named sites. Absent on compositions frozen before S-2 = whole. */
export type ReportCompositionScope = { kind: "whole" } | { kind: "sites"; siteIds: string[]; siteLabels: string[] };

/**
 * Which sections a scope recomposes (S-2): emissions and intensity are **site** kind — filtered to the selection; the
 * targets, the plan and SRS readiness are **client** kind — the client's own records, shown whole regardless of scope.
 */
export const reportSectionScopeKind = {
  "executive-summary": "site", emissions: "site", intensity: "site", sites: "site",
  targets: "client", plan: "client", srs: "client",
} as const;

/** The flag a site-kind section carries under a site scope, and the one every client-kind section carries. */
export function reportScopeFlag(scope: ReportCompositionScope | undefined, kind: "site" | "client"): string | null {
  if (kind === "client") return scope && scope.kind === "sites" ? "Client-level — shown for the whole client regardless of site scope" : null;
  return scope && scope.kind === "sites" ? `Recomposed for: ${scope.siteLabels.join(", ")}` : null;
}

export type ReportIntensitySection = {
  metrics: Array<{
    key: string; label: string; iconKey: string; unit: string;
    value: number | null;
    /** Set only when `value` is null — the honest reason, not a dash. */
    unavailableReason: string | null;
    /**
     * RF-1 (RULING-reporting-RF): the metric the CRP reports — the one the review froze. Absent on compositions frozen
     * before RF-1, which render as they always have.
     */
    reported?: boolean;
    /** RF-1: what the intensity is per, as a reader sees it ("£12,500,000", "431 employees"). Frozen as composed, so a report issued before
     * the plural keeps "431 employee". Absent before RF-1. */
    denominatorText?: string | null;
    /**
     * S-2: under a site scope, a measure that has no per-site value (turnover, employees, a custom measure) is not divided
     * by the sites' emissions — it says so here ("Reported at whole-client level only"), never apportioned.
     */
    scopeNote?: string | null;
  }>;
  /**
   * RF-1: the key of the metric the CRP reports, read from the reviewed snapshot (3c-3's adapter, frozen at review) —
   * null when the snapshot carries none or predates 3c-3; absent on compositions frozen before RF-1.
   */
  reportedMetricKey?: string | null;
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
  /** Frozen: a report issued before A1 may say `planned`. */
  status: FrozenStrategyStatus;
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
export type ReportSrsRoadmapStrategy = { title: string; status: FrozenStrategyStatus; statusLabel: string };

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
  /** S-2: the scope this report was issued at — its version's. Absent on compositions frozen before S-2 (= whole client). */
  scope?: ReportCompositionScope;
  /**
   * Who issued it, frozen at validation (D3, ruled Q2): the organisation's display and short name, its footer and its
   * logo as they stood then. A composition frozen before D3 has none; its report version's backfilled columns stand in.
   */
  issuer?: ReportIssuer;
  /**
   * F-0: the layout this composition was issued under (`reportRenderers`), stamped at freeze. Absent on compositions frozen
   * before F-0, which were issued under `composed@1`.
   */
  renderer?: string;
  /**
   * F-1: the sections this report shows, in order, as its version held them at publish — frozen here, so the plan is part
   * of what was issued. Absent on compositions frozen before F-1, which show the default.
   */
  sectionPlan?: ReportSectionPlan;
  /** F-1 (R-D1): the client's issuer line from its report profile, frozen at validation. Absent when there was none. */
  issuerLine?: string;
  /** F-2: the charts' input, frozen with the report (`composed@2`). Absent on compositions issued before F-2 (`composed@1`). */
  chartBasis?: ReportChartBasis;
  /**
   * B1 (`composed@3`): what the figures rest on, named once — the snapshot stamp's datasets labelled by id at compose and
   * frozen, so a later relabel cannot redraw an issued report. Absent before `composed@3`, and on a snapshot with no stamp.
   */
  sources?: ReportSources;
  /** B1 (`composed@3`): the audit appendix — every row the report's figures sum, with its factor and source. Absent before. */
  audit?: ReportAuditAppendix;
  /**
   * B2-3 (`composed@4`, RULING-report-B2-3): the reporting period, from the snapshot stamp's own — the cover's metacard row.
   * Absent when the stamp has none: the row is then left out, never guessed.
   */
  reportingPeriod?: { from: string; to: string };
  /**
   * B2-3 (`composed@4`, call 2): the client's signee chosen at validate (a contact's name and job title, already on the
   * version) — the sign-off box's client side, with blank signature and date lines. The firm's side is the frozen issuer.
   * Absent when the version named none, and on a draft.
   */
  signee?: { name: string; jobTitle: string | null };
  /**
   * composed@5 (BUILD-report-studio-composed5): the client's logo — the asset the report version froze at validate (an append-
   * only asset, so the issued report keeps it). Absent when the client had none: the cover then shows no logo, never a stand-in.
   */
  clientLogoAssetId?: string;
  /**
   * composed@5 (ACCEPT-composed5-checkpoint2, decision 1): the client record's industry (its sector) and location, for
   * Background & Organisation. Absent when the record has neither; a missing one reads "Not recorded", never guessed.
   */
  organisation?: { industry: string | null; location: string | null };
  /**
   * B2-4 (`composed@6`; RULING-report-studio-B2-4): the narrative this report says — frozen at validate onto the version (0169),
   * the job's working sections (a draft). One element per narrative the report draws, in catalogue order; its body holds token
   * keys (`<span data-token="…">`), never a typed figure, resolved at draw from this composition. Present exactly when the
   * renderer is `composed@6` (`reportRendererFor`); a composition without it is `composed@5` and draws the template.
   */
  narrative?: ReportNarrativeElement[];
};

/** One frozen narrative section: its catalogue key, its body (token keys, no typed figures), where it came from, its version. */
export type ReportNarrativeElement = { key: string; bodyHtml: string; contentSource: "default" | "ai" | "client-edited"; sectionVersion: number };

export type ReportIssuer = { displayName: string; shortName: string; footer: string; logoAssetId: string | null };

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
  // `include_in_report` and the status are read HERE, at issue, and frozen with everything else. A later toggle
  // cannot reach back into a report the client already holds. Only what is marked for the report AND agreed or
  // beyond composes (A1, R5): a proposal, a declined action or one on hold is not presented as the client's plan.
  const included = live.filter(strategyIsReportable);
  const excludedCount = live.length - included.length;

  if (included.length === 0) {
    return {
      state: "unavailable",
      reason: live.length === 0
        ? "No reduction strategies were on this client's plan when the report was issued."
        : `None of this client's ${live.length} reduction strategies were both agreed and marked for inclusion when the report was issued.`,
    };
  }

  // `planned` keeps its name because issued reports carry it; on the live ladder it counts what is agreed and not
  // yet started — the same meaning it always had.
  const summary = { total: included.length, planned: 0, inProgress: 0, complete: 0 };
  for (const strategy of included) {
    if (strategy.status === "agreed") summary.planned += 1;
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
export function reportHeadline(emissions: ReportEmissionsSection | ReportSectionGap, reportingYear: number, scope?: ReportCompositionScope): string {
  if (isReportGap(emissions)) return "No assured emissions figure was available when this report was issued.";
  const total = emissions.totalTco2e.toLocaleString("en-GB", { maximumFractionDigits: 0 });
  // S-2: a site view's history is its comparison (its own sites, period by period), never the whole client's prior year.
  if (scope?.kind === "sites" && emissions.comparison) {
    const lead = `FY${reportingYear} assured emissions for ${scope.siteLabels.join(", ")}: ${total} tCO₂e`;
    const columns = emissions.comparison.columns, totals = emissions.comparison.totals;
    const earlier = columns.length - 2;
    if (earlier < 0) return `${lead}. This is the first assured period, so there is no earlier period to compare against.`;
    const before = totals[earlier];
    if (before === null || before === undefined) return `${lead}. FY${columns[earlier]!.year} cannot be attributed to these sites, so no movement is stated.`;
    if (before === 0) return `${lead}.`;
    const movement = ((emissions.totalTco2e - before) / before) * 100;
    return `${lead}, ${movement < 0 ? "down" : "up"} ${Math.abs(movement).toFixed(1)}% against FY${columns[earlier]!.year}.`;
  }
  if (emissions.priorYear === null) {
    return `FY${reportingYear} assured emissions: ${total} tCO₂e. This is the first assured year, so there is no prior year to compare against.`;
  }
  if (emissions.priorYear.totalTco2e === 0) return `FY${reportingYear} assured emissions: ${total} tCO₂e.`;
  const change = ((emissions.totalTco2e - emissions.priorYear.totalTco2e) / emissions.priorYear.totalTco2e) * 100;
  const direction = change < 0 ? "down" : "up";
  return `FY${reportingYear} assured emissions: ${total} tCO₂e, ${direction} ${Math.abs(change).toFixed(1)}% against FY${emissions.priorYear.year}.`;
}

/**
 * Everything a reader needs to judge the report, gathered for the Methodology page.
 *
 * Built from what the sections actually carry rather than written once by hand, so a page
 * claiming "DEFRA 2024" cannot outlive the factor set the figures were built on.
 */
export function reportMethodologyRows(composition: ReportComposition, options: {
  /** `composed@3`: the frozen source summary, in place of the per-row factor strings. */
  factorSet?: string;
  /** `composed@3` preview: what stands where an issued report states its issue date. */
  issued?: string;
} = {}): Array<{ label: string; value: string }> {
  const factorSets = new Set<string>();
  const tiers = new Map<string, number>();
  for (const section of [composition.emissions, composition.intensity, composition.targets]) {
    if (isReportGap(section)) continue;
    for (const set of section.provenance.factorSets) factorSets.add(set);
    for (const { tier, count } of section.provenance.qualityTiers) tiers.set(tier, (tiers.get(tier) ?? 0) + count);
  }
  const rows = [
    { label: "Standard", value: "GHG Protocol · UK SRS S2 aligned" },
    { label: "Factor set", value: options.factorSet ?? (factorSets.size > 0 ? [...factorSets].join(" · ") : "Not recorded") },
    {
      label: "Data quality",
      value: tiers.size > 0
        ? [...tiers.entries()].map(([tier, count]) => `${tier} ${count}`).join(" · ")
        : "Not recorded",
    },
    // The one row that must never be softened.
    { label: "Assurance basis", value: composition.assurance.statement },
    { label: "Reviewed by", value: composition.assurance.reviewedBy },
    { label: "Issued", value: options.issued ?? composition.issuedAt.slice(0, 10) },
    { label: "Evidence hash", value: composition.snapshotDataHash },
  ];
  // F-4b (ruled): the client's copy carries no reviewer (`clientFacingComposition` blanks it at the read), and the line goes
  // with it — no name, and no organisation in its place; the assurance basis above stands alone. A staff copy always has one.
  return rows.filter((row) => !(row.label === "Reviewed by" && row.value === ""));
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
 * `plan` must be the strategies **this report froze** — `strategyIsReportable`: active, `include_in_report` and
 * agreed or beyond — the same population the plan section shows. Passing the live plan would make a report's
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
