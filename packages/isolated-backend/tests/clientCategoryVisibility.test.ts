import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  AuthorizationError, CommandValidationError, listCategoryVisibility, listInputSpec,
  listInputSpecForClient, listPortalDataEntryBuckets, setClientCategoryVisibility,
} from "../src/index";

/**
 * What a client sees of the category list, and why (NZC-110).
 *
 * Three properties are proved here, and the third is the one that justifies the table existing at
 * all:
 *
 * 1. **A hidden category is absent from the client's spec**, with nothing left behind to say how
 *    many were withheld.
 * 2. **Effective visibility is granted AND category-on.** Turning a category off hides its rows
 *    whatever data-entry grants exist, and default-on weakens nothing, because a row still needs a
 *    grant to be seen at all.
 * 3. **The CRM can say why.** A category absent because somebody decided is distinguishable from a
 *    category absent because nobody has looked — which is the difference between answering a
 *    client's question and shrugging at it.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const OTHER_CLIENT = "client-b";
const ACTOR = "consultant-a";

const context = (key: string) => ({
  organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole("admin", ORG, ACTOR),
});

describe("a category a client does not see (NZC-110)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;
  let aCategory: string;
  let anotherCategory: string;

  before(async () => {
    database = (await createDisposableDatabase("catvisibility"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ACTOR]);
    for (const [clientId, name] of [[CLIENT, "Client A"], [OTHER_CLIENT, "Client B"]]) {
      await db.query(
        `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,$3,'active')`,
        [ORG, clientId, name]);
    }
    // The spec is seeded by 0093 — real categories, not invented ones, so the decisions here are
    // about things the product actually offers.
    const spec = await listInputSpec(db);
    assert.ok(spec.length >= 2, "the governed spec should be seeded");
    aCategory = spec[0]!.categoryCode;
    anotherCategory = spec[1]!.categoryCode;
  });

  after(async () => { await db?.end(); await database?.end(); });

  /** The portal session the data-entry read runs under. */
  const portalPrincipal = () => ({
    principal: "portal" as const, organisationId: ORG, userId: "portal-a", clientId: CLIENT,
    sessionId: "s", issuedAt: 1, expiresAt: 2,
    displayName: "A Person", email: "someone@example.test",
    idleLimitMinutes: 30, termsVersion: "v1", mustAcceptTerms: false,
  });

  it("shows every category until somebody decides otherwise", async () => {
    const all = await listInputSpec(db);
    const mine = await listInputSpecForClient(db, CLIENT);
    assert.deepEqual(mine.map((c) => c.categoryCode), all.map((c) => c.categoryCode));
    assert.deepEqual(await listCategoryVisibility(db, CLIENT), [], "no decisions, no rows");
  });

  it("removes a category from that client's spec, leaving no trace of the removal", async () => {
    await setClientCategoryVisibility(pool, {
      clientId: CLIENT, categoryCode: aCategory, visible: false, note: "Client does not operate vehicles",
    }, context("v-1"));

    const mine = await listInputSpecForClient(db, CLIENT);
    const all = await listInputSpec(db);
    assert.equal(mine.length, all.length - 1);
    assert.ok(!mine.some((c) => c.categoryCode === aCategory));
    // Absent, not flagged: a client told that three categories were withheld has been told what
    // was withheld.
    const serialised = JSON.stringify(mine);
    assert.ok(!serialised.includes(aCategory), "the hidden category's code does not travel with the response");
    assert.ok(!/hidden|withheld|suppressed/i.test(serialised));
  });

  it("is one client's decision and no one else's", async () => {
    const theirs = await listInputSpecForClient(db, OTHER_CLIENT);
    assert.ok(theirs.some((c) => c.categoryCode === aCategory), "the other client still sees it");
  });

  it("tells the CRM why, which is the reason a row exists at all", async () => {
    const decisions = await listCategoryVisibility(db, CLIENT);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.categoryCode, aCategory);
    assert.equal(decisions[0]!.visible, false);
    assert.equal(decisions[0]!.note, "Client does not operate vehicles");
    assert.equal(decisions[0]!.decidedBy, ACTOR);
    assert.match(decisions[0]!.decidedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("records a decision to show as a decision, not as silence", async () => {
    // Saying "yes, this client does see it" is the default said deliberately, by somebody, on a
    // date — a different fact from nobody having considered it, and the register keeps both.
    await setClientCategoryVisibility(pool, {
      clientId: CLIENT, categoryCode: anotherCategory, visible: true, note: "Confirmed in scope for FY26",
    }, context("v-2"));
    const decisions = await listCategoryVisibility(db, CLIENT);
    assert.equal(decisions.length, 2);
    const shown = decisions.find((d) => d.categoryCode === anotherCategory)!;
    assert.equal(shown.visible, true);
    // And it changes nothing about what is served, because visible was already the default.
    const mine = await listInputSpecForClient(db, CLIENT);
    assert.ok(mine.some((c) => c.categoryCode === anotherCategory));
  });

  it("is audited, and carries what it changed from", async () => {
    await setClientCategoryVisibility(pool, { clientId: CLIENT, categoryCode: aCategory, visible: true }, context("v-3"));
    const { rows } = await db.query<{ action: string; before_json: { visible?: boolean } | null }>(
      `SELECT action, before_json FROM nzi_console.audit_events
        WHERE entity_type='client_category_visibility'`);
    assert.ok(rows.length >= 3, `expected each decision to be audited, saw ${rows.length}`);
    // The event this test is about, identified by what it records rather than by being last: the
    // decision just made turned a hidden category back on, so its "before" says hidden.
    const turnedBackOn = rows.filter((row) => row.action === "client_category_visibility_set" && row.before_json?.visible === false);
    assert.equal(turnedBackOn.length, 1, "exactly one decision so far reversed a hiding");
    assert.equal(turnedBackOn[0]!.before_json?.visible, false, "the audit says what the decision was before");
  });

  it("withdraws to the default without erasing that a decision was made", async () => {
    await setClientCategoryVisibility(pool, { clientId: CLIENT, categoryCode: aCategory, visible: null }, context("v-4"));
    const decisions = await listCategoryVisibility(db, CLIENT);
    assert.ok(!decisions.some((d) => d.categoryCode === aCategory), "no longer in force");
    const stored = await db.query<{ active: boolean; visible: boolean }>(
      `SELECT active, visible FROM nzi_console.client_category_visibility WHERE client_id=$1 AND category_code=$2`,
      [CLIENT, aCategory]);
    assert.equal(stored.rows.length, 1, "the row stays, deactivated");
    assert.equal(stored.rows[0]!.active, false);
    // And the category is served again.
    assert.ok((await listInputSpecForClient(db, CLIENT)).some((c) => c.categoryCode === aCategory));
  });

  it("refuses a category the spec does not have, and a client that is not yours", async () => {
    await assert.rejects(() => setClientCategoryVisibility(pool, {
      clientId: CLIENT, categoryCode: "not-a-category", visible: false,
    }, context("v-5")), CommandValidationError);
    await assert.rejects(() => setClientCategoryVisibility(pool, {
      clientId: "client-nothing", categoryCode: aCategory, visible: false,
    }, context("v-6")), AuthorizationError);
  });

  it("hides a granted row when its category is turned off — stricter wins", async () => {
    // The composition rule, against a real database because it lives in SQL: a fake pool returns
    // whatever the fixture author typed and could not notice a WHERE clause at all.
    //
    // Two controls, opposite defaults, on different axes. A bucket grant is deny-by-default and
    // answers "may this portal user enter data into this row". The toggle is default-on and answers
    // "is this category part of this client's view". Effective visibility is the AND of them, so a
    // category turned off hides its rows however explicitly they were granted.
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,'job-v',$2,9,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,'job-v','2025-01-01','2025-12-31','GB')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,email_normalized,display_name,status)
       VALUES ($1,'portal-a',$2,'someone@example.test','A Person','active')`, [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
       VALUES ($1,'grant-a',$2,'portal-a','job-v',now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_scope_rows
         (organisation_id,scope_row_id,job_id,scope,category_code,source_label,report_label,level_1,level_2,unit,enabled,version)
       VALUES ($1,'row-v','job-v','1',$2,'Fleet diesel','Fleet diesel','Scope 1','Direct','litres',true,1)`, [ORG, aCategory]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-v','Synthetic','2025.1','2025-01-01','2025-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-v','f-v','Diesel','litres',2.5,ARRAY['1'])`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,'job-v','ds-v','automatic','Fixture',$2)`, [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.portal_data_entry_bucket_grants
         (organisation_id,bucket_grant_id,access_grant_id,scope_row_id,allowed_factor_ids,allowed_units,entry_kind,created_by)
       VALUES ($1,'bucket-a','grant-a','row-v',ARRAY['f-v'],ARRAY['litres'],'manual_activity',$2)`, [ORG, ACTOR]);

    const principal = portalPrincipal();

    // Granted, category on (the default): visible.
    const granted = await listPortalDataEntryBuckets(pool, principal, "job-v");
    assert.equal(granted.length, 1, "an explicit grant is visible while the category is on");

    // Category off: gone, despite the grant standing untouched.
    await setClientCategoryVisibility(pool, { clientId: CLIENT, categoryCode: aCategory, visible: false }, context("v-and-1"));
    assert.deepEqual(await listPortalDataEntryBuckets(pool, principal, "job-v"), [],
      "a category turned off hides its rows whatever grants exist");

    // The grant itself is untouched — the toggle subtracts from what grants allow, it does not
    // revoke them, so restoring the category restores the access without re-granting anything.
    const stillGranted = await db.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM nzi_console.portal_data_entry_bucket_grants WHERE bucket_grant_id='bucket-a'`);
    assert.equal(stillGranted.rows[0]!.revoked_at, null);

    await setClientCategoryVisibility(pool, { clientId: CLIENT, categoryCode: aCategory, visible: null }, context("v-and-2"));
    assert.equal((await listPortalDataEntryBuckets(pool, principal, "job-v")).length, 1, "and it comes back");
  });

  it("does not make anything visible that was never granted", async () => {
    // The other direction of the AND, and why default-on weakens nothing: a row nobody granted is
    // invisible whatever the toggle says, because the grant is still required.
    await db.query(
      `INSERT INTO nzi_console.job_scope_rows
         (organisation_id,scope_row_id,job_id,scope,category_code,source_label,report_label,level_1,level_2,unit,enabled,version)
       VALUES ($1,'row-ungranted','job-v','1',$2,'Ungranted','Ungranted','Scope 1','Direct','litres',true,1)`, [ORG, anotherCategory]);
    await setClientCategoryVisibility(pool, { clientId: CLIENT, categoryCode: anotherCategory, visible: true }, context("v-and-3"));

    const principal = portalPrincipal();
    const buckets = await listPortalDataEntryBuckets(pool, principal, "job-v");
    assert.ok(!buckets.some((bucket) => bucket.scopeRowId === "row-ungranted"),
      "saying a category is visible does not grant entry to its rows");
  });

  it("cannot be deleted, only deactivated", async () => {
    const app = new pg.Client({ connectionString: database.url.replace(/\/\/[^@]*@/, "//nzi_console_app@") });
    await assert.rejects(async () => {
      await app.connect();
      await app.query(`DELETE FROM nzi_console.client_category_visibility`);
    });
    await app.end().catch(() => {});
  });
});
