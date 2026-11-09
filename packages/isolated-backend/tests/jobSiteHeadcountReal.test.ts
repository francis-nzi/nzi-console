import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext, type PortalCommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { CommandValidationError, createReviewedCrpSnapshot, readJobCommutingUplift, savePortalSiteHeadcount, setJobSiteHeadcount, withTenantRead } from "../src/index";
import { VersionConflictError } from "../src/errors";

/**
 * Employee commuting (3.7) per-site sample uplift (BRIEF-commuting-uplift-lean) against a real database:
 *  - the headcount record: staff and the client write it (versioned, audited, own-client sites only), and it holds inputs only;
 *  - the read: per site E, C, R, response rate, default and agreed U, f, and the figures (none sent where unassigned rows exist);
 *  - the figure that locks: a snapshot scales a switched-on site's 3.7 rows by f, with the provenance, and nothing else - not
 *    another site's rows, not a row with no site, not a site with the toggle off - and the stored rows never move;
 *  - the backfill assigns a null-site 3.7 row only where the client has exactly one site.
 */
const ORG = "uplift-org";
const CLIENT = "client-up", OTHER_CLIENT = "client-up-other";
const JOB = "job-up", OTHER_JOB = "job-up-other";
const STAFF = "staff-up", USER = "portal-up", REVIEWER = "reviewer-up";
const here = dirname(fileURLToPath(import.meta.url));

