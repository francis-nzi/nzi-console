import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, roleCapabilityGrants, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { setJobSiteInclusion, SITE_IN_USE_MESSAGE } from "../src/jobSiteInclusions";
import { refuseExcludedSiteChange, SITE_EXCLUDED_MESSAGE } from "../src/siteInclusionGuard";
import { createScopeRow, rollforwardScopeRows, updateScopeRow } from "../src/postgresCommands";
import { listJobSites } from "../src/readModels";
import { resolveJobSiteBoundary } from "../src/siteBoundary";
import { archiveSite, createClientSite } from "../src/siteLifecycle";
import { listPortalDataEntryBuckets, setPortalDataEntryBucketGrant } from "../src/portalDataEntry";
import { createPortalDataEntryRecord, decidePortalDataEntryReview, submitPortalDataEntryRecord } from "../src/portalDataEntryRecords";
import { withTenantRead, type PortalPrincipal, type StaffPrincipal } from "../src/index";

/**
 * Phase 3a, per-job site inclusion (0161; RULING-phase3-design.md #1–#6), against a real database:
 * - absence is included, so a job that decides nothing reads exactly as before;
 * - an exclusion is the next version, with a reason, and records ids, a boolean and a version (NZC-120);
 * - SITE_ARCHIVED either way, UNCHANGED for a no-op, NOT_FOUND for another client's site;
 * - SITE_IN_USE for any scope row (enabled or not), any source, any pending portal record — not an accepted/rejected one;
 * - every site-setting write refuses an excluded site; the portal neither offers nor authorises one; roll-forward drops it;
 * - the boundary leaves it out;
 * - atomic: an exclusion waits for a writer holding the job's shared lock and then sees its row, and a writer waits for an
 *   exclusion holding the job row and then sees it.
 */
const ORG = "demo-nzi-console"; // the synthetic factor seed's organisation
const CLIENT = "client-si";
const OTHER_CLIENT = "client-si-other";
const JOB = "job-si-2026";
const NEXT_JOB = "job-si-2027";
const ACTOR = "ada-si";
const USER = "portal-si";
const here = dirname(fileURLToPath(import.meta.url));

const staff: StaffPrincipal = {
  organisationId: ORG, userId: ACTOR, sessionId: "s", issuedAt: 1, expiresAt: 2,
  role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin"),
} as StaffPrincipal;
const portal = {
  principal: "portal", organisationId: ORG, userId: USER, clientId: CLIENT, sessionId: "p",
  issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid",
} as unknown as PortalPrincipal;

