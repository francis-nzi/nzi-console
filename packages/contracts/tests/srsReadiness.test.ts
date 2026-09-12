import test from "node:test";
import assert from "node:assert/strict";
import {
  benchmark, evidenceCoverage, gaps, maturityLabel, overallReadiness, pillarReadiness,
  prefillFromNzi, readinessTrend, rollup, standardReadiness,
  type SrsAssessment, type SrsAssessmentItem, type SrsFramework, type SrsMaturity, type SrsNziFacts,
} from "../src/srsReadiness";

/**
 * The readiness resolver. Every surface reads these, so the rules they encode are the
 * rules the dashboard, the register, the portal and the report all obey.
 */

const level = (n: number, key: string, label: string) => ({ level: n as SrsMaturity, key, label, definition: `${label} definition` });
const requirement = (id: string, standardKey: string, pillarKey: string, over: Partial<SrsFramework["requirements"][number]> = {}) => ({
  id, standardKey, pillarKey, code: id.toUpperCase(), title: `Requirement ${id}`, helpText: "",
  weight: 1, source: "entered" as const, nziSourceKey: null, targetMaturity: 2 as SrsMaturity,
  ordering: 1, active: true, ...over,
});

const framework: SrsFramework = {
  frameworkId: "uk-srs-2026", version: 1, label: "UK SRS S1 & S2 (2026)", status: "active",
  effectiveFrom: "2026-02-25", notes: null,
  standards: [
    { key: "S2", label: "UK SRS S2 — Climate", description: "", climateLed: true, ordering: 1 },
    { key: "S1", label: "UK SRS S1 — General", description: "", climateLed: false, ordering: 2 },
  ],
  pillars: [
    { key: "governance", label: "Governance", description: "", ordering: 1 },
    { key: "metrics", label: "Metrics & targets", description: "", ordering: 2 },
  ],
  maturityLevels: [
    level(0, "not-started", "Not started"), level(1, "developing", "Developing"), level(2, "established", "Established"),
    level(3, "advanced", "Advanced"), level(4, "assured", "Assured"),
  ],
  requirements: [
    requirement("g1", "S2", "governance"),
    requirement("g2", "S2", "governance", { weight: 2 }),
    requirement("m1", "S2", "metrics", { source: "nzi-data", nziSourceKey: "footprint.scope1", targetMaturity: 3 }),
    requirement("m2", "S2", "metrics", { source: "nzi-data", nziSourceKey: "targets.model", targetMaturity: 3 }),
    requirement("s1g1", "S1", "governance"),
    requirement("retired", "S2", "governance", { active: false }),
  ],
};

const item = (requirementId: string, maturity: SrsMaturity | null, over: Partial<SrsAssessmentItem> = {}): SrsAssessmentItem => ({
  requirementId, maturity, source: "entered", evidence: null, owner: "", dueDate: null, linkedActionId: null, version: 1, ...over,
});

test("readiness is weighted, and an unanswered requirement is not readiness", () => {
  // g2 carries twice the weight of g1, so answering only g2 at the top is worth more.
  const onlyLight = rollup(framework.requirements.filter((r) => r.pillarKey === "governance" && r.standardKey === "S2" && r.active), [item("g1", 4)]);
  const onlyHeavy = rollup(framework.requirements.filter((r) => r.pillarKey === "governance" && r.standardKey === "S2" && r.active), [item("g2", 4)]);
  assert.ok(onlyHeavy.percent > onlyLight.percent, "the heavier requirement moves the score further");
  // What has not been looked at still counts against the total: readiness is not an average of what suits.
  assert.equal(onlyLight.assessed, 1);
  assert.ok(onlyLight.percent < 100);
});

test("an inactive requirement is out of the framework entirely", () => {
  const all = overallReadiness(framework, framework.requirements.map((r) => item(r.id, 4)));
  assert.equal(all.total, 5, "the retired requirement is not counted");
  assert.equal(all.percent, 100);
});

test("rolls up per pillar and per standard, and the climate standard stands on its own", () => {
  const items = [item("g1", 4), item("g2", 4), item("m1", 0), item("m2", 0), item("s1g1", 0)];
  const pillars = pillarReadiness(framework, items);
  const governance = pillars.find((p) => p.pillarKey === "governance")!;
  assert.equal(governance.byStandard.S2!.percent, 100);
  assert.equal(governance.byStandard.S1!.percent, 0, "S1 is rolled up separately from S2");
  const standards = standardReadiness(framework, items);
  assert.equal(standards[0]!.standard.key, "S2", "the climate standard leads");
});

test("the pillar target is the highest expectation in it", () => {
  const metrics = pillarReadiness(framework, []).find((p) => p.pillarKey === "metrics")!;
  assert.equal(metrics.targetLevel, 3);
});

