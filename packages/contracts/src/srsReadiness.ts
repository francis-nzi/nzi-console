/**
 * UK SRS readiness — the model and the one resolver every surface reads.
 *
 * The framework (standards, pillars, requirements, weights, the maturity ladder) is
 * reference data, versioned as a whole and published by an administrator. An assessment
 * is a dated record for one client that stamps the framework version it used, so an old
 * assessment keeps meaning what it meant when the framework moves.
 *
 * Everything here is pure: the backend supplies the rows, this decides what they add up
 * to. The dashboard, the register, the portal and (later) the report all read these same
 * functions, so they cannot disagree about how ready a client is.
 */

export const srsMaturityLevels = 5;
export type SrsMaturity = 0 | 1 | 2 | 3 | 4;
export type SrsStandardKey = string;
export type SrsPillarKey = string;

export type SrsMaturityLevel = { level: SrsMaturity; key: string; label: string; definition: string };
export type SrsStandard = { key: SrsStandardKey; label: string; description: string; climateLed: boolean; ordering: number };
export type SrsPillar = { key: SrsPillarKey; label: string; description: string; ordering: number };
export type SrsRequirement = {
  id: string;
  standardKey: SrsStandardKey;
  pillarKey: SrsPillarKey;
  code: string;
  title: string;
  helpText: string;
  weight: number;
  /** `nzi-data` requirements are answered from the client's own assured record, not re-asked. */
  source: "entered" | "nzi-data";
  nziSourceKey: string | null;
  targetMaturity: SrsMaturity;
  ordering: number;
  active: boolean;
};
export type SrsFramework = {
  frameworkId: string;
  version: number;
  label: string;
  status: "draft" | "active" | "superseded";
  effectiveFrom: string | null;
  notes: string | null;
  standards: SrsStandard[];
  pillars: SrsPillar[];
  maturityLevels: SrsMaturityLevel[];
  requirements: SrsRequirement[];
};

export type SrsEvidence = { kind: "document" | "data" | "note"; ref: string | null; note: string } | null;
export type SrsAssessmentItem = {
  requirementId: string;
  /** null = not yet assessed. Distinct from 0 ("Not started"), which is an answer. */
  maturity: SrsMaturity | null;
  source: "entered" | "auto";
  evidence: SrsEvidence;
  owner: string;
  dueDate: string | null;
  linkedActionId: string | null;
  version: number;
};
export type SrsAssessment = {
  assessmentId: string;
  clientId: string;
  frameworkId: string;
  /** Stamped at creation: what this assessment was measured against. */
  frameworkVersion: number;
  status: "draft" | "complete";
  assessedOn: string;
  assessedBy: string;
  completedAt: string | null;
  notes: string;
  version: number;
  /** Future slots — null until a defensible peer dataset exists. Never invented. */
  sectorKey: string | null;
  benchmarkPercentile: number | null;
  benchmarkSource: string | null;
  items: SrsAssessmentItem[];
};

/**
 * The order a person works through the framework: the climate standard first, then the
 * general one, each by pillar and then by the framework's own ordering. Alphabetical would
 * put S1 ahead of S2, which is backwards — S2 is the one that leads.
 *
 * One ordering, used by the register, the guided assessment and the heatmap alike, so
 * "the next requirement" means the same thing everywhere.
 */
export function orderedRequirements(framework: SrsFramework): SrsRequirement[] {
  const standardRank = new Map(framework.standards.map((standard) => [standard.key, standard.ordering]));
  const pillarRank = new Map(framework.pillars.map((pillar) => [pillar.key, pillar.ordering]));
  return framework.requirements.filter((requirement) => requirement.active).sort((a, b) =>
    (standardRank.get(a.standardKey) ?? 99) - (standardRank.get(b.standardKey) ?? 99)
    || (pillarRank.get(a.pillarKey) ?? 99) - (pillarRank.get(b.pillarKey) ?? 99)
    || a.ordering - b.ordering
    || a.id.localeCompare(b.id));
}

/* ── Rolling up ─────────────────────────────────────────────────────────────────────── */

/**
 * A weighted score over a set of requirements, as a fraction of the top of the ladder.
 * Unanswered requirements count as nothing achieved but still carry their weight — a
 * readiness score that ignored what has not been looked at would flatter the client.
 */
export type SrsRollup = {
  /** 0–100. */
  percent: number;
  /** The average maturity those requirements sit at, 0–4, for the ladder graphics. */
  level: number;
  /** The nearest whole rung, for a label. */
  levelIndex: SrsMaturity;
  assessed: number;
  total: number;
  evidenced: number;
  /** Requirements below their own target. */
  gaps: number;
  weight: number;
};

