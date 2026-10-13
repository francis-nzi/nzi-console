import assert from "node:assert/strict";
import test from "node:test";
import { CRP_RESOLVER_AGGREGATED, CRP_RESOLVER_VERSION, resolveCrpCoreCharts, type ReviewedCrpSnapshotCore } from "../src/crp";
import type { EmissionsByActivityData } from "../src/types";

// B1 (composed@3): resolver v2 draws "Largest emissions activities" one bar per activity. v1 — every other surface, and the
// composed@2 reports it re-resolves — is unchanged.
const snapshot: ReviewedCrpSnapshotCore = {
  id: "snap-v2", jobId: "job-v2", jobNumber: "J000001", client: "Synthetic Client", reportingYear: 2025, generatedAt: "2026-03-01T09:00:00.000Z", dataHash: "sha256:v2",
  measurements: [
    { rowId: "r1", scope: "1", sourceLabel: "Gas", tco2e: 6, factorSet: "f" },
    { rowId: "r2", scope: "1", sourceLabel: "Gas", tco2e: 4, factorSet: "f" },
    { rowId: "r3", scope: "3", sourceLabel: "Gas", tco2e: 1, factorSet: "f" },
    { rowId: "r4", scope: "2", sourceLabel: "Electricity", tco2e: 10, factorSet: "f" },
    { rowId: "r5", scope: "3", sourceLabel: "  ", tco2e: 2, factorSet: "f" },
  ],
};
const activities = (charts: ReturnType<typeof resolveCrpCoreCharts>) => (charts.find((chart) => chart.spec.type === "emissions_by_activity") as EmissionsByActivityData);

test("v1 is the default: one bar per measurement row, as every surface has always drawn", () => {
  const chart = activities(resolveCrpCoreCharts(snapshot));
  assert.deepEqual(chart.activities.map((bar) => [bar.id, bar.value]), [["r4", 10], ["r1", 6], ["r2", 4], ["r5", 2], ["r3", 1]]);
  assert.equal(chart.provenance.resolverVersion, CRP_RESOLVER_VERSION);
  assert.deepEqual(resolveCrpCoreCharts(snapshot, { resolverVersion: CRP_RESOLVER_VERSION }), resolveCrpCoreCharts(snapshot));
});

test("v2: rows of one activity and scope are one bar; the same label in another scope stays its own; ties by label", () => {
  const chart = activities(resolveCrpCoreCharts(snapshot, { resolverVersion: CRP_RESOLVER_AGGREGATED }));
  assert.deepEqual(chart.activities.map((bar) => [bar.label, bar.scope, bar.value]), [
    ["Electricity", "2", 10], ["Gas", "1", 10], ["Unlabelled activity", "3", 2], ["Gas", "3", 1],
  ]);
  assert.equal(chart.provenance.resolverVersion, CRP_RESOLVER_AGGREGATED, "stamped v2, so its asset key differs from v1's");
});

test("v2 changes nothing else: every other chart is v1's, but for the resolver stamp", () => {
  const strip = (charts: ReturnType<typeof resolveCrpCoreCharts>) => charts.filter((chart) => chart.spec.type !== "emissions_by_activity").map((chart) => ({ ...chart, provenance: { ...chart.provenance, resolverVersion: 0 } }));
  assert.deepEqual(strip(resolveCrpCoreCharts(snapshot, { resolverVersion: CRP_RESOLVER_AGGREGATED })), strip(resolveCrpCoreCharts(snapshot)));
});
