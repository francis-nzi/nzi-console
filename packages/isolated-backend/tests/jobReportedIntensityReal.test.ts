import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { resolveJobReportedIntensity } from "../src/jobReportedIntensity";
import { getJobAnnualMetrics } from "../src/intensityMetricRecords";
import { deactivateClientIntensityTarget, setClientIntensityTarget } from "../src/clientIntensityTargets";
import { resolveNziFacts } from "../src/srsReadiness";
import { withTenantRead } from "../src/postgres";

/**
 * Phase 3c, the reported intensity (RULING-3c3-intensity-readers), against a real database:
 * - the CRP reports the first active standard metric (turnover / employees / floor area), in the client's ordering, with
 *   an active client target — reordering the client's metrics changes it; a custom metric's target alone reports nothing
 *   (ruled (1));
 * - the drawer's read names the same metric (ruled (2)): one rule;
 * - the year's Value is the job's, over the metric's divider and in the unit the drawer shows (a currency metric per £m);
 * - the milestones are the target's own (addendum (i)): an optional interim and an end point at its percentage, never a
 *   net zero the client did not commit to;
 * - SRS counts intensity bases from the client's targets and its jobs' Values, not the retired per-job rows.
 */
const ORG = "ri-org";
const CLIENT = "ri-client";
const JOB = "ri-job";

describe("the intensity a job's CRP reports (Phase 3c), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `ri-${keys}`, correlationId: `corr-ri-${keys}`, grant: commandGrantForRole("admin", ORG, "ada"), ...(reason ? { reason } : {}) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const reported = () => withTenantRead(database.pool, ORG, (db) => resolveJobReportedIntensity(db, JOB));
  const drawer = () => withTenantRead(database.pool, ORG, (db) => getJobAnnualMetrics(db, JOB, 2026));
  const metric = (key: string, label: string, unit: string, version: number, ordering: number, divider = 1, unitKind = "text") => q(
    `INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, unit_kind, set_by, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'metric', $8, 'entered', true, $9, $10, 'seed', 'seed')`,
    [ORG, CLIENT, key, version, label, unit, divider, key !== "beds", ordering, unitKind]);
  const value = (key: string, amount: number | null, version = 1) => q(
    `INSERT INTO nzi_console.job_intensity_values (organisation_id, job_id, reporting_year, metric_key, value, version, recorded_by) VALUES ($1, $2, 2026, $3, $4, $5, 'ada')
     ON CONFLICT (organisation_id, job_id, reporting_year, metric_key, period_key) DO UPDATE SET value = EXCLUDED.value, version = EXCLUDED.version`, [ORG, JOB, key, amount, version]);
  const target = (metricKey: string, over: Record<string, unknown> = {}) => setClientIntensityTarget(database.pool, { clientId: CLIENT, metricKey, expectedVersion: 0,
    baselineYear: 2022, baselineIntensity: 10, interimYear: 2030, interimReductionPct: 40, targetYear: 2040, targetReductionPct: 70, ...over } as never, context());

  before(async () => {
    database = (await createDisposableDatabase("reportedintensity"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9301, 'crp', 'CRP', 'open', 'delivery', 2026)`, [ORG, JOB, CLIENT]);
    // A custom metric first in the order, then employees (per 1,000), then turnover (a currency metric, per £m).
    await metric("beds", "Beds", "bed", 1, 1);
    await metric("employees", "Employees", "employee", 1, 2, 1000);
    await metric("turnover", "Turnover", "turnover", 1, 3, 1000000, "currency");
  });
  after(async () => { await database?.end(); });

  it("reports nothing until a standard metric has a target — a custom metric's target alone is not reported (ruled (1))", async () => {
    assert.equal(await reported(), null);
    await target("beds");
    assert.equal(await reported(), null, "a target on a custom metric is not the reported one");
    const read = (await drawer())!;
    assert.equal(read.reportedMetricKey, null);
    assert.deepEqual(read.targets.map((entry) => entry.metricKey), ["beds"], "the custom metric's target still shows in the drawer");
  });

  it("reports the first targeted standard metric in the client's order, with the job's Value over its divider", async () => {
    await target("turnover", { baselineIntensity: 4, interimYear: null, interimReductionPct: null, targetYear: 2035, targetReductionPct: 50 });
    await value("turnover", 12_500_000);
    const turnover = (await reported())!;
    assert.deepEqual([turnover.source, turnover.metric, turnover.metricLabel], ["client-target", "turnover", "Turnover"]);
    assert.equal(turnover.denominatorUnit, "£m", "a currency metric reads per £m, as the drawer does");
    assert.equal(turnover.reportingDenominator, 12.5, "£12,500,000 over the £m divider");
    // The target's own milestones (addendum (i)): no interim stated, an end point at −50% — no net zero it did not commit to.
    assert.deepEqual([turnover.baselineYear, turnover.baselineIntensity, turnover.interimYear, turnover.targetYear, turnover.targetReductionPercent, turnover.netZeroYear],
      [2022, 4, null, 2035, 50, null]);
    assert.equal((await drawer())!.reportedMetricKey, "turnover", "the drawer names the same metric — one rule");

    // Employees come earlier in the client's order: once they have a target, they are the reported metric.
    await target("employees");
    await value("employees", 431);
    const employees = (await reported())!;
    assert.equal(employees.metric, "employee");
    assert.equal(employees.denominatorUnit, "1,000 employees");
    assert.equal(employees.reportingDenominator, 0.431);
    assert.deepEqual([employees.interimYear, employees.interimReductionPercent, employees.targetYear, employees.targetReductionPercent], [2030, 40, 2040, 70]);
    assert.equal((await drawer())!.reportedMetricKey, "employees");
  });

  it("follows the client's reordering (ruled (2))", async () => {
    await metric("turnover", "Turnover", "turnover", 2, 0, 1000000, "currency");
    assert.equal((await reported())!.metric, "turnover");
    assert.equal((await drawer())!.reportedMetricKey, "turnover");
  });

  it("an unrecorded Value is null — the report says the intensity is unavailable, never a nought", async () => {
    await value("turnover", null, 2);
    assert.equal((await reported())!.reportingDenominator, null);
  });

  it("counts SRS intensity bases from the client's targets and its jobs' Values, not the retired per-job rows", async () => {
    // Targeted and valued: employees (431). Turnover's Value was just cleared; beds has a target but no Value.
    const facts = await withTenantRead(database.pool, ORG, (db) => resolveNziFacts(db, CLIENT));
    assert.equal(facts.intensityBasesResolved, 1);
  });

  it("a withdrawn target is not reported: the next targeted standard metric is, and the drawer agrees", async () => {
    await deactivateClientIntensityTarget(database.pool, { clientId: CLIENT, metricKey: "turnover", expectedVersion: 1 }, context("turnover no longer a reported basis"));
    assert.equal((await reported())!.metric, "employee");
    assert.equal((await drawer())!.reportedMetricKey, "employees");
  });
});
