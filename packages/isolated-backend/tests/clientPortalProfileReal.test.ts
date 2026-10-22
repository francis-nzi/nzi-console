import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, PORTAL_PROFILE_DEFAULT, PORTAL_PROFILE_KEYS, PORTAL_PROFILE_VALUES } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  AuthorizationError, CommandValidationError, effectivePortalProfile, getPortalProfileForStaff, listInputSpec, portalFacingProfile,
  portalProfileStaffView, setClientCategoryVisibility, setClientPortalProfile, setClientPortalScopeVisibility,
} from "../src/index";

/**
 * Portal data-entry phase 1 (RULING-portal-dataentry-01; BUILD-portal-dataentry-phase1), against a real database: the
 * portal profile and the scope register, recorded as decisions in the `client_category_visibility` pattern (NZC-110).
 *
 *  1. **Decisions over a default.** No row means the code-defined default; a row is a decision; withdrawing deactivates it
 *     and the key returns to the default, with the record kept.
 *  2. **The value sets hold at both boundaries** — the command and 0176's CHECK — and milestones is never `edit`.
 *  3. **Scope AND category.** A hidden scope hides every category in it; a category is shown only when both are on.
 *  4. **Two readers.** The portal's reading names nothing withheld; the staff reading carries the decisions.
 *  5. **The seam.** Each decision is audited and emits its named outbox topic, through `runPostgresCommand`.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const OTHER_CLIENT = "client-b";
const ACTOR = "admin-a";
const CONSULTANT = "consultant-a";

const context = (key: string, role: "admin" | "consultant" | "reviewer" = "admin", actor = role === "consultant" ? CONSULTANT : ACTOR) => ({
  organisationId: ORG, actorId: actor, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole(role, ORG, actor),
});

describe("the client portal profile and scope register (portal data-entry phase 1)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;
  let scope1Categories: string[];
  let scope3Category: string;

  before(async () => {
    database = (await createDisposableDatabase("portalprofile"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    for (const [user, role, name] of [[ACTOR, "admin", "Ada Admin"], [CONSULTANT, "consultant", "Cass Consultant"], ["reviewer-a", "reviewer", "Rae Reviewer"]]) {
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,$3,'active',$4)`, [ORG, user, role, name]);
    }
    // client-a belongs to the consultant; client-b to nobody, so an own-clients holder may not touch it.
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,owner_user_id) VALUES ($1,$2,'Client A','active',$3),($1,$4,'Client B','active',NULL)`,
      [ORG, CLIENT, CONSULTANT, OTHER_CLIENT]);
    const spec = await listInputSpec(db);
    scope1Categories = spec.filter((category) => category.scope === "1").map((category) => category.categoryCode);
    scope3Category = spec.find((category) => category.scope === "3")!.categoryCode;
    assert.ok(scope1Categories.length >= 1 && scope3Category, "the governed spec (0093) should carry scope 1 and scope 3 categories");
  });

  after(async () => { await db?.end(); await database?.end(); });

  const topics = async (entityType: string) => (await db.query<{ topic: string }>(
    `SELECT o.topic FROM nzi_console.transactional_outbox o JOIN nzi_console.audit_events a ON a.correlation_id=o.correlation_id
      WHERE a.entity_type=$1 ORDER BY o.created_at, o.outbox_id`, [entityType])).rows.map((row) => row.topic);

  describe("the profile", () => {
    it("is the org default until somebody decides otherwise", async () => {
      assert.deepEqual(await effectivePortalProfile(db, CLIENT), PORTAL_PROFILE_DEFAULT);
      const view = await portalProfileStaffView(db, CLIENT);
      assert.ok(view.profile.every((entry) => entry.decision === null && entry.effectiveValue === entry.defaultValue));
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.client_portal_profile_decisions`)).rows[0].n, 0, "no decisions, no rows");
    });

    it("records a decision, overlays it on the default for that client alone, and emits client.portal.profile.set", async () => {
      const outcome = await setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "evidenceProvenance", value: "visible", note: "Assurance lead wants the evidence" }, context("p-1"));
      assert.deepEqual(outcome.data, { clientId: CLIENT, profileKey: "evidenceProvenance", value: "visible" });
      assert.equal((await effectivePortalProfile(db, CLIENT)).evidenceProvenance, "visible");
      assert.equal((await effectivePortalProfile(db, OTHER_CLIENT)).evidenceProvenance, "hidden", "one client's decision and no one else's");
      assert.deepEqual(await topics("client_portal_profile_decisions"), ["client.portal.profile.set"]);
    });

    it("tells staff who decided, when and why", async () => {
      const entry = (await portalProfileStaffView(db, CLIENT)).profile.find((row) => row.key === "evidenceProvenance")!;
      assert.equal(entry.defaultValue, "hidden");
      assert.equal(entry.effectiveValue, "visible");
      assert.equal(entry.decision?.value, "visible");
      assert.equal(entry.decision?.note, "Assurance lead wants the evidence");
      assert.equal(entry.decision?.decidedBy, ACTOR);
      assert.equal(entry.decision?.decidedByName, "Ada Admin");
      assert.match(entry.decision!.decidedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    it("records the default restated as a decision, not as silence — and it changes nothing the client is offered", async () => {
      await setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "setup", value: "hidden", note: "Confirmed: setup stays ours" }, context("p-2"));
      const entry = (await portalProfileStaffView(db, CLIENT)).profile.find((row) => row.key === "setup")!;
      assert.equal(entry.decision?.value, "hidden");
      assert.equal(entry.effectiveValue, entry.defaultValue);
    });

    it("withdraws to the default without erasing that a decision was made, and emits client.portal.profile.withdrawn", async () => {
      await setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "evidenceProvenance", value: null }, context("p-3"));
      assert.equal((await effectivePortalProfile(db, CLIENT)).evidenceProvenance, "hidden");
      const stored = await db.query<{ active: boolean; value: string }>(`SELECT active, value FROM nzi_console.client_portal_profile_decisions WHERE client_id=$1 AND profile_key='evidenceProvenance'`, [CLIENT]);
      assert.deepEqual(stored.rows, [{ active: false, value: "visible" }], "the row stays, deactivated");
      assert.equal((await topics("client_portal_profile_decisions")).at(-1), "client.portal.profile.withdrawn");
      const audit = await db.query<{ before_json: { value?: string; active?: boolean } }>(
        `SELECT before_json FROM nzi_console.audit_events WHERE entity_type='client_portal_profile_decisions' AND correlation_id='corr-p-3'`);
      assert.deepEqual(audit.rows[0]?.before_json, { value: "visible", note: "Assurance lead wants the evidence", active: true }, "the audit says what was withdrawn");
    });

    it("a decision made again after a withdrawal is in force again — the same row, reactivated", async () => {
      await setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "evidenceProvenance", value: "visible", note: "Back on for the audit" }, context("p-3b"));
      assert.equal((await effectivePortalProfile(db, CLIENT)).evidenceProvenance, "visible");
      const stored = await db.query<{ active: boolean; note: string }>(`SELECT active, note FROM nzi_console.client_portal_profile_decisions WHERE client_id=$1 AND profile_key='evidenceProvenance'`, [CLIENT]);
      assert.deepEqual(stored.rows, [{ active: true, note: "Back on for the audit" }]);
      await setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "evidenceProvenance", value: null }, context("p-3c"));
    });

    it("refuses a key it does not know, a value the key does not take, and milestones as edit — at the command", async () => {
      await assert.rejects(setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "history", value: "hidden" }, context("p-4")), CommandValidationError, "history is not a setting");
      await assert.rejects(setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "setup", value: "view" }, context("p-5")), CommandValidationError);
      await assert.rejects(setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "milestones", value: "edit" }, context("p-6")),
        (error: unknown) => error instanceof CommandValidationError && JSON.stringify(error).includes("MILESTONES_VIEW_ONLY"));
      await assert.rejects(setClientPortalProfile(pool, { clientId: "client-nothing", profileKey: "setup", value: "visible" }, context("p-7")), AuthorizationError);
    });

    it("refuses the same at the table, so no path can store a value the portal does not understand", async () => {
      const insert = (key: string, value: string) => db.query(
        `INSERT INTO nzi_console.client_portal_profile_decisions (organisation_id,client_id,profile_key,value,decided_by) VALUES ($1,$2,$3,$4,'hand')`, [ORG, OTHER_CLIENT, key, value]);
      await assert.rejects(insert("milestones", "edit"), /client_portal_profile_decisions_value/);
      await assert.rejects(insert("history", "hidden"), /client_portal_profile_decisions_value/);
      await assert.rejects(insert("deactivate", "visible"), /client_portal_profile_decisions_value/);
      // And every value the contract allows, the table accepts — the two value sets are one set.
      for (const key of PORTAL_PROFILE_KEYS) {
        for (const value of PORTAL_PROFILE_VALUES[key]) {
          await db.query("BEGIN");
          await insert(key, value);
          await db.query("ROLLBACK");
        }
      }
    });

    it("is portal.admin on this client: a reviewer is refused, a consultant decides for their own client only", async () => {
      await assert.rejects(setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "time", value: "visible" }, context("p-8", "reviewer", "reviewer-a")), AuthorizationError);
      await setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "time", value: "visible" }, context("p-9", "consultant"));
      await assert.rejects(setClientPortalProfile(pool, { clientId: OTHER_CLIENT, profileKey: "time", value: "visible" }, context("p-10", "consultant")), AuthorizationError);
    });

    it("is idempotent: the same request replayed is one decision, one audit row, one topic", async () => {
      const count = async () => (await db.query(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE entity_type='client_portal_profile_decisions'`)).rows[0].n as number;
      const first = await setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "dataQuality", value: "visible" }, context("p-11"));
      const audits = await count();
      const replay = await setClientPortalProfile(pool, { clientId: CLIENT, profileKey: "dataQuality", value: "visible" }, context("p-11"));
      assert.deepEqual(replay.data, first.data);
      assert.equal(await count(), audits);
    });
  });

  describe("the scope register, composed with categories", () => {
    it("hides every category in a hidden scope, without a row per category, and emits client.portal.scope.visibility.set", async () => {
      const before = (await portalFacingProfile(db, CLIENT)).categoryCodes;
      assert.ok(scope1Categories.every((code) => before.includes(code)));
      await setClientPortalScopeVisibility(pool, { clientId: CLIENT, scope: "1", visible: false, note: "No direct emissions this year" }, context("s-1"));
      const after = (await portalFacingProfile(db, CLIENT)).categoryCodes;
      assert.ok(scope1Categories.every((code) => !after.includes(code)), "scope 1's categories are gone");
      assert.ok(after.includes(scope3Category), "other scopes are untouched");
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.client_category_visibility WHERE client_id=$1`, [CLIENT])).rows[0].n, 0, "no category rows were written");
      assert.deepEqual(await topics("client_portal_scope_visibility"), ["client.portal.scope.visibility.set"]);
      assert.ok((await portalFacingProfile(db, OTHER_CLIENT)).categoryCodes.includes(scope1Categories[0]!), "one client's decision only");
    });

    it("shows a category only when its scope is on AND it is on itself; switching the scope back restores the category decisions", async () => {
      await setClientCategoryVisibility(pool, { clientId: CLIENT, categoryCode: scope3Category, visible: false }, context("s-2"));
      let view = await portalProfileStaffView(db, CLIENT);
      const scope1 = view.scopes.find((scope) => scope.scope === "1")!;
      assert.equal(scope1.effectiveVisible, false);
      assert.equal(scope1.decision?.note, "No direct emissions this year");
      assert.ok(scope1.categories.every((category) => !category.shown && category.hiddenBy === "scope"), "the scope explains its categories");
      const hiddenItself = view.scopes.find((scope) => scope.scope === "3")!.categories.find((category) => category.categoryCode === scope3Category)!;
      assert.deepEqual([hiddenItself.shown, hiddenItself.hiddenBy, hiddenItself.decision?.value], [false, "category", false]);

      await setClientPortalScopeVisibility(pool, { clientId: CLIENT, scope: "1", visible: null }, context("s-3"));
      assert.equal((await topics("client_portal_scope_visibility")).at(-1), "client.portal.scope.visibility.withdrawn");
      view = await portalProfileStaffView(db, CLIENT);
      assert.ok(view.scopes.find((scope) => scope.scope === "1")!.categories.every((category) => category.shown), "scope 1 back, as it was");
      assert.ok(!(await portalFacingProfile(db, CLIENT)).categoryCodes.includes(scope3Category), "the category decision still holds");
      const stored = await db.query<{ active: boolean }>(`SELECT active FROM nzi_console.client_portal_scope_visibility WHERE client_id=$1 AND scope='1'`, [CLIENT]);
      assert.deepEqual(stored.rows, [{ active: false }], "the scope decision stays, deactivated");
    });

    it("refuses a scope that is not 1, 2 or 3 — at the command and at the table", async () => {
      await assert.rejects(setClientPortalScopeVisibility(pool, { clientId: CLIENT, scope: "4", visible: false }, context("s-4")), CommandValidationError);
      await assert.rejects(db.query(`INSERT INTO nzi_console.client_portal_scope_visibility (organisation_id,client_id,scope,visible,decided_by) VALUES ($1,$2,'3.1',false,'hand')`, [ORG, CLIENT]), /check constraint/i);
    });

    it("is category.visibility on this client, as the category switch is (NZC-110)", async () => {
      await assert.rejects(setClientPortalScopeVisibility(pool, { clientId: CLIENT, scope: "2", visible: false }, context("s-5", "reviewer", "reviewer-a")), AuthorizationError);
      await assert.rejects(setClientPortalScopeVisibility(pool, { clientId: OTHER_CLIENT, scope: "2", visible: false }, context("s-6", "consultant")), AuthorizationError);
    });
  });

  describe("two readers", () => {
    it("the portal's reading offers, and never names or counts what was withheld", async () => {
      await setClientPortalScopeVisibility(pool, { clientId: CLIENT, scope: "2", visible: false }, context("r-1"));
      const portal = await portalFacingProfile(db, CLIENT);
      const serialised = JSON.stringify(portal);
      assert.ok(!/hidden|withheld|suppressed|disabled|decision|note|decided/i.test(serialised), serialised);
      // Quoted, because category codes nest as strings ("3.1" is inside "3.10").
      assert.ok(!serialised.includes(JSON.stringify(scope3Category)), "a hidden category's code does not travel");
      assert.ok(portal.profile.areas.includes("time"), "time was switched on for this client");
      assert.ok(!portal.profile.areas.includes("setup"), "setup is simply absent");
      assert.ok(portal.profile.areas.includes("milestones"), "milestones are offered, view-only, by default");
      assert.deepEqual(portal.profile.rowSections, ["dataQuality"]);
      assert.deepEqual(portal.profile.actions, []);
    });

    it("the staff reading is portal.admin on this client, resolved against the database", async () => {
      const holder = (role: "admin" | "consultant" | "reviewer", userId: string) => ({ organisationId: ORG, userId, capabilities: commandGrantForRole(role, ORG, userId).capabilities });
      const view = await getPortalProfileForStaff(pool, holder("consultant", CONSULTANT), CLIENT);
      assert.equal(view.profile.find((entry) => entry.key === "time")?.decision?.decidedByName, "Cass Consultant");
      await assert.rejects(getPortalProfileForStaff(pool, holder("consultant", CONSULTANT), OTHER_CLIENT), AuthorizationError, "own clients only");
      await assert.rejects(getPortalProfileForStaff(pool, holder("reviewer", "reviewer-a"), CLIENT), AuthorizationError);
    });
  });

  it("cannot be deleted, only deactivated", async () => {
    for (const table of ["client_portal_profile_decisions", "client_portal_scope_visibility"]) {
      const granted = await db.query<{ granted: boolean }>(`SELECT has_table_privilege('nzi_console_app','nzi_console.${table}','DELETE') AS granted`);
      assert.equal(granted.rows[0]!.granted, false, table);
    }
  });
});
