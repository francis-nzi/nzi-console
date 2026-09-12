import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveYearDenominators } from "../src/readModels";
import { resolveIntensity, type ClientSiteReadModel, type IntensityMetricDefinition, type IntensityMetricValue } from "@nzi/contracts";

/**
 * Intensity denominators, now that the metric set is defined by the client rather than
 * hard-coded. The rule that matters is unchanged: a metric with nothing recorded reads
 * unavailable, and a denominator is never borrowed from another metric or another year.
 */

const period = { from: "2024-01-01", to: "2024-12-31" };
const site = (id: string, floorAreaM2: number | null, over: Partial<ClientSiteReadModel> = {}): ClientSiteReadModel => ({
  id, name: `Site ${id}`, isRegisteredOffice: false, inServiceFrom: "2020-01-01", vacatedEffective: null, version: 1,
  floorAreas: floorAreaM2 === null ? [] : [{ effectiveFrom: null, floorAreaM2, recordedBy: "tester", recordedAt: "2024-01-01T00:00:00Z" }],
  ...over,
});
const metric = (key: string, over: Partial<IntensityMetricDefinition> = {}): IntensityMetricDefinition => ({
  key, version: 1, label: key === "employees" ? "Employees" : key === "turnover" ? "Turnover" : "Floor area",
  unitWording: key === "turnover" ? "£m" : key === "floor-area" ? "m²" : "employee",
  divider: 1, iconKey: "metric", isStandard: key !== "floor-area",
  valueSource: key === "floor-area" ? "site-floor-area" : "entered", active: true, ordering: 1, ...over,
});
const value = (metricKey: string, recorded: number | null, reportingYear = 2024): IntensityMetricValue =>
  ({ metricKey, reportingYear, periodKey: "year", value: recorded, overridesResolved: false, note: "", version: 1 });

describe("intensity denominators", () => {
  it("takes the value the job recorded for that metric and year", () => {
    const resolved = resolveYearDenominators({
      definitions: [metric("employees"), metric("turnover")],
      values: [value("employees", 240), value("turnover", 40)],
      reportingYear: 2024, sites: [], period,
    });
    assert.deepEqual(resolved.employees, { value: 240, source: "recorded" });
    assert.deepEqual(resolved.turnover, { value: 40, source: "recorded" });
  });

  it("says nothing was recorded rather than inventing a denominator", () => {
    const resolved = resolveYearDenominators({
      definitions: [metric("employees")], values: [], reportingYear: 2024, sites: [], period,
    });
    assert.equal(resolved.employees!.value, null);
    assert.equal(resolved.employees!.source, "none");
  });

  it("does not read another year's value", () => {
    const resolved = resolveYearDenominators({
      definitions: [metric("employees")], values: [value("employees", 240, 2023)],
      reportingYear: 2024, sites: [], period,
    });
    assert.equal(resolved.employees!.value, null);
  });

  it("sums a site-derived metric across the in-service sites for the period", () => {
    const resolved = resolveYearDenominators({
      definitions: [metric("floor-area")], values: [], reportingYear: 2024,
      sites: [site("a", 2000), site("b", 3000)], period,
    });
    assert.deepEqual(resolved["floor-area"], { value: 5000, source: "site-floor-area" });
  });

  it("refuses a partial floor area rather than under-counting the boundary", () => {
    const resolved = resolveYearDenominators({
      definitions: [metric("floor-area")], values: [], reportingYear: 2024,
      sites: [site("a", 2000), site("b", null)], period,
    });
    assert.equal(resolved["floor-area"]!.value, null);
    assert.match(resolved["floor-area"]!.reason!, /No floor area is recorded for Site b/);
  });

  it("keeps a vacated site out of a later year's denominator", () => {
    const resolved = resolveYearDenominators({
      definitions: [metric("floor-area")], values: [], reportingYear: 2024,
      sites: [site("a", 2000), site("b", 3000, { vacatedEffective: "2023-06-30" })], period,
    });
    assert.equal(resolved["floor-area"]!.value, 2000);
  });

  it("lets a recorded value override what the sites resolve to", () => {
    const resolved = resolveYearDenominators({
      definitions: [metric("floor-area")], values: [value("floor-area", 9000)],
      reportingYear: 2024, sites: [site("a", 2000)], period,
    });
    assert.deepEqual(resolved["floor-area"], { value: 9000, source: "recorded" });
  });

  it("says the boundary is unknown when the year has no period", () => {
    const resolved = resolveYearDenominators({
      definitions: [metric("floor-area")], values: [], reportingYear: 2024, sites: [site("a", 2000)], period: null,
    });
    assert.equal(resolved["floor-area"]!.value, null);
    assert.match(resolved["floor-area"]!.reason!, /no reporting period/);
  });

  it("computes the intensity with the metric's own divider, and refuses to divide by nothing", () => {
    const perThousand = metric("employees", { divider: 1000 });
    const resolved = resolveIntensity({ definition: perThousand, emissionsTco2e: 1600, value: 240 });
    assert.equal(resolved.state, "resolved");
    if (resolved.state === "resolved") {
      assert.ok(Math.abs(resolved.value - 6666.67) < 0.01, "1,600 tCO₂e per 1,000 of 240 employees");
      assert.equal(resolved.unit, "tCO₂e per 1,000 employees");
    }
    // A year with no assured total, and a zero denominator, are both unavailable — never 0.
    assert.equal(resolveIntensity({ definition: perThousand, emissionsTco2e: null, value: 240 }).state, "unavailable");
    assert.equal(resolveIntensity({ definition: perThousand, emissionsTco2e: 1600, value: 0 }).state, "unavailable");
    assert.equal(resolveIntensity({ definition: perThousand, emissionsTco2e: 1600, value: null }).state, "unavailable");
  });
});
