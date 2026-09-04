import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAssuranceScreen, withTenantRead } from "../src/index";

// A CRP job at 2026 with a 2022 baseline target, one 2025 prior snapshot, and
// live current-year rows (no current snapshot).
function screenPool() {
  const priorPayload = {
    reportingYear: 2025, intensityTarget: { reportingDenominator: 50, denominatorUnit: "FTE" },
    measurements: [
      { scope: "2", scopeCode: "2", siteId: "hq", siteLabel: "HQ", tco2e: 5 },
      { scope: "3", scopeCode: "3.7", siteId: null, siteLabel: null, tco2e: 30 },
    ],
  };
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      if (sql.startsWith("BEGIN") || sql.startsWith("SET LOCAL") || sql.includes("set_config") || sql.startsWith("COMMIT")) return { rows: [] };
      if (sql.includes("FROM nzi_console.jobs WHERE job_id")) return { rows: [{ client_id: "client-a", reporting_year: 2026, start_date: "2026-01-01", job_family: "crp" }] };
      if (sql.includes("job_emissions_targets")) return { rows: [{ baseline_year: 2022 }] };
      if (sql.includes("DISTINCT ON") && sql.includes("reviewed_crp_snapshots")) return { rows: [{ snapshot_id: "s-2025", data_hash: "sha256:2025", reporting_year: 2025 }] };
      if (sql.includes("ORDER BY snapshot_version DESC LIMIT 1")) return { rows: [] }; // no current snapshot → live
      if (sql.includes("SELECT snapshot_id, payload_json FROM nzi_console.reviewed_crp_snapshots")) return { rows: [{ snapshot_id: "s-2025", payload_json: priorPayload }] };
      // resolveAssuranceTrend's live current-year query
      if (sql.includes("coalesce(r.override_tco2e, r.calculated_tco2e)::text AS tco2e")) {
        return { rows: [
          { scope: "3", scope_code: "3.7", site_id: null, site_label: null, tco2e: "80" },
          { scope: "2", scope_code: "2", site_id: "hq", site_label: "HQ", tco2e: "0" },
        ] };
      }
      // getAssuranceScreen's row query (currentRows for the gap engine + auditRows)
      if (sql.includes("r.quality_tier, r.data_confidence, r.review_status")) {
        return { rows: [
          { scope: "3", scope_code: "3.7", source_label: "Commuting survey", site_id: null, site_label: null, quantity: "4000", unit: "passenger.km", factor_id: "f1", factor_label: "Car - petrol", factor_source: "dataset", client_factor_id: null, quality_tier: "estimated", data_confidence: "M", review_status: "approved", calculated_tco2e: "80", override_tco2e: null, enabled: true, monthly_activity_json: null },
          { scope: "3", scope_code: "3.1", source_label: "Waste water", site_id: null, site_label: null, quantity: "1200", unit: "m3", factor_id: null, factor_label: null, factor_source: "dataset", client_factor_id: null, quality_tier: null, data_confidence: null, review_status: "pending", calculated_tco2e: null, override_tco2e: null, enabled: true, monthly_activity_json: null },
          { scope: "2", scope_code: "2", source_label: "Old grid row", site_id: "hq", site_label: "HQ", quantity: null, unit: null, factor_id: "f2", factor_label: "Grid", factor_source: "dataset", client_factor_id: null, quality_tier: "measured", data_confidence: "H", review_status: "approved", calculated_tco2e: "0", override_tco2e: null, enabled: true, monthly_activity_json: null },
        ] };
      }
      if (sql.includes("FROM nzi_console.gap_resolutions") && sql.includes("SELECT gap_key")) return { rows: [] };
      if (sql.includes("job_intensity_targets")) return { rows: [{ job_id: "job-a", metric: "employee", denominator_unit: "FTE", reporting_denominator: "50", baseline_year: 2022, baseline_intensity: "2", interim_year: 2030, interim_reduction_percent: "50", net_zero_year: 2045, version: 1, updated_by: "u", updated_at: "x" }] };
      return { rows: [] };
    },
    release() {},
  };
  return { connect: async () => client } as never;
}

describe("getAssuranceScreen (DA3a)", () => {
  it("composes the trend, gap engine and audit rows for the assurance surface", async () => {
    const screen = await withTenantRead(screenPool(), "org-a", (db) => getAssuranceScreen(db, "job-a"));
    assert.ok(screen);

    // trend: baseline 2022 (no snapshot → none), prior 2025, current 2026 (live)
    assert.deepEqual(screen!.trend.years.map((y) => [y.year, y.kind, y.source]), [
      [2022, "baseline", "none"], [2025, "prior", "reviewed-snapshot"], [2026, "current", "live"],
    ]);
    const current = screen!.trend.years.find((y) => y.kind === "current")!;
    assert.equal(current.total, 80); // 80 (commuting) + 0 (grid) ; waste water uncalculated → excluded
    assert.equal(current.intensity, 1.6); // 80 / 50

    // gap engine: waste-water is unmapped; the zeroed grid row is zero_blank;
    // Scope 2 category present in 2025, absent now → completeness
    const flags = new Set(screen!.gaps.gaps.map((g) => g.flag));
    assert.ok(flags.has("unmapped"));
    assert.ok(flags.has("zero_blank"));
    assert.ok(flags.has("completeness"));
    assert.equal(screen!.gaps.openCount, screen!.gaps.gaps.length);

    // audit rows: one per enabled row, with lineage
    assert.equal(screen!.auditRows.length, 3);
    const wasteWater = screen!.auditRows.find((r) => r.sourceLabel === "Waste water")!;
    assert.equal(wasteWater.factorLabel, null);
    assert.equal(wasteWater.category, "Purchased goods and services");
    assert.equal(wasteWater.siteLabel, "Unallocated");
  });

  it("returns null for a non-CRP job", async () => {
    const client = { async query(sql: string) { return sql.includes("FROM nzi_console.jobs WHERE job_id") ? { rows: [{ client_id: "c", reporting_year: 2026, start_date: "2026-01-01", job_family: "lca" }] } : { rows: [] }; }, release() {} };
    assert.equal(await withTenantRead({ connect: async () => client } as never, "org-a", (db) => getAssuranceScreen(db, "job-a")), null);
  });
});
