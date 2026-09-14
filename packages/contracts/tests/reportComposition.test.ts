import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REPORT_ASSURANCE_STATEMENT, composeReportPlan, isReportGap, reportAssurance,
  reportHeadline, reportMethodologyRows,
  type ReportComposition, type ReportEmissionsSection,
} from "../src/reportComposition";
import { strategyControlLevelLabels, strategyControlLevels, type ClientStrategy } from "../src/reductionStrategies";

const action = (id: string, over: Partial<ClientStrategy> = {}): ClientStrategy => ({
  id, clientId: "client-a", leverIds: [], strategyId: null, title: id, scope: "2", category: "Energy",
  controlLevel: "direct_control", iconKey: "energy", status: "planned", owner: "", targetDate: null,
  progressPct: 0, notes: "", active: true, version: 1, ...over,
});

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

    it("says so when there is no assured footprint at all", () => {
      const gap = reportHeadline({ state: "unavailable", reason: "none" }, 2024);
      assert.match(gap, /No assured footprint/);
      assert.doesNotMatch(gap, /0 tCO₂e/, "a gap is never rendered as zero");
    });
  });

  describe("the plan section", () => {
    it("freezes the plan as it stood, grouped by level of control", () => {
      const section = composeReportPlan(
        [action("a", { status: "in_progress", progressPct: 60 }), action("b", { controlLevel: "influence" })],
        strategyControlLevelLabels, strategyControlLevels,
      );
      assert.ok(!isReportGap(section));
      if (isReportGap(section)) return;
      assert.deepEqual(section.groups.map((group) => group.controlLevel), ["direct_control", "influence"]);
      assert.equal(section.summary.total, 2);
      assert.equal(section.summary.inProgress, 1);
      // Said on the page: these percentages are progress, not carbon.
      assert.equal(section.qualitativeOnly, true);
    });

    it("leaves out actions already removed at issue, and keeps the rest frozen", () => {
      const section = composeReportPlan([action("a"), action("gone", { active: false })], strategyControlLevelLabels, strategyControlLevels);
      assert.ok(!isReportGap(section));
      if (isReportGap(section)) return;
      assert.equal(section.summary.total, 1, "an action removed before issue was never in the report");
    });

    it("states an empty plan rather than showing a zeroed summary", () => {
      const section = composeReportPlan([], strategyControlLevelLabels, strategyControlLevels);
      assert.ok(isReportGap(section));
      if (!isReportGap(section)) return;
      assert.match(section.reason, /No decarbonisation actions were on this client's plan/);
    });
  });
});
