import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type ReportComposition, type ReportScope, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { getReportComposition, previewReportComposition } from "../src/reportCompositions";
import { withTenantRead } from "../src/postgres";

/**
 * B1 (`composed@3`; RULING-report-studio-consolidation R3/R6, REVIEW-report-srcline-and-B1-rulings), against a real database:
 * a report composed now freezes its sources — the snapshot stamp's datasets named by id — and its audit appendix, cut to its
 * scope, with no upload file name anywhere in either. The preview composes exactly what publish freezes, these included.
 * Synthetic: the stamp is shaped like a re-ingested job's (dataset name and version are upload file names).
 */
const ORG = "c3-org";
const CLIENT = "c3-client";

describe("composed@3 freezes its sources and audit appendix, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `c3-${count}`, correlationId: `corr-c3-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const validate = async (scope?: ReportScope) => (await validateCrpReport(database.pool, { reviewedSnapshotId: "snap-c3", manifestVersion: 1, ...(scope ? { scope } : {}) }, context("rev", "reviewer"))).data.reportVersionId;
  const publish = (id: string) => publishCrpReport(database.pool, { reportVersionId: id, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: "snap-c3" }, context("rev", "reviewer"));
  const frozen = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, id)))!;
  const preview = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => previewReportComposition(db, { organisationId: ORG, reportVersionId: id })))!.composition;
  let wholeId = "", annexId = "", wholePreview: ReportComposition;

  before(async () => {
    database = (await createDisposableDatabase("reportcomposed3"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Composed Three Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, 's-a', 'Works', '2020-01-01', 'seed'), ($1, $2, 's-b', 'Annex', '2020-01-01', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_targets (organisation_id, client_id, version, near_term_year, near_term_pct, net_zero_year, net_zero_pct, benchmark_year, benchmark_total_tco2e, benchmark_source, set_by, correlation_id)
             VALUES ($1, $2, 1, 2030, 50, 2045, 90, 2024, 64, 'client-record', 'fixture', 'fixture')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, unit_kind, set_by, correlation_id)
             VALUES ($1, $2, 'turnover', 1, 'Turnover', '£m', 1000000, 'currency', true, 'entered', true, 1, 'currency', 'seed', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, 'j-c3', $2, 9831, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, 'j-c3', '2025-01-01', '2025-12-31', 'GB')`, [ORG]);
    await q(`INSERT INTO nzi_console.job_intensity_values (organisation_id, job_id, reporting_year, metric_key, value, recorded_by) VALUES ($1, 'j-c3', 2025, 'turnover', 12500000, 'ada')`, [ORG]);
    const row = (rowId: string, scope: string, scopeCode: string, siteId: string | null, siteLabel: string | null, sourceLabel: string, tco2e: number, factorSet: string, qualityTier: string, extra: Record<string, unknown> = {}) =>
      ({ rowId, scope, scopeCode, siteId, siteLabel, sourceLabel, tco2e, factorSet, qualityTier, factorSource: "dataset", ...extra });
    const payload = { jobNumber: "J-c3", client: "Composed Three Co", reportingYear: 2025,
      measurements: [
        row("g1", "1", "1", "s-a", "Works", "Gas", 6, "Natural gas · upload-2019-2025.xlsx", "measured"),
        row("g2", "1", "1", "s-a", "Works", "Gas", 4, "Natural gas · upload-2019-2025.xlsx", "measured"),
        row("e1", "2", "2", "s-b", "Annex", "Electricity", 5, "UK electricity · upload-2019-2025.xlsx", "measured"),
        row("p1", "3", "3.1", null, null, "Goods", 20, "Manufacture of goods · tmpupload1.csv", "estimated", { purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials", sourceQuantity: 4100000, sourceUnit: "GBP" }),
        row("s1", "3", "3.1", "s-a", "Works", "Steel", 4, "Basic iron and steel · tmpupload1.csv", "estimated", { purchasedGoodsCategoryId: "steel", purchasedGoodsCategoryLabel: "Metals" })],
      target: { baselineYear: 2024, baselineTco2e: 60, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2024, baselineIntensity: 4,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId: "j-c3", version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 14 }, { scope: "2", value: 6 }, { scope: "3", value: 30 }] }, { year: 2025, values: [{ scope: "1", value: 10 }, { scope: "2", value: 5 }, { scope: "3", value: 24 }] }],
      provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: "2025-01-01", to: "2025-12-31" }, boundary: { siteIds: ["s-a", "s-b"], excludedRowIds: [] },
        factorSets: [
          { source: "dataset", id: "uk-ghg-gb-2025", name: "upload-2019-2025.xlsx", version: "upload-2019-2025.xlsx" },
          { source: "dataset", id: "uk-ghg-gb-2026", name: "tmpupload1.csv", version: "tmpupload1.csv" }] } };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, 'snap-c3', 'j-c3', 1, 1, $2, $3::jsonb, 'prep', 'rev', now())`, [ORG, `sha256:${createHash("sha256").update("snap-c3").digest("hex")}`, JSON.stringify(payload)]);
    wholeId = await validate();
    wholePreview = await preview(wholeId);
    await publish(wholeId);
    annexId = await validate({ kind: "sites", siteIds: ["s-b"] });
    await publish(annexId);
  });
  after(async () => { await database?.end(); });

  it("a report composed now is drawn composed@6 (composed@3's freeze carried forward) and names its sources by dataset id, frozen", async () => {
    const issued = await frozen(wholeId);
    assert.equal(issued.renderer, "composed@6", "B2-4: a new composition carries its narrative, so it is drawn composed@6");
    assert.deepEqual(issued.sources, {
      summary: "Reviewed snapshot J-c3 · DESNZ GB 2025 · DESNZ GB 2026",
      sets: [{ source: "dataset", id: "uk-ghg-gb-2025", label: "DESNZ GB 2025" }, { source: "dataset", id: "uk-ghg-gb-2026", label: "DESNZ GB 2026" }],
    });
  });

  it("freezes the audit appendix: every row, its factor and dataset by id — no upload file name, no quantity", async () => {
    const issued = await frozen(wholeId);
    assert.deepEqual(issued.audit!.rows.map((entry) => [entry.scopeCode, entry.activity, entry.site, entry.factor, entry.source, entry.qualityTier, entry.tco2e]), [
      ["1", "Gas", "Works", "Natural gas", "DESNZ GB 2025", "measured", 6], ["1", "Gas", "Works", "Natural gas", "DESNZ GB 2025", "measured", 4],
      ["2", "Electricity", "Annex", "UK electricity", "DESNZ GB 2025", "measured", 5],
      ["3.1", "Goods", null, "Manufacture of goods", "DESNZ GB 2026", "estimated", 20], ["3.1", "Steel", "Works", "Basic iron and steel", "DESNZ GB 2026", "estimated", 4],
    ]);
    assert.equal(issued.audit!.totalTco2e, 39);
    assert.ok(!("emissions" in issued && "state" in issued.emissions) && issued.audit!.totalTco2e === (issued.emissions as { totalTco2e: number }).totalTco2e, "the appendix sums to the report's total");
    assert.doesNotMatch(JSON.stringify({ sources: issued.sources, audit: issued.audit }), /\.csv|\.xlsx|4100000|GBP/);
  });

  it("a site view's appendix is its own: only its sites' rows, summing to its total", async () => {
    const issued = await frozen(annexId);
    assert.equal(issued.renderer, "composed@6", "B2-4: a new composition carries its narrative, so it is drawn composed@6");
    assert.deepEqual(issued.audit!.rows.map((entry) => entry.activity), ["Electricity"]);
    assert.equal(issued.audit!.totalTco2e, (issued.emissions as { totalTco2e: number }).totalTco2e);
  });

  it("the preview composes exactly what publish froze — its sources and appendix included", async () => {
    const issued = await frozen(wholeId);
    const { issuedAt: _a, ...fromPreview } = wholePreview, { issuedAt: _b, ...fromFrozen } = issued;
    // As stored: the frozen copy is JSON, so a field the preview holds as `undefined` is simply absent from it.
    assert.deepEqual(JSON.parse(JSON.stringify(fromPreview)), fromFrozen);
    assert.ok(fromFrozen.sources && fromFrozen.audit, "the comparison covers both new fields");
  });
});
