import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultReportSectionPlan, isOptionalReportSection, REPORT_NARRATIVE_SECTIONS_AVAILABLE, REPORT_SECTION_EXCLUSION_AVAILABLE, reportIssuerLineIssues,
  reportNarrativePlanKeys, reportOmittedSections, reportPlanSectionKeys, reportSectionPlanIssues, reportSectionPlanOrigin,
  resolveReportSectionPlan, setReportSectionIncluded, type ReportSectionPlan,
} from "../src/reportComposition";
import { validateCommand, type CommandContext } from "../src/commands";
import { commandGrantForRole } from "../src/permissions";

/** F-1 (RULING-reporting-F Q1–Q3, Q5, Q6; R-D1): the section plan's rules, its precedence and origin, and the issuer line. */
const codes = (plan: unknown, options?: { allowExclusion?: boolean; allowNarrative?: boolean }) => reportSectionPlanIssues(plan, options).map((issue) => issue.code);
const exclude = (key: string): ReportSectionPlan => defaultReportSectionPlan.map((entry) => entry.key === key ? { ...entry, included: false } : entry);
const move = (key: string, to: number): ReportSectionPlan => {
  const rest = defaultReportSectionPlan.filter((entry) => entry.key !== key);
  return [...rest.slice(0, to), defaultReportSectionPlan.find((entry) => entry.key === key)!, ...rest.slice(to)];
};

describe("the plan key set spans the data sections and the narrative (Q6)", () => {
  it("names the six R2 narrative sections, namespaced apart from the data section of the same name", () => {
    assert.deepEqual([...reportNarrativePlanKeys], ["narrative:executive-summary", "narrative:net-zero-commitment", "narrative:background",
      "narrative:intensity-analysis", "narrative:category-analysis", "narrative:reduction-actions"]);
    assert.equal(reportPlanSectionKeys.length, 15);
    assert.ok(reportPlanSectionKeys.includes("executive-summary") && reportPlanSectionKeys.includes("narrative:executive-summary"));
  });

  it("the default plan is valid and complete", () => {
    assert.deepEqual(reportSectionPlanIssues(defaultReportSectionPlan), []);
    assert.equal(defaultReportSectionPlan.length, reportPlanSectionKeys.length);
  });
});

describe("a plan a report may carry (Q1)", () => {
  it("is complete: every key once, nothing unknown", () => {
    assert.ok(codes(defaultReportSectionPlan.slice(0, -2).concat(defaultReportSectionPlan.slice(-1))).includes("MISSING_SECTION"));
    assert.ok(codes([...defaultReportSectionPlan, { key: "emissions", included: true }]).includes("DUPLICATE_SECTION"));
    assert.ok(codes([...defaultReportSectionPlan, { key: "appendix", included: true }]).includes("UNKNOWN_SECTION"));
    assert.ok(codes("emissions").includes("INVALID"));
    assert.ok(codes(defaultReportSectionPlan.map((entry, index) => index === 3 ? { key: entry.key } : entry)).includes("INVALID"));
  });

  it("keeps the cover first and the methodology last, and both in", () => {
    assert.ok(codes(move("cover", 2)).includes("COVER_FIRST"));
    assert.ok(codes(move("methodology", 3)).includes("METHODOLOGY_LAST"));
    assert.ok(codes(exclude("cover"), { allowExclusion: true }).includes("MANDATORY_SECTION"));
    assert.ok(codes(exclude("methodology"), { allowExclusion: true }).includes("MANDATORY_SECTION"));
  });

  it("moves the executive summary and emissions freely, but never leaves them out", () => {
    assert.deepEqual(codes(move("emissions", 9)), []);
    assert.deepEqual(codes(move("executive-summary", 6)), []);
    for (const key of ["executive-summary", "emissions"]) assert.ok(codes(exclude(key), { allowExclusion: true }).includes("MANDATORY_SECTION"), key);
  });

  it("reorders the optional sections freely", () => {
    for (const key of ["sites", "intensity", "targets", "plan", "srs"]) assert.deepEqual(codes(move(key, 2)), [], key);
  });
});

