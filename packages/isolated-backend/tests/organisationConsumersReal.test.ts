import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { setClientIntensityMetric } from "../src/intensityMetrics";
import { applyIntensityDefaultsToClient, readOrganisationBrand, readOrganisationProfile, setIntensityDefault, updateOrganisationProfile } from "../src/organisationSettings";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import { getReportComposition } from "../src/reportCompositions";

/**
 * Organisation consumers (admin Phase D, D3a; ruled `phaseD3-plan.md`) against a real database. A pre-D3 world is seeded
 * straight after 0142, so 0143's own work is what is tested: the issuer backfilled onto an old report version and
 * certificate to exactly what they printed; verify_training_certificate() reading the certificate's issuer; the short
 * name set for net-zero-international only; turnover classified as a currency metric; and the one carried-across turnover
 * value scaled ×1,000,000 — only that one, noted on the row and audited. Then D3a's writes: report.validate freezing the
 * issuer from the profile, publish carrying it into the composition, a later profile change altering neither, and
 * unit_kind kept on every new metric version.
 */
const HASH = `sha256:${"a".repeat(64)}`;
const NZI = "net-zero-international";
const DEMO = "cons-demo";

describe("Organisation consumers (0143), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor: string, role: StaffRole, org = NZI, reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `cons-${keys}`, correlationId: `corr-cons-${keys}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };

  /** A pre-D3 world, written straight after 0142 — before 0143 exists. */
  const seedBefore0143 = async (admin: pg.Client) => {
    await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Net Zero International') ON CONFLICT DO NOTHING`, [NZI]);
    await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Demo Organisation')`, [DEMO]);
    await admin.query(`SELECT nzi_console.provision_organisation_settings($1)`, [NZI]);
    for (const org of [NZI, DEMO]) {
      await admin.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c1', 'Client One', 'active')`, [org]);
    }
    await admin.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage) VALUES ($1, 'job-old', 'c1', 9001, 'crp', 'Old CRP', 'open', 'delivery')`, [NZI]);
    await admin.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
      VALUES ($1, 'snap-old', 'job-old', 1, 1, $2, $3::jsonb, 'preparer')`, [NZI, HASH, JSON.stringify({ jobNumber: "J009001", client: "Client One", reportingYear: 2024, measurements: [], annualComparison: [] })]);
    await admin.query(`INSERT INTO nzi_console.report_versions (organisation_id, report_version_id, job_id, status, manifest_version, reviewed_snapshot_id, data_hash) VALUES ($1, 'rv-old', 'job-old', 'published', 1, 'snap-old', $2)`, [NZI, HASH]);
    await admin.query(`INSERT INTO nzi_console.report_compositions (organisation_id, composition_id, report_version_id, job_id, reviewed_snapshot_id, snapshot_data_hash, data_hash, payload_json, issued_by)
      VALUES ($1, 'comp-old', 'rv-old', 'job-old', 'snap-old', $2, $2, $3::jsonb, 'reviewer')`, [NZI, HASH, JSON.stringify({ reportVersionId: "rv-old", jobId: "job-old", jobNumber: "J009001", client: "Client One", reportingYear: 2024 })]);
    // A training certificate, pre-D3: no issuer column yet.
    await admin.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage) VALUES ($1, 'job-train', 'c1', 9002, 'training', 'Course', 'open', 'setup')`, [NZI]);
    await admin.query(`INSERT INTO nzi_console.training_course_runs (organisation_id, course_run_id, job_id, run_name, workflow_stage_key, created_by) VALUES ($1, 'run', 'job-train', 'Carbon Literacy', 'certified', 'seed')`, [NZI]);
    await admin.query(`INSERT INTO nzi_console.training_bookings (organisation_id, booking_id, course_run_id, person_name, created_by) VALUES ($1, 'book', 'run', 'Pat Example', 'seed')`, [NZI]);
    await admin.query(`INSERT INTO nzi_console.training_certificates (organisation_id, certificate_id, course_run_id, booking_id, certificate_number, attended_minutes, required_minutes, attendance_pct, certificate_hash, issued_by, verify_code)
      VALUES ($1, 'cert-old', 'run', 'book', 'NZI-0001', 360, 360, 100, 'hash', 'seed', 'VERIFY-OLD')`, [NZI]);
    // Turnover: the carried-across £m value (wrong by construction), a genuine whole-pounds value, and a carried one already in whole units.
    for (const [job, year, value, note] of [["job-old", 2023, 12.5, "Carried across from the job intensity target by migration 0071."], ["job-old", 2024, 8_000_000, "Entered."], ["job-old", 2022, 5_000_000, "Carried across from the job intensity target by migration 0071."]] as const) {
      await admin.query(`INSERT INTO nzi_console.job_intensity_values (organisation_id, job_id, reporting_year, metric_key, value, note, recorded_by) VALUES ($1, $2, $3, 'turnover', $4, $5, 'seed')`, [NZI, job, year, value, note]);
    }
    await admin.query(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, set_by, correlation_id)
      VALUES ($1, 'c1', 'turnover', 1, 'Turnover', '£m', 1000000, 'currency', true, 's', 's'), ($1, 'c1', 'employees', 1, 'Employees', 'employee', 1, 'people', true, 's', 's')`, [NZI]);
  };

  before(async () => {
    database = (await createDisposableDatabase("orgconsumers", {
      onMigration: async (filename, admin) => { if (filename === "0142_organisation_settings.sql") await seedBefore0143(admin); },
    }))!;
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES
      ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'rev', 'reviewer', 'active', 'Rev Reviewer'), ($1, 'prep', 'consultant', 'active', 'Prep Preparer')`, [NZI]);
  });
  after(async () => { await database?.end(); });

  describe("what 0143 did to the pre-D3 world", () => {
    it("backfilled the old report version to exactly what it printed, and its composition reads it", async () => {
      const [row] = await q(`SELECT issuer_display_name, issuer_short_name, issuer_footer, issuer_logo_asset_id FROM nzi_console.report_versions WHERE report_version_id = 'rv-old'`);
      assert.deepEqual(row, { issuer_display_name: "Net Zero International", issuer_short_name: "NZI", issuer_footer: "Net Zero International", issuer_logo_asset_id: null });
      const composition = await withTenantRead(database.pool, NZI, (db) => getReportComposition(db, "rv-old"));
      assert.deepEqual(composition?.issuer, { displayName: "Net Zero International", shortName: "NZI", footer: "Net Zero International", logoAssetId: null });
    });

    it("backfilled the old certificate's issuer, and the verify function reads the certificate's own", async () => {
      assert.equal((await q(`SELECT issuer_name FROM nzi_console.training_certificates WHERE certificate_id = 'cert-old'`))[0].issuer_name, "Net Zero International");
      await q(`UPDATE nzi_console.training_certificates SET issuer_name = 'Renamed Issuer Ltd' WHERE certificate_id = 'cert-old'`);
      assert.equal((await q(`SELECT issuer FROM nzi_console.verify_training_certificate('VERIFY-OLD')`))[0].issuer, "Renamed Issuer Ltd", "not the literal any more");
      await q(`UPDATE nzi_console.training_certificates SET issuer_name = 'Net Zero International' WHERE certificate_id = 'cert-old'`);
      const [fn] = await q(`SELECT pg_get_userbyid(proowner) AS owner, prosecdef FROM pg_proc WHERE proname = 'verify_training_certificate'`);
      assert.deepEqual([fn.owner, fn.prosecdef], ["nzi_console_definer", true], "owner and SECURITY DEFINER kept");
      await assert.rejects(q(`UPDATE nzi_console.training_certificates SET issuer_name = NULL WHERE certificate_id = 'cert-old'`), /null value|not-null/i);
    });

    it("set the short name NZI for net-zero-international only", async () => {
      const rows = await q(`SELECT organisation_id, short_name, updated_by FROM nzi_console.organisation_profiles WHERE organisation_id IN ($1, $2) ORDER BY organisation_id`, [DEMO, NZI]);
      assert.deepEqual(rows.map((row) => [row.organisation_id, row.short_name, row.updated_by]), [[DEMO, null, "migration:0142"], [NZI, "NZI", "migration:0143"]]);
    });

    it("classified the standard turnover as a currency metric, and left employees as text", async () => {
      const rows = await q(`SELECT metric_key, unit_kind FROM nzi_console.client_intensity_metrics WHERE client_id = 'c1' AND organisation_id = $1 ORDER BY metric_key`, [NZI]);
      assert.deepEqual(rows.map((row) => [row.metric_key, row.unit_kind]), [["employees", "text"], ["turnover", "currency"]]);
      const defaults = await q(`SELECT metric_key, unit_kind FROM nzi_console.organisation_intensity_metric_defaults WHERE organisation_id = $1 ORDER BY metric_key`, [NZI]);
      assert.deepEqual(defaults.map((row) => [row.metric_key, row.unit_kind]), [["employees", "text"], ["turnover", "currency"]]);
    });

    it("scaled only the carried-across £m turnover value ×1,000,000 — noted on the row and audited", async () => {
      const rows = await q(`SELECT reporting_year, value::float8 AS value, version, note FROM nzi_console.job_intensity_values WHERE job_id = 'job-old' ORDER BY reporting_year`);
      assert.deepEqual(rows.map((row) => [row.reporting_year, row.value, row.version]), [[2022, 5_000_000, 1], [2023, 12_500_000, 2], [2024, 8_000_000, 1]]);
      assert.match(rows[1].note, /Scaled ×1,000,000 by migration 0143/);
      const audit = await q(`SELECT entity_id, reason, before_json, after_json FROM nzi_console.audit_events WHERE action = 'job.intensity_value.corrected'`);
      assert.equal(audit.length, 1);
      assert.deepEqual([audit[0].entity_id, Number(audit[0].before_json.value), Number(audit[0].after_json.value), audit[0].after_json.reportingYear], ["job-old", 12.5, 12_500_000, 2023]);
    });
  });

  describe("D3a's writes", () => {
    it("the profile takes a short name, and the brand read falls back to the display name without one", async () => {
      const brand = await withTenantRead(database.pool, NZI, (db) => readOrganisationBrand(db, NZI));
      assert.deepEqual([brand.displayName, brand.shortName], ["Net Zero International", "NZI"]);
      const demo = await withTenantRead(database.pool, DEMO, (db) => readOrganisationBrand(db, DEMO));
      assert.equal(demo.shortName, "Demo Organisation", "no short name: the display name");
      const view = (await withTenantRead(database.pool, NZI, (db) => readOrganisationProfile(db, NZI)))!;
      await assert.rejects(updateOrganisationProfile(database.pool, { ...view.fields, shortName: "x".repeat(21), expectedVersion: view.version }, context("ada", "admin")), /Command validation failed/);
    });

    it("report.validate freezes the issuer from the profile; publish carries it; a later profile change alters neither", async () => {
      await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage) VALUES ($1, 'job-new', 'c1', 9003, 'crp', 'New CRP', 'open', 'delivery')`, [NZI]);
      const payload = { jobNumber: "J009003", client: "Client One", reportingYear: 2025,
        measurements: [
          { scope: "Scope 1", scopeCode: "1", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
          { scope: "Scope 2", scopeCode: "2", tco2e: 5, qualityTier: "measured", factorSet: "demo" },
          { scope: "Scope 3", scopeCode: "3.1", tco2e: 20, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
        target: { baselineYear: 2024, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
        intensityTarget: { metric: "turnover", denominatorUnit: "£m", reportingDenominator: 2, baselineYear: 2024, baselineIntensity: 20, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
        annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }] };
      await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
        VALUES ($1, 'snap-new', 'job-new', 1, 1, $2, $3::jsonb, 'prep', 'rev', now())`, [NZI, `sha256:${"b".repeat(64)}`, JSON.stringify(payload)]);
      const view = (await withTenantRead(database.pool, NZI, (db) => readOrganisationProfile(db, NZI)))!;
      await updateOrganisationProfile(database.pool, { ...view.fields, legalName: "Example Legal Limited", websiteUrl: "https://example.test", expectedVersion: view.version }, context("ada", "admin"));
      const validated = await validateCrpReport(database.pool, { reviewedSnapshotId: "snap-new", manifestVersion: 1 }, context("rev", "reviewer"));
      const [frozen] = await q(`SELECT issuer_display_name, issuer_short_name, issuer_footer FROM nzi_console.report_versions WHERE report_version_id = $1`, [validated.data.reportVersionId]);
      assert.deepEqual(frozen, { issuer_display_name: "Net Zero International", issuer_short_name: "NZI", issuer_footer: "Example Legal Limited | example.test" });
      await publishCrpReport(database.pool, { reportVersionId: validated.data.reportVersionId, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: "snap-new" }, context("rev", "reviewer"));
      // The profile moves on; the issued document does not.
      const later = (await withTenantRead(database.pool, NZI, (db) => readOrganisationProfile(db, NZI)))!;
      await updateOrganisationProfile(database.pool, { ...later.fields, displayName: "Renamed Organisation", shortName: "RNO", expectedVersion: later.version }, context("ada", "admin"));
      const composition = await withTenantRead(database.pool, NZI, (db) => getReportComposition(db, validated.data.reportVersionId));
      assert.deepEqual(composition?.issuer, { displayName: "Net Zero International", shortName: "NZI", footer: "Example Legal Limited | example.test", logoAssetId: null });
      const [stored] = await q(`SELECT payload_json->'issuer' AS issuer FROM nzi_console.report_compositions WHERE report_version_id = $1`, [validated.data.reportVersionId]);
      assert.equal(stored.issuer.displayName, "Net Zero International", "frozen into the composition itself at publish");
    });

    it("keeps unit_kind on every new metric version, and carries it from a default onto a client", async () => {
      await setClientIntensityMetric(database.pool, { clientId: "c1", metricKey: "turnover", label: "Turnover", unitWording: "£m", divider: 1000000, iconKey: "currency", expectedVersion: 1 }, context("ada", "admin"));
      assert.equal((await q(`SELECT unit_kind FROM nzi_console.client_intensity_metrics WHERE organisation_id = $1 AND client_id = 'c1' AND metric_key = 'turnover' AND version = 2`, [NZI]))[0].unit_kind, "currency");
      const current = (await q(`SELECT max(version)::int AS v FROM nzi_console.organisation_intensity_metric_defaults WHERE organisation_id = $1 AND metric_key = 'turnover'`, [NZI]))[0].v;
      await setIntensityDefault(database.pool, { metricKey: "turnover", label: "Turnover", unitWording: "£m", divider: 1000000, iconKey: "currency", expectedVersion: current }, context("ada", "admin"));
      assert.equal((await q(`SELECT unit_kind FROM nzi_console.organisation_intensity_metric_defaults WHERE organisation_id = $1 AND metric_key = 'turnover' ORDER BY version DESC LIMIT 1`, [NZI]))[0].unit_kind, "currency");
      await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c-new', 'New Client', 'active')`, [NZI]);
      await withTenantWrite(database.pool, NZI, (db) => applyIntensityDefaultsToClient(db, NZI, "c-new", "ada", "corr"));
      const applied = await q(`SELECT metric_key, unit_kind FROM nzi_console.client_intensity_metrics WHERE client_id = 'c-new' ORDER BY metric_key`);
      assert.deepEqual(applied.map((row) => [row.metric_key, row.unit_kind]), [["employees", "text"], ["turnover", "currency"]]);
    });
  });
});
