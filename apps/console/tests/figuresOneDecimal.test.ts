import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { formatTco2e } from "../app/lib/formatNumber";

/** Every headline tCO₂e figure is shown to one decimal place, through the one shared formatter, rounded from the unrounded value. */
describe("tCO₂e figures to one decimal place", () => {
  it("always shows exactly one decimal, with thousands separators", () => {
    assert.equal(formatTco2e(13157), "13,157.0");
    assert.equal(formatTco2e(75.99), "76.0");
    assert.equal(formatTco2e(77.11), "77.1");
    assert.equal(formatTco2e(13004.04), "13,004.0");
    assert.equal(formatTco2e(76), "76.0");
    assert.equal(formatTco2e(0), "0.0");
  });

  it("is an em dash, never a zero, for a missing or non-finite value", () => {
    assert.equal(formatTco2e(null), "—");
    assert.equal(formatTco2e(undefined), "—");
    assert.equal(formatTco2e(Number.NaN), "—");
  });

  it("rounds the sum, not the parts: three 0.04 rows total 0.1, not 0.0", () => {
    const rows = [0.04, 0.04, 0.04];
    assert.equal(formatTco2e(rows.reduce((a, b) => a + b, 0)), "0.1");
    assert.equal(rows.map(formatTco2e).join(","), "0.0,0.0,0.0");
  });

  it("is the formatter the CRM, report and portal surfaces share", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    for (const path of [
      "../app/jobs/CrpDataEntryAccordion.tsx", "../app/jobs/EmissionsSummary.tsx", "../app/jobs/CrpScopeWorkspace.tsx",
      "../app/clients/[clientId]/FigureEvidence.tsx", "../app/portal/jobs/[jobId]/PortalDashboard.tsx", "../app/portal/insights/insightsView.ts",
      "../app/portal/metrics/PortalMetrics.tsx", "../app/portal/intensity/PortalIntensity.tsx", "../app/portal/jobs/[jobId]/data/PortalDataView.tsx",
    ]) assert.match(read(path), /formatTco2e/, path);
  });
});
