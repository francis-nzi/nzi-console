import {
  benchmark as resolveBenchmark, isAssessed, orderedRequirements, overallReadiness, pillarReadiness, rollup, srsCompletion,
  type SrsAssessment, type SrsBenchmark, type SrsEvidence, type SrsFramework, type SrsMaturity,
} from "./srsReadiness";

/**
 * The readiness dashboard's view model (SRS S2) — one read of S1's assessment model that the CRM dashboard and the client
 * portal both render, so the dials, the radar and the heatmap are the same pictures of the same numbers wherever they
 * appear. It **reads** S1's weighted rollups (`rollup`, `pillarReadiness`, `overallReadiness`) and recomputes nothing
 * differently; it writes nothing.
 *
 * **One scale.** Every number here is on the 0–4 ladder. A rolled-up level is fractional (2.6); the step it names is the
 * step **reached** — the floor — so 2.6 reads "Established", never rounded up to a step the client has not yet reached.
 *
 * **In progress vs assessed (R11).** A draft can be modelled — the CRM draws its provisional scores, marked — and carries
 * its completion (`n of m addressed`) and no assessed date. The portal builds from `latestAssessed` only (S1), so a client
 * never sees a provisional score.
 */

export type SrsLadderStep = { level: SrsMaturity; name: string; definition: string };

/** The step reached by a rolled-up level: the floor, clamped to the ladder. */
export const srsStepReached = (level: number): SrsMaturity => Math.max(0, Math.min(4, Math.floor(Number.isFinite(level) ? level + 1e-9 : 0))) as SrsMaturity;

export type SrsDashboardPillar = {
  key: string;
  label: string;
  /** Weighted mean maturity, 0–4, two decimals (S1's rollup). */
  level: number;
  step: SrsMaturity;
  stepName: string;
  /** What the framework expects of the pillar — its heaviest requirement target. */
  targetLevel: SrsMaturity;
  /** Change since the previous completed assessment, in ladder steps; null with nothing earlier to compare. */
  delta: number | null;
  assessed: number;
  total: number;
};

export type SrsRequirementHistoryPoint = { assessedOn: string; maturity: SrsMaturity | null; stepName: string | null };

export type SrsDashboardRequirement = {
  id: string;
  code: string;
  title: string;
  helpText: string;
  pillarKey: string;
  pillarLabel: string;
  standardKey: string;
  maturity: SrsMaturity | null;
  stepName: string | null;
  target: SrsMaturity;
  /** Below its own target — a gap (unanswered counts, as S1's rollup counts it). */
  gap: boolean;
  /** `auto`: read from the client's own assured NZI data (S1 R4) — its evidence carries the record it came from. */
  source: "entered" | "auto" | null;
  evidence: SrsEvidence;
  /** The position at each completed assessment, oldest first — the requirement's own history. */
  history: SrsRequirementHistoryPoint[];
  /** Staff-only working fields. Absent from the portal's model (NZC-110). */
  owner?: string;
  dueDate?: string | null;
  linkedActionId?: string | null;
};

export type SrsTrendPoint = { assessmentId: string; assessedOn: string; level: number };

