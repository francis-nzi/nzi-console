import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, roleCapabilityGrants } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, lookupVehicleByRegistration, withTenantRead } from "../src/index";
import { listPortalDataEntryBuckets, setPortalDataEntryBucketGrant } from "../src/portalDataEntry";
import { createPortalDataEntryRecord, decidePortalDataEntryReview, submitPortalDataEntryRecord } from "../src/portalDataEntryRecords";
import type { PortalPrincipal, StaffPrincipal } from "../src/index";
// NZC-162: the capture path as production runs it — the portal's default, the console's draft mapping and the
// lookup's suggestion — imported across the package seam as the other capture suites do.
import * as modelModule from "../../../apps/console/app/jobs/emissionEntryModel";
import * as defaultModule from "../../../apps/console/app/portal/portalFactorDefault";
import * as suggestionModule from "../../../apps/console/app/lib/vehicleSuggestion";

const form = ((modelModule as any).emissionEntryDraftToPortalRecord ? modelModule : (modelModule as any).default) as typeof import("../../../apps/console/app/jobs/emissionEntryModel");
const { defaultPortalFactorId } = ((defaultModule as any).defaultPortalFactorId ? defaultModule : (defaultModule as any).default) as typeof import("../../../apps/console/app/portal/portalFactorDefault");
const { suggestVehicleFactor } = ((suggestionModule as any).suggestVehicleFactor ? suggestionModule : (suggestionModule as any).default) as typeof import("../../../apps/console/app/lib/vehicleSuggestion");