describe("a job's site inclusion (Phase 3a, 0161), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `si-${keys}`, correlationId: `corr-si-${keys}`,
      grant: commandGrantForRole("admin", ORG, ACTOR), ...(reason ? { reason } : {}) };
  };
  // Typed loosely: these build command inputs, and the command validates them.
  const entry = (over: Record<string, unknown> = {}): any => ({
    jobId: JOB, scope: "1", sourceLabel: "Boiler", reportLabel: "Boiler", categoryCode: "1.natural-gas",
    quantity: 10, unit: "kWh", datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorVersion: "2026 demo v1", factorLabel: "Gas", qualityTier: "measured", ...over,
  });
  const set = (siteId: string, included: boolean, expectedVersion: number, reason?: string, jobId = JOB) =>
    setJobSiteInclusion(database.pool, { jobId, siteId, included, expectedVersion }, context(reason));
  const sitesOf = (jobId = JOB) => withTenantRead(database.pool, ORG, (reader) => listJobSites(reader, jobId));
  const issue = (code: string) => (error: any) => error?.issues?.[0]?.code === code;
  const site = async (name: string, clientId = CLIENT) =>
    (await createClientSite(database.pool, { clientId, name, inServiceFrom: null } as never, context())).data.siteId;
  const s: Record<string, string> = {};
  let bucket = "";
  let officeRow = "";

  before(async () => {
    database = (await createDisposableDatabase("siteinclusion"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada Admin')`, [ORG, ACTOR]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    for (const clientId of [CLIENT, OTHER_CLIENT]) {
      await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,$2,'active')`, [ORG, clientId]);
    }
    for (const [jobId, sequence, year] of [[JOB, 1, 2026], [NEXT_JOB, 2, 2027]] as const) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',$5,$6,$7)`, [ORG, jobId, CLIENT, sequence, year, `${year}-01-01`, `${year}-12-31`]);
      await db.query(
        `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`,
        [ORG, jobId, `${year}-01-01`, `${year}-12-31`]);
    }
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    for (const name of ["office", "depot", "yard", "shed", "store", "kiosk", "annex", "bay", "old"]) s[name] = await site(name);
    s.far = await site("far", OTHER_CLIENT);
    const { rows: [old] } = await db.query<{ version: number }>(`SELECT version FROM nzi_console.client_sites WHERE site_id=$1`, [s.old]);
    await archiveSite(database.pool, { siteId: s.old!, expectedVersion: old!.version }, context("closed"));

    // What uses a site: an enabled row at the depot, a disabled row in the shed, a source in the store.
    officeRow = (await createScopeRow(database.pool, entry({ siteId: s.office, sourceLabel: "Office boiler" }), context())).data.rowId;
    await createScopeRow(database.pool, entry({ siteId: s.depot, sourceLabel: "Depot boiler" }), context());
    await db.query(
      `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code,site_id,enabled)
       VALUES ($1,'row-shed',$2,'1','Shed heater','Shed heater','Scope 1','Gas','1.natural-gas',$3,false)`, [ORG, JOB, s.shed]);
    await db.query(
      `INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_name,dataset_id,factor_id,factor_source,site_id)
       VALUES ($1,'src-store',$2,'1','Store boiler','synthetic-gb-2026','gas-demo','dataset',$3)`, [ORG, JOB, s.store]);

    // The portal: one bucket on an unsited row, authorised for the kiosk and the yard.
    await db.query(
      `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code)
       VALUES ($1,'row-open',$2,'1','Open','Open','Scope 1','Gas','1.natural-gas')`, [ORG, JOB]);
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, USER, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
       VALUES ($1,'grant-si',$2,$3,$4,now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, USER, JOB]);
    bucket = (await setPortalDataEntryBucketGrant(database.pool, staff, {
      portalUserId: USER, jobId: JOB, scopeRowId: "row-open", entryKind: "manual_activity", factorIds: ["gas-demo"], siteIds: [s.kiosk!, s.yard!] })).bucketGrantId;
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("absence is included: a job that has decided nothing lists every in-use site as included, at version 0", async () => {
    const sites = await sitesOf();
    assert.equal(sites.length, 8, "the eight in-use sites; the archived one is not listed");
    assert.ok(sites.every((one) => one.included === true && one.inclusionVersion === 0 && one.exclusionReason === null));
    assert.ok(!sites.some((one) => one.id === s.old), "an archived site is not listed");
    assert.equal((await db.query(`SELECT 1 FROM nzi_console.job_site_inclusions`)).rowCount, 0);
  });

  it("refuses an exclusion without a reason, at a stale version, or as a no-op", async () => {
    await assert.rejects(() => set(s.yard!, false, 0), issue("REASON_REQUIRED"));
    await assert.rejects(() => set(s.yard!, false, 1, "sold"), (error: any) => error?.name === "VersionConflictError");
    await assert.rejects(() => set(s.yard!, true, 0), issue("UNCHANGED"));
  });

  it("leaves a site out as the next version, and records only ids, a boolean and a version (NZC-120)", async () => {
    const done = await set(s.yard!, false, 0, "sold before the year");
    assert.deepEqual(done.data, { jobId: JOB, siteId: s.yard, version: 1, included: false });
    const yard = (await sitesOf()).find((one) => one.id === s.yard)!;
    assert.deepEqual({ included: yard.included, version: yard.inclusionVersion, reason: yard.exclusionReason }, { included: false, version: 1, reason: "sold before the year" });
    const { rows: [audit] } = await db.query<{ action: string; entity_id: string; before_json: unknown; after_json: unknown }>(
      `SELECT action, entity_id, before_json, after_json FROM nzi_console.audit_events WHERE action='job_site_inclusion_set' ORDER BY occurred_at DESC LIMIT 1`);
    assert.equal(audit!.entity_id, `${JOB}:${s.yard}`);
    assert.deepEqual(audit!.after_json, { jobId: JOB, siteId: s.yard, version: 1, included: false });
    assert.deepEqual(audit!.before_json, { included: true });
    const { rows: [outbox] } = await db.query<{ payload_json: unknown }>(`SELECT payload_json FROM nzi_console.transactional_outbox WHERE topic='job.site.inclusion.set'`);
    assert.deepEqual(outbox!.payload_json, { jobId: JOB, siteId: s.yard, version: 1, included: false });
    // No-op again, then back in and out: each a version, the one before kept.
    await assert.rejects(() => set(s.yard!, false, 1, "again"), issue("UNCHANGED"));
    assert.equal((await set(s.yard!, true, 1)).data.version, 2);
    assert.equal((await set(s.yard!, false, 2, "sold before the year")).data.version, 3);
    assert.equal((await db.query(`SELECT 1 FROM nzi_console.job_site_inclusions WHERE site_id=$1`, [s.yard])).rowCount, 3);
  });

  it("refuses an archived site either way, and a site that is not the job client's", async () => {
    await assert.rejects(() => set(s.old!, false, 0, "gone"), issue("SITE_ARCHIVED"));
    await assert.rejects(() => set(s.far!, false, 0, "not ours"), issue("NOT_FOUND"));
  });

  it("refuses to leave out a site the job uses: an enabled row, a disabled row, a source", async () => {
    for (const name of ["depot", "shed", "store"]) {
      await assert.rejects(() => set(s[name]!, false, 0, "unused?"), (error: any) => issue("SITE_IN_USE")(error) && error.issues[0].message === SITE_IN_USE_MESSAGE, name);
    }
  });

  it("a pending portal record uses its site; once rejected it no longer does", async () => {
    const draft = await createPortalDataEntryRecord(database.pool, portal, JOB, { bucketGrantId: bucket, quantity: 100, unit: "kWh", factorId: "gas-demo", siteId: s.kiosk!, note: "" });
    await assert.rejects(() => set(s.kiosk!, false, 0, "closed"), issue("SITE_IN_USE"), "a draft");
    const submitted = await submitPortalDataEntryRecord(database.pool, portal, JOB, draft.recordId, draft.version);
    await assert.rejects(() => set(s.kiosk!, false, 0, "closed"), issue("SITE_IN_USE"), "a submission pending review");
    await decidePortalDataEntryReview(database.pool, staff, { queueId: submitted.queueId, expectedSubmittedVersion: submitted.version, decision: "reject", note: "wrong site" });
    assert.equal((await set(s.kiosk!, false, 0, "closed")).data.version, 1, "a rejected submission does not hold the site");
  });

  it("every site-setting write refuses a site the job leaves out; an included one still lands", async () => {
    await assert.rejects(() => createScopeRow(database.pool, entry({ siteId: s.yard, sourceLabel: "Yard boiler" }), context()),
      (error: any) => issue("SITE_EXCLUDED")(error) && error.issues[0].message === SITE_EXCLUDED_MESSAGE, "scope row create");
    const { rows: [office] } = await db.query<{ version: number }>(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [officeRow]);
    await assert.rejects(() => updateScopeRow(database.pool, { ...entry({ siteId: s.yard, sourceLabel: "Office boiler" }), rowId: officeRow, expectedVersion: office!.version, enabled: true }, context()),
      issue("SITE_EXCLUDED"), "scope row update onto it");
    assert.ok((await createScopeRow(database.pool, entry({ siteId: s.annex, sourceLabel: "Annex boiler" }), context())).data.rowId, "an included site");
    await assert.rejects(() => createPortalDataEntryRecord(database.pool, portal, JOB, { bucketGrantId: bucket, quantity: 1, unit: "kWh", factorId: "gas-demo", siteId: s.yard!, note: "" }),
      new RegExp(SITE_EXCLUDED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "portal record create");
  });

  it("the portal neither offers nor authorises a site the job leaves out", async () => {
    const [offered] = await listPortalDataEntryBuckets(database.pool, portal, JOB);
    assert.deepEqual(offered!.sites.map((one) => one.id), [], "the yard and the kiosk are both left out, so nothing is offered");
    await assert.rejects(() => setPortalDataEntryBucketGrant(database.pool, staff, {
      portalUserId: USER, jobId: JOB, scopeRowId: "row-open", entryKind: "manual_activity", factorIds: ["gas-demo"], siteIds: [s.yard!] }), /one this job leaves out/);
    assert.deepEqual((await db.query<{ allowed_site_ids: string[] }>(`SELECT allowed_site_ids FROM nzi_console.portal_data_entry_bucket_grants WHERE bucket_grant_id=$1`, [bucket])).rows[0]!.allowed_site_ids.sort(),
      [s.kiosk, s.yard].sort(), "the grant keeps its ids; nothing is rewritten");
  });

  it("roll-forward drops a site the new job leaves out, as it does an archived one", async () => {
    await set(s.office!, false, 0, "moved out", NEXT_JOB);
    await rollforwardScopeRows(database.pool, { jobId: NEXT_JOB, priorJobId: JOB, rowIds: [officeRow] }, context());
    const { rows: [row] } = await db.query<{ site_id: string | null }>(`SELECT site_id FROM nzi_console.job_scope_rows WHERE job_id=$1 AND rolled_forward_from_row_id=$2`, [NEXT_JOB, officeRow]);
    assert.equal(row!.site_id, null);
  });

  it("the boundary leaves out an excluded site — out of the boundary and out of the floor-area sites", async () => {
    const boundary = (await withTenantRead(database.pool, ORG, (reader) => resolveJobSiteBoundary(reader, JOB)))!;
    assert.ok(!boundary.inBoundaryIds.has(s.yard!) && !boundary.sites.some((one) => one.id === s.yard), "the yard");
    assert.ok(boundary.inBoundaryIds.has(s.office!) && boundary.inBoundaryIds.has(s.depot!), "included sites stay in");
  });

  it("atomic: an exclusion waits for a writer holding the job's shared lock, then sees its row", async () => {
    const writer = await database.admin();
    try {
      await writer.query("BEGIN");
      await writer.query(`SELECT set_config('app.organisation_id', $1, true)`, [ORG]);
      await refuseExcludedSiteChange(writer, ORG, JOB, s.annex!, null, (message) => new Error(message));
      // The annex's only use so far is the row this writer has inserted and not yet committed.
      await writer.query(
        `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code,site_id)
         VALUES ($1,'row-race-annex',$2,'1','Race','Race','Scope 1','Gas','1.natural-gas',$3)`, [ORG, JOB, s.annex]);
      await db.query(`DELETE FROM nzi_console.job_scope_rows WHERE job_id=$1 AND site_id=$2 AND scope_row_id<>'row-race-annex'`, [JOB, s.annex]);
      let settled = false;
      const outcome = set(s.annex!, false, 0, "unused")
        .then(() => "excluded", (error: any) => error?.issues?.[0]?.code ?? String(error)).finally(() => { settled = true; });
      await new Promise((done) => setTimeout(done, 400));
      assert.equal(settled, false, "the exclusion waited for the writer's transaction");
      await writer.query("COMMIT");
      assert.equal(await outcome, "SITE_IN_USE", "after the wait it saw the row the writer committed");
    } finally { await writer.end(); }
  });

  it("atomic: a writer waits for an exclusion holding the job row, then refuses the site", async () => {
    const excluder = await database.admin();
    try {
      await excluder.query("BEGIN");
      await excluder.query(`SELECT set_config('app.organisation_id', $1, true)`, [ORG]);
      await excluder.query(`SELECT 1 FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2 FOR UPDATE`, [ORG, JOB]);
      const { rows: [bay] } = await excluder.query<{ version: number }>(`SELECT coalesce(max(version),0)::int AS version FROM nzi_console.job_site_inclusions WHERE site_id=$1`, [s.bay]);
      await excluder.query(
        `INSERT INTO nzi_console.job_site_inclusions (organisation_id,job_id,site_id,version,included,reason,decided_by,correlation_id)
         VALUES ($1,$2,$3,$4,false,'race',$5,'corr-race')`, [ORG, JOB, s.bay, bay!.version + 1, ACTOR]);
      let settled = false;
      const write = createScopeRow(database.pool, entry({ siteId: s.bay, sourceLabel: "Bay boiler" }), context());
      const outcome = write.then(() => "created", (error: any) => error?.issues?.[0]?.code ?? String(error)).finally(() => { settled = true; });
      await new Promise((done) => setTimeout(done, 400));
      assert.equal(settled, false, "the writer waited for the exclusion's transaction");
      await excluder.query("COMMIT");
      assert.equal(await outcome, "SITE_EXCLUDED", "after the wait it read the committed exclusion");
    } finally { await excluder.end(); }
  });
});
