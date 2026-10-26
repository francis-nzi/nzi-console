import test from "node:test";
import assert from "node:assert/strict";
import { srsDashboard, srsPortalDashboard, srsStepReached } from "../src/srsDashboard";
import { overallReadiness, pillarReadiness, type SrsAssessment, type SrsAssessmentItem, type SrsFramework, type SrsMaturity } from "../src/srsReadiness";

/**
 * The readiness dashboard's model (SRS S2). The CRM dashboard and the client portal both render it, so the rules here are
 * the rules both obey: the step shown is the step reached, deltas compare with the previous completed assessment, the
 * trend is completed assessments only, a draft is provisional and undated, and the portal's copy carries no staff fields.
 */

const level = (n: number, label: string) => ({ level: n as SrsMaturity, key: label.toLowerCase(), label, definition: `${label} definition` });
const requirement = (id: string, standardKey: string, pillarKey: string, over: Partial<SrsFramework["requirements"][number]> = {}) => ({
  id, standardKey, pillarKey, code: id.toUpperCase(), title: `Requirement ${id}`, helpText: `What ${id} asks`,
  weight: 1, source: "entered" as const, nziSourceKey: null, targetMaturity: 2 as SrsMaturity, ordering: 1, active: true, ...over,
});

const framework: SrsFramework = {
  frameworkId: "uk-srs-2026", version: 2, label: "UK SRS S1 & S2 (2026)", status: "active", effectiveFrom: "2026-02-25", notes: null,
  standards: [
    { key: "S2", label: "UK SRS S2 — Climate", description: "", climateLed: true, ordering: 1 },
    { key: "S1", label: "UK SRS S1 — General", description: "", climateLed: false, ordering: 2 },
  ],
  pillars: [
    { key: "governance", label: "Governance", description: "", ordering: 1 },
    { key: "metrics", label: "Metrics & targets", description: "", ordering: 2 },
  ],
  maturityLevels: [level(0, "Not started"), level(1, "Developing"), level(2, "Established"), level(3, "Advanced"), level(4, "Assured")],
  requirements: [
    requirement("g1", "S2", "governance"),
    requirement("g2", "S2", "governance", { weight: 2 }),
    requirement("m1", "S2", "metrics", { targetMaturity: 3 }),
    requirement("s1g1", "S1", "governance"),
  ],
};

const item = (requirementId: string, maturity: SrsMaturity | null, over: Partial<SrsAssessmentItem> = {}): SrsAssessmentItem => ({
  requirementId, maturity, source: "entered", evidence: null, owner: "", dueDate: null, linkedActionId: null, version: 1, ...over,
});
const assessment = (id: string, status: "draft" | "complete", assessedOn: string | null, items: SrsAssessmentItem[]): SrsAssessment => ({
  assessmentId: id, clientId: "c1", frameworkId: framework.frameworkId, frameworkVersion: 1, status,
  startedOn: assessedOn ?? "2026-09-01", assessedOn, assessedBy: "Ada", completedAt: assessedOn, notes: "", sectorKey: null,
  benchmarkPercentile: null, benchmarkSource: null, version: 1, items,
});

const working = { owner: "Ada Admin", dueDate: "2027-01-31", linkedActionId: "strategy-1", evidence: { kind: "document" as const, ref: "Board minutes", note: "Minuted" } };
const first = assessment("a1", "complete", "2026-03-01", [item("g1", 1), item("g2", 1), item("m1", 0), item("s1g1", 1)]);
const second = assessment("a2", "complete", "2026-06-01", [item("g1", 3, working), item("g2", 2), item("m1", 2), item("s1g1", 2)]);
const draft = assessment("a3", "draft", null, [item("g1", 4), item("g2", null)]);
const all = [draft, second, first];

test("the step shown is the step reached — the floor, never rounded up", () => {
  assert.deepEqual([0, 0.99, 1, 2.6, 3.999, 4, 5, -1].map(srsStepReached), [0, 0, 1, 2, 3, 4, 4, 0]);
  // Two-decimal rollups at a boundary (2.00 held as 1.9999…) still read as the step they equal.
  assert.equal(srsStepReached(2 - 1e-12), 2);
});