/**
 * Portal parity at Stop 2d, end to end: grant → listing → the portal's default → draft → submission → acceptance →
 * a calculated number.
 *
 * Acceptance is the third write path, and now applies what the CRM's write applies — F1 and the variant-base rule —
 * with the accountable party for a deviation being NZI: a client's pick that is not the declared factor stands only
 * if the reviewer records why (P1), or the reviewer switches it to the declared one. The grant refuses a bucket that
 * omits the category's entry-independent declared factor (P2), and the portal pre-selects that factor (P4). A
 * looked-up vehicle's attributes travel in the draft, and acceptance re-resolves from them, naming both actors (P3).
 *
 * Every case starts at the real grant command and ends at the scope row the reviewer's decision wrote.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const CLIENT = "client-2d";
const JOB = "job-2d";
const USER = "portal-2d";
const STAFF = "staff-2d";
const here = dirname(fileURLToPath(import.meta.url));

const staff: StaffPrincipal = {
  organisationId: ORG, userId: STAFF, sessionId: "s", issuedAt: 1, expiresAt: 2,
  role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin"),
} as StaffPrincipal;
const portal = {
  principal: "portal", organisationId: ORG, userId: USER, clientId: CLIENT, sessionId: "p",
  issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid",
} as unknown as PortalPrincipal;

describe("portal parity: a portal entry is resolved at acceptance as the CRM's write resolves it (Stop 2d)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff" as const, idempotencyKey: `2d-${keys}`,
      correlationId: `corr-2d-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) };
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

  /** The portal surface: the bucket as listed, the factor it pre-selects (or the client's pick), the draft mapped by
   *  the console's own function, saved, and sent. */
  const capture = async (scopeRowId: string, over: Record<string, unknown> = {}, pick?: string) => {
    const bucket = await bucketFor(scopeRowId);
    const factorId = pick ?? defaultPortalFactorId(bucket.factors, bucket.declaredFactorId);
    const mapped = form.emissionEntryDraftToPortalRecord(draft({ ...over, factorId }), bucket as never, { id: null });
    assert.ok(!("error" in mapped), `the draft did not map: ${"error" in mapped ? mapped.error : ""}`);
    const saved = await createPortalDataEntryRecord(database.pool, portal, JOB, mapped as never);
    return submitPortalDataEntryRecord(database.pool, portal, JOB, saved.recordId, saved.version);
  };
  const accept = (submitted: { queueId: string; version: number }, deviation: { factorOverrideReason?: string; useDeclaredFactor?: boolean } = {}) =>
    decidePortalDataEntryReview(database.pool, staff, {
      queueId: submitted.queueId, expectedSubmittedVersion: submitted.version, decision: "accept", note: "", ...deviation,
    });
  const landed = async (scopeRowId: string) => (await db.query<{ factor_id: string | null; version: number; provenance_json: Record<string, any> }>(
    `SELECT factor_id, version, provenance_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [scopeRowId])).rows[0]!;
  const calculate = async (scopeRowId: string) => {
    const current = await landed(scopeRowId);
    await calculateScopeRow(database.pool, { jobId: JOB, rowId: scopeRowId, expectedVersion: current.version }, context());
    return Number((await db.query<{ t: string }>(`SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [scopeRowId])).rows[0]!.t);
  };
  const DEVIATION = /switch it to the declared factor, or record why the client's choice stands/;

  before(async () => {
    database = (await createDisposableDatabase("portal2d"))!;
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
    // Two alternatives a client could plausibly pick, named as test factors: a second grid factor, and a per-litre
    // factor for a fuel the lookup did not report.
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES
        ($1,'synthetic-gb-2026','electricity-alt-test','UK electricity, supplier-specific — test','kWh',0.4,ARRAY['2']),
        ($1,'synthetic-gb-2026','petrol-litres-test','Petrol — test','litres',2.3,ARRAY['1'])`, [ORG]);
    for (const id of ["row-elec-matched", "row-elec-override", "row-elec-switch"]) await row(id, "2", "2.purchased-electricity");
    await row("row-van", "1", "1.company-vehicles");
    await row("row-van-contradicted", "1", "1.company-vehicles");
    await row("row-travel", "3.6", "3.6");
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, USER, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
       VALUES ($1,'grant-2d',$2,$3,$4,now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, USER, JOB]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── The grant (P2) ───────────────────────────────────────────────────────────────────────────────────

  it("refuses an electricity bucket that omits the declared grid factor, and never adds it", async () => {
    await assert.rejects(() => grant("row-elec-matched", ["electricity-alt-test"]), /must authorise it/);
    const granted = await db.query(`SELECT 1 FROM nzi_console.portal_data_entry_bucket_grants WHERE scope_row_id='row-elec-matched'`);
    assert.equal(granted.rows.length, 0, "a refused grant left a bucket behind");
  });

  it("refuses a business-travel bucket offering the base of its own variant", async () => {
    await assert.rejects(() => grant("row-travel", ["uk-ghg-1_101_1011_8_1"]), /base factor this category files under its own variant/);
  });

  it("does not demand a vehicle factor at the grant — that depends on the entry, and meets F1 at acceptance", async () => {
    await grant("row-van", ["uk-ghg-1_101_1011_8_1", "gas-demo"]);
  });

  // ── The declared factor, from the listing to a number (P4) ───────────────────────────────────────────

  it("lists the declared factor, pre-selects it among several, and accepts it as matched — 0.3 t", async () => {
    await grant("row-elec-matched", ["uk-ghg-7_400_4000_5_1", "electricity-alt-test"]);
    const bucket = await bucketFor("row-elec-matched");
    assert.equal(bucket.declaredFactorId, "uk-ghg-7_400_4000_5_1");
    assert.equal(defaultPortalFactorId(bucket.factors, bucket.declaredFactorId), "uk-ghg-7_400_4000_5_1",
      "with two grid factors authorised the portal did not pre-select the declared one");
    await accept(await capture("row-elec-matched", { unit: "kWh" }));
    const result = await landed("row-elec-matched");
    assert.equal(result.factor_id, "uk-ghg-7_400_4000_5_1");
    assert.equal(result.provenance_json.declarativeResolution.decision, "matched");
    assert.equal(result.provenance_json.declarativeResolution.acceptedBy, STAFF);
    assert.equal(await calculate("row-elec-matched"), 0.3);
  });

  // ── A client's pick that is not the declared factor (P1) ─────────────────────────────────────────────

  it("refuses to accept the client's alternative without a reason, and writes nothing", async () => {
    await grant("row-elec-override", ["uk-ghg-7_400_4000_5_1", "electricity-alt-test"]);
    const submitted = await capture("row-elec-override", {}, "electricity-alt-test");
    await assert.rejects(() => accept(submitted), DEVIATION);
    assert.equal((await landed("row-elec-override")).factor_id, null, "a refused acceptance wrote the client's factor");
    // The reviewer's reason is what lets it stand — recorded as an override, with the reviewer as the one deciding.
    await accept(submitted, { factorOverrideReason: "Supplier is US-based; the client's grid factor is right." });
    const result = await landed("row-elec-override");
    assert.equal(result.factor_id, "electricity-alt-test");
    assert.equal(result.provenance_json.declarativeResolution.decision, "override");
    assert.equal(result.provenance_json.declarativeResolution.acceptedBy, STAFF);
    assert.equal(await calculate("row-elec-override"), 0.4);
  });

  it("switches the client's alternative to the declared factor when the reviewer chooses that", async () => {
    await grant("row-elec-switch", ["uk-ghg-7_400_4000_5_1", "electricity-alt-test"]);
    await accept(await capture("row-elec-switch", {}, "electricity-alt-test"), { useDeclaredFactor: true });
    const result = await landed("row-elec-switch");
    assert.equal(result.factor_id, "uk-ghg-7_400_4000_5_1");
    assert.equal(result.provenance_json.declarativeResolution.decision, "matched");
    assert.equal(result.provenance_json.declarativeResolution.switchedToDeclared, true);
    assert.equal(await calculate("row-elec-switch"), 0.3);
  });

  // ── A looked-up vehicle: attributes asserted by the client, re-resolved at acceptance (P3) ─────────────

  it("carries the lookup's attributes to acceptance, which resolves the vehicle and names both actors — 2.5 t", async () => {
    const found = await lookupVehicleByRegistration("AB12CDH", { allowStub: true });
    assert.ok(found.ok);
    const suggestion = await withTenantRead(database.pool, ORG, (reader) =>
      suggestVehicleFactor(reader, ORG, JOB, found.vehicle, found.source, "1.company-vehicles", "1"));
    assert.equal(suggestion.factor?.factorId, "uk-ghg-1_101_1011_8_1");
    const bucket = await bucketFor("row-van");
    assert.equal(bucket.declaredFactorId, null, "a vehicle bucket claimed a declared factor without a vehicle");
    assert.equal(defaultPortalFactorId(bucket.factors, bucket.declaredFactorId), "", "the vehicle bucket pre-selected a factor");

    const submitted = await capture("row-van", { registration: "AB12 CDH", assertedVehicleAttributes: suggestion.attributes }, "uk-ghg-1_101_1011_8_1");
    const stored = await db.query<{ detail_json: Record<string, any> }>(
      `SELECT detail_json FROM nzi_console.portal_data_entry_records WHERE bucket_grant_id=$1`, [bucket.bucketGrantId]);
    assert.deepEqual(stored.rows[0]!.detail_json, { vehicleAttributes: { source: "stub", fuel: "diesel", vehicleClass: "van" } });
    assert.ok(!JSON.stringify(stored.rows[0]!.detail_json).includes("AB12"), "the plate was stored in the detail");

    await accept(submitted);
    const result = await landed("row-van");
    assert.equal(result.factor_id, "uk-ghg-1_101_1011_8_1");
    const resolution = result.provenance_json.declarativeResolution;
    assert.equal(resolution.decision, "matched");
    assert.equal(resolution.attributesAssertedBy, USER, "the client who asserted the attributes is not named");
    assert.equal(resolution.acceptedBy, STAFF, "the reviewer who accepted is not named");
    assert.equal(resolution.assertedVehicleAttributes.trust, "asserted-at-capture");
    assert.equal(await calculate("row-van"), 2.5);
  });

  it("refuses a vehicle entry whose pick contradicts its own lookup, and switches it to what the lookup resolves", async () => {
    const found = await lookupVehicleByRegistration("AB12CDH", { allowStub: true });
    assert.ok(found.ok);
    const suggestion = await withTenantRead(database.pool, ORG, (reader) =>
      suggestVehicleFactor(reader, ORG, JOB, found.vehicle, found.source, "1.company-vehicles", "1"));
    // A diesel van priced per litre of petrol. The bucket allows petrol; acceptance, reading the lookup, refuses it.
    await grant("row-van-contradicted", ["uk-ghg-1_101_1011_8_1", "petrol-litres-test"]);
    const submitted = await capture("row-van-contradicted", { assertedVehicleAttributes: suggestion.attributes }, "petrol-litres-test");
    await assert.rejects(() => accept(submitted), DEVIATION);
    assert.equal((await landed("row-van-contradicted")).factor_id, null, "a refused acceptance wrote the client's factor");
    await accept(submitted, { useDeclaredFactor: true });
    const result = await landed("row-van-contradicted");
    assert.equal(result.factor_id, "uk-ghg-1_101_1011_8_1", "the switch did not resolve from the stored attributes");
    assert.equal(result.provenance_json.declarativeResolution.switchedToDeclared, true);
    assert.equal(result.provenance_json.declarativeResolution.attributesAssertedBy, USER);
    assert.equal(await calculate("row-van-contradicted"), 2.5);
  });

  it("lets a pick stand where the lookup's rule cannot price the entry's unit (D2), rather than refusing it", async () => {
    // A diesel van recorded against a per-kWh factor: the diesel rule's factor is per litre, so it declines and
    // nothing is declared — the client's pick is the pick, and the reviewer's eyes are what check it.
    const found = await lookupVehicleByRegistration("AB12CDH", { allowStub: true });
    assert.ok(found.ok);
    const suggestion = await withTenantRead(database.pool, ORG, (reader) =>
      suggestVehicleFactor(reader, ORG, JOB, found.vehicle, found.source, "1.company-vehicles", "1"));
    await accept(await capture("row-van", { assertedVehicleAttributes: suggestion.attributes }, "gas-demo"));
    assert.equal((await landed("row-van")).factor_id, "gas-demo");
  });
});
