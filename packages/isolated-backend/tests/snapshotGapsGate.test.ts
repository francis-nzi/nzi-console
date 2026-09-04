import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandValidationError, createReviewedCrpSnapshot } from "../src/index";

const context = (key: string) => ({ organisationId: "org-a", actorId: "reviewer-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}` });

/**
 * A single-row CRP job that is fully QA-complete (calculation-approved,
 * quality-tiered, independently reviewed) — so QA_INCOMPLETE never fires —
 * with no baseline target and no prior snapshots, so the gap engine's only
 * possible flag is "unmapped" on the one row, driven by `opts.mapped`.
 */
function gatePool(opts: { mapped: boolean }) {
  const row = {
    scope_row_id: "row-a",
    version: 4,
    scope: "1",
    source_label: "Fleet diesel",
    site_id: null as string | null,
    site_label: null as string | null,
    purchased_goods_category_id: null as string | null,
    purchased_goods_category_label: null as string | null,
    quantity: "500",
    unit: "litres",
    factor_id: opts.mapped ? "factor-a" : null,
    factor_label: opts.mapped ? "Diesel (average biofuel blend)" : null,
    factor_version: "2026.1",
    factor_source: "dataset",
    client_factor_id: null as string | null,
    data_confidence: "H" as const,
    calculated_tco2e: "1.2",
    override_tco2e: null as string | null,
    quality_tier: "measured" as const,
    review_status: "approved",
    reviewed_by: "reviewer-a",
    enabled: true,
    monthly_activity_json: null,
  };
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("INSERT INTO nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("INSERT INTO nzi_console.audit_events")) return { rows: [] };
      if (sql.includes("INSERT INTO nzi_console.transactional_outbox")) return { rows: [] };
      // createReviewedCrpSnapshot's own queries
      if (sql.includes("SELECT j.version")) return { rows: [{ version: 5, job_family: "crp", job_number: "J000717", client_id: "client-a", reporting_year: 2026, start_date: "2026-01-01", client_name: "Gate Client" }] };
      if (sql.includes("FROM nzi_console.job_emissions_targets")) return { rows: [] };
      if (sql.includes("FROM nzi_console.job_intensity_targets")) return { rows: [] };
      if (sql.includes("SELECT scope_row_id,r.version")) return { rows: [row] };
      if (sql.includes("SELECT DISTINCT ON") && sql.includes("previous_job")) return { rows: [] };
      if (sql.includes("INSERT INTO nzi_console.reviewed_crp_snapshots")) return { rows: [] };
      if (sql.includes("coalesce(max(snapshot_version)")) return { rows: [{ version: 1 }] };
      if (sql.includes("SELECT snapshot_id,snapshot_version")) return { rows: [] };
      // resolveCrpReportingChain (via getAssuranceScreen → resolveAssuranceTrend)
      if (sql.includes("FROM nzi_console.jobs WHERE job_id")) return { rows: [{ client_id: "client-a", reporting_year: 2026, start_date: "2026-01-01", job_family: "crp" }] };
      if (sql.includes("SELECT baseline_year FROM")) return { rows: [] };
      if (sql.includes("DISTINCT ON") && sql.includes("reviewed_crp_snapshots")) return { rows: [] };
      if (sql.includes("ORDER BY snapshot_version DESC LIMIT 1")) return { rows: [] };
      // resolveAssuranceTrend's live current-year measurements
      if (sql.includes("coalesce(r.override_tco2e, r.calculated_tco2e)::text AS tco2e"))
        return { rows: [{ scope: "1", scope_code: "1", site_id: null, site_label: null, tco2e: "1.2" }] };
      // getAssuranceScreen's own row query (currentRows for the gap engine + auditRows)
      if (sql.includes("r.quality_tier, r.data_confidence, r.review_status"))
        return { rows: [{ scope: "1", scope_code: "1", version: 4, source_label: "Fleet diesel", site_id: null, site_label: null, quantity: "500", unit: "litres", factor_id: row.factor_id, factor_label: row.factor_label, factor_source: "dataset", client_factor_id: null, quality_tier: "measured", data_confidence: "H", review_status: "approved", reviewer_note: null, calculated_tco2e: "1.2", override_tco2e: null, enabled: true, monthly_activity_json: null }] };
      if (sql.includes("FROM nzi_console.gap_resolutions") && sql.includes("SELECT gap_key")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never };
}

describe("createReviewedCrpSnapshot gap gate (DA3c / NZC-060)", () => {
  it("blocks the freeze while an integrity gap is open, unforked from the DA1/DA3a gap engine", async () => {
    await assert.rejects(
      () => createReviewedCrpSnapshot(gatePool({ mapped: false }).pool, { jobId: "job-a", expectedJobVersion: 5 }, context("gate-open")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "GAPS_OPEN"),
    );
  });

  it("freezes once the row is mapped and no gap remains", async () => {
    const result = await createReviewedCrpSnapshot(gatePool({ mapped: true }).pool, { jobId: "job-a", expectedJobVersion: 5 }, context("gate-clear"));
    assert.ok(result.data.snapshotId);
  });
});
