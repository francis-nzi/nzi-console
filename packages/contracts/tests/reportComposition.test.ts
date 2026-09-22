import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REPORT_ASSURANCE_STATEMENT, composeReportPlan, isReportGap, reportAssurance,
  reportHeadline, reportMethodologyRows, reportSrsRadarChart, shortPillarLabel,
  composeSrsRoadmap,
  type ReportComposition, type ReportEmissionsSection, type ReportPlanStrategy, type ReportSrsSection,
} from "../src/reportComposition";
import type { SrsAssessmentItem, SrsFramework, SrsMaturity } from "../src/srsReadiness";
import { strategyControlLevelLabels, strategyControlLevels, type ClientStrategy } from "../src/reductionStrategies";

const action = (id: string, over: Partial<ClientStrategy> = {}): ClientStrategy => ({
  id, clientId: "client-a", leverIds: ["lever-energy"], srsRequirementIds: ["req-1"], includeInReport: true, strategyId: null, title: id, scope: "2", category: "Energy",
  controlLevel: "direct_control", iconKey: "energy", status: "planned", owner: "", targetDate: null,
  progressPct: 0, notes: "", active: true, version: 1, estimate: null, ...over,
});

const LEVERS = [{ id: "lever-energy", key: "energy", title: "Energy", iconKey: "energy", ordering: 1, active: true }];
const CODES = new Map([["req-1", "S2 M2"]]);

const emissions = (over: Partial<ReportEmissionsSection> = {}): ReportEmissionsSection => ({
  totalTco2e: 1706,
  byScope: [{ scope: "1", tco2e: 500 }, { scope: "2", tco2e: 206 }, { scope: "3", tco2e: 1000 }],
  priorYear: { year: 2023, totalTco2e: 1842 },
  provenance: { factorSets: ["DEFRA 2024 v1.2"], dataHash: "sha256:abc", asAt: "2025-03-31", qualityTiers: [{ tier: "measured", count: 12 }] },
  ...over,
});

