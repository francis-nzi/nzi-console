import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { clientFacingComposition, clientFacingPublishedReport, commandGrantForRole, type CommandContext, type ReportComposition, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { getReportComposition } from "../src/reportCompositions";
import { getCurrentPublishedCrpReport } from "../src/readModels";
import { withTenantRead } from "../src/postgres";

/**
 * RULING-report-denominator (NZC-120) against a real database: a currency measure's denominator — the client's turnover —
 * crosses neither client boundary (the composition's chart basis; the client's copy of the published report). The year's
 * intensity goes in its place, equal at full precision to the Intensity section's reported value — on figures where the
 * resolver's divider-scaled division and the pathway's own differ in the last digit, so the guard is real. A non-currency
 * measure (employees) keeps its denominator at both boundaries. The staff-side snapshot keeps the turnover.
 */
const ORG = "ri-org";
const TONNES = 7508.8, TURNOVER = 17_925_590, TURNOVER_M = 17.92559; // (7508.8 × 10⁶) / (17.92559 × 10⁶) ≠ 7508.8 / 17.92559

describe("no currency denominator crosses to the client, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `ri-${count}`, correlationId: `corr-ri-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const issue = async (snapshotId: string) => {
    const id = (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1 }, context("rev", "reviewer"))).data.reportVersionId;
    await publishCrpReport(database.pool, { reportVersionId: id, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: snapshotId }, context("rev", "reviewer"));
    return id;
  };
  const composition = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, id)))!;
  const published = async (jobId: string) => (await withTenantRead(database.pool, ORG, (db) => getCurrentPublishedCrpReport(db, jobId)))!;
  const seedJob = async (input: { clientId: string; jobId: string; sequence: number; snapshotId: string; metric: "turnover" | "employee"; denominator: number }) => {
    const metricKey = input.metric === "turnover" ? "turnover" : "employees";
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, $2, 'active', 'GBP')`, [ORG, input.clientId]);
    await q(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, unit_kind, set_by, correlation_id)
             VALUES ($1, $2, $3, 1, $4, $5, $6, $7, true, 'entered', true, 1, $8, 'seed', 'seed')`,
      [ORG, input.clientId, metricKey, input.metric === "turnover" ? "Turnover" : "Employees", input.metric === "turnover" ? "£m" : "employee",
        input.metric === "turnover" ? 1_000_000 : 1, input.metric === "turnover" ? "currency" : "people", input.metric === "turnover" ? "currency" : "text"]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', 2025)`,
      [ORG, input.jobId, input.clientId, input.sequence]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, input.jobId]);
    const payload = { jobNumber: `J-${input.sequence}`, client: input.clientId, reportingYear: 2025,
      measurements: [{ rowId: `${input.jobId}-g`, scope: "1", scopeCode: "1", siteId: null, siteLabel: null, sourceLabel: "Gas", tco2e: TONNES, factorSet: "Gas · demo", qualityTier: "measured", factorSource: "dataset" }],
      target: { baselineYear: 2024, baselineTco2e: 9000, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: input.metric, metricLabel: input.metric === "turnover" ? "Turnover" : "Employees", denominatorUnit: input.metric === "turnover" ? "£m" : "employee",
        reportingDenominator: input.denominator, baselineYear: 2024, baselineIntensity: 500, interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100,
        netZeroYear: null, jobId: input.jobId, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
      annualComparison: [] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, 1, 1, $4, $5::jsonb, 'prep', 'rev', now())`, [ORG, input.snapshotId, input.jobId, `sha256:${createHash("sha256").update(input.snapshotId).digest("hex")}`, JSON.stringify(payload)]);
  };
  let turnoverId = "", employeesId = "";

  before(async () => {
    database = (await createDisposableDatabase("reportingintensity"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    await seedJob({ clientId: "ri-turnover", jobId: "j-ri-t", sequence: 9851, snapshotId: "snap-ri-t", metric: "turnover", denominator: TURNOVER_M });
    await seedJob({ clientId: "ri-people", jobId: "j-ri-e", sequence: 9852, snapshotId: "snap-ri-e", metric: "employee", denominator: 431 });
    turnoverId = await issue("snap-ri-t");
    employeesId = await issue("snap-ri-e");
  });
  after(async () => { await database?.end(); });

  const reportedValue = (issued: ReportComposition) => {
    if ("state" in issued.intensity) throw new Error("expected a composed intensity section");
    return issued.intensity.metrics.find((metric) => metric.reported)!.value;
  };

  it("the composition freezes the year's intensity, not the turnover — equal to the section's figure at full precision", async () => {
    const issued = await composition(turnoverId);
    const basis = issued.chartBasis!.intensityTarget as { reportingIntensity?: number; reportingDenominator?: number; denominatorUnit: string };
    assert.ok(!("reportingDenominator" in basis), "no turnover frozen into the chart basis");
    assert.equal(basis.denominatorUnit, "£m", "the unit stays");
    assert.ok(Object.is(basis.reportingIntensity, reportedValue(issued)), `chart ${basis.reportingIntensity} vs section ${reportedValue(issued)}`);
    assert.ok(Object.is(basis.reportingIntensity, TONNES / TURNOVER_M), "the pathway's own division");
    assert.notEqual((TONNES * 1_000_000) / (TURNOVER_M * 1_000_000), TONNES / TURNOVER_M, "the figures do exercise the last-digit divergence");
    assert.doesNotMatch(JSON.stringify(issued), new RegExp(`${TURNOVER}|17,925,590|${TURNOVER_M}`), "no turnover anywhere in the issued composition");
  });

  it("the client's copies — the composition and the published report — carry the same intensity and no turnover; staff keep it", async () => {
    const issued = await composition(turnoverId);
    const report = await published("j-ri-t");
    const clientReport = clientFacingPublishedReport(report);
    const clientComposition = clientFacingComposition(issued);
    assert.doesNotMatch(JSON.stringify({ clientReport, clientComposition }), new RegExp(`reportingDenominator|${TURNOVER}|${TURNOVER_M}`));
    assert.ok(Object.is(clientReport.snapshot.intensityTarget?.reportingIntensity, reportedValue(issued)), "the portal's figure is the report's");
    assert.equal(report.snapshot.intensityTarget?.reportingDenominator, TURNOVER_M, "the staff-side snapshot keeps the turnover");
  });

  it("a non-currency measure keeps its denominator at both boundaries", async () => {
    const issued = await composition(employeesId);
    assert.equal((issued.chartBasis!.intensityTarget as { reportingDenominator?: number }).reportingDenominator, 431);
    assert.ok(!("reportingIntensity" in issued.chartBasis!.intensityTarget!));
    const clientReport = clientFacingPublishedReport(await published("j-ri-e"));
    assert.equal(clientReport.snapshot.intensityTarget?.reportingDenominator, 431);
    assert.ok(!("reportingIntensity" in clientReport.snapshot.intensityTarget!));
    if ("state" in issued.intensity) throw new Error("expected a composed intensity section");
    assert.equal(issued.intensity.metrics.find((metric) => metric.reported)!.denominatorText, "431 employees", "and its frozen wording");
  });
});
