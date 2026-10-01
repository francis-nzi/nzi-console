import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { setClientIntensityMetric } from "../src/intensityMetrics";
import { getJobAnnualMetrics, listClientIntensityMetrics } from "../src/intensityMetricRecords";
import { getPortalClientIntensity } from "../src/portalIntensity";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { withTenantRead } from "../src/postgres";
import { getReportComposition } from "../src/reportCompositions";

/**
 * Currency-driven intensity (admin Phase D, D3c; ruled `phaseD3-plan.md` C) against a real database: a client metric
 * created as a currency metric and keeping that kind on every later version; the job and portal read models carrying
 * the client's currency; and a report issued for a euro client freezing "tCO₂e per €m" — the unit stamped right at
 * source, in the client's currency, never the bare "£m" wording.
 */
const ORG = "cur-org";

describe("Currency intensity (D3c), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `cur-${keys}`, correlationId: `corr-cur-${keys}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };

  before(async () => {
    database = (await createDisposableDatabase("currencyintensity"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Currency Org')`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES
      ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'rev', 'reviewer', 'active', 'Rev Reviewer')`, [ORG]);
    // A euro client, a dirham client stored as "UAE" (Q5), and a sterling one.
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES
      ($1, 'eu', 'Euro Client', 'active', 'EUR'), ($1, 'ae', 'Dirham Client', 'active', 'UAE'), ($1, 'gb', 'Sterling Client', 'active', 'GBP')`, [ORG]);
    // E1: the organisation's set (0145 provisioned GBP; an admin adds the euro, with a symbol of their own choosing) —
    // what currencySymbol reads in a report. "EU€" is not the built-in €, so a report reading it proves the table is read.
    await q(`INSERT INTO nzi_console.currencies (organisation_id, code, name, symbol, created_by, updated_by) VALUES ($1, 'EUR', 'Euro', 'EU€', 'ada', 'ada')`, [ORG]);
  });
  after(async () => { await database?.end(); });

  it("creates a currency metric, keeps its kind on every later version, and refuses an unknown kind", async () => {
    await setClientIntensityMetric(database.pool, { clientId: "eu", metricKey: "revenue", label: "Revenue", unitWording: "currency", unitKind: "currency", divider: 1000000, iconKey: "currency", expectedVersion: 0 }, context("ada", "admin"));
    await setClientIntensityMetric(database.pool, { clientId: "eu", metricKey: "vehicles", label: "Vehicles", unitWording: "vehicle", divider: 1, iconKey: "vehicle", expectedVersion: 0 }, context("ada", "admin"));
    // A later edit that says nothing about the kind keeps it.
    await setClientIntensityMetric(database.pool, { clientId: "eu", metricKey: "revenue", label: "Revenue", unitWording: "currency", divider: 1000, iconKey: "currency", expectedVersion: 1 }, context("ada", "admin"));
    const metrics = await withTenantRead(database.pool, ORG, (db) => listClientIntensityMetrics(db, "eu"));
    assert.deepEqual(metrics.map((metric) => [metric.key, metric.version, metric.unitKind]).sort(), [["revenue", 2, "currency"], ["vehicles", 1, "text"]]);
    const audit = await q(`SELECT after_json FROM nzi_console.audit_events WHERE action = 'client_intensity_metric_set' AND entity_id = 'eu:revenue' ORDER BY occurred_at DESC LIMIT 1`);
    assert.equal(audit[0]?.after_json.unitKind, "currency", "the kind is in the audit trail");
    await assert.rejects(setClientIntensityMetric(database.pool, { clientId: "eu", metricKey: "odd", label: "Odd", unitWording: "x", unitKind: "money" as never, divider: 1, iconKey: "metric", expectedVersion: 0 }, context("ada", "admin")), /Command validation failed/);
  });

  it("carries the client's currency on the job and portal read models", async () => {
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage) VALUES ($1, 'job-ae', 'ae', 9101, 'crp', 'Dirham CRP', 'open', 'delivery')`, [ORG]);
    const annual = await withTenantRead(database.pool, ORG, (db) => getJobAnnualMetrics(db, "job-ae", 2025));
    assert.equal(annual?.currency, "UAE", "as stored — the display reads it as AED (currencySymbol)");
    const portal = await withTenantRead(database.pool, ORG, (db) => getPortalClientIntensity(db, { portalUserId: "nobody", clientId: "gb" }));
    assert.equal(portal.currency, "GBP");
  });

  it("freezes the unit into an issued report in the client's currency — \"tCO₂e per €m\", not \"£m\"", async () => {
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage) VALUES ($1, 'job-eu', 'eu', 9102, 'crp', 'Euro CRP', 'open', 'delivery')`, [ORG]);
    await q(`INSERT INTO nzi_console.job_intensity_values (organisation_id, job_id, reporting_year, metric_key, value, recorded_by) VALUES ($1, 'job-eu', 2025, 'revenue', 7000000, 'ada')`, [ORG]);
    const payload = { jobNumber: "J009102", client: "Euro Client", reportingYear: 2025,
      measurements: [
        { scope: "Scope 1", scopeCode: "1", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { scope: "Scope 2", scopeCode: "2", tco2e: 5, qualityTier: "measured", factorSet: "demo" },
        { scope: "Scope 3", scopeCode: "3.1", tco2e: 20, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
      target: { baselineYear: 2024, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { metric: "turnover", denominatorUnit: "€m", reportingDenominator: 7, baselineYear: 2024, baselineIntensity: 6, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
      VALUES ($1, 'snap-eu', 'job-eu', 1, 1, $2, $3::jsonb, 'ada', 'rev', now())`, [ORG, `sha256:${"c".repeat(64)}`, JSON.stringify(payload)]);
    const validated = await validateCrpReport(database.pool, { reviewedSnapshotId: "snap-eu", manifestVersion: 1 }, context("rev", "reviewer"));
    await publishCrpReport(database.pool, { reportVersionId: validated.data.reportVersionId, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: "snap-eu" }, context("rev", "reviewer"));
    const composition = await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, validated.data.reportVersionId));
    const intensity = composition?.intensity;
    assert.ok(intensity && !("state" in intensity), "the intensity section composed");
    const revenue = intensity.metrics.find((metric) => metric.key === "revenue");
    // 35 tCO₂e over €7,000,000 at the per-€k divider the metric now carries: 0.005 tCO₂e per €k.
    assert.equal(revenue?.unit, "tCO₂e per EU€k", "frozen in the issuing organisation's own symbol (E1), not a built-in one");
    assert.ok(Math.abs((revenue?.value ?? 0) - 0.005) < 1e-9);
    assert.equal(intensity.metrics.find((metric) => metric.key === "vehicles")?.unit, "tCO₂e / vehicle", "a text metric reads as it always has");
  });
});
