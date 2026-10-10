import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { resolveCrpCoreCharts } from "@nzi/charts";
import { commandGrantForRole, type CommandContext, type ReportComposition, type ReportScope, type ReviewedCrpSnapshotReadModel, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { listCurrentPublishedCrpReports } from "../src/readModels";
import { getReportComposition } from "../src/reportCompositions";
import { withTenantRead } from "../src/postgres";

/**
 * Reporting F-2 (chart parity; RULING-reporting-F4 D2), against a real database: a report composed now freezes its charts'
 * input and is drawn `composed@2`. The bar is parity — a whole-client report's charts, drawn from the frozen basis, are the
 * charts the portal draws today from the published snapshot (`PortalWorkspace`'s exact call), so moving the portal onto the
 * composed report (F-4) costs a client no chart. The one deliberate difference is the reduction pathway: the portal's draws
 * the superseded job-level target on the snapshot; the composed report draws its own Targets section (the client target
 * model, NZC-072), so the basis never carries the job target. A site report's basis is its own: its sites' rows, its own
 * year-on-year, and no client-level intensity pathway drawn against site actuals.
 */
const ORG = "parity-org";
const CLIENT = "parity-client";

/** The portal's call today, verbatim in shape (`PortalWorkspace.tsx` Results). */
const portalCharts = (snapshot: ReviewedCrpSnapshotReadModel) => resolveCrpCoreCharts({
  id: snapshot.id, jobId: snapshot.jobId, jobNumber: snapshot.jobNumber, client: snapshot.client, reportingYear: snapshot.reportingYear,
  generatedAt: snapshot.createdAt, dataHash: snapshot.dataHash, target: snapshot.target, intensityTarget: snapshot.intensityTarget,
  annualComparison: snapshot.annualComparison,
  measurements: snapshot.measurements.map((row) => ({ rowId: row.rowId, scope: row.scope, scopeCode: row.scopeCode, sourceLabel: row.sourceLabel, siteId: row.siteId,
    siteLabel: row.siteLabel, purchasedGoodsCategoryId: row.purchasedGoodsCategoryId, purchasedGoodsCategoryLabel: row.purchasedGoodsCategoryLabel, tco2e: row.tco2e, factorSet: row.factorSet })),
} as Parameters<typeof resolveCrpCoreCharts>[0]);
const basisCharts = (composition: ReportComposition) => resolveCrpCoreCharts(composition.chartBasis as Parameters<typeof resolveCrpCoreCharts>[0]);
const types = (charts: ReturnType<typeof resolveCrpCoreCharts>) => charts.map((chart) => chart.spec.type);

describe("a composed report draws the portal's charts from its frozen basis (F-2), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `cp-${count}`, correlationId: `corr-cp-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const issue = async (snapshotId: string, scope?: ReportScope) => {
    const id = (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1, ...(scope ? { scope } : {}) }, context("rev", "reviewer"))).data.reportVersionId;
    await publishCrpReport(database.pool, { reportVersionId: id, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: snapshotId }, context("rev", "reviewer"));
    return id;
  };
  const composition = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, id)))!;
  let whole = "", works = "";

  before(async () => {
    database = (await createDisposableDatabase("reportchartparity"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Parity Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, 's-a', 'Works', '2020-01-01', 'seed'), ($1, $2, 's-b', 'Annex', '2020-01-01', 'seed')`, [ORG, CLIENT]);
    // The client target model the report's Targets section (and its pathway) reads: a 2024 benchmark of 64 t, 50% by 2030,
    // 90% by 2045 — net zero at a 6.4 t residual. The snapshot's job target below differs on purpose (60 t, flat zero).
    await q(`INSERT INTO nzi_console.client_targets (organisation_id, client_id, version, near_term_year, near_term_pct, net_zero_year, net_zero_pct, benchmark_year, benchmark_total_tco2e, benchmark_source, set_by, correlation_id)
             VALUES ($1, $2, 1, 2030, 50, 2045, 90, 2024, 64, 'client-record', 'fixture', 'fixture')`, [ORG, CLIENT]);
    // Turnover, the measure the snapshots report — so the Intensity section is composed, and its pathway is drawn beside it.
    await q(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, unit_kind, set_by, correlation_id)
             VALUES ($1, $2, 'turnover', 1, 'Turnover', '£m', 1000000, 'currency', true, 'entered', true, 1, 'currency', 'seed', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, 'j-prev', $2, 9811, 'crp', 'CRP', 'open', 'delivery', 2024), ($1, 'j-cur', $2, 9812, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, CLIENT]);
    for (const [jobId, year] of [["j-prev", 2024], ["j-cur", 2025]] as const) {
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, $3, $4, 'GB')`, [ORG, jobId, `${year}-01-01`, `${year}-12-31`]);
    }
    const snapshot = async (snapshotId: string, jobId: string, year: number, works: number, annex: number, goods: number) => {
      const payload = { jobNumber: `J-${jobId}`, client: "Parity Co", reportingYear: year,
        measurements: [
          { rowId: `${snapshotId}-a`, scope: "1", scopeCode: "1", siteId: "s-a", siteLabel: "Works", sourceLabel: "Gas", tco2e: works, qualityTier: "measured", factorSet: "demo" },
          { rowId: `${snapshotId}-b`, scope: "2", scopeCode: "2", siteId: "s-b", siteLabel: "Annex", sourceLabel: "Electricity", tco2e: annex, qualityTier: "measured", factorSet: "demo" },
          { rowId: `${snapshotId}-g`, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: goods, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" },
          { rowId: `${snapshotId}-w`, scope: "3", scopeCode: "3.1", siteId: "s-a", siteLabel: "Works", sourceLabel: "Steel", tco2e: 4, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "steel", purchasedGoodsCategoryLabel: "Metals" }],
        target: { baselineYear: 2024, baselineTco2e: 60, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
        intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2024, baselineIntensity: 4,
          interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
        annualComparison: [{ year: 2024, values: [{ scope: "1", value: 14 }, { scope: "2", value: 6 }, { scope: "3", value: 30 }] }, { year, values: [{ scope: "1", value: works }, { scope: "2", value: annex }, { scope: "3", value: goods + 4 }] }],
        provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: `${year}-01-01`, to: `${year}-12-31` }, factorSets: [], boundary: { siteIds: ["s-a", "s-b"], excludedRowIds: [] } } };
      await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
               VALUES ($1, $2, $3, 1, 1, $4, $5::jsonb, 'prep', 'rev', now())`, [ORG, snapshotId, jobId, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload)]);
    };
    await snapshot("snap-prev", "j-prev", 2024, 14, 6, 26);
    await snapshot("snap-cur", "j-cur", 2025, 10, 5, 20);
    await q(`INSERT INTO nzi_console.job_intensity_values (organisation_id, job_id, reporting_year, metric_key, value, recorded_by) VALUES ($1, 'j-cur', 2025, 'turnover', 12500000, 'ada')`, [ORG]);
    await issue("snap-prev");
    whole = await issue("snap-cur");
    works = await issue("snap-cur", { kind: "sites", siteIds: ["s-a"] });
  });
  after(async () => { await database?.end(); });

  it("a report composed now is drawn composed@2 and carries its charts' input", async () => {
    const issued = await composition(whole);
    assert.equal(issued.renderer, "composed@2");
    assert.ok(issued.chartBasis && issued.chartBasis.measurements.length === 4);
    if (process.env.F2_DUMP) writeFileSync(process.env.F2_DUMP, JSON.stringify(issued, null, 2));
  });

  it("parity: a whole-client report's charts are exactly the portal's — every one but the pathway, which is the report's own", async () => {
    const issued = await composition(whole);
    const published = (await withTenantRead(database.pool, ORG, (db) => listCurrentPublishedCrpReports(db, "j-cur"))).find((report) => report.reportVersionId === whole)!;
    const fromBasis = basisCharts(issued), fromPortal = portalCharts(published.snapshot);
    assert.deepEqual(types(fromBasis), ["emissions_scope_donut", "scope_year_on_year_bar", "emissions_by_activity", "intensity_pathway", "emissions_site_donut", "purchased_goods_breakdown"]);
    assert.deepEqual(fromBasis, fromPortal.filter((chart) => chart.spec.type !== "reduction_pathway"), "chart for chart, value for value");
    assert.ok(types(fromPortal).includes("reduction_pathway"), "the portal draws one today — composed@2 draws the report's own (console: reportComposedV2)");
  });

  it("never freezes the superseded job-level target; the Targets section the pathway is drawn from is the client's", async () => {
    const issued = await composition(whole);
    assert.ok(!("target" in issued.chartBasis!), "no job target in the basis");
    assert.doesNotMatch(JSON.stringify(issued.chartBasis), /baselineTco2e/);
    if (!issued.targets || "state" in issued.targets) throw new Error("expected composed targets");
    assert.deepEqual(issued.targets.trajectory.map((point) => [point.kind, point.year, Math.round(point.tco2e * 1000) / 1000]), [["benchmark", 2024, 64], ["near-term", 2030, 32], ["net-zero", 2045, 6.4]],
      "the client model's 64 t benchmark and 6.4 t residual — not the snapshot's 60 t to zero");
  });

  it("a site report's charts are its own: its sites' rows, its own year-on-year, and no client-level pathway", async () => {
    const issued = await composition(works);
    const charts = basisCharts(issued);
    assert.deepEqual(types(charts), ["emissions_scope_donut", "scope_year_on_year_bar", "emissions_by_activity", "emissions_site_donut", "purchased_goods_breakdown"]);
    const donut = charts.find((chart) => chart.spec.type === "emissions_scope_donut") as unknown as { segments: Array<{ scope: string; value: number }> };
    assert.deepEqual(donut.segments.map((segment) => [segment.scope, segment.value]).filter(([, value]) => Number(value) > 0), [["1", 10], ["3", 4]], "Works' 10 t and its 4 t of steel — not Annex, not organisation-level goods");
    const purchased = charts.find((chart) => chart.spec.type === "purchased_goods_breakdown") as unknown as { activities: Array<{ label: string; value: number }> };
    assert.deepEqual(purchased.activities.map((activity) => [activity.label, activity.value]), [["Metals", 4]]);
    const yoy = charts.find((chart) => chart.spec.type === "scope_year_on_year_bar") as unknown as { years: Array<{ year: number; values: Array<{ scope: string; value: number }> }> };
    assert.deepEqual(yoy.years.map((year) => [year.year, year.values.reduce((sum, value) => sum + value.value, 0)]), [[2024, 18], [2025, 14]], "Works' own history (14 + 4 steel, then 10 + 4), from the comparison");
    assert.equal(issued.chartBasis!.intensityTarget, null);
  });
});
