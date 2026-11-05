import { comparePriority, requirementsByPillar, rollup, type SrsAssessmentItem, type SrsGap, type SrsFramework, type SrsMaturity, type SrsPillar, type SrsRequirement } from "@nzi/contracts";

/**
 * The guided assessment's logic, apart from its screen: the order the questions come in, where a reopened wizard lands,
 * what a pillar's header says, and when the assessment may be completed. Pure, so the rules are tested without a browser.
 */

export type WizardStep = { requirement: SrsRequirement; pillar: SrsPillar; indexInPillar: number; pillarSize: number };

/** One question per step, the framework's own ordering cut into pillars (Governance, Strategy, Risk management, Metrics & targets). */
export function wizardSteps(framework: SrsFramework): WizardStep[] {
  return requirementsByPillar(framework).flatMap(({ pillar, requirements }) =>
    requirements.map((requirement, indexInPillar) => ({ requirement, pillar, indexInPillar, pillarSize: requirements.length })));
}

/** The maturity answered for each requirement. A requirement with no entry — or a null one — is not addressed (not a zero). */
export type MaturityMap = ReadonlyMap<string, SrsMaturity | null>;

export const maturityMap = (items: readonly SrsAssessmentItem[]): Map<string, SrsMaturity | null> =>
  new Map(items.map((item) => [item.requirementId, item.maturity]));

const addressed = (maturities: MaturityMap, requirementId: string) => (maturities.get(requirementId) ?? null) !== null;

/** Where a reopened wizard lands: the first requirement not yet addressed, else the first question. */
export function resumeIndex(steps: readonly WizardStep[], maturities: MaturityMap): number {
  const index = steps.findIndex((step) => !addressed(maturities, step.requirement.id));
  return index === -1 ? 0 : index;
}

export const addressedCount = (steps: readonly WizardStep[], maturities: MaturityMap): number =>
  steps.filter((step) => addressed(maturities, step.requirement.id)).length;

/** Complete is offered only when every active requirement has a maturity — the server enforces the same count. */
export const canComplete = (steps: readonly WizardStep[], maturities: MaturityMap): boolean =>
  steps.length > 0 && addressedCount(steps, maturities) === steps.length;

/** Stepping from `from` to `to` crosses into a new pillar — the moment for the brief section divider. */
export const entersNewPillar = (steps: readonly WizardStep[], from: number, to: number): boolean =>
  steps[to] !== undefined && steps[from] !== undefined && steps[to]!.pillar.key !== steps[from]!.pillar.key;

/**
 * The Path-to-SRS-ready order: by the consultant's priority (high → medium → low → unset), and within a priority the existing
 * order — the biggest shortfall first — is kept. `gaps()` already returns that shortfall order, and the sort is stable.
 */
export function gapsByPriority(gaps: readonly SrsGap[], items: readonly SrsAssessmentItem[]): SrsGap[] {
  const priority = new Map(items.map((item) => [item.requirementId, item.priority]));
  return gaps.map((gap, position) => ({ gap, position }))
    .sort((a, b) => comparePriority(priority.get(a.gap.requirement.id), priority.get(b.gap.requirement.id)) || a.position - b.position)
    .map((entry) => entry.gap);
}

/** A pillar's rollup for its header: "Maturing · avg 2.3 · 6/6 addressed". Nothing answered says so rather than showing 0.0. */
export function pillarSummary(framework: SrsFramework, pillarKey: string, items: readonly SrsAssessmentItem[], standardKey: string | null = null): { text: string; assessed: number; total: number } {
  const requirements = framework.requirements.filter((requirement) => requirement.active && requirement.pillarKey === pillarKey && (!standardKey || requirement.standardKey === standardKey));
  const { assessed, total, level, levelIndex } = rollup(requirements, items);
  if (assessed === 0) return { text: `Not yet assessed · 0/${total} addressed`, assessed, total };
  const step = framework.maturityLevels.find((entry) => entry.level === levelIndex)?.label ?? "";
  return { text: `${step} · avg ${level.toFixed(1)} · ${assessed}/${total} addressed`, assessed, total };
}