test("reads S1's weighted rollups rather than computing its own", () => {
  const model = srsDashboard(framework, second, all);
  assert.equal(model.overall.level, overallReadiness(framework, second.items).level);
  assert.equal(model.overall.percent, overallReadiness(framework, second.items).percent);
  const governance = pillarReadiness(framework, second.items).find((pillar) => pillar.pillarKey === "governance")!;
  assert.equal(model.pillars.find((pillar) => pillar.key === "governance")!.level, governance.overall.level);
  assert.equal(model.overall.stepName, framework.maturityLevels[model.overall.step]!.label);
});

test("deltas compare with the previous completed assessment; the first has none", () => {
  const latest = srsDashboard(framework, second, all);
  const before = overallReadiness(framework, first.items).level;
  assert.equal(latest.overall.delta, Math.round((latest.overall.level - before) * 100) / 100);
  assert.ok(latest.overall.delta! > 0);
  const earliest = srsDashboard(framework, first, all);
  assert.equal(earliest.overall.delta, null, "nothing earlier to compare — not a zero change");
  assert.ok(earliest.pillars.every((pillar) => pillar.delta === null));
  // A draft has none: half-answered, it would read as a decline — a verdict on working-out (R11).
  const provisional = srsDashboard(framework, draft, all);
  assert.equal(provisional.overall.delta, null);
  assert.ok(provisional.pillars.every((pillar) => pillar.delta === null));
});

test("a draft is provisional, counts what is addressed, and has no assessed date (R11)", () => {
  const model = srsDashboard(framework, draft, all);
  assert.deepEqual([model.assessment.provisional, model.assessment.assessedOn, model.assessment.addressed, model.assessment.total], [true, null, 1, 4]);
  assert.equal(srsDashboard(framework, second, all).assessment.provisional, false);
});

test("the trend is completed assessments only, oldest first — and one assessment is one point", () => {
  const model = srsDashboard(framework, draft, all);
  assert.deepEqual(model.trend.overall.map((point) => point.assessmentId), ["a1", "a2"], "the draft is not on it");
  assert.deepEqual(Object.keys(model.trend.byPillar).sort(), ["governance", "metrics"]);
  assert.equal(srsDashboard(framework, first, [first]).trend.overall.length, 1);
  assert.deepEqual(srsDashboard(framework, draft, [draft]).trend.overall, [], "nothing completed, nothing plotted");
});

test("a requirement carries its own history across completed assessments", () => {
  const g1 = srsDashboard(framework, second, all).requirements.find((entry) => entry.id === "g1")!;
  assert.deepEqual(g1.history.map((point) => [point.assessedOn, point.maturity, point.stepName]), [["2026-03-01", 1, "Developing"], ["2026-06-01", 3, "Advanced"]]);
  const g2 = srsDashboard(framework, draft, all).requirements.find((entry) => entry.id === "g2")!;
  assert.deepEqual([g2.maturity, g2.stepName, g2.gap], [null, null, true], "unanswered is not zero, and is still a gap");
});

test("filters every rollup to one standard", () => {
  const s1 = srsDashboard(framework, second, all, { standardKey: "S1" });
  assert.equal(s1.standardKey, "S1");
  assert.deepEqual(s1.requirements.map((entry) => entry.id), ["s1g1"]);
  assert.deepEqual(s1.pillars.map((pillar) => pillar.key), ["governance"], "a pillar with nothing in the standard is left out, not drawn at zero");
  assert.equal(srsDashboard(framework, second, all, { standardKey: "nope" }).standardKey, null, "an unknown standard reads both");
});

test("the portal reads the latest completed assessment, and none of the staff working fields (NZC-110)", () => {
  const portal = srsPortalDashboard(framework, all)!;
  assert.equal(portal.assessment.id, "a2", "never the draft");
  assert.equal(portal.assessment.provisional, false);
  for (const requirement of portal.requirements) {
    for (const field of ["owner", "dueDate", "linkedActionId"]) assert.ok(!(field in requirement), `${requirement.id} carries no ${field}`);
  }
  // R9: the client sees the evidence and the history on each question.
  const g1 = portal.requirements.find((entry) => entry.id === "g1")!;
  assert.equal(g1.evidence?.ref, "Board minutes");
  assert.equal(g1.history.length, 2);
  assert.ok(!JSON.stringify(portal).includes("Ada Admin"), "no staff identity anywhere in the payload");
  assert.equal(srsPortalDashboard(framework, [draft]), null, "nothing completed — the portal says so rather than showing a provisional score");
});