describe("the report composition", () => {
  describe("assurance", () => {
    it("states the honest basis", () => {
      const basis = reportAssurance({ reviewedBy: "reviewer-a", reviewedAt: "2026-04-01T00:00:00Z" });
      assert.equal(basis.statement, REPORT_ASSURANCE_STATEMENT);
      assert.match(basis.statement, /not third-party assured/);
      assert.equal(basis.kind, "internal-review");
    });

    it("cannot express a third-party assurance claim", () => {
      // The platform records who REVIEWED a snapshot — not an assurer, a standard, or a
      // scope of assurance. A boolean here would be one careless `true` from a false
      // assurance claim on a client document, so the union has exactly one member and no
      // second variant may be added until those records actually exist.
      const basis = reportAssurance({ reviewedBy: "r", reviewedAt: "2026-04-01T00:00:00Z" });
      const kinds: Array<typeof basis.kind> = ["internal-review"];
      assert.deepEqual(kinds, ["internal-review"]);
      assert.ok(!("thirdPartyAssured" in basis), "no boolean to flip");
      assert.ok(!("assurer" in basis), "and nothing to name one in");
    });

    it("puts the basis on the methodology page unsoftened", () => {
      const composition = {
        issuedAt: "2026-04-01T00:00:00Z", snapshotDataHash: "sha256:abc",
        assurance: reportAssurance({ reviewedBy: "A. Reviewer", reviewedAt: "2026-04-01T00:00:00Z" }),
        emissions: emissions(), intensity: { state: "unavailable", reason: "none" },
        targets: { state: "unavailable", reason: "none" },
      } as unknown as ReportComposition;
      const rows = reportMethodologyRows(composition);
      const assurance = rows.find((row) => row.label === "Assurance basis");
      assert.equal(assurance?.value, REPORT_ASSURANCE_STATEMENT);
      // And the factor set comes from what the figures were actually built on, so a page
      // cannot outlive the data it describes.
      assert.equal(rows.find((row) => row.label === "Factor set")?.value, "DEFRA 2024 v1.2");
      assert.equal(rows.find((row) => row.label === "Data quality")?.value, "measured 12");
    });

    it("says a missing basis is missing rather than implying one", () => {
      const composition = {
        issuedAt: "2026-04-01T00:00:00Z", snapshotDataHash: "sha256:abc",
        assurance: reportAssurance({ reviewedBy: "A", reviewedAt: "2026-04-01T00:00:00Z" }),
        emissions: { state: "unavailable", reason: "none" },
        intensity: { state: "unavailable", reason: "none" },
        targets: { state: "unavailable", reason: "none" },
      } as unknown as ReportComposition;
      const rows = reportMethodologyRows(composition);
      assert.equal(rows.find((row) => row.label === "Factor set")?.value, "Not recorded");
    });
  });

  describe("the headline", () => {
    it("states the movement when there is a prior year", () => {
      assert.match(reportHeadline(emissions(), 2024), /1,706 tCO₂e, down 7\.4% against FY2023/);
    });

    it("says there is nothing to compare against in a first assured year", () => {
      // "Down 0%" against nothing is a claim, not a neutral default.
      const first = reportHeadline(emissions({ priorYear: null }), 2024);
      assert.match(first, /first assured year/);
      assert.doesNotMatch(first, /0%|down|up/);
    });

    it("reports an increase as an increase", () => {
      assert.match(reportHeadline(emissions({ priorYear: { year: 2023, totalTco2e: 1500 } }), 2024), /up 13\.7%/);
    });

    it("says so when there is no assured emissions figure at all", () => {
      const gap = reportHeadline({ state: "unavailable", reason: "none" }, 2024);
      assert.match(gap, /No assured emissions figure/);
      assert.doesNotMatch(gap, /0 tCO₂e/, "a gap is never rendered as zero");
    });
  });

  describe("the plan section", () => {
    it("freezes the plan as it stood, grouped by lever", () => {
      const section = composeReportPlan([action("a", { status: "in_progress", progressPct: 60 }), action("b")], LEVERS, CODES);
      assert.ok(!isReportGap(section));
      if (isReportGap(section)) return;
      assert.deepEqual(section.groups.map((group) => group.label), ["Energy"]);
      assert.equal(section.summary.total, 2);
      assert.equal(section.summary.inProgress, 1);
      // Said on the page: these percentages are progress, not carbon.
      assert.equal(section.qualitativeOnly, true);
    });

    it("carries each strategy's SRS alignment as a code, not an id", () => {
      // "S2 M2" means something to a reader; a generated id does not.
      const section = composeReportPlan([action("a")], LEVERS, CODES);
      assert.ok(!isReportGap(section));
      if (isReportGap(section)) return;
      assert.deepEqual(section.groups[0]!.strategies[0]!.srsRequirementCodes, ["S2 M2"]);
    });

    it("includes only the strategies marked for the report, and says how many it left out", () => {
      // A plan section showing one of a client's three strategies must not read as the
      // whole plan.
      const section = composeReportPlan(
        [action("in"), action("out-1", { includeInReport: false }), action("out-2", { includeInReport: false })],
        LEVERS, CODES);
      assert.ok(!isReportGap(section));
      if (isReportGap(section)) return;
      assert.equal(section.summary.total, 1);
      assert.equal(section.excludedCount, 2);
    });

    it("distinguishes an empty plan from one with nothing included", () => {
      // Two different facts that would otherwise read the same on the page.
      const empty = composeReportPlan([], LEVERS, CODES);
      assert.ok(isReportGap(empty));
      if (isReportGap(empty)) assert.match(empty.reason, /No reduction strategies were on this client's plan/);

      const noneIncluded = composeReportPlan([action("a", { includeInReport: false })], LEVERS, CODES);
      assert.ok(isReportGap(noneIncluded));
      if (isReportGap(noneIncluded)) assert.match(noneIncluded.reason, /None of this client's 1 reduction strategies were marked for inclusion/);
    });

    it("leaves out strategies already removed at issue, and keeps the rest frozen", () => {
      const section = composeReportPlan([action("a"), action("gone", { active: false })], LEVERS, CODES);
      assert.ok(!isReportGap(section));
      if (isReportGap(section)) return;
      assert.equal(section.summary.total, 1, "a strategy removed before issue was never in the report");
    });

    it("keeps a strategy whose lever was withdrawn rather than dropping it", () => {
      const section = composeReportPlan([action("orphan", { leverIds: ["gone"] })], LEVERS, CODES);
      assert.ok(!isReportGap(section));
      if (isReportGap(section)) return;
      assert.deepEqual(section.groups.map((group) => group.label), ["Other"]);
      assert.equal(section.summary.total, 1, "it is still in the report the client was sent");
    });
  });
});

describe("the readiness radar a report draws", () => {
  const srs = (over: Partial<ReportSrsSection> = {}): ReportSrsSection => ({
    frameworkVersion: 2, assessedOn: "2026-06-30", overallPct: 58, overallLabel: "Developing",
    pillars: [
      { label: "Governance", maturity: 3, maturityLabel: "Established" },
      { label: "Strategy", maturity: 2, maturityLabel: "Developing" },
      { label: "Risk management", maturity: 2, maturityLabel: "Developing" },
      { label: "Metrics & targets", maturity: 1, maturityLabel: "Emerging" },
    ],
    radar: {
      maxLevel: 4,
      series: [
        { key: "S2", label: "Climate", values: [3, 2, 2, 1] },
        { key: "S1", label: "General", values: [2, 1, 1, 1] },
      ],
      target: [3, 3, 3, 4],
    },
    ...over,
  });

  it("draws it from what the report froze, not from anything live", () => {
    const chart = reportSrsRadarChart(srs());
    assert.ok(chart);
    assert.deepEqual(chart.series.map((entry) => entry.key), ["S2", "S1"]);
    assert.deepEqual(chart.series[0]!.values, [3, 2, 2, 1]);
    assert.deepEqual(chart.target, [3, 3, 3, 4]);
    assert.equal(chart.maxLevel, 4);
    // One axis per frozen pillar, in the frozen order — the series index against it.
    assert.equal(chart.pillars.length, srs().pillars.length);
    assert.equal(chart.series[0]!.values.length, chart.pillars.length);
    assert.equal(chart.target.length, chart.pillars.length);
  });

  it("gives a composition frozen before the radar shipped no chart at all", () => {
    // An issued report is what it said at the time. Back-filling a graphic into one would
    // show the client a figure their document never contained.
    const { radar: _radar, ...withoutRadar } = srs();
    assert.equal(reportSrsRadarChart(withoutRadar), null);
  });

  it("draws nothing rather than an empty dial when there is nothing to plot", () => {
    assert.equal(reportSrsRadarChart(srs({ pillars: [] })), null);
    assert.equal(reportSrsRadarChart(srs({ radar: { maxLevel: 4, series: [], target: [] } })), null);
  });

  it("shortens only the axis labels that will not fit", () => {
    const chart = reportSrsRadarChart(srs());
    assert.ok(chart);
    assert.deepEqual(chart.pillars, ["Governance", "Strategy", "Risk mgmt", "Metrics"]);
    // The full names are untouched in the section the table renders from.
    assert.equal(srs().pillars[2]!.label, "Risk management");
  });

  it("leaves a label that already fits exactly as it is", () => {
    assert.equal(shortPillarLabel("Strategy"), "Strategy");
    assert.equal(shortPillarLabel("Governance"), "Governance");
  });
});

describe("the readiness roadmap a report freezes", () => {
  const level = (n: number, key: string, label: string) => ({ level: n as SrsMaturity, key, label, definition: "" });
  const requirement = (id: string, pillarKey: string, over: Partial<SrsFramework["requirements"][number]> = {}) => ({
    id, standardKey: "S2", pillarKey, code: id.toUpperCase(), title: `Requirement ${id}`, helpText: "",
    weight: 1, source: "entered" as const, nziSourceKey: null, targetMaturity: 3 as SrsMaturity,
    ordering: 1, active: true, ...over,
  });
  const framework: SrsFramework = {
    frameworkId: "uk-srs-2026", version: 1, label: "UK SRS", status: "active",
    effectiveFrom: "2026-02-25", notes: null,
    standards: [{ key: "S2", label: "UK SRS S2 — Climate", description: "", climateLed: true, ordering: 1 }],
    pillars: [
      { key: "governance", label: "Governance", description: "", ordering: 1 },
      { key: "metrics", label: "Metrics & targets", description: "", ordering: 2 },
    ],
    maturityLevels: [
      level(0, "not-started", "Not started"), level(1, "developing", "Developing"),
      level(2, "established", "Established"), level(3, "advanced", "Advanced"), level(4, "assured", "Assured"),
    ],
    requirements: [
      requirement("g1", "governance"),
      requirement("m1", "metrics"),
      requirement("m2", "metrics"),
    ],
  };
  const item = (requirementId: string, maturity: SrsMaturity | null): SrsAssessmentItem => ({
    requirementId, maturity, source: "entered", evidence: null, owner: "", dueDate: null, linkedActionId: null, version: 1,
  });

  it("orders by shortfall through gaps(), and groups by pillar", () => {
    // m1 is 3 short, g1 is 1 short, m2 is 2 short. Metrics leads because its worst gap is
    // the worst gap overall — the ordering is gaps()'s, read through the grouping.
    const roadmap = composeSrsRoadmap(framework, [item("g1", 2), item("m1", 0), item("m2", 1)], []);
    assert.deepEqual(roadmap.pillars.map((pillar) => pillar.label), ["Metrics & targets", "Governance"]);
    assert.deepEqual(roadmap.pillars[0]!.gaps.map((gap) => [gap.code, gap.shortfall]), [["M1", 3], ["M2", 2]]);
    assert.deepEqual(roadmap.pillars[1]!.gaps.map((gap) => [gap.code, gap.shortfall]), [["G1", 1]]);
  });

  it("answers each gap with the strategies aligned to it", () => {
    const roadmap = composeSrsRoadmap(framework, [item("g1", 1)], [
      action("a", { srsRequirementIds: ["g1"], title: "Board oversight", status: "in_progress", progressPct: 50 }),
      action("b", { srsRequirementIds: ["m1"], title: "Elsewhere" }),
    ]);
    const governance = roadmap.pillars.find((pillar) => pillar.label === "Governance")!;
    assert.deepEqual(governance.gaps[0]!.strategies, [
      { title: "Board oversight", status: "in_progress", statusLabel: "In progress" },
    ]);
  });

  it("says plainly when nothing on the plan addresses a gap", () => {
    // The useful half of the picture. Inventing an alignment would tell the client work is
    // under way that nobody has agreed to.
    const roadmap = composeSrsRoadmap(framework, [item("g1", 1), item("m1", 1)], [
      action("a", { srsRequirementIds: ["g1"], title: "Board oversight" }),
    ]);
    const all = roadmap.pillars.flatMap((pillar) => pillar.gaps);
    assert.deepEqual(all.find((gap) => gap.code === "M1")?.strategies, []);
    assert.equal(roadmap.unaddressedCount, 2, "M1 and M2 — both unanswered, and counted");
  });

  it("excludes a withdrawn strategy, so a gap never looks answered by abandoned work", () => {
    const roadmap = composeSrsRoadmap(framework, [item("g1", 1)], [
      action("dropped", { srsRequirementIds: ["g1"], title: "Abandoned", active: false }),
    ]);
    const governance = roadmap.pillars.find((pillar) => pillar.label === "Governance")!;
    assert.deepEqual(governance.gaps[0]!.strategies, []);
    assert.equal(roadmap.unaddressedCount, 3);
  });

  it("states where a requirement stands and what is expected of it", () => {
    const roadmap = composeSrsRoadmap(framework, [item("g1", 1)], []);
    const gap = roadmap.pillars.find((pillar) => pillar.label === "Governance")!.gaps[0]!;
    assert.equal(gap.title, "Requirement g1", "the requirement in words, not just a code");
    assert.equal(gap.maturityLabel, "Developing");
    assert.equal(gap.targetLabel, "Advanced");
  });

  it("reads an unassessed requirement as the floor, not as an answer", () => {
    // null maturity is "not looked at", which is short of target by the whole ladder.
    const roadmap = composeSrsRoadmap(framework, [], []);
    const gap = roadmap.pillars.flatMap((pillar) => pillar.gaps).find((entry) => entry.code === "G1")!;
    assert.equal(gap.shortfall, 3);
    assert.equal(gap.maturityLabel, "Not started");
  });

  it("returns an empty roadmap — not a missing one — when nothing is below target", () => {
    // Two different facts. An empty roadmap means "assessed, nothing outstanding"; an absent
    // one means the report was frozen before roadmaps existed.
    const roadmap = composeSrsRoadmap(framework, [item("g1", 3), item("m1", 3), item("m2", 3)], []);
    assert.deepEqual(roadmap.pillars, []);
    assert.equal(roadmap.unaddressedCount, 0);
  });

  it("is optional on the section, so an older report simply has none", () => {
    const srs: ReportSrsSection = {
      frameworkVersion: 1, assessedOn: "2026-06-30", overallPct: 58, overallLabel: "Developing",
      pillars: [{ label: "Governance", maturity: 2, maturityLabel: "Established" }],
    };
    assert.equal(srs.roadmap, undefined, "and nothing back-fills it");
    // The section still renders everything else it froze.
    assert.equal(srs.pillars.length, 1);
  });
});

describe("control level on a report's plan strategy", () => {
  it("carries it from the strategy, frozen with the rest of the plan", () => {
    const section = composeReportPlan([action("a", { controlLevel: "supply_chain" })], LEVERS, CODES);
    assert.ok(!isReportGap(section));
    if (isReportGap(section)) return;
    assert.equal(section.groups[0]!.strategies[0]!.controlLevel, "supply_chain");
  });

  it("stays an attribute — the plan is still grouped by lever", () => {
    // Two strategies at different control levels, one lever: one group, not two.
    const section = composeReportPlan([
      action("a", { controlLevel: "direct_control" }),
      action("b", { controlLevel: "influence" }),
    ], LEVERS, CODES);
    assert.ok(!isReportGap(section));
    if (isReportGap(section)) return;
    assert.deepEqual(section.groups.map((group) => group.label), ["Energy"]);
    assert.deepEqual(section.groups[0]!.strategies.map((entry) => entry.controlLevel),
      ["direct_control", "influence"]);
  });

  it("is absent on a strategy frozen before it was carried, so nothing is back-filled", () => {
    // What an older composition looks like: the field simply is not there, and the report
    // renders without the chip rather than guessing at a classification.
    const older: ReportPlanStrategy = {
      title: "Rooftop solar", scope: "2", category: "Energy", status: "planned",
      progressPct: 0, owner: "", targetDate: null, srsRequirementCodes: ["S2 M2"],
    };
    assert.equal(older.controlLevel, undefined);
  });
});
