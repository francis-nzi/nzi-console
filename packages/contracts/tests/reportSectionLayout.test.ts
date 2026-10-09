import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultReportSectionPlan, REPORT_RENDERER_LATEST, reportCompositionSections, reportRendererOf, reportSectionLayout,
  type ReportSectionPlan,
} from "../src/reportComposition";

/** F-0 (RULING-reporting-F Q4): the layout version a composition names, and the plan-derived numbering. */
describe("the renderer a composition was issued under", () => {
  it("is composed@1 for every composition issued before the stamp, and the latest is stamped on new ones", () => {
    assert.equal(reportRendererOf({}), "composed@1");
    assert.equal(reportRendererOf({ renderer: "composed@1" }), "composed@1");
    assert.equal(REPORT_RENDERER_LATEST, "composed@1");
  });

  it("is null for a layout this code does not carry — never quietly drawn with another", () => {
    assert.equal(reportRendererOf({ renderer: "composed@2" }), null);
    assert.equal(reportRendererOf({ renderer: "" }), null);
  });
});

describe("the section layout follows the plan", () => {
  const all = () => true;

  it("the default plan is every data section, included, in the order the report has always had — and the narrative, not included (F-1, Q6)", () => {
    assert.deepEqual(defaultReportSectionPlan.filter((entry) => !entry.key.startsWith("narrative:")).map((entry) => entry.key), [...reportCompositionSections]);
    assert.ok(defaultReportSectionPlan.every((entry) => entry.included === !entry.key.startsWith("narrative:")));
  });

  it("the cover is page 1 and unnumbered; every section after it is numbered in order, a page each", () => {
    assert.deepEqual(reportSectionLayout(defaultReportSectionPlan, all), [
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
  });

  it("a section the composition does not have leaves no hole in the numbering (a composition without a site breakdown)", () => {
    const layout = reportSectionLayout(defaultReportSectionPlan, (key) => key !== "sites");
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