describe("commuting uplift: headcount, response rate and the figure that locks", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let rowSeq = 0;
  const staff = (): CommandContext => { keys += 1; return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `up-${keys}`, correlationId: `corr-up-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) }; };
  const portal = (): PortalCommandContext => { keys += 1; return { organisationId: ORG, actorId: USER, principal: "portal", portal: { portalUserId: USER, clientId: CLIENT }, idempotencyKey: `up-${keys}`, correlationId: `corr-up-${keys}` }; };
  const codes = async (promise: Promise<unknown>) => { try { await promise; return []; } catch (error) { return error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [(error as Error).name]; } };
  const view = () => withTenantRead(database.pool, ORG, (client) => readJobCommutingUplift(client, ORG, JOB));
  const site = async () => (await view()).sites;
  // A commuting row (3.7): approved, priced, in the job. `site` null leaves it unassigned.
  const commuter = async (jobId: string, siteId: string | null, tco2e: number, over: { review?: string; enabled?: boolean } = {}) => {
    rowSeq += 1;
    const review = over.review ?? "approved";
    await db.query(
      `INSERT INTO nzi_console.job_scope_rows (organisation_id, scope_row_id, job_id, scope, category_code, source_label, report_label, level_1, level_2, site_id, quantity, unit,
         dataset_id, factor_id, factor_label, calculated_tco2e, quality_tier, enabled, review_status, reviewed_by, reviewed_row_version, reviewed_at, reviewer_note)
       VALUES ($1, $2, $3, '3.7', '3.7', $4, 'Commuter', 'Employee commuting', 'Rail', $5, 1000, 'km', 'up-ds', 'up-rail', 'Rail (test)', $6, 'estimated', $7, $8,
         CASE WHEN $8 = 'pending' THEN NULL ELSE $9 END, CASE WHEN $8 = 'pending' THEN NULL ELSE 1 END, CASE WHEN $8 = 'pending' THEN NULL ELSE now() END, CASE WHEN $8 = 'rejected' THEN 'Not a commute' ELSE NULL END)`,
      [ORG, `${jobId}-c${rowSeq}`, jobId, `Commuter ${rowSeq} · Rail`, siteId, tco2e, over.enabled ?? true, review, REVIEWER]);
    return `${jobId}-c${rowSeq}`;
  };
  const rowsAsStored = async () => JSON.stringify((await db.query(`SELECT scope_row_id, quantity, unit, calculated_tco2e, site_id, version, review_status FROM nzi_console.job_scope_rows WHERE job_id = $1 ORDER BY scope_row_id`, [JOB])).rows);
  const snapshot = async () => {
    const version = (await db.query<{ version: number }>(`SELECT version FROM nzi_console.jobs WHERE job_id = $1`, [JOB])).rows[0]!.version;
    const created = await createReviewedCrpSnapshot(database.pool, { jobId: JOB, expectedJobVersion: version }, staff());
    return (await db.query<{ payload_json: any }>(`SELECT payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id = $1`, [created.data.snapshotId])).rows[0]!.payload_json;
  };
  let leeds = "", york = "", lone = "";

  before(async () => {
    database = (await createDisposableDatabase("commutinguplift"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Co', 'active', 'GBP'), ($1, $3, 'Lone Co', 'active', 'GBP')`, [ORG, CLIENT, OTHER_CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, 'admin', 'active', 'Sam'), ($1, $3, 'reviewer', 'active', 'Rev')`, [ORG, STAFF, REVIEWER]);
    for (const [job, client, seq] of [[JOB, CLIENT, 1], [OTHER_JOB, OTHER_CLIENT, 2]] as const) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
         VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'Data entry', 2026, '2026-01-01', '2026-12-31')`, [ORG, job, client, seq]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2026-01-01', '2026-12-31', 'GB')`, [ORG, job]);
    }
    await db.query(`INSERT INTO nzi_console.client_sites (organisation_id, site_id, client_id, name, created_by) VALUES ($1, 's-leeds', $2, 'Leeds', 'seed'), ($1, 's-york', $2, 'York', 'seed'), ($1, 's-lone', $3, 'Only site', 'seed')`, [ORG, CLIENT, OTHER_CLIENT]);
    [leeds, york, lone] = ["s-leeds", "s-york", "s-lone"];
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
       VALUES ($1, 'up-ds', 'Uplift test factors', 'up', '2026-01-01', '2026-12-31', 'GB', 'active', 'Test', 'Test only')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, 'up-ds', 'up-rail', 'Rail (test)', 'km', 0.1, ARRAY['3'])`, [ORG]);
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status) VALUES ($1, $2, $3, 'active')`, [ORG, USER, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id, data_entry_starts_at, data_entry_expires_at, revoked_at)
       VALUES ($1, 'grant-up', $2, $3, $4, now() - interval '1 day', now() + interval '30 days', NULL)`, [ORG, CLIENT, USER, JOB]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the backfill assigns a null-site 3.7 row only where the client has exactly one site", async () => {
    const sql = readFileSync(resolve(here, "../migrations/0219_job_site_headcount_commuting_uplift.sql"), "utf8").match(/UPDATE nzi_console\.job_scope_rows[\s\S]*?;/)![0];
    const multi = await commuter(JOB, null, 5);
    const single = await commuter(OTHER_JOB, null, 5);
    await db.query(sql);
    const siteOf = async (id: string) => (await db.query<{ site_id: string | null }>(`SELECT site_id FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [id])).rows[0]!.site_id;
    assert.equal(await siteOf(single), lone, "one site: unambiguous");
    assert.equal(await siteOf(multi), null, "two sites: never bucketed");
    await db.query(`DELETE FROM nzi_console.job_scope_rows WHERE job_id IN ($1, $2)`, [JOB, OTHER_JOB]);
  });

  it("with no rows and no headcount there is nothing to scale: R = 0, the toggle is unavailable, the default is off", async () => {
    const sites = await site();
    assert.deepEqual(sites.map((entry) => [entry.name, entry.respondents, entry.available, entry.unavailableReason, entry.enabled, entry.applied]),
      [["Leeds", 0, false, "no-respondents", false, false], ["York", 0, false, "no-respondents", false, false]]);
  });

  it("worked case: E=100, C=10, R=54 → eligible 90, default U=36, f=90/54, response rate 60%; the sampled and uplifted figures", async () => {
    for (let index = 0; index < 54; index += 1) await commuter(JOB, leeds, 2);
    const saved = await setJobSiteHeadcount(database.pool, { jobId: JOB, siteId: leeds, employees: 100, companyCarUsers: 10, upliftEnabled: false, agreedHeadcount: null }, staff());
    assert.equal(saved.data.version, 1);
    const [row] = (await site()).filter((entry) => entry.siteId === leeds);
    assert.deepEqual([row!.respondents, row!.eligible, row!.defaultHeadcount, row!.headcount, row!.enabled, row!.applied, row!.factor], [54, 90, 36, 36, false, false, 1]);
    assert.ok(Math.abs(row!.responseRate! - 0.6) < 1e-9);
    assert.equal(row!.sampledTco2e, 108);
    assert.equal(row!.upliftedTco2e, 108, "off: the sampled figure stands");
    await setJobSiteHeadcount(database.pool, { jobId: JOB, siteId: leeds, employees: 100, companyCarUsers: 10, upliftEnabled: true, agreedHeadcount: null, expectedVersion: 1 }, staff());
    const [on] = (await site()).filter((entry) => entry.siteId === leeds);
    assert.ok(Math.abs(on!.factor - 90 / 54) < 1e-9);
    assert.ok(Math.abs(on!.upliftedTco2e - 108 * (90 / 54)) < 1e-9);
  });

  it("the headcount is versioned and audited; an unchanged save and a stale version are refused; another client's site is refused", async () => {
    assert.deepEqual(await codes(setJobSiteHeadcount(database.pool, { jobId: JOB, siteId: leeds, employees: 100, companyCarUsers: 10, upliftEnabled: true, agreedHeadcount: null, expectedVersion: 2 }, staff())), ["UNCHANGED"]);
    await assert.rejects(setJobSiteHeadcount(database.pool, { jobId: JOB, siteId: leeds, employees: 120, companyCarUsers: 10, upliftEnabled: true, agreedHeadcount: null, expectedVersion: 1 }, staff()), VersionConflictError);
    assert.deepEqual(await codes(setJobSiteHeadcount(database.pool, { jobId: JOB, siteId: lone, employees: 5, companyCarUsers: 0, upliftEnabled: false, agreedHeadcount: null }, staff())), ["NOT_FOUND"]);
    assert.deepEqual(await codes(setJobSiteHeadcount(database.pool, { jobId: JOB, siteId: york, employees: 5, companyCarUsers: 9, upliftEnabled: false, agreedHeadcount: null }, staff())), ["INVALID"], "more company-car staff than employees");
    const audit = await db.query(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE action = 'job_site_headcount_set'`);
    assert.equal(audit.rows[0].n, 2);
  });

  it("the client saves its own site's headcount through the portal command; the staff-only history stays out of the portal read", async () => {
    const saved = await savePortalSiteHeadcount(database.pool, { jobId: JOB, siteId: york, employees: 30, companyCarUsers: 2, upliftEnabled: false, agreedHeadcount: null }, portal());
    assert.equal(saved.data.version, 1);
    assert.equal((await db.query<{ saved_in_portal: boolean }>(`SELECT saved_in_portal FROM nzi_console.job_site_headcount WHERE site_id = $1`, [york])).rows[0]!.saved_in_portal, true);
    assert.deepEqual(await codes(savePortalSiteHeadcount(database.pool, { jobId: JOB, siteId: lone, employees: 5, companyCarUsers: 0, upliftEnabled: false, agreedHeadcount: null }, portal())), ["NOT_FOUND"]);
    const audit = await db.query(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE action = 'portal_site_headcount_saved'`);
    assert.equal(audit.rows[0].n, 1);
  });

  it("edges: respondents above eligible → default U=0 and the site is flagged, nothing scaled down; unassigned rows are counted and excluded", async () => {
    await setJobSiteHeadcount(database.pool, { jobId: JOB, siteId: york, employees: 4, companyCarUsers: 0, upliftEnabled: false, agreedHeadcount: null, expectedVersion: 1 }, staff());
    for (let index = 0; index < 6; index += 1) await commuter(JOB, york, 1);
    await commuter(JOB, null, 50); // no site: in no site's R
    const current = await view();
    const [yorkView] = current.sites.filter((entry) => entry.siteId === york);
    assert.deepEqual([yorkView!.respondents, yorkView!.defaultHeadcount, yorkView!.flags], [6, 0, ["respondents-exceed-eligible"]]);
    assert.equal(current.unassignedRows, 1);
    await commuter(JOB, leeds, 99, { review: "rejected" }); // a rejected row is not a respondent
    await commuter(JOB, leeds, 99, { enabled: false });
    assert.equal((await site()).find((entry) => entry.siteId === leeds)!.respondents, 54);
  });

  it("the figure that locks: a switched-on site's 3.7 is scaled by f with the provenance; nothing else moves, and the stored rows are byte-unchanged", async () => {
    await db.query(`DELETE FROM nzi_console.job_scope_rows WHERE job_id = $1 AND (review_status = 'rejected' OR NOT enabled)`, [JOB]);
    await db.query(`UPDATE nzi_console.job_scope_rows SET quality_tier = 'estimated' WHERE job_id = $1`, [JOB]);
    const before = await rowsAsStored();
    const payload = await snapshot();
    assert.equal(await rowsAsStored(), before, "uplift is derived: no stored row is touched");
    const f = 90 / 54;
    const leedsRows = payload.measurements.filter((entry: any) => entry.siteId === leeds);
    const yorkRows = payload.measurements.filter((entry: any) => entry.siteId === york);
    const unassigned = payload.measurements.filter((entry: any) => entry.siteId === null);
    assert.equal(leedsRows.length, 54);
    for (const entry of leedsRows) { assert.ok(Math.abs(entry.tco2e - 2 * f) < 1e-9); assert.equal(entry.sampledTco2e, 2); assert.ok(Math.abs(entry.upliftFactor - f) < 1e-9); }
    for (const entry of [...yorkRows, ...unassigned]) { assert.equal(entry.upliftFactor, undefined, "toggle off, or no site: never scaled"); assert.equal(entry.sampledTco2e, undefined); }
    assert.deepEqual(unassigned.map((entry: any) => entry.tco2e), [50]);
    assert.deepEqual(payload.commutingUplift.sites.map((entry: any) => [entry.siteId, entry.employees, entry.companyCarUsers, entry.respondents, entry.eligible, entry.headcount]), [[leeds, 100, 10, 54, 90, 36]]);
    assert.ok(Math.abs(payload.commutingUplift.sites[0].factor - f) < 1e-9);
    assert.equal(payload.commutingUplift.sites[0].agreedBy, STAFF);
    assert.match(payload.commutingUplift.method, /representative/);
    const scope3 = payload.annualComparison.at(-1).values.find((entry: any) => entry.scope === "3").value;
    assert.ok(Math.abs(scope3 - (108 * f + 6 + 50)) < 1e-9, "the 3.7 total that locks carries the uplifted figure");
  });

  it("uplift off everywhere: the snapshot is exactly the sampled one, with no uplift block", async () => {
    await setJobSiteHeadcount(database.pool, { jobId: JOB, siteId: leeds, employees: 100, companyCarUsers: 10, upliftEnabled: false, agreedHeadcount: null, expectedVersion: 2 }, staff());
    const payload = await snapshot();
    assert.equal(payload.commutingUplift, undefined);
    assert.ok(payload.measurements.every((entry: any) => entry.upliftFactor === undefined));
    assert.equal(payload.measurements.filter((entry: any) => entry.siteId === leeds).reduce((sum: number, entry: any) => sum + entry.tco2e, 0), 108);
  });
});
