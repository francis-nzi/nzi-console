import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getPortalAssuredDashboard } from "../src/index";

// Client portal Phase 2 · A1 — the assured-dashboard read model (§0):
// PUBLISHED snapshot + prior frozen snapshots only, never `job_scope_rows`.

const measurement = (scope: "1" | "2" | "3", scopeCode: string, tco2e: number) => ({
  rowId: `${scopeCode}-${tco2e}`, rowVersion: 1, scope, scopeCode, sourceLabel: "src", tco2e,
  factorSet: "DEFRA 2024", qualityTier: "measured", reviewedBy: "rev",
});

const publishedPayload = (reportingYear: number, total: number) => ({
  jobNumber: "J000712", client: "Acme", reportingYear,
  target: null, intensityTarget: null, annualComparison: [], sections: [], gapResolutions: [],
  measurements: [measurement("1", "1", total * 0.2), measurement("2", "2", total * 0.3), measurement("3", "3.1", total * 0.5)],
});

function fakeDb(opts: { publishedRow: unknown; chainRows: unknown[]; priorPayloads: Record<string, unknown> }) {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string, values?: readonly unknown[]) {
      calls.push(sql);
      if (sql.includes("FROM nzi_console.portal_access_grants g") && sql.includes("g.portal_user_id=$1")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM nzi_console.report_versions r") && sql.includes("r.status='published'")) return { rows: opts.publishedRow ? [opts.publishedRow] : [] };
      if (sql.includes("SELECT client_id, reporting_year, start_date, job_family FROM nzi_console.jobs")) return { rows: [{ client_id: "client-a", reporting_year: 2025, start_date: "2025-01-01", job_family: "crp" }] };
      if (sql.includes("FROM nzi_console.job_emissions_targets")) return { rows: [{ baseline_year: 2020 }] };
      if (sql.includes("FROM nzi_console.reviewed_crp_snapshots s") && sql.includes("pj.client_id = $1")) return { rows: opts.chainRows };
      if (sql.includes("SELECT snapshot_id, data_hash FROM nzi_console.reviewed_crp_snapshots WHERE job_id=$1")) return { rows: [{ snapshot_id: "cur", data_hash: "sha256:current" }] };
      if (sql.includes("SELECT snapshot_id, payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id = ANY($1)")) {
        const ids = (values?.[0] ?? []) as string[];
        return { rows: ids.filter((id) => opts.priorPayloads[id]).map((id) => ({ snapshot_id: id, payload_json: opts.priorPayloads[id] })) };
      }
      return { rows: [] };
    },
  };
}

const publishedReportRow = {
  report_version_id: "rv-1", manifest_version: 1, report_data_hash: "sha256:current", published_at: "2026-02-01T00:00:00.000Z",
  snapshot_id: "cur", job_id: "job-a", snapshot_version: 2, job_version: 3, data_hash: "sha256:current",
  payload_json: publishedPayload(2025, 500), created_by: "consultant", created_at: "2026-01-01T00:00:00.000Z",
};

describe("getPortalAssuredDashboard (§0)", () => {
  it("returns { published: false } when the granted job has no published report", async () => {
    const db = fakeDb({ publishedRow: null, chainRows: [], priorPayloads: {} });
    const result = await getPortalAssuredDashboard(db as never, { portalUserId: "p", clientId: "client-a", jobId: "job-a" });
    assert.deepEqual(result, { published: false });
  });

  it("aggregates the PUBLISHED snapshot + prior frozen snapshots; dataHash is the published report's", async () => {
    const db = fakeDb({
      publishedRow: publishedReportRow,
      chainRows: [{ snapshot_id: "s-2020", data_hash: "sha256:2020", reporting_year: 2020 }],
      priorPayloads: { "s-2020": publishedPayload(2020, 900) },
    });
    const result = await getPortalAssuredDashboard(db as never, { portalUserId: "p", clientId: "client-a", jobId: "job-a" });
    assert.equal(result.published, true);
    if (!result.published) return;
    assert.equal(result.dataHash, "sha256:current");
    assert.equal(result.reportVersionId, "rv-1");
    assert.equal(result.total, 500);
    assert.deepEqual(result.byScope, { "1": 100, "2": 150, "3": 250 });
    assert.deepEqual(result.trend.map((y) => [y.year, y.kind, y.total]), [[2020, "baseline", 900], [2025, "current", 500]]);
    // Never queried the editable row store.
    assert.equal(db.calls.some((sql) => sql.includes("FROM nzi_console.job_scope_rows")), false);
  });
});