const clampMaturity = (value: number): SrsMaturity => Math.max(0, Math.min(4, Math.round(value))) as SrsMaturity;

export function rollup(requirements: readonly SrsRequirement[], items: readonly SrsAssessmentItem[]): SrsRollup {
  const byRequirement = new Map(items.map((item) => [item.requirementId, item]));
  let achieved = 0, weight = 0, assessed = 0, evidenced = 0, gaps = 0, levelSum = 0;
  for (const requirement of requirements) {
    if (!requirement.active) continue;
    const item = byRequirement.get(requirement.id);
    weight += requirement.weight;
    const maturity = item?.maturity ?? null;
    if (maturity !== null) {
      assessed += 1;
      achieved += requirement.weight * (maturity / (srsMaturityLevels - 1));
      levelSum += maturity * requirement.weight;
      if (maturity < requirement.targetMaturity) gaps += 1;
    } else {
      // Not looked at yet is not the same as nothing in place, but it is not readiness.
      gaps += requirement.targetMaturity > 0 ? 1 : 0;
    }
    if (item?.evidence) evidenced += 1;
  }
  const percent = weight === 0 ? 0 : (achieved / weight) * 100;
  const level = weight === 0 ? 0 : levelSum / weight;
  return {
    percent: Math.round(percent * 10) / 10,
    level: Math.round(level * 100) / 100,
    levelIndex: clampMaturity(level),
    assessed, total: requirements.filter((requirement) => requirement.active).length,
    evidenced, gaps, weight,
  };
}

export type SrsPillarReadiness = {
  pillarKey: SrsPillarKey;
  label: string;
  byStandard: Record<SrsStandardKey, SrsRollup>;
  /** The target the graphics draw: the heaviest expectation across this pillar's requirements. */
  targetLevel: SrsMaturity;
  overall: SrsRollup;
};

export function pillarReadiness(framework: SrsFramework, items: readonly SrsAssessmentItem[]): SrsPillarReadiness[] {
  return [...framework.pillars].sort((a, b) => a.ordering - b.ordering).map((pillar) => {
    const inPillar = framework.requirements.filter((requirement) => requirement.pillarKey === pillar.key && requirement.active);
    const byStandard: Record<string, SrsRollup> = {};
    for (const standard of framework.standards) {
      byStandard[standard.key] = rollup(inPillar.filter((requirement) => requirement.standardKey === standard.key), items);
    }
    const targets = inPillar.map((requirement) => requirement.targetMaturity);
    return {
      pillarKey: pillar.key, label: pillar.label, byStandard,
      targetLevel: targets.length ? clampMaturity(Math.max(...targets)) : 2,
      overall: rollup(inPillar, items),
    };
  });
}

export function standardReadiness(framework: SrsFramework, items: readonly SrsAssessmentItem[]): Array<{ standard: SrsStandard; rollup: SrsRollup }> {
  return [...framework.standards].sort((a, b) => a.ordering - b.ordering).map((standard) => ({
    standard,
    rollup: rollup(framework.requirements.filter((requirement) => requirement.standardKey === standard.key), items),
  }));
}

export function overallReadiness(framework: SrsFramework, items: readonly SrsAssessmentItem[]): SrsRollup {
  return rollup(framework.requirements, items);
}

/** The label for a rolled-up level — a number and a level, never a bare percentage. */
export function maturityLabel(framework: SrsFramework, level: number): string {
  const index = clampMaturity(level);
  return framework.maturityLevels.find((entry) => entry.level === index)?.label ?? "Not started";
}

/* ── Gaps ───────────────────────────────────────────────────────────────────────────── */

/**
 * A requirement below what the framework expects of it. Every gap is something to do, so
 * each one carries the owner and date from the assessment and the action it is linked to
 * once the action-lever library holds one.
 */
export type SrsGap = {
  requirement: SrsRequirement;
  maturity: SrsMaturity | null;
  targetMaturity: SrsMaturity;
  /** How many rungs short: what the roadmap orders by. */
  shortfall: number;
  owner: string;
  dueDate: string | null;
  linkedActionId: string | null;
  evidenced: boolean;
};

