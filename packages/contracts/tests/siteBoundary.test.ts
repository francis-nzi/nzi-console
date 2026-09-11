import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reportingPeriodForYear, resolveFloorAreaDenominator, resolveSiteBoundary, siteFloorAreaForPeriod, siteIsInReportingBoundary, siteLifecycleStatus, type ClientSiteReadModel } from "../src/index";

const site = (overrides: Partial<ClientSiteReadModel> = {}): ClientSiteReadModel => ({ id: "site-1", name: "Depot", isRegisteredOffice: false, inServiceFrom: "2023-04-01", vacatedEffective: null, version: 1, floorAreas: [], ...overrides });
const FY24 = { from: "2024-04-01", to: "2025-03-31" };
const FY25 = { from: "2025-04-01", to: "2026-03-31" };

describe("effective-dated site boundary (NZC-070)", () => {
  it("keeps a site vacated effective 01/04/2025 in FY24 (to 31/03/2025) and drops it from FY25", () => {
    const vacated = site({ vacatedEffective: "2025-04-01" });
    assert.equal(siteIsInReportingBoundary(vacated, FY24), true);
    assert.equal(siteIsInReportingBoundary(vacated, FY25), false);
  });

  it("treats vacated_effective as the first day out — a site vacated on the period's first day is out", () => {
    assert.equal(siteIsInReportingBoundary(site({ vacatedEffective: FY25.from }), FY25), false);
    assert.equal(siteIsInReportingBoundary(site({ vacatedEffective: "2025-04-02" }), FY25), true);
  });

  it("puts a NULL-start site in every historical year", () => {
    const legacy = site({ inServiceFrom: null });
    for (const year of [2005, 2015, 2020, 2024]) assert.equal(siteIsInReportingBoundary(legacy, reportingPeriodForYear(year, 3)), true, String(year));
  });

  it("includes a site that starts during the period and excludes one that starts after it", () => {
    assert.equal(siteIsInReportingBoundary(site({ inServiceFrom: "2025-03-31" }), FY24), true);
    assert.equal(siteIsInReportingBoundary(site({ inServiceFrom: "2025-04-01" }), FY24), false);
  });

  it("filters a site list for a period", () => {
    const sites = [site({ id: "hq", inServiceFrom: null }), site({ id: "depot", vacatedEffective: "2025-04-01" }), site({ id: "new", inServiceFrom: "2025-06-01" })];
    assert.deepEqual(resolveSiteBoundary(sites, FY24).map((item) => item.id), ["hq", "depot"]);
    assert.deepEqual(resolveSiteBoundary(sites, FY25).map((item) => item.id), ["hq", "new"]);
  });
});

describe("reporting period from the financial year (NZC-070)", () => {
  it("labels a March year end by its start year", () => assert.deepEqual(reportingPeriodForYear(2024, 3), FY24));
  it("gives the calendar year for a December (or unset) year end", () => {
    assert.deepEqual(reportingPeriodForYear(2024, 12), { from: "2024-01-01", to: "2024-12-31" });
    assert.deepEqual(reportingPeriodForYear(2024, null), { from: "2024-01-01", to: "2024-12-31" });
  });
  it("ends on the real last day of the month", () => assert.deepEqual(reportingPeriodForYear(2023, 2), { from: "2023-03-01", to: "2024-02-29" }));
});

describe("site status is derived from today (NZC-070)", () => {
  const today = "2026-09-11";
  it("is Planned before a future start", () => assert.equal(siteLifecycleStatus(site({ inServiceFrom: "2026-10-01" }), today).kind, "planned"));
  it("is In service, with the date, ahead of a future vacate", () => assert.deepEqual(siteLifecycleStatus(site({ vacatedEffective: "2026-12-01" }), today), { kind: "in-service", label: "In service", vacatesOn: "2026-12-01" }));
  it("is Vacated from the effective date", () => assert.equal(siteLifecycleStatus(site({ vacatedEffective: today }), today).kind, "vacated"));
  it("is In service for a NULL-start site", () => assert.equal(siteLifecycleStatus(site({ inServiceFrom: null }), today).kind, "in-service"));
});

describe("per-m² denominator (NZC-071)", () => {
  const recorded = (floorAreaM2: number, effectiveFrom: string | null, recordedAt = "2026-01-01T00:00:00Z") => ({ floorAreaM2, effectiveFrom, recordedAt, recordedBy: "consultant" });

  it("takes the floor-area record in force at the period end", () => {
    const grown = site({ floorAreas: [recorded(1000, null), recorded(1500, "2025-01-01"), recorded(2000, "2026-01-01")] });
    assert.equal(siteFloorAreaForPeriod(grown, FY24), 1500);
    assert.equal(siteFloorAreaForPeriod(grown, { from: "2023-04-01", to: "2024-03-31" }), 1000);
  });

  it("sums the in-boundary sites and drops a site vacated before the period", () => {
    const sites = [site({ id: "hq", name: "HQ", inServiceFrom: null, floorAreas: [recorded(800, null)] }), site({ id: "depot", name: "Depot", vacatedEffective: "2025-04-01", floorAreas: [recorded(1200, null)] })];
    assert.deepEqual(resolveFloorAreaDenominator(sites, FY24), { state: "resolved", floorAreaM2: 2000, sites: [{ siteId: "hq", name: "HQ", floorAreaM2: 800 }, { siteId: "depot", name: "Depot", floorAreaM2: 1200 }] });
    const fy25 = resolveFloorAreaDenominator(sites, FY25);
    assert.equal(fy25.state === "resolved" ? fy25.floorAreaM2 : null, 800);
  });

  it("is unavailable — never a partial sum — when an in-boundary site has no floor area", () => {
    const result = resolveFloorAreaDenominator([site({ id: "hq", name: "HQ", floorAreas: [recorded(800, null)] }), site({ id: "yard", name: "Yard" })], FY24);
    assert.equal(result.state, "unavailable");
    assert.match(result.state === "unavailable" ? result.reason : "", /Yard/);
  });

  it("is unavailable when no site is in the boundary", () => assert.equal(resolveFloorAreaDenominator([], FY24).state, "unavailable"));
});
