import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveIntensityBases } from "../src/readModels";
import type { ClientSiteReadModel, IntensityTargetReadModel } from "@nzi/contracts";

/**
 * Multi-base intensity (client workspace v10). Each basis is formed from its own
 * denominator or it is unavailable *with its reason*. The rule that matters: a missing
 * denominator is never replaced by a different one, because that would silently change
 * what the figure means.
 */

const period = { from: "2024-01-01", to: "2024-12-31" };
const site = (id: string, floorAreaM2: number | null, over: Partial<ClientSiteReadModel> = {}): ClientSiteReadModel => ({
  id, name: `Site ${id}`, isRegisteredOffice: false, inServiceFrom: "2020-01-01", vacatedEffective: null, version: 1,
  floorAreas: floorAreaM2 === null ? [] : [{ effectiveFrom: null, floorAreaM2, recordedBy: "tester", recordedAt: "2024-01-01T00:00:00Z" }],
  ...over,
});

const target = (over: Partial<IntensityTargetReadModel>): IntensityTargetReadModel => ({
  jobId: "job-a", metric: "turnover", denominatorUnit: "£m", reportingDenominator: 40,
  baselineYear: 2023, baselineIntensity: 48, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045,
  version: 1, updatedAt: "2024-01-01T00:00:00Z", updatedBy: "tester", ...over,
});

describe("resolveIntensityBases", () => {
  it("forms each basis only from its own denominator", () => {
    const bases = resolveIntensityBases({ totalTco2e: 1600, intensityTarget: target({ metric: "turnover", reportingDenominator: 40 }), sites: [site("a", 3200)], period });
    assert.equal(bases.turnover.state, "resolved");
    if (bases.turnover.state === "resolved") {
      assert.equal(bases.turnover.value, 40); // 1600 tCO₂e / £40m
      assert.equal(bases.turnover.unit, "tCO₂e / £m");
      assert.equal(bases.turnover.source, "job-business-metric");
    }
    // Floor area resolves from the client's own sites even though the job chose turnover.
    assert.equal(bases["floor-area"].state, "resolved");
    if (bases["floor-area"].state === "resolved") {
      assert.equal(bases["floor-area"].value, 500); // 1600 t = 1,600,000 kg / 3200 m²
      assert.equal(bases["floor-area"].unit, "kgCO₂e / m²");
      assert.equal(bases["floor-area"].source, "site-floor-area");
    }
    // Employees was never recorded — it says so, it does not borrow turnover.
    assert.equal(bases.employee.state, "unavailable");
    if (bases.employee.state === "unavailable") assert.match(bases.employee.reason, /did not record employees/);
  });

  it("sums floor area across the in-service sites for the period", () => {
    const bases = resolveIntensityBases({ totalTco2e: 1000, intensityTarget: null, sites: [site("a", 2000), site("b", 3000)], period });
    assert.equal(bases["floor-area"].state, "resolved");
    if (bases["floor-area"].state === "resolved") assert.equal(bases["floor-area"].denominator, 5000);
  });

  it("refuses a partial floor area rather than under-counting the denominator", () => {
    // One site has no floor area recorded: summing the rest would inflate the intensity.
    const bases = resolveIntensityBases({ totalTco2e: 1000, intensityTarget: null, sites: [site("a", 2000), site("b", null)], period });
    assert.equal(bases["floor-area"].state, "unavailable");
    if (bases["floor-area"].state === "unavailable") assert.match(bases["floor-area"].reason, /No floor area is recorded for Site b/);
  });

  it("says the boundary is unknown when the year has no period", () => {
    const bases = resolveIntensityBases({ totalTco2e: 1000, intensityTarget: null, sites: [site("a", 2000)], period: null });
    assert.equal(bases["floor-area"].state, "unavailable");
    if (bases["floor-area"].state === "unavailable") assert.match(bases["floor-area"].reason, /no reporting period/);
  });

  it("reports every basis as unavailable when the year has no assured total — never zero", () => {
    const bases = resolveIntensityBases({ totalTco2e: null, intensityTarget: target({}), sites: [site("a", 2000)], period });
    for (const key of ["turnover", "employee", "floor-area"] as const) {
      assert.equal(bases[key].state, "unavailable", key);
      if (bases[key].state === "unavailable") assert.match(bases[key].reason, /No assured total/);
    }
  });

  it("treats a zero or missing denominator as unavailable rather than dividing by it", () => {
    const zero = resolveIntensityBases({ totalTco2e: 1000, intensityTarget: target({ metric: "employee", reportingDenominator: 0, denominatorUnit: "FTE" }), sites: [], period });
    assert.equal(zero.employee.state, "unavailable");
    const missing = resolveIntensityBases({ totalTco2e: 1000, intensityTarget: target({ metric: "employee", reportingDenominator: null, denominatorUnit: "FTE" }), sites: [], period });
    assert.equal(missing.employee.state, "unavailable");
  });

  it("keeps a vacated site out of the floor-area denominator for later years", () => {
    const vacated = site("b", 3000, { vacatedEffective: "2023-06-30" });
    const bases = resolveIntensityBases({ totalTco2e: 1000, intensityTarget: null, sites: [site("a", 2000), vacated], period });
    assert.equal(bases["floor-area"].state, "resolved");
    if (bases["floor-area"].state === "resolved") assert.equal(bases["floor-area"].denominator, 2000);
  });
});
