import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, roleCapabilityGrants, SUPPLY_SOURCES } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow } from "../src/index";
import { listPortalDataEntryBuckets, setPortalDataEntryBucketGrant } from "../src/portalDataEntry";
import {
  createPortalDataEntryRecord, decidePortalDataEntryReview, listPortalDataEntryRecords, listPortalDataEntryReviewQueue,
  submitPortalDataEntryRecord, updatePortalDataEntryRecord,
} from "../src/portalDataEntryRecords";
import type { PortalPrincipal, StaffPrincipal } from "../src/index";
// NZC-162: the portal's draft mapping as production runs it, imported across the package seam.
import * as modelModule from "../../../apps/console/app/jobs/emissionEntryModel";

const form = ((modelModule as any).emissionEntryDraftToPortalRecord ? modelModule : (modelModule as any).default) as typeof import("../../../apps/console/app/jobs/emissionEntryModel");

/**
 * A portal entry records how its electricity arrived, and acceptance carries it onto the row (NZC-164, 0124).
 *
 * The H4 precondition. The T&D companion fires on `supplySource`; a portal entry that cannot state it would produce
 * no T&D row once companions are on, silently. Before 0124 the portal's form *showed* the Supply control — it is the
 * shared renderer — and the draft mapping dropped the answer. Each case here runs from the real grant, through the
 * console's own mapping, draft, submission and the reviewer's queue, to acceptance and a calculated number.
 *
 * What it does not do, asserted rather than assumed: switch anything on. Companions stay off, so no 3.3 row appears.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const CLIENT = "client-ss";
const JOB = "job-ss";
const USER = "portal-ss";
const STAFF = "staff-ss";
const here = dirname(fileURLToPath(import.meta.url));

const staff: StaffPrincipal = {
  organisationId: ORG, userId: STAFF, sessionId: "s", issuedAt: 1, expiresAt: 2,
  role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin"),
} as StaffPrincipal;
const portal = {
  principal: "portal", organisationId: ORG, userId: USER, clientId: CLIENT, sessionId: "p",
  issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid",
} as unknown as PortalPrincipal;

describe("a portal entry records how its electricity arrived, and acceptance carries it (NZC-164)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff" as const, idempotencyKey: `ss-${keys}`,
      correlationId: `corr-ss-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) };
  };
  const row = (id: string, scope: string, category: string) => db.query(
    `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code)
     VALUES ($1,$2,$3,$4,$2,$2,'Scope x','x',$5)`, [ORG, id, JOB, scope, category]);
  const grant = (scopeRowId: string, factorIds: string[]) => setPortalDataEntryBucketGrant(database.pool, staff, {
    portalUserId: USER, jobId: JOB, scopeRowId, entryKind: "manual_activity", factorIds, siteIds: [],
  });
  const bucketFor = async (scopeRowId: string) =>
    (await listPortalDataEntryBuckets(database.pool, portal, JOB)).find((bucket) => bucket.scopeRowId === scopeRowId)!;
  const draft = (over: Record<string, unknown>) => ({
    activity: "Meter", quantity: "1000", unit: "", vatPercent: "", glCode: "", spendCategoryId: "", registration: "",
    manualMode: false, manualDetail: "", factorId: "", qualityTier: "Measured", dataConfidence: "M — Medium",
    supplySource: "", factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {}, ...over,
  }) as any;
  /** The portal surface: the bucket as listed, the form's draft mapped by the console's own function, and saved. */
  const save = async (scopeRowId: string, over: Record<string, unknown>) => {
    const bucket = await bucketFor(scopeRowId);
    const mapped = form.emissionEntryDraftToPortalRecord(draft(over), bucket as never, { id: null });
    assert.ok(!("error" in mapped), `the draft did not map: ${"error" in mapped ? mapped.error : ""}`);
    return createPortalDataEntryRecord(database.pool, portal, JOB, mapped as never);
  };
  const stored = async (recordId: string) => (await db.query<{ supply_source: string | null }>(
    `SELECT supply_source FROM nzi_console.portal_data_entry_records WHERE record_id=$1`, [recordId])).rows[0]!.supply_source;
  const accept = (submitted: { queueId: string; version: number }) => decidePortalDataEntryReview(database.pool, staff, {
    queueId: submitted.queueId, expectedSubmittedVersion: submitted.version, decision: "accept", note: "",
  });
  const landed = async (scopeRowId: string) => (await db.query<{ supply_source: string | null; factor_id: string; version: number; provenance_json: Record<string, any> }>(
    `SELECT supply_source, factor_id, version, provenance_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [scopeRowId])).rows[0]!;

  before(async () => {
    database = (await createDisposableDatabase("portalsupply"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`, [ORG, STAFF]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    await row("row-grid", "2", "2.purchased-electricity");
    await row("row-unstated", "2", "2.purchased-electricity");
    await row("row-rego", "2", "2.renewable-electricity");
    await row("row-van", "1", "1.company-vehicles");
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, USER, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
       VALUES ($1,'grant-ss',$2,$3,$4,now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, USER, JOB]);
    for (const id of ["row-grid", "row-unstated", "row-rego"]) await grant(id, ["electricity-demo"]);
    await grant("row-van", ["diesel-demo"]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("tells each form whether its bucket asks how electricity arrived — from the input spec, not a list of categories", async () => {
    assert.equal((await bucketFor("row-grid")).capturesSupplySource, true);
    assert.equal((await bucketFor("row-rego")).capturesSupplySource, true);
    assert.equal((await bucketFor("row-van")).capturesSupplySource, false);
  });

  it("keeps the answer the form collects, where the mapping used to drop it", async () => {
    const saved = await save("row-grid", { supplySource: "grid" });
    assert.equal(await stored(saved.recordId), "grid", "the portal's Supply answer was lost between the form and the record");
    const listed = (await listPortalDataEntryRecords(database.pool, portal, JOB)).find((record) => record.recordId === saved.recordId)!;
    assert.equal(listed.supplySource, "grid", "the client's own list does not show what they said");
  });

  it("keeps not-stated distinct from every answer, as the row does", async () => {
    const saved = await save("row-unstated", {});
    assert.equal(await stored(saved.recordId), null);
  });

  it("stores the answer through the edit path too, because it is a second call site", async () => {
    const saved = await save("row-grid", { supplySource: "grid" });
    const bucket = await bucketFor("row-grid");
    const edited = await updatePortalDataEntryRecord(database.pool, portal, JOB, saved.recordId, saved.version, {
      bucketGrantId: bucket.bucketGrantId, quantity: 500, unit: "kWh", factorId: "electricity-demo", siteId: null, note: "", supplySource: "self-generated",
    });
    assert.equal(edited.version, 2);
    assert.equal(await stored(saved.recordId), "self-generated");
  });

  it("accepts every value the contract enumerates, so acceptance can always carry it onto the row", async () => {
    const bucket = await bucketFor("row-grid");
    for (const value of SUPPLY_SOURCES) {
      const saved = await createPortalDataEntryRecord(database.pool, portal, JOB, {
        bucketGrantId: bucket.bucketGrantId, quantity: 1, unit: "kWh", factorId: "electricity-demo", siteId: null, note: "", supplySource: value,
      });
      assert.equal(await stored(saved.recordId), value);
    }
  });

  it("refuses a value the contract does not name, and one on a bucket that does not ask", async () => {
    const grid = await bucketFor("row-grid");
    await assert.rejects(() => createPortalDataEntryRecord(database.pool, portal, JOB, {
      bucketGrantId: grid.bucketGrantId, quantity: 1, unit: "kWh", factorId: "electricity-demo", siteId: null, note: "", supplySource: "solar-ish",
    }), /Supply must be one of/);
    const van = await bucketFor("row-van");
    await assert.rejects(() => createPortalDataEntryRecord(database.pool, portal, JOB, {
      bucketGrantId: van.bucketGrantId, quantity: 1, unit: "litres", factorId: "diesel-demo", siteId: null, note: "", supplySource: "grid",
    }), /does not record how electricity arrived/);
  });

  it("shows the reviewer what the client said, and carries it onto the row at acceptance — 0.3 t, and no T&D row", async () => {
    const saved = await save("row-grid", { supplySource: "grid" });
    const submitted = await submitPortalDataEntryRecord(database.pool, portal, JOB, saved.recordId, saved.version);
    const queued = (await listPortalDataEntryReviewQueue(database.pool, staff, JOB)).find((item) => item.queueId === submitted.queueId)!;
    assert.equal(queued.supplySource, "grid", "the reviewer cannot see how the client said the electricity arrived");
    await accept(submitted);
    const result = await landed("row-grid");
    assert.equal(result.supply_source, "grid", "acceptance did not carry the supply source onto the row");
    assert.equal(result.provenance_json.supplySourceStatedBy, USER, "the client who stated it is not named");
    assert.equal(result.provenance_json.declarativeResolution.decision, "matched");
    await calculateScopeRow(database.pool, { jobId: JOB, rowId: "row-grid", expectedVersion: result.version }, context());
    const calculated = await db.query<{ t: string }>(`SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE scope_row_id='row-grid'`);
    assert.equal(Number(calculated.rows[0]!.t), 0.3);
    // Companions stay off: capture is the precondition, not the activation.
    const td = await db.query(`SELECT 1 FROM nzi_console.job_scope_rows WHERE job_id=$1 AND scope LIKE '3.3%'`, [JOB]);
    assert.equal(td.rows.length, 0, "a T&D row appeared — companions are not switched on");
  });

  it("carries a renewable supply the same way, and not-stated as not-stated", async () => {
    const rego = await save("row-rego", { supplySource: "rego" });
    await accept(await submitPortalDataEntryRecord(database.pool, portal, JOB, rego.recordId, rego.version));
    assert.equal((await landed("row-rego")).supply_source, "rego");

    const unstated = await save("row-unstated", {});
    await accept(await submitPortalDataEntryRecord(database.pool, portal, JOB, unstated.recordId, unstated.version));
    const result = await landed("row-unstated");
    assert.equal(result.supply_source, null, "acceptance invented a supply source nobody stated");
    assert.equal(result.provenance_json.supplySourceStatedBy, undefined);
  });
});
