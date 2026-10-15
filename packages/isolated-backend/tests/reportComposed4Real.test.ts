import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultReportSectionPlan, legacyReportSectionPlanV3, reportSectionPlanIssues, setReportSectionIncluded, type CommandContext, type ReportComposition, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { getReportComposition, previewReportComposition } from "../src/reportCompositions";
import { getReportVersionSectionPlan } from "../src/reportSectionPlanRecords";
import { withTenantRead } from "../src/postgres";

/**
 * B2-3 (`composed@4`, RULING-report-B2-3) against a real database: a report composed now is drawn `composed@4`, freezes its
 * reporting period from the snapshot stamp (absent → none frozen) and the client signee the version named, and carries its plan
 * complete. A client profile written before B2-3 — without the new sections — still seeds validate: it is read complete,
 * deterministically, keeping its own order and choices. The B0 preview still equals what publish freezes.
 */
const ORG = "c4-org";
const CLIENT = "c4-client";

describe("composed@4 freezes its period and signee, and reads stored plans complete, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `c4-${count}`, correlationId: `corr-c4-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const validate = async (snapshotId: string, extra: Record<string, unknown> = {}) => (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1, ...extra }, context("rev", "reviewer"))).data.reportVersionId;
  const publish = (id: string, snapshotId: string) => publishCrpReport(database.pool, { reportVersionId: id, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: snapshotId }, context("rev", "reviewer"));
  const frozen = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, id)))!;
  const preview = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => previewReportComposition(db, { organisationId: ORG, reportVersionId: id })))!.composition;
  const snapshot = async (id: string, version: number, stamped: boolean) => {
    const row = (rowId: string, scope: string, scopeCode: string, siteId: string | null, siteLabel: string | null, sourceLabel: string, tco2e: number, qualityTier: string, extra: Record<string, unknown> = {}) =>
      ({ rowId: `${id}-${rowId}`, scope, scopeCode, siteId, siteLabel, sourceLabel, tco2e, factorSet: `${sourceLabel} · upload.xlsx`, qualityTier, factorSource: "dataset", ...extra });
    const payload = { jobNumber: "J-c4", client: "Composed Four Co", reportingYear: 2025,
      measurements: [row("g", "1", "1", "s-a", "Works", "Gas", 10, "measured"), row("e", "2", "2", "s-a", "Works", "Electricity", 5, "measured"),
        row("p", "3", "3.1", null, null, "Goods", 20, "estimated", { purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" })],
      target: { baselineYear: 2024, baselineTco2e: 60, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2024, baselineIntensity: 4,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId: "j-c4", version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 14 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }],
      ...(stamped ? { provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: "2025-04-01", to: "2026-03-31" }, boundary: { siteIds: ["s-a"], excludedRowIds: [] },
        factorSets: [{ source: "dataset", id: "uk-ghg-gb-2025", name: "upload.xlsx", version: "upload.xlsx" }] } } : {}) };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, 'j-c4', $3, 1, $4, $5::jsonb, 'prep', 'rev', now())`, [ORG, id, version, `sha256:${createHash("sha256").update(id).digest("hex")}`, JSON.stringify(payload)]);
  };
  let signedId = "";

  before(async () => {
    database = (await createDisposableDatabase("reportcomposed4"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Composed Four Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, 's-a', 'Works', '2020-01-01', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_targets (organisation_id, client_id, version, near_term_year, near_term_pct, net_zero_year, net_zero_pct, benchmark_year, benchmark_total_tco2e, benchmark_source, set_by, correlation_id)
             VALUES ($1, $2, 1, 2030, 50, 2045, 90, 2024, 64, 'client-record', 'fixture', 'fixture')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, unit_kind, set_by, correlation_id)
             VALUES ($1, $2, 'turnover', 1, 'Turnover', '£m', 1000000, 'currency', true, 'entered', true, 1, 'currency', 'seed', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_contacts (organisation_id, contact_id, client_id, full_name, job_title, roles, created_by, updated_by) VALUES ($1, 'k-sign', $2, 'Sam Taylor', 'Head of Sustainability', ARRAY['report_signee'], 'seed', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, 'j-c4', $2, 9841, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, 'j-c4', '2025-04-01', '2026-03-31', 'GB')`, [ORG]);
    await q(`INSERT INTO nzi_console.job_intensity_values (organisation_id, job_id, reporting_year, metric_key, value, recorded_by) VALUES ($1, 'j-c4', 2025, 'turnover', 12500000, 'ada')`, [ORG]);
    await snapshot("snap-c4", 1, true);
    await snapshot("snap-c4-unstamped", 2, false);
    // One report version per snapshot and scope: the unsigned and the profile-seeded validates each take their own.
    await snapshot("snap-c4-unsigned", 3, true);
    await snapshot("snap-c4-profile", 4, true);
    signedId = await validate("snap-c4", { signeeContactId: "k-sign" });
  });
  after(async () => { await database?.end(); });

  it("a report composed now is drawn composed@5 (composed@4 the layout before it), with its plan complete and the stamp's reporting period", async () => {
    const drawn = await preview(signedId);
    assert.equal(drawn.renderer, "composed@5");
    assert.deepEqual(reportSectionPlanIssues(drawn.sectionPlan), [], "a complete plan, by the rules");
    assert.deepEqual(drawn.sectionPlan, defaultReportSectionPlan.map(({ key, included }) => ({ key, included })));
    assert.deepEqual(drawn.reportingPeriod, { from: "2025-04-01", to: "2026-03-31" });
  });

  it("freezes no turnover amount: the currency measure's denominator is never in the composition (RULING-B2-3-two-decisions)", async () => {
    const drawn = await preview(signedId);
    if ("state" in drawn.intensity) throw new Error("expected a composed intensity section");
    const turnover = drawn.intensity.metrics.find((metric) => metric.key === "turnover")!;
    assert.equal(turnover.denominatorText, null);
    assert.equal(turnover.unit, "tCO₂e per £m", "the unit stays");
    assert.equal(turnover.value, 2.8, "and the intensity: 35 tCO₂e over £12.5m");
    assert.doesNotMatch(JSON.stringify(drawn), /12,500,000|12500000|£12/, "nowhere in the payload");
  });

  it("freezes the client signee the version named — and nothing about the preparer or reviewer", async () => {
    const drawn = await preview(signedId);
    assert.deepEqual(drawn.signee, { name: "Sam Taylor", jobTitle: "Head of Sustainability" });
    assert.doesNotMatch(JSON.stringify({ signee: drawn.signee, period: drawn.reportingPeriod }), /prep|rev|ada/i);
    const unsigned = await preview(await validate("snap-c4-unsigned"));
    assert.equal("signee" in unsigned, false, "no signee named: none frozen");
  });

  it("a snapshot with no stamped period freezes none — the cover row is left out, never guessed", async () => {
    const drawn = await preview(await validate("snap-c4-unstamped"));
    assert.equal("reportingPeriod" in drawn, false);
  });

  it("a client profile written before B2-3 still seeds validate: read complete, keeping its own order and choices", async () => {
    const legacyProfile = setReportSectionIncluded(legacyReportSectionPlanV3, "srs", false, { allowExclusion: true });
    await q(`INSERT INTO nzi_console.client_report_profiles (organisation_id, client_id, version, active, section_plan, set_by, correlation_id) VALUES ($1, $2, 1, true, $3::jsonb, 'seed', 'seed')`, [ORG, CLIENT, JSON.stringify(legacyProfile)]);
    const id = await validate("snap-c4-profile");
    const held = (await withTenantRead(database.pool, ORG, (db) => getReportVersionSectionPlan(db, id)))!;
    assert.deepEqual(reportSectionPlanIssues(held.sectionPlan), []);
    assert.equal(held.sectionPlan.find((entry) => entry.key === "srs")!.included, false, "the profile's choice kept");
    const legacyKeys = legacyProfile.map((entry) => entry.key);
    assert.deepEqual(held.sectionPlan.map((entry) => entry.key).filter((key) => legacyKeys.includes(key)), legacyKeys, "the profile's order kept");
    assert.ok(["scope-analysis", "glossary", "audit", "appendix-sites"].every((key) => held.sectionPlan.some((entry) => entry.key === key && entry.included)));
    assert.equal(held.origin, "profile:1");
    await q(`DELETE FROM nzi_console.client_report_profiles WHERE organisation_id = $1 AND client_id = $2`, [ORG, CLIENT]);
  });

  it("the preview is still what publish freezes — the new fields included", async () => {
    const before = await preview(signedId);
    await publish(signedId, "snap-c4");
    const issued = await frozen(signedId);
    const without = (composition: ReportComposition) => JSON.parse(JSON.stringify(composition).split(composition.issuedAt).join("<issued>"));
    assert.deepEqual(without(before), without(issued));
    assert.ok(issued.signee && issued.reportingPeriod);
  });
});