describe("the exclusion interlock (Q5, binding) and the narrative", () => {
  it("is HELD until every client surface honours it (GATE 1: F-4c's dashboard; GATE 2: the target backfill): leaving an optional section out is refused", () => {
    assert.equal(REPORT_SECTION_EXCLUSION_AVAILABLE, false, "RULING-reporting-F4b-flip-and-dashboard decision 1: F-4b merges with the flip held");
    for (const key of ["sites", "intensity", "targets", "plan", "srs"]) assert.deepEqual(codes(exclude(key)), ["EXCLUSION_NOT_YET_AVAILABLE"], key);
  });

  it("never lets a mandatory section be left out (Q1), held or not", () => {
    for (const key of ["cover", "executive-summary", "emissions", "methodology"]) {
      assert.deepEqual(codes(exclude(key)), ["MANDATORY_SECTION"], key);
      assert.deepEqual(codes(exclude(key), { allowExclusion: true }), ["MANDATORY_SECTION"], key);
    }
  });

  it("the machinery is ready behind the switch: with exclusion allowed, an optional section may be left out", () => {
    for (const key of ["sites", "intensity", "targets", "plan", "srs"]) assert.deepEqual(codes(exclude(key), { allowExclusion: true }), [], key);
  });

  it("a left-out section is stated, by its title", () => {
    assert.deepEqual(reportOmittedSections(exclude("targets")), ["Targets & reduction pathway"]);
    assert.deepEqual(reportOmittedSections(defaultReportSectionPlan), [], "the narrative is not yet drawn, so it is not 'left out'");
  });

  it("the editors' switch: no change while held; with exclusion allowed it leaves out an optional section, and only an optional one", () => {
    assert.equal(setReportSectionIncluded(defaultReportSectionPlan, "srs", false), defaultReportSectionPlan, "held: the switch changes nothing");
    const allow = { allowExclusion: true };
    const cut = setReportSectionIncluded(defaultReportSectionPlan, "srs", false, allow);
    assert.equal(cut.find((entry) => entry.key === "srs")!.included, false);
    assert.deepEqual(codes(cut, allow), []);
    assert.equal(setReportSectionIncluded(cut, "srs", true, allow).find((entry) => entry.key === "srs")!.included, true, "and puts it back");
    for (const key of ["cover", "executive-summary", "emissions", "methodology", "narrative:background"] as const) {
      assert.equal(setReportSectionIncluded(defaultReportSectionPlan, key, !defaultReportSectionPlan.find((entry) => entry.key === key)!.included, allow), defaultReportSectionPlan, key);
    }
    assert.deepEqual(defaultReportSectionPlan.filter((entry) => isOptionalReportSection(entry.key)).map((entry) => entry.key), ["sites", "intensity", "targets", "plan", "srs"]);
  });

  it("refuses the narrative until it is drawn (with F-2/F-4)", () => {
    assert.equal(REPORT_NARRATIVE_SECTIONS_AVAILABLE, false);
    const plan = defaultReportSectionPlan.map((entry) => entry.key === "narrative:background" ? { ...entry, included: true } : entry);
    assert.deepEqual(codes(plan), ["NARRATIVE_NOT_YET_DRAWN"]);
    assert.deepEqual(codes(plan, { allowNarrative: true }), []);
  });

  it("is enforced by every command that takes a plan, through the one validator", () => {
    const context: CommandContext = { organisationId: "o", actorId: "a", principal: "staff", idempotencyKey: "k", correlationId: "c", grant: commandGrantForRole("admin", "o", "a") };
    const cut = exclude("srs"), mandatory = exclude("emissions");
    assert.ok(validateCommand("report.validate", { reviewedSnapshotId: "s", manifestVersion: 1, sectionPlan: cut }, context).some((issue) => issue.code === "EXCLUSION_NOT_YET_AVAILABLE"));
    assert.ok(validateCommand("report.sectionPlan.update", { reportVersionId: "r", expectedVersion: 1, sectionPlan: cut }, context).some((issue) => issue.code === "EXCLUSION_NOT_YET_AVAILABLE"));
    assert.ok(validateCommand("client.reportProfile.set", { clientId: "c", expectedVersion: 0, sectionPlan: cut, issuerLine: null }, context).some((issue) => issue.code === "EXCLUSION_NOT_YET_AVAILABLE"));
    assert.ok(validateCommand("report.validate", { reviewedSnapshotId: "s", manifestVersion: 1, sectionPlan: mandatory }, context).some((issue) => issue.code === "MANDATORY_SECTION"));
    assert.ok(validateCommand("report.sectionPlan.update", { reportVersionId: "r", expectedVersion: 1, sectionPlan: mandatory }, context).some((issue) => issue.code === "MANDATORY_SECTION"));
    assert.ok(validateCommand("client.reportProfile.set", { clientId: "c", expectedVersion: 0, sectionPlan: mandatory, issuerLine: null }, context).some((issue) => issue.code === "MANDATORY_SECTION"));
    assert.deepEqual(validateCommand("report.validate", { reviewedSnapshotId: "s", manifestVersion: 1 }, context), [], "no plan asked for: the profile or the default applies");
  });
});

describe("precedence and origin (Q3)", () => {
  const profile = { version: 3, sectionPlan: move("targets", 2) };

  it("resolves the plan asked for, else the active profile, else the default", () => {
    assert.deepEqual(resolveReportSectionPlan(null, null), { plan: defaultReportSectionPlan, origin: "default" });
    assert.deepEqual(resolveReportSectionPlan(null, profile), { plan: profile.sectionPlan, origin: "profile:3" });
    assert.deepEqual(resolveReportSectionPlan(move("srs", 2), profile).origin, "edited");
  });

  it("names the origin by what the plan equals: a house style re-chosen by hand reads as the profile's", () => {
    assert.equal(reportSectionPlanOrigin(move("targets", 2), profile), "profile:3");
    assert.equal(reportSectionPlanOrigin(defaultReportSectionPlan, profile), "default");
    assert.equal(reportSectionPlanOrigin(move("plan", 2), null), "edited");
  });
});

describe("the issuer line (R-D1, NZC-120)", () => {
  it("is words for the cover, or none", () => {
    assert.deepEqual(reportIssuerLineIssues(null), []);
    assert.deepEqual(reportIssuerLineIssues("Prepared for the Board of Plan Co"), []);
    assert.deepEqual(reportIssuerLineIssues("Prepared for FY2025 reporting"), [], "a year is not money");
  });

  it("is never money, never blank or padded, never too long", () => {
    for (const line of ["A £2m programme", "Fee $1,500", "Budget GBP 40000", "40000 EUR budget", "€5k"]) assert.deepEqual(reportIssuerLineIssues(line).map((issue) => issue.code), ["MONEY_SHAPED"], line);
    assert.deepEqual(reportIssuerLineIssues("  ").map((issue) => issue.code), ["INVALID"]);
    assert.deepEqual(reportIssuerLineIssues(" padded ").map((issue) => issue.code), ["INVALID"]);
    assert.deepEqual(reportIssuerLineIssues("x".repeat(161)).map((issue) => issue.code), ["TOO_LONG"]);
  });
});
