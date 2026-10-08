import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type ReportIntensitySection, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { validateCrpReport } from "../src/postgresCommands";
import { composeAssuredActuals, composeForReportVersion } from "../src/reportCompositions";
import { setClientIntensityTarget } from "../src/clientIntensityTargets";
import { withTenantRead } from "../src/postgres";

/**
 * Reporting RF (RULING-reporting-RF), against a real database:
 * - RF-1: the Intensity section lists every active measure, each denominator through `denominatorFor` over the sites the
 *   job reports on (3a) — so floor area resolves, and a left-out site moves it — and marks the measure the CRP reports,
 *   read from the reviewed snapshot (3c-3, frozen at review): its figure is the snapshot's, even when the job's Value was
 *   corrected afterwards or the client has since reordered; a pre-3c snapshot marks nothing.
 * - RF-2: the pathway's actuals take one snapshot per reporting period, latest version — a year frozen twice counts once —
 *   and the report's own period is the snapshot it was validated against.
 */
const ORG = "rf-org";
const CLIENT = "rf-client";

describe("reporting re-foundation (RF-1, RF-2), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `rf-${keys}`, correlationId: `corr-rf-${keys}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const job = (jobId: string, sequence: number, year: number) => q(
    `INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', $5)`,
    [ORG, jobId, CLIENT, sequence, year]).then(() => q(
    `INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, $3, $4, 'GB')`,
    [ORG, jobId, `${year}-01-01`, `${year}-12-31`]));
  const measurements = (s1: number, s2: number, s3: number) => [
    { scope: "1", scopeCode: "1", siteId: "s-a", siteLabel: "Works", tco2e: s1, qualityTier: "measured", factorSet: "demo" },
    { scope: "2", scopeCode: "2", siteId: "s-a", siteLabel: "Works", tco2e: s2, qualityTier: "measured", factorSet: "demo" },
    { scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, tco2e: s3, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }];
  const snapshot = async (snapshotId: string, jobId: string, version: number, year: number, rows: unknown[], intensityTarget: unknown) => {
    const payload = { jobNumber: `J00${jobId}`, client: "RF Client", reportingYear: year, measurements: rows,
      target: { baselineYear: 2024, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget,
      annualComparison: [{ year: year - 1, values: [{ scope: "1", value: 12 }] }, { year, values: [{ scope: "1", value: 10 }] }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
      VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, 'ada', 'rev', now())`, [ORG, snapshotId, jobId, version, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload)]);
  };
  const clientTarget = { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5,
    baselineYear: 2024, baselineIntensity: 6, interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null,
    jobId: "job-rf", version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" };
  const compose = async (snapshotId: string) => {
    const validated = await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1 }, context("rev", "reviewer"));
    const composition = await withTenantRead(database.pool, ORG, (db) => composeForReportVersion(db, { organisationId: ORG, reportVersionId: validated.data.reportVersionId, issuedAt: "2026-02-01T00:00:00.000Z" }));
    assert.ok(!("state" in composition.intensity), "the intensity section composed");
    return composition.intensity as ReportIntensitySection;
  };

  before(async () => {
    database = (await createDisposableDatabase("reportrefoundation"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'rev', 'reviewer', 'active', 'Rev Reviewer')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'RF Client', 'active', 'GBP')`, [ORG, CLIENT]);
    // Two in-service sites; the job leaves one out (3a), so floor area is the Works' 1,000 m² alone.
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, 's-a', 'Works', '2020-01-01', 'seed'), ($1, $2, 's-b', 'Annex', '2020-01-01', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_site_floor_areas (organisation_id, floor_area_id, site_id, effective_from, floor_area_m2, recorded_by) VALUES ($1, 'fa-a', 's-a', NULL, 1000, 'seed'), ($1, 'fa-b', 's-b', NULL, 500, 'seed')`, [ORG]);
    for (const [key, label, unit, divider, kind, source, ordering] of [
      ["employees", "Employees", "employee", 1, "text", "entered", 1],
      ["turnover", "Turnover", "turnover", 1000000, "currency", "entered", 2],
      ["floor-area", "Floor area", "m²", 1, "text", "site-floor-area", 3]] as const) {
      await q(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, unit_kind, set_by, correlation_id)
               VALUES ($1, $2, $3, 1, $4, $5, $6, 'metric', true, $7, true, $8, $9, 'seed', 'seed')`, [ORG, CLIENT, key, label, unit, divider, source, ordering, kind]);
    }
    await job("job-rf", 9401, 2025);
    await q(`INSERT INTO nzi_console.job_site_inclusions (organisation_id, job_id, site_id, version, included, reason, decided_by, correlation_id) VALUES ($1, 'job-rf', 's-b', 1, false, 'annex reported separately', 'ada', 'seed')`, [ORG]);
    // The turnover Value was corrected after the review froze £12.5m; employees recorded; floor area never typed.
    await q(`INSERT INTO nzi_console.job_intensity_values (organisation_id, job_id, reporting_year, metric_key, value, recorded_by) VALUES ($1, 'job-rf', 2025, 'turnover', 14000000, 'ada'), ($1, 'job-rf', 2025, 'employees', 50, 'ada')`, [ORG]);
    await snapshot("snap-rf", "job-rf", 1, 2025, measurements(10, 5, 20), clientTarget);
  });
  after(async () => { await database?.end(); });

  it("lists every measure in the client's order, resolves floor area from the sites the job reports on, and marks the CRP's measure", async () => {
    const intensity = await compose("snap-rf");
    assert.deepEqual(intensity.metrics.map((metric) => metric.key), ["employees", "turnover", "floor-area"], "the client's order — the reported one is not floated");
    assert.equal(intensity.reportedMetricKey, "turnover");
    assert.deepEqual(intensity.metrics.map((metric) => metric.reported), [false, true, false]);
    const [employees, turnover, floor] = intensity.metrics;
    // 35 tCO₂e over 1,000 m² — the left-out Annex is not in the denominator; before RF-1 this read "unavailable".
    assert.equal(floor!.value, 0.035);
    assert.equal(floor!.denominatorText, "1,000 m²");
    // The reported measure is the snapshot's £12.5m, not the £14m corrected since: 35 / 12.5 = 2.8, as the pathway draws.
    assert.equal(turnover!.value, 2.8);
    assert.equal(turnover!.denominatorText, "£12,500,000");
    assert.equal(turnover!.unit, "tCO₂e per £m");
    assert.equal(employees!.value, 0.7, "a context measure resolves at issue, as it always has");
  });

  it("keeps marking the snapshot's measure after the client reorders — publish does not re-decide the CRP's metric", async () => {
    await setClientIntensityTarget(database.pool, { clientId: CLIENT, metricKey: "employees", expectedVersion: 0, baselineYear: 2024, baselineIntensity: 1,
      interimYear: 2030, interimReductionPct: 50, targetYear: null, targetReductionPct: null } as never, context("ada", "admin"));
    await snapshot("snap-rf-2", "job-rf", 2, 2025, measurements(10, 5, 20), clientTarget);
    const intensity = await compose("snap-rf-2");
    assert.equal(intensity.reportedMetricKey, "turnover", "today's rule would pick employees; the review froze turnover");
  });

  it("marks nothing for a snapshot frozen before 3c-3 (a per-job intensity target)", async () => {
    await job("job-old", 9402, 2024);
    await snapshot("snap-old", "job-old", 1, 2024, measurements(10, 5, 20), { metric: "employee", denominatorUnit: "FTE", reportingDenominator: 50, baselineYear: 2023, baselineIntensity: 1,
      interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045, jobId: "job-old", version: 1, updatedAt: "2025-01-01T00:00:00.000Z", updatedBy: "ada" });
    const intensity = await compose("snap-old");
    assert.equal(intensity.reportedMetricKey, null);
    assert.ok(intensity.metrics.every((metric) => metric.reported === false));
  });

  it("takes one assured snapshot per period, latest version — a year frozen twice counts once (RF-2)", async () => {
    await job("job-prev", 9403, 2023);
    await snapshot("snap-prev-1", "job-prev", 1, 2023, measurements(30, 10, 10), clientTarget);
    await snapshot("snap-prev-2", "job-prev", 2, 2023, measurements(30, 10, 20), clientTarget);
    const actuals = await withTenantRead(database.pool, ORG, (db) => composeAssuredActuals(db, {
      clientId: CLIENT, snapshot: { id: "snap-rf", jobId: "job-rf", jobNumber: "J00job-rf", reportingYear: 2025, measurements: measurements(10, 5, 20) } }));
    assert.deepEqual(actuals.map((actual) => [actual.year, actual.tco2e, actual.snapshotId]), [
      [2023, 60, "snap-prev-2"],
      [2024, 35, "snap-old"],
      [2025, 35, "snap-rf"],
    ], "2023 once, at its latest version; the report's own period is its validated snapshot, not the job's latest (snap-rf-2)");
  });
});
