import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultReportSectionPlan, legacyReportSectionPlanV3, REPORT_RENDERER_LATEST, reportRendererOf, reportSectionLayout,
  type ReportSectionPlan,
} from "../src/reportComposition";

/** F-0 (RULING-reporting-F Q4): the layout version a composition names, and the plan-derived numbering. */
describe("the renderer a composition was issued under", () => {
  it("is composed@1 for every composition issued before the stamp, and the latest is stamped on new ones", () => {
    assert.equal(reportRendererOf({}), "composed@1");
    assert.equal(reportRendererOf({ renderer: "composed@1" }), "composed@1");
    // F-2 (chart parity): new compositions are drawn composed@2; composed@1 stays for every report issued under it.
    assert.equal(reportRendererOf({ renderer: "composed@2" }), "composed@2");
    // B1: composed@3; B2-3: new compositions are drawn composed@4 — every earlier layout stays for the reports issued under it.
    assert.equal(reportRendererOf({ renderer: "composed@3" }), "composed@3");
    assert.equal(reportRendererOf({ renderer: "composed@4" }), "composed@4");
    assert.equal(REPORT_RENDERER_LATEST, "composed@4");
  });

  it("is null for a layout this code does not carry — never quietly drawn with another", () => {
    assert.equal(reportRendererOf({ renderer: "composed@5" }), null);
    assert.equal(reportRendererOf({ renderer: "" }), null);
  });
});

describe("the section layout follows the plan", () => {
  const all = () => true;

  it("the frozen v3 legacy plan numbers exactly as the report always has (what composed@1/2/3 render a plan-less composition with)", () => {
    assert.deepEqual(reportSectionLayout(legacyReportSectionPlanV3, all), [
      { key: "cover", number: null, page: 1 },
      { key: "executive-summary", number: "01", page: 2 },
      { key: "emissions", number: "02", page: 3 },
      { key: "sites", number: "03", page: 4 },
      { key: "intensity", number: "04", page: 5 },
      { key: "targets", number: "05", page: 6 },
      { key: "plan", number: "06", page: 7 },
      { key: "srs", number: "07", page: 8 },
      { key: "methodology", number: "08", page: 9 },
    ]);
    assert.ok(legacyReportSectionPlanV3.every((entry) => entry.included === !entry.key.startsWith("narrative:")));
  });

  it("the default plan (B2-3, composed@4's canonical order): the cover unnumbered, then the mockup's sections, a page each", () => {
    assert.deepEqual(reportSectionLayout(defaultReportSectionPlan, all).map((entry) => [entry.key, entry.number, entry.page]), [
      ["cover", null, 1], ["executive-summary", "01", 2], ["sites", "02", 3], ["emissions", "03", 4], ["intensity", "04", 5],
      ["targets", "05", 6], ["scope-analysis", "06", 7], ["category-analysis", "07", 8], ["plan", "08", 9], ["srs", "09", 10],
      ["methodology", "10", 11], ["glossary", "11", 12], ["audit", "12", 13], ["appendix-sites", "13", 14],
    ]);
    assert.ok(defaultReportSectionPlan.every((entry) => entry.included === !entry.key.startsWith("narrative:")), "the narrative is not included");
  });

  it("a section the composition does not have leaves no hole in the numbering (a composition without a site breakdown)", () => {
    const layout = reportSectionLayout(legacyReportSectionPlanV3, (key) => key !== "sites");
    assert.deepEqual(layout.map((entry) => [entry.key, entry.number, entry.page]), [
      ["cover", null, 1], ["executive-summary", "01", 2], ["emissions", "02", 3], ["intensity", "03", 4],
      ["targets", "04", 5], ["plan", "05", 6], ["srs", "06", 7], ["methodology", "07", 8],
    ]);
  });

  it("follows a plan's order and leaves out what it excludes (the shape F-1 will freeze)", () => {
    const plan: ReportSectionPlan = [
      { key: "cover", included: true }, { key: "executive-summary", included: true }, { key: "targets", included: true },
      { key: "emissions", included: true }, { key: "srs", included: false }, { key: "methodology", included: true },
    ];
    assert.deepEqual(reportSectionLayout(plan, all).map((entry) => [entry.key, entry.number]), [
      ["cover", null], ["executive-summary", "01"], ["targets", "02"], ["emissions", "03"], ["methodology", "04"],
    ]);
  });
});
