import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultReportSectionPlan, setReportSectionIncluded, type CommandContext, type ReportComposition, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { getReportComposition, previewReportComposition } from "../src/reportCompositions";
import { draftReportComposition } from "../src/reportDraftComposition";
import { withTenantRead } from "../src/postgres";

/**
 * composed@5 (BUILD-report-studio-composed5 and its rulings, ACCEPT-composed5-checkpoint1–5) against a real database: a report
 * composed now is drawn `composed@5`, and freezes — additive, forward only, no money —
 *  - the client's logo the version froze at validate (a draft: the client's now);
 *  - the client record's industry (the sector's curated label over its stored text) and location (else headquarters);
 *  - the stamp's reporting period, and the signee the version named;
 *  - each site's in-service date and its floor area for the period;
 *  - each site's and each GHG category's own figure for the earlier assured periods — null where none, never modelled.
 * The B0 preview still equals what publish freezes, and no money is in the payload (NZC-120).
 */
const ORG = "c5-org";
const CLIENT = "c5-client";
const JOB = "j-c5";

describe("composed@5 freezes the mockup's fields, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `c5-${count}`, correlationId: `corr-c5-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const validate = async (snapshotId: string, extra: Record<string, unknown> = {}) => (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1, ...extra }, context("rev", "reviewer"))).data.reportVersionId;
  const preview = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => previewReportComposition(db, { organisationId: ORG, reportVersionId: id })))!.composition;
  const frozen = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, id)))!;
  const draft = async () => (await withTenantRead(database.pool, ORG, (db) => draftReportComposition(db, { organisationId: ORG, jobId: JOB })))!.composition;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const logo = async (assetId: string, text: string) => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>${text}</text></svg>`);
    await q(`INSERT INTO nzi_console.client_logo_assets (organisation_id, asset_id, client_id, file_name, content_type, byte_size, sha256, content, uploaded_by)
             VALUES ($1, $2, $3, 'logo.svg', 'image/svg+xml', $4, $5, $6, 'seed')`, [ORG, assetId, CLIENT, svg.length, sha(svg.toString()), svg]);
  };
  // A snapshot's row: [site, GHG category code, tCO₂e]; its scope is the code's whole part.
  const snapshot = async (id: string, jobId: string, version: number, year: number, rows: Array<[string | null, string, number]>, stamped: boolean) => {
    const measurements = rows.map(([site, code, tco2e], index) => ({ rowId: `${id}-${index}`, rowVersion: 1, scope: code.split(".")[0], scopeCode: code, siteId: site,
      siteLabel: site === null ? null : { "s-a": "Works", "s-b": "Depot", "s-c": "Annex" }[site], sourceLabel: `Category ${code}`, tco2e, factorSet: `Category ${code} · dataset`,
      qualityTier: code.startsWith("3") ? "estimated" : "measured", factorSource: "dataset" }));
    const payload = { jobNumber: `J-${jobId}`, client: "Composed Five Co", reportingYear: year, measurements, annualComparison: [],
      ...(stamped ? { provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: `${year}-04-01`, to: `${year + 1}-03-31` },
        boundary: { siteIds: ["s-a", "s-b", "s-c"], excludedRowIds: [] }, factorSets: [{ source: "dataset", id: "uk-ghg-gb-2025", name: "upload.xlsx", version: "upload.xlsx" }] } } : {}) };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, 'prep', 'rev', now())`, [ORG, id, jobId, version, `sha256:${sha(id)}`, JSON.stringify(payload)]);
  };
  const job = async (jobId: string, sequence: number, year: number) => {
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', $5)`,
      [ORG, jobId, CLIENT, sequence, year]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, $3, $4, 'GB')`, [ORG, jobId, `${year}-04-01`, `${year + 1}-03-31`]);
  };
  let signedId = "";

  before(async () => {
    database = (await createDisposableDatabase("reportcomposed5"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    await q(`INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, created_by, updated_by) VALUES ($1, 'industries', 'ind-mfg', 'Manufacturing', 'seed', 'seed')`, [ORG]);
    // The stored sector text differs from the curated label: the label wins (NZC-090). No location, so headquarters stands in.
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency, sector, sector_value_id, location, headquarters, baseline_period_start, baseline_total_tco2e)
             VALUES ($1, $2, 'Composed Five Co', 'active', 'GBP', 'mfg (old text)', 'ind-mfg', '', 'Leeds, United Kingdom', '2022-04-01', 100)`, [ORG, CLIENT]);
    await logo("logo-1", "first");
    await q(`UPDATE nzi_console.clients SET logo_asset_id = 'logo-1' WHERE organisation_id = $1 AND client_id = $2`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, site_id, client_id, name, in_service_from, created_by) VALUES
             ($1, 's-a', $2, 'Works', '2019-04-01', 'seed'), ($1, 's-b', $2, 'Depot', '2021-09-01', 'seed'), ($1, 's-c', $2, 'Annex', '2023-06-01', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_site_floor_areas (organisation_id, floor_area_id, site_id, effective_from, floor_area_m2, recorded_by) VALUES
             ($1, 'fa-a', 's-a', NULL, 1000, 'seed'), ($1, 'fa-b', 's-b', NULL, 400, 'seed')`, [ORG]);
    await q(`INSERT INTO nzi_console.client_contacts (organisation_id, contact_id, client_id, full_name, job_title, roles, created_by, updated_by) VALUES ($1, 'k-sign', $2, 'Sam Taylor', 'Head of Sustainability', ARRAY['report_signee'], 'seed', 'seed')`, [ORG, CLIENT]);
    // Earlier assured periods: FY2022 (the baseline: no Annex row, no 3.5 row) and FY2024.
    await job("j-c5-2022", 9761, 2022);
    await snapshot("snap-2022", "j-c5-2022", 1, 2022, [["s-a", "1", 40], ["s-b", "1", 20], ["s-a", "3.1", 30], [null, "2", 10]], false);
    await job("j-c5-2024", 9762, 2024);
    await snapshot("snap-2024", "j-c5-2024", 1, 2024, [["s-a", "1", 35], ["s-b", "1", 18], ["s-a", "3.1", 28], ["s-c", "3.5", 4], [null, "2", 9]], false);
    // This report: FY2025.
    await job(JOB, 9763, 2025);
    await snapshot("snap-c5", JOB, 1, 2025, [["s-a", "1", 30], ["s-b", "1", 15], ["s-a", "3.1", 25], ["s-c", "3.5", 3], [null, "2", 8]], true);
    // No targets or intensity measures here (not what this suite is about), so the plan leaves those two sections out —
    // validate's R4 would refuse their charts otherwise.
    const plan = setReportSectionIncluded(setReportSectionIncluded(defaultReportSectionPlan, "targets", false), "intensity", false);
    signedId = await validate("snap-c5", { signeeContactId: "k-sign", sectionPlan: plan });
  });
  after(async () => { await database?.end(); });

  it("a report composed now is drawn composed@5; the stamp's period and the signee the version named are frozen", async () => {
    const drawn = await preview(signedId);
    assert.equal(drawn.renderer, "composed@5");
    assert.deepEqual(drawn.reportingPeriod, { from: "2025-04-01", to: "2026-03-31" });
    assert.deepEqual(drawn.signee, { name: "Sam Taylor", jobTitle: "Head of Sustainability" });
  });

  it("freezes the client logo the version froze at validate — a later logo change reaches only new work (the draft)", async () => {
    assert.equal((await preview(signedId)).clientLogoAssetId, "logo-1");
    await logo("logo-2", "second");
    await q(`UPDATE nzi_console.clients SET logo_asset_id = 'logo-2' WHERE organisation_id = $1 AND client_id = $2`, [ORG, CLIENT]);
    assert.equal((await preview(signedId)).clientLogoAssetId, "logo-1", "the version's own logo");
    assert.equal((await draft()).clientLogoAssetId, "logo-2", "a draft takes the client's now, as validate would");
  });

  it("freezes the industry (the curated label over the stored text) and the location (else headquarters); a record with neither freezes none", async () => {
    assert.deepEqual((await preview(signedId)).organisation, { industry: "Manufacturing", location: "Leeds, United Kingdom" });
    await q(`UPDATE nzi_console.clients SET sector_value_id = NULL, location = 'Bradford, United Kingdom' WHERE organisation_id = $1 AND client_id = $2`, [ORG, CLIENT]);
    assert.deepEqual((await preview(signedId)).organisation, { industry: "mfg (old text)", location: "Bradford, United Kingdom" }, "no label: the stored text; location over headquarters");
    await q(`UPDATE nzi_console.clients SET sector = NULL, location = NULL, headquarters = NULL WHERE organisation_id = $1 AND client_id = $2`, [ORG, CLIENT]);
    assert.equal("organisation" in (await preview(signedId)), false, "nothing recorded: nothing frozen, never guessed");
    await q(`UPDATE nzi_console.clients SET sector = 'mfg (old text)', sector_value_id = 'ind-mfg', headquarters = 'Leeds, United Kingdom' WHERE organisation_id = $1 AND client_id = $2`, [ORG, CLIENT]);
  });

  it("freezes each site's in-service date and its floor area for the period (null where none is recorded)", async () => {
    const { emissions } = await preview(signedId);
    if ("state" in emissions) throw new Error("expected emissions");
    const site = (id: string) => emissions.sites!.find((entry) => entry.siteId === id)!;
    assert.deepEqual([site("s-a").inServiceFrom, site("s-a").floorAreaM2], ["2019-04-01", 1000]);
    assert.deepEqual([site("s-b").inServiceFrom, site("s-b").floorAreaM2], ["2021-09-01", 400]);
    assert.deepEqual([site("s-c").inServiceFrom, site("s-c").floorAreaM2], ["2023-06-01", null], "no floor area recorded: null");
  });

  it("freezes each site's and each category's figure for the earlier assured periods — null where none, reconciling to the totals", async () => {
    const drawn = await preview(signedId);
    if ("state" in drawn.emissions) throw new Error("expected emissions");
    const comparison = drawn.emissions.comparison!;
    assert.deepEqual(comparison.columns.map((column) => `${column.key}:${column.year}`), ["baseline:2022", "previous:2024", "current:2025"]);
    const site = (id: string | null) => comparison.sites!.find((entry) => entry.siteId === id)!.values;
    assert.deepEqual(site("s-a"), [70, 63, 55]);
    assert.deepEqual(site("s-c"), [null, 4, 3], "the Annex opened in 2023: no baseline figure");
    assert.deepEqual(site(null), [10, 9, 8]);
    const category = (code: string) => comparison.categories!.find((entry) => entry.scopeCode === code)!.values;
    assert.deepEqual(category("3.1"), [30, 28, 25]);
    assert.deepEqual(category("3.5"), [null, 4, 3]);
    assert.deepEqual(comparison.totals, [100, 94, 81]);
  });

  it("the preview is still what publish freezes — the new fields included — and no money is in the payload (NZC-120)", async () => {
    const before = await preview(signedId);
    await publishCrpReport(database.pool, { reportVersionId: signedId, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: "snap-c5" }, context("rev", "reviewer"));
    const issued = await frozen(signedId);
    const without = (composition: ReportComposition) => JSON.parse(JSON.stringify(composition).split(composition.issuedAt).join("<issued>"));
    assert.deepEqual(without(before), without(issued));
    assert.ok(issued.clientLogoAssetId && issued.organisation && issued.reportingPeriod && issued.signee);
    assert.doesNotMatch(JSON.stringify(issued), /[£$€]\s?\d|reportingDenominator|upload\.xlsx/);
  });
});