export function gaps(framework: SrsFramework, items: readonly SrsAssessmentItem[]): SrsGap[] {
  const byRequirement = new Map(items.map((item) => [item.requirementId, item]));
  const result: SrsGap[] = [];
  for (const requirement of framework.requirements) {
    if (!requirement.active) continue;
    const item = byRequirement.get(requirement.id);
    const maturity = item?.maturity ?? null;
    const achieved = maturity ?? 0;
    if (maturity !== null && maturity >= requirement.targetMaturity) continue;
    if (maturity === null && requirement.targetMaturity === 0) continue;
    result.push({
      requirement, maturity, targetMaturity: requirement.targetMaturity,
      shortfall: requirement.targetMaturity - achieved,
      owner: item?.owner ?? "", dueDate: item?.dueDate ?? null,
      linkedActionId: item?.linkedActionId ?? null, evidenced: Boolean(item?.evidence),
    });
  }
  // Worst first, then by the framework's own order so the roadmap is stable.
  return result.sort((a, b) => b.shortfall - a.shortfall
    || a.requirement.standardKey.localeCompare(b.requirement.standardKey)
    || a.requirement.ordering - b.requirement.ordering);
}

/* ── Evidence ───────────────────────────────────────────────────────────────────────── */

export type SrsEvidenceCoverage = { evidenced: number; total: number; percent: number; byPillar: Array<{ pillarKey: string; label: string; evidenced: number; total: number }> };

export function evidenceCoverage(framework: SrsFramework, items: readonly SrsAssessmentItem[]): SrsEvidenceCoverage {
  const byRequirement = new Map(items.map((item) => [item.requirementId, item]));
  const active = framework.requirements.filter((requirement) => requirement.active);
  const evidenced = active.filter((requirement) => Boolean(byRequirement.get(requirement.id)?.evidence)).length;
  return {
    evidenced, total: active.length,
    percent: active.length === 0 ? 0 : Math.round((evidenced / active.length) * 100),
    byPillar: [...framework.pillars].sort((a, b) => a.ordering - b.ordering).map((pillar) => {
      const inPillar = active.filter((requirement) => requirement.pillarKey === pillar.key);
      return {
        pillarKey: pillar.key, label: pillar.label,
        evidenced: inPillar.filter((requirement) => Boolean(byRequirement.get(requirement.id)?.evidence)).length,
        total: inPillar.length,
      };
    }),
  };
}

/* ── The benchmark slot ─────────────────────────────────────────────────────────────── */

/**
 * Sector and peer comparison is structural today and empty on purpose. It reports
 * `state: "future"` until an assessment carries a percentile from a named source — there
 * is no defensible peer dataset yet, and an invented comparison would be worse than none.
 */
export type SrsBenchmark =
  | { state: "future"; reason: string }
  | { state: "resolved"; sectorKey: string; percentile: number; source: string };

export function benchmark(assessment: Pick<SrsAssessment, "sectorKey" | "benchmarkPercentile" | "benchmarkSource">): SrsBenchmark {
  if (assessment.benchmarkPercentile === null || assessment.benchmarkSource === null || assessment.sectorKey === null) {
    return { state: "future", reason: "Sector and peer benchmarking is built into the model (sector tagging and a percentile slot) and will populate once a defensible peer dataset is available — no invented comparisons." };
  }
  return { state: "resolved", sectorKey: assessment.sectorKey, percentile: assessment.benchmarkPercentile, source: assessment.benchmarkSource };
}

/* ── Pre-filling from the client's own NZI record ───────────────────────────────────── */

/**
 * What NZI already holds for this client, as facts rather than opinions. The backend
 * resolves these from the assured snapshots, the target model and the intensity metrics;
 * this decides what they are worth against a requirement.
 */
export type SrsNziFacts = {
  /** Reviewed reporting years on record — the measured position. */
  assuredYears: number;
  scopesReported: { scope1: boolean; scope2: boolean; scope3: boolean };
  /** Whether the latest assured figure carries a factor-set provenance stamp. */
  provenanceStamped: boolean;
  /** Whether the latest snapshot's stamp was issued rather than backfilled. */
  provenanceVerified: boolean;
  targetsSet: boolean;
  targetProgressMeasured: boolean;
  intensityBasesResolved: number;
  /** Third-party assurance of the inventory, if the platform knows of any. */
  independentlyAssured: boolean;
};

export type SrsPrefill = {
  requirementId: string;
  maturity: SrsMaturity;
  evidence: SrsEvidence;
  /** Why this answer was suggested — shown to the consultant, who can override it. */
  because: string;
};