test("a level is reported with a label, never a bare number", () => {
  assert.equal(maturityLabel(framework, 0), "Not started");
  assert.equal(maturityLabel(framework, 2.4), "Established");
  assert.equal(maturityLabel(framework, 3.6), "Assured");
});

test("a requirement below its target is a gap, worst first", () => {
  const found = gaps(framework, [item("g1", 2), item("m1", 0), item("m2", 3)]);
  const ids = found.map((gap) => gap.requirement.id);
  assert.ok(!ids.includes("g1"), "at target is not a gap");
  assert.ok(!ids.includes("m2"), "above target is not a gap");
  assert.equal(ids[0], "m1", "the biggest shortfall leads the roadmap");
  assert.equal(found.find((gap) => gap.requirement.id === "m1")!.shortfall, 3);
  // Never assessed is a gap too — silence is not readiness.
  assert.ok(ids.includes("g2"));
  assert.equal(found.find((gap) => gap.requirement.id === "g2")!.maturity, null);
});

test("evidence coverage counts what can actually be shown", () => {
  const coverage = evidenceCoverage(framework, [
    item("g1", 3, { evidence: { kind: "document", ref: "ToR extract", note: "" } }),
    item("g2", 3),
  ]);
  assert.equal(coverage.evidenced, 1);
  assert.equal(coverage.total, 5);
  assert.equal(coverage.byPillar.find((pillar) => pillar.pillarKey === "governance")!.evidenced, 1);
});

test("the benchmark stays a Future state until a real source names it", () => {
  const empty = benchmark({ sectorKey: null, benchmarkPercentile: null, benchmarkSource: null });
  assert.equal(empty.state, "future");
  if (empty.state === "future") assert.match(empty.reason, /no invented comparisons/);
  // Only a percentile that names where it came from resolves.
  assert.equal(benchmark({ sectorKey: "manufacturing", benchmarkPercentile: 62, benchmarkSource: null }).state, "future");
  assert.equal(benchmark({ sectorKey: "manufacturing", benchmarkPercentile: 62, benchmarkSource: "ONS 2026" }).state, "resolved");
});

test("pre-fill answers only what the client's record actually shows", () => {
  const facts: SrsNziFacts = {
    assuredYears: 2, scopesReported: { scope1: true, scope2: true, scope3: false },
    provenanceStamped: true, provenanceVerified: true, targetsSet: true, targetProgressMeasured: true,
    intensityBasesResolved: 2, independentlyAssured: false,
  };
  const filled = prefillFromNzi(framework, facts);
  const scope1 = filled.find((entry) => entry.requirementId === "m1");
  assert.ok(scope1, "Scope 1 is answered from the assured footprint");
  assert.equal(scope1!.maturity, 3);
  assert.equal(scope1!.evidence?.kind, "data");
  assert.match(scope1!.evidence!.note, /2 assured reporting years/);
  assert.ok(filled.find((entry) => entry.requirementId === "m2"), "targets are answered from the target model");
  // Nothing is claimed for a requirement the record does not answer.
  assert.ok(!filled.some((entry) => entry.requirementId === "g1"));
});

test("pre-fill claims nothing when the record is empty, and never claims assurance", () => {
  const none: SrsNziFacts = {
    assuredYears: 0, scopesReported: { scope1: false, scope2: false, scope3: false },
    provenanceStamped: false, provenanceVerified: false, targetsSet: false, targetProgressMeasured: false,
    intensityBasesResolved: 0, independentlyAssured: false,
  };
  assert.deepEqual(prefillFromNzi(framework, none), []);
  // A backfilled stamp is worth less than an issued one — it is context, not verification.
  const migrated = prefillFromNzi(framework, {
    assuredYears: 1, scopesReported: { scope1: true, scope2: false, scope3: false },
    provenanceStamped: true, provenanceVerified: false, targetsSet: false, targetProgressMeasured: false,
    intensityBasesResolved: 0, independentlyAssured: false,
  });
  assert.equal(migrated.find((entry) => entry.requirementId === "m1")!.maturity, 2);
});

test("the trend reads oldest first, across reassessments", () => {
  const assessment = (id: string, on: string, items: SrsAssessmentItem[]): SrsAssessment => ({
    assessmentId: id, clientId: "c", frameworkId: "uk-srs-2026", frameworkVersion: 1, status: "complete",
    assessedOn: on, assessedBy: "a", completedAt: `${on}T00:00:00Z`, notes: "", version: 1,
    sectorKey: null, benchmarkPercentile: null, benchmarkSource: null, items,
  });
  const trend = readinessTrend(framework, [
    assessment("b", "2026-09-01", framework.requirements.map((r) => item(r.id, 4))),
    assessment("a", "2025-09-01", [item("g1", 1)]),
  ]);
  assert.deepEqual(trend.map((point) => point.assessmentId), ["a", "b"]);
  assert.ok(trend[1]!.value > trend[0]!.value, "readiness improves across the two");
});
