import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type ReportComposition, type ReportEmissionsSection, type ReportIntensitySection, type ReportScope, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { validateCrpReport } from "../src/postgresCommands";
import { composeForReportVersion } from "../src/reportCompositions";
import { withTenantRead } from "../src/postgres";

/**
 * Reporting S-2 (RULING-reporting-site-scope R-S1 (A′) + sub-rulings; RULING-reporting-S.md), against a real database: a
 * report version's composition recomposed for its scope, from the snapshot's frozen rows —
 * - whole client: every row, the organisation-level line inside the total;
 * - a site scope: only its sites; organisation-level excluded and stated, never apportioned; "every site" still excludes it;
 * - year-on-year: columns from the assured periods that exist (baseline, previous, current), each filtered by the scope; a
 *   period frozen before rows carried a site is not attributable, never nought; two jobs on one period flagged, not summed;
 * - intensity: floor area over the selected sites (and per site); turnover "reported at whole-client level only";
 * - the scope recorded on the composition, its sites named from the frozen rows.
 */
const ORG = "scomp-org";
const CLIENT = "scomp-client";

describe("a report composed for its scope (S-2), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `scomp-${keys}`, correlationId: `corr-scomp-${keys}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const intensityTarget = { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2023, baselineIntensity: 6,
    interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId: "x", version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" };
  const job = async (jobId: string, sequence: number, year: number) => {
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', $5)`, [ORG, jobId, CLIENT, sequence, year]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, $3, $4, 'GB')`, [ORG, jobId, `${year}-01-01`, `${year}-12-31`]);
  };
  const snapshot = async (snapshotId: string, jobId: string, year: number, measurements: unknown[], stamp: string[] | null) => {
    const payload = { jobNumber: `J-${jobId}`, client: "Scope Co", reportingYear: year, measurements, intensityTarget,
      target: { baselineYear: 2023, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      annualComparison: [{ year: year - 1, values: [{ scope: "1", value: 12 }] }, { year, values: [{ scope: "1", value: 10 }] }],
      ...(stamp ? { provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: `${year}-01-01`, to: `${year}-12-31` }, factorSets: [], boundary: { siteIds: stamp, excludedRowIds: [] } } } : {}) };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, 1, 1, $4, $5::jsonb, 'ada', 'rev', now())`, [ORG, snapshotId, jobId, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload)]);
  };
  const row = (scope: string, tco2e: number, siteId: string | null, siteLabel: string | null, sourceLabel: string, extra: Record<string, unknown> = {}) =>
    ({ rowId: `${sourceLabel}-${siteId}`, scope, scopeCode: scope === "3" ? "3.1" : scope, siteId, siteLabel, sourceLabel, tco2e, qualityTier: "measured", factorSet: "demo", ...(scope === "3" ? { purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" } : {}), ...extra });
  const compose = async (scope?: ReportScope): Promise<ReportComposition> => {
    const validated = await validateCrpReport(database.pool, { reviewedSnapshotId: "snap-cur", manifestVersion: 1, ...(scope ? { scope } : {}) }, context("rev", "reviewer"));
    return withTenantRead(database.pool, ORG, (db) => composeForReportVersion(db, { organisationId: ORG, reportVersionId: validated.data.reportVersionId, issuedAt: "2026-02-01T00:00:00.000Z" }));
  };
  const emissionsOf = (composition: ReportComposition) => composition.emissions as ReportEmissionsSection;
  const intensityOf = (composition: ReportComposition) => composition.intensity as ReportIntensitySection;

  before(async () => {
    database = (await createDisposableDatabase("reportscopecomposition"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    // The client's baseline is 2023 (the comparison's baseline column comes from the assured period for that year).
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency, baseline_period_start, baseline_total_tco2e) VALUES ($1, $2, 'Scope Co', 'active', 'GBP', '2023-01-01', 30)`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, 's-a', 'Works', '2020-01-01', 'seed'), ($1, $2, 's-b', 'Annex', '2020-01-01', 'seed'), ($1, $2, 's-c', 'Depot', '2020-01-01', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_site_floor_areas (organisation_id, floor_area_id, site_id, effective_from, floor_area_m2, recorded_by) VALUES ($1, 'fa-a', 's-a', NULL, 1000, 'seed'), ($1, 'fa-b', 's-b', NULL, 500, 'seed'), ($1, 'fa-c', 's-c', NULL, 300, 'seed')`, [ORG]);
    for (const [key, label, unit, divider, kind, source, ordering] of [["turnover", "Turnover", "turnover", 1000000, "currency", "entered", 1], ["floor-area", "Floor area", "m²", 1, "text", "site-floor-area", 2]] as const) {
      await q(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, unit_kind, set_by, correlation_id)
               VALUES ($1, $2, $3, 1, $4, $5, $6, 'metric', true, $7, true, $8, $9, 'seed', 'seed')`, [ORG, CLIENT, key, label, unit, divider, source, ordering, kind]);
    }
    await job("j-legacy", 9701, 2023);
    await job("j-prev", 9702, 2024);
    await job("j-cur", 9703, 2025);
    // 2023 was frozen before rows carried a site; 2024 carries sites; 2025 is the report's own.
    await snapshot("snap-legacy", "j-legacy", 2023, [{ rowId: "l1", scope: "1", tco2e: 30, factorSet: "demo", qualityTier: "measured" }], null);
    await snapshot("snap-prev", "j-prev", 2024, [row("1", 12, "s-a", "Works", "Gas"), row("3", 18, null, null, "Goods")], ["s-a", "s-b", "s-c"]);
    await snapshot("snap-cur", "j-cur", 2025, [row("1", 10, "s-a", "Works", "Gas"), row("2", 5, "s-b", "Annex", "Electricity"), row("3", 20, null, null, "Goods")], ["s-a", "s-b", "s-c"]);
  });
  after(async () => { await database?.end(); });

  it("whole client: every row, the organisation-level line inside the total, history from baseline to now", async () => {
    const composition = await compose();
    const emissions = emissionsOf(composition);
    assert.deepEqual(composition.scope, { kind: "whole" });
    assert.equal(composition.renderer, "composed@2", "F-0: a new composition names the layout it is issued under (F-2: composed@2)");
    assert.equal(emissions.totalTco2e, 35);
    assert.deepEqual(emissions.sites!.map((site) => [site.label, site.totalTco2e]), [["Works", 10], ["Annex", 5], ["Unallocated / organisation-level", 20]]);
    assert.equal(emissions.unallocated, undefined);
    assert.deepEqual(emissions.comparison!.columns.map((column) => [column.key, column.year]), [["baseline", 2023], ["previous", 2024], ["current", 2025]]);
    assert.deepEqual(emissions.comparison!.totals, [30, 30, 35]);
    assert.equal(emissions.periodConflicts, undefined);
    // Per-site floor-area intensity on the Sites page: Works 10 t over 1,000 m².
    assert.equal(emissions.sites![0]!.floorAreaIntensity!.value, 0.01);
    assert.equal(emissions.sites![2]!.floorAreaIntensity, undefined, "the organisation-level line has no floor");
    assert.equal(intensityOf(composition).metrics.find((metric) => metric.key === "turnover")!.value, 2.8, "RF-1 unchanged at whole-client scope");
  });

  it("a site scope: only the site's rows; organisation-level excluded and stated; history filtered, a pre-site period not attributable", async () => {
    const composition = await compose({ kind: "sites", siteIds: ["s-a"] });
    const emissions = emissionsOf(composition);
    assert.deepEqual(composition.scope, { kind: "sites", siteIds: ["s-a"], siteLabels: ["Works"] });
    assert.equal(emissions.totalTco2e, 10, "20 t organisation-level is not apportioned to Works");
    assert.equal(emissions.unallocated?.tco2e, 20);
    assert.match(emissions.unallocated!.statement, /reported at whole-client level only and are not included in this site view/);
    assert.equal(emissions.priorYear, null, "a site view carries its history in the comparison");
    assert.deepEqual(emissions.comparison!.totals, [null, 12, 10], "2023 cannot be attributed; 2024's Works rows only");
    assert.match(emissions.comparison!.notes[0]!, /FY2023 was frozen before its rows carried a site/);
    const intensity = intensityOf(composition);
    const turnover = intensity.metrics.find((metric) => metric.key === "turnover")!, floor = intensity.metrics.find((metric) => metric.key === "floor-area")!;
    assert.deepEqual([turnover.value, turnover.scopeNote, turnover.reported], [null, "Reported at whole-client level only", true], "never apportioned; the CRP mark stays");
    assert.deepEqual([floor.value, floor.denominatorText], [0.01, "1,000 m²"], "Works' own floor area");
  });

  it("'every site' still excludes organisation-level, and lists a boundary site with no rows as a read zero", async () => {
    const emissions = emissionsOf(await compose({ kind: "sites", siteIds: ["s-a", "s-b", "s-c"] }));
    assert.equal(emissions.totalTco2e, 15, "not the whole client's 35");
    assert.deepEqual(emissions.sites!.map((site) => [site.label, site.totalTco2e]), [["Works", 10], ["Annex", 5], ["Depot", 0]]);
    assert.equal(emissions.unallocated?.tco2e, 20);
  });

  it("flags a reporting period two jobs both report — never summed, never silently picked", async () => {
    await job("j-dup", 9704, 2024);
    await snapshot("snap-dup", "j-dup", 2024, [row("1", 99, "s-a", "Works", "Gas")], ["s-a"]);
    const emissions = emissionsOf(await compose({ kind: "sites", siteIds: ["s-b"] }));
    assert.deepEqual(emissions.periodConflicts, [{ period: "01/01/2024 – 31/12/2024", jobNumbers: ["J009702", "J009704"] }]);
  });
});