/**
 * Suggest answers for the requirements the client's own record already answers. This
 * never invents readiness: each suggestion names the record it came from, and a fact the
 * platform does not hold produces no suggestion at all rather than a hopeful one.
 *
 * Suggestions are exactly that — the consultant confirms or overrides, and an item saved
 * this way is marked `source: "auto"` so the register shows where the answer came from.
 */
export function prefillFromNzi(framework: SrsFramework, facts: SrsNziFacts): SrsPrefill[] {
  const out: SrsPrefill[] = [];
  const dataEvidence = (note: string): SrsEvidence => ({ kind: "data", ref: null, note });
  const scopeMaturity = (reported: boolean): SrsMaturity | null => {
    if (!reported || facts.assuredYears === 0) return null;
    if (facts.independentlyAssured) return 4;
    // Reviewed and stamped is a disclosure that would stand up; unstamped is a step back.
    return facts.provenanceStamped && facts.provenanceVerified ? 3 : 2;
  };
  const add = (requirementId: string, maturity: SrsMaturity | null, note: string, because: string) => {
    if (maturity === null) return;
    const requirement = framework.requirements.find((entry) => entry.id === requirementId && entry.active);
    if (!requirement) return;
    out.push({ requirementId, maturity, evidence: dataEvidence(note), because });
  };

  for (const requirement of framework.requirements) {
    if (requirement.source !== "nzi-data" || !requirement.active) continue;
    const years = `${facts.assuredYears} assured reporting year${facts.assuredYears === 1 ? "" : "s"}`;
    switch (requirement.nziSourceKey) {
      case "footprint.scope1":
        add(requirement.id, scopeMaturity(facts.scopesReported.scope1), `Scope 1 resolved from the client's reviewed snapshot · ${years}`, "The assured footprint already reports Scope 1.");
        break;
      case "footprint.scope2":
        add(requirement.id, scopeMaturity(facts.scopesReported.scope2), `Scope 2 resolved from the client's reviewed snapshot · ${years}`, "The assured footprint already reports Scope 2.");
        break;
      case "footprint.scope3":
        add(requirement.id, scopeMaturity(facts.scopesReported.scope3), `Scope 3 resolved from the client's reviewed snapshot · ${years}`, "The assured footprint already reports Scope 3 by category.");
        break;
      case "footprint.method":
        add(requirement.id, facts.assuredYears > 0 ? 3 : null, "GHG Protocol basis and boundary recorded on the job's emissions configuration", "The measurement approach is recorded with the snapshot.");
        break;
      case "footprint.provenance":
        add(requirement.id, facts.provenanceStamped ? (facts.provenanceVerified ? 3 : 2) : null,
          facts.provenanceVerified ? "Factor set, version and as-at date stamped on the issued snapshot" : "Factor-set stamp present but backfilled (migrated, unverified)",
          "The snapshot carries its factor-set provenance.");
        break;
      case "targets.model":
        add(requirement.id, facts.targetsSet ? 3 : null, "Targets held in the client's forward target model, versioned and audited", "Forward targets are set against the baseline in force.");
        break;
      case "targets.gap":
        add(requirement.id, facts.targetProgressMeasured ? 3 : null, "Progress measured against the target line by the gap engine", "Progress against target is already computed from assured years.");
        break;
      case "intensity.metrics":
        add(requirement.id, facts.intensityBasesResolved > 0 ? (facts.intensityBasesResolved > 1 ? 3 : 2) : null,
          `${facts.intensityBasesResolved} intensity bas${facts.intensityBasesResolved === 1 ? "is" : "es"} resolved from the client's own denominators`,
          "Intensity is already computed on the client's recorded denominators.");
        break;
      case "footprint.assurance":
        // The platform records who reviewed a snapshot, not whether a third party assured
        // it. Saying nothing is right: claiming assurance we cannot see would be a lie.
        if (facts.independentlyAssured) add(requirement.id, 4, "Independent assurance recorded against the inventory", "The inventory is recorded as independently assured.");
        break;
      default:
        break;
    }
  }
  return out;
}

/* ── Trend ──────────────────────────────────────────────────────────────────────────── */

/** Overall readiness across reassessments, oldest first — the renewal story. */
export function readinessTrend(framework: SrsFramework, assessments: readonly SrsAssessment[]): Array<{ assessmentId: string; label: string; value: number }> {
  return [...assessments]
    .sort((a, b) => a.assessedOn.localeCompare(b.assessedOn))
    .map((assessment) => ({
      assessmentId: assessment.assessmentId,
      label: assessment.assessedOn.slice(0, 7),
      value: overallReadiness(framework, assessment.items).percent,
    }));
}