export type SrsDashboardModel = {
  frameworkLabel: string;
  frameworkVersion: number;
  ladder: SrsLadderStep[];
  standards: Array<{ key: string; label: string; climateLed: boolean }>;
  /** The standard the view is filtered to, or null for both. */
  standardKey: string | null;
  assessment: {
    id: string;
    /** A draft's scores are provisional — drawn marked, never as a verdict. */
    provisional: boolean;
    startedOn: string;
    /** Only a completed assessment has one (S1 R3). */
    assessedOn: string | null;
    addressed: number;
    total: number;
  };
  overall: { level: number; step: SrsMaturity; stepName: string; percent: number; delta: number | null };
  pillars: SrsDashboardPillar[];
  requirements: SrsDashboardRequirement[];
  /** Completed assessments only, oldest first (R5) — a single assessment is a single point, never a slope. */
  trend: { overall: SrsTrendPoint[]; byPillar: Record<string, SrsTrendPoint[]> };
  benchmark: SrsBenchmark;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Build the dashboard model for one assessment (completed, or the draft in progress) among a client's assessments.
 * `standardKey` filters every rollup to one standard; null reads both, as S1's overall does.
 *
 * `frameworks` (S3, from the S2 review): the framework versions the client's assessments were made against, by id. Given
 * them, every assessment — the one shown, the previous one a delta compares with, and each trend point — is read against
 * **its own stamped version**, so publishing a new framework never restates what an earlier assessment measured. Without
 * them, the framework in force is used throughout (every assessment on one version, as before).
 */
export function srsDashboard(inForce: SrsFramework, assessment: SrsAssessment, assessments: readonly SrsAssessment[], options: { standardKey?: string | null; frameworks?: ReadonlyMap<string, SrsFramework> } = {}): SrsDashboardModel {
  const own = (entry: SrsAssessment) => options.frameworks?.get(entry.frameworkId) ?? inForce;
  const framework = own(assessment);
  const standardKey = options.standardKey && framework.standards.some((standard) => standard.key === options.standardKey) ? options.standardKey : null;
  const scopeOf = (version: SrsFramework): SrsFramework => standardKey ? { ...version, requirements: version.requirements.filter((requirement) => requirement.standardKey === standardKey) } : version;
  const scoped = scopeOf(framework);
  const stepName = (step: SrsMaturity) => framework.maturityLevels.find((entry) => entry.level === step)?.label ?? `Step ${step}`;

  // The completed assessments that are not this one and came before it — what a delta compares against.
  const completed = assessments.filter(isAssessed).sort((a, b) => a.assessedOn.localeCompare(b.assessedOn) || a.assessmentId.localeCompare(b.assessmentId));
  // A draft has no delta (R11): its unanswered requirements count against its rollup, so a half-worked reassessment
  // would read as a decline — a verdict on working-out. Change is shown once it is complete and dated.
  const previous = !isAssessed(assessment) ? null : [...completed].reverse().find((entry) => entry.assessmentId !== assessment.assessmentId
    && (entry.assessedOn < assessment.assessedOn! || (entry.assessedOn === assessment.assessedOn && entry.assessmentId < assessment.assessmentId))) ?? null;

  const overallNow = overallReadiness(scoped, assessment.items);
  const overallBefore = previous ? overallReadiness(scopeOf(own(previous)), previous.items) : null;
  const pillarsNow = pillarReadiness(scoped, assessment.items);
  const pillarsBefore = previous ? new Map(pillarReadiness(scopeOf(own(previous)), previous.items).map((pillar) => [pillar.pillarKey, pillar.overall.level])) : null;
  const completion = srsCompletion(scoped, assessment.items);
  const pillarLabels = new Map(framework.pillars.map((pillar) => [pillar.key, pillar.label]));
  const items = new Map(assessment.items.map((item) => [item.requirementId, item]));
  const history = completed.map((entry) => ({ assessedOn: entry.assessedOn, items: new Map(entry.items.map((item) => [item.requirementId, item.maturity])) }));

  return {
    frameworkLabel: framework.label,
    frameworkVersion: assessment.frameworkVersion,
    ladder: [...framework.maturityLevels].sort((a, b) => a.level - b.level).map((entry) => ({ level: entry.level, name: entry.label, definition: entry.definition })),
    standards: [...framework.standards].sort((a, b) => a.ordering - b.ordering).map((standard) => ({ key: standard.key, label: standard.label, climateLed: standard.climateLed })),
    standardKey,
    assessment: {
      id: assessment.assessmentId, provisional: assessment.status !== "complete", startedOn: assessment.startedOn,
      assessedOn: isAssessed(assessment) ? assessment.assessedOn : null, addressed: completion.addressed, total: completion.total,
    },
    overall: {
      level: overallNow.level, step: srsStepReached(overallNow.level), stepName: stepName(srsStepReached(overallNow.level)), percent: overallNow.percent,
      delta: overallBefore ? round2(overallNow.level - overallBefore.level) : null,
    },
    pillars: pillarsNow.filter((pillar) => pillar.overall.total > 0).map((pillar) => ({
      key: pillar.pillarKey, label: pillar.label, level: pillar.overall.level, step: srsStepReached(pillar.overall.level),
      stepName: stepName(srsStepReached(pillar.overall.level)), targetLevel: pillar.targetLevel,
      delta: pillarsBefore?.has(pillar.pillarKey) ? round2(pillar.overall.level - pillarsBefore.get(pillar.pillarKey)!) : null,
      assessed: pillar.overall.assessed, total: pillar.overall.total,
    })),
    requirements: orderedRequirements(scoped).map((requirement) => {
      const item = items.get(requirement.id) ?? null;
      const maturity = item?.maturity ?? null;
      return {
        id: requirement.id, code: requirement.code, title: requirement.title, helpText: requirement.helpText,
        pillarKey: requirement.pillarKey, pillarLabel: pillarLabels.get(requirement.pillarKey) ?? requirement.pillarKey, standardKey: requirement.standardKey,
        maturity, stepName: maturity === null ? null : stepName(maturity), target: requirement.targetMaturity,
        gap: maturity === null ? requirement.targetMaturity > 0 : maturity < requirement.targetMaturity,
        source: item?.source ?? null, evidence: item?.evidence ?? null,
        history: history.map((point) => {
          const value = point.items.get(requirement.id) ?? null;
          return { assessedOn: point.assessedOn, maturity: value, stepName: value === null ? null : stepName(value) };
        }),
        owner: item?.owner ?? "", dueDate: item?.dueDate ?? null, linkedActionId: item?.linkedActionId ?? null,
      };
    }),
    trend: {
      overall: completed.map((entry) => ({ assessmentId: entry.assessmentId, assessedOn: entry.assessedOn, level: overallReadiness(scopeOf(own(entry)), entry.items).level })),
      byPillar: Object.fromEntries(scoped.pillars.map((pillar) => [pillar.key, completed.map((entry) => ({
        assessmentId: entry.assessmentId, assessedOn: entry.assessedOn,
        level: rollup(scopeOf(own(entry)).requirements.filter((requirement) => requirement.pillarKey === pillar.key), entry.items).level,
      }))])),
    },
    benchmark: resolveBenchmark(assessment),
  };
}

/**
 * The client's model (R9): built from the latest **completed** assessment only, with the staff working fields — owner,
 * due date, the action link — left out field by field (NZC-110: the client sees scores and evidence, never staff identity
 * or internal working). Null when nothing is completed yet: the portal says so rather than showing a provisional score.
 */
export function srsPortalDashboard(framework: SrsFramework, assessments: readonly SrsAssessment[], options: { standardKey?: string | null; frameworks?: ReadonlyMap<string, SrsFramework> } = {}): SrsDashboardModel | null {
  const latest = [...assessments].filter(isAssessed).sort((a, b) => b.assessedOn.localeCompare(a.assessedOn) || b.assessmentId.localeCompare(a.assessmentId))[0];
  if (!latest) return null;
  const model = srsDashboard(framework, latest, assessments, options);
  return {
    ...model,
    requirements: model.requirements.map(({ owner: _owner, dueDate: _due, linkedActionId: _link, ...client }) => ({
      ...client,
      // The S2 review's ruling: evidence crosses as its kind and reference only. The free-text note is a consultant's
      // working record ("client slow to engage") and stays one — blanked here, before the model leaves the contract,
      // unless and until a note carries an explicit client-safe flag.
      evidence: client.evidence === null ? null : { kind: client.evidence.kind, ref: client.evidence.ref, note: "" },
    })),
  };
}
