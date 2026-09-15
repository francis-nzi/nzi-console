import {
  composeSrsRoadmap, evidenceCoverage, maturityLabel, overallReadiness, pillarReadiness,
  type ReportSrsRoadmap,
} from "@nzi/contracts";
import { listClientStrategies } from "./reductionStrategies";
import { getSrsFramework, listSrsAssessments } from "./srsReadinessRecords";
import type { Queryable } from "./postgres";

/**
 * The client portal's view of their own UK SRS readiness — READ-ONLY, and **live**.
 *
 * The live twin of the report's frozen readiness section, exactly as the portal plan is the
 * live twin of the report's frozen plan. The report quotes readiness as at the moment it was
 * issued, because a client holds a document; the portal shows where they stand now, because
 * readiness is an ongoing assessment and not a measurement. `report_compositions` is
 * deliberately not read here.
 *
 * **Only a completed assessment is shown.** A draft is a consultant part-way through
 * scoring: its levels are provisional, and putting them in front of the client would present
 * working-out as a finding. A client whose assessment is still open sees that it is in
 * progress, which is true, rather than a partial score, which is not.
 *
 * **Nothing internal crosses.** The assessment's own `notes`, and each item's `owner`,
 * `dueDate`, `evidence` and `linkedActionId`, are consultant working records. None of them
 * are projected — same discipline as `owner` and `notes` on the portal plan, and applied by
 * building the payload field by field rather than by omitting fields from a spread.
 *
 * Tenancy: `clientId` comes from the verified portal session, never from the request. The
 * caller wraps this in `withTenantRead(pool, organisationId, …)`.
 */

export type PortalReadinessPillar = {
  key: string;
  label: string;
  /** The level reached, and the framework's expectation of it. */
  level: number;
  levelLabel: string;
  targetLevel: number;
};

export type PortalReadinessReadModel =
  | {
    state: "none";
    /** Why there is nothing to show, in the client's terms. Never a zero score. */
    reason: string;
  }
  | {
    state: "assessed";
    assessedOn: string;
    frameworkLabel: string;
    frameworkVersion: number;
    overallPct: number;
    overallLabel: string;
    /** The top of the ladder — what the levels below are out of. */
    maxLevel: number;
    pillars: PortalReadinessPillar[];
    /** Axis labels, per-standard series and the target ring, for `SrsPillarRadar`. */
    radar: {
      pillars: string[];
      series: Array<{ key: "S1" | "S2"; label: string; values: number[] }>;
      target: number[];
    };
    /** Requirements below target, worst first, grouped by pillar, each with what addresses it. */
    roadmap: ReportSrsRoadmap;
    /** How many requirements have been evidenced, out of how many. */
    evidenced: { count: number; total: number };
  };

export async function getPortalClientReadiness(
  db: Queryable,
  input: { clientId: string },
): Promise<PortalReadinessReadModel> {
  const [framework, assessments, plan] = await Promise.all([
    getSrsFramework(db),
    listSrsAssessments(db, input.clientId),
    listClientStrategies(db, input.clientId),
  ]);

  if (!framework) {
    return { state: "none", reason: "No readiness framework is published yet, so there is nothing to assess against." };
  }
  const assessment = assessments.find((entry) => entry.status === "complete") ?? null;
  if (!assessment) {
    return {
      state: "none",
      reason: assessments.length > 0
        ? "Your readiness assessment is in progress. It appears here once your NZI consultant has completed it."
        : "Your readiness assessment has not started yet. Your NZI consultant will work through it with you.",
    };
  }

  const overall = overallReadiness(framework, assessment.items);
  const pillars = pillarReadiness(framework, assessment.items);
  const coverage = evidenceCoverage(framework, assessment.items);
  // The climate-led standard is painted over the top, as the staff radar and the report's
  // draw it — one picture of the same assessment, whoever is looking at it.
  const climate = framework.standards.find((standard) => standard.climateLed) ?? framework.standards[0] ?? null;
  const other = climate ? framework.standards.find((standard) => standard.key !== climate.key) ?? null : null;

  return {
    state: "assessed",
    assessedOn: assessment.assessedOn.slice(0, 10),
    frameworkLabel: framework.label,
    frameworkVersion: assessment.frameworkVersion,
    overallPct: overall.percent,
    overallLabel: maturityLabel(framework, overall.levelIndex),
    maxLevel: Math.max(1, framework.maturityLevels.length - 1),
    pillars: pillars.map((pillar) => ({
      key: pillar.pillarKey,
      label: pillar.label,
      level: pillar.overall.level,
      levelLabel: maturityLabel(framework, pillar.overall.levelIndex),
      targetLevel: pillar.targetLevel,
    })),
    radar: {
      pillars: pillars.map((pillar) => shortPillar(pillar.label)),
      series: climate === null ? [] : [climate, ...(other ? [other] : [])].map((standard) => ({
        key: (standard.key === climate.key ? "S2" : "S1") as "S1" | "S2",
        label: standard.label.replace(/^UK SRS \w+ — /, ""),
        values: pillars.map((pillar) => pillar.byStandard[standard.key]?.level ?? 0),
      })),
      target: pillars.map((pillar) => pillar.targetLevel),
    },
    // The same builder the report uses, given the LIVE plan rather than a frozen one. One
    // ordering and one reverse mapping, so the client's document and their portal cannot
    // disagree about which gap matters most or what is aimed at it. `strategiesBySrsRequirement`
    // inside it already excludes withdrawn strategies.
    roadmap: composeSrsRoadmap(framework, assessment.items, plan.filter((strategy) => strategy.includeInReport)),
    evidenced: { count: coverage.evidenced, total: coverage.total },
  };
}

/** Axis labels have to fit the radar; the full pillar name stays in the table beside it. */
const shortPillar = (label: string) => label.length <= 11 ? label
  : label.replace(/\bmanagement\b/i, "mgmt").replace(/\s*&\s*targets$/i, "").slice(0, 12).trim();
