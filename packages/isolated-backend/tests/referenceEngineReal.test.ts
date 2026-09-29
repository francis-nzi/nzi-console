import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultListQuery, LOOKUP_CATEGORIES, referenceValueListSpec, type CommandContext, type ReferenceValueListQuery, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  createReferenceValue, deactivateReferenceValue, listLookupCategories, listReferenceValuesPage, reinstateReferenceValue, updateReferenceValue,
} from "../src/referenceEngine";
import { listAllClients } from "../src/readModels";
import { withTenantRead, withTenantWrite } from "../src/postgres";

/**
 * The reference-value engine (admin Phase A2) against a real database: the commands behind admin.lookups — never a
 * delete, a reason to deactivate, versioned edits, idempotent replays, before-and-after audit — the list the Lookups
 * screen reads, migration 0138's shapes and grants, and all of it inside one organisation.
 */
const ORG_A = "ref-org-a";
const ORG_B = "ref-org-b";

describe("the reference-value engine, against the database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (org = ORG_A, role: StaffRole = "admin", reason?: string, idempotencyKey?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: `${role}-${org}`, principal: "staff", idempotencyKey: idempotencyKey ?? `ref-${keys}`, correlationId: `corr-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, `${role}-${org}`) };
  };
  const listOf = (org: string, change: Partial<ReferenceValueListQuery> & { category?: string; status?: string } = {}) => {
    const { category = "industries", status, ...rest } = change;
    const query: ReferenceValueListQuery = { ...defaultListQuery(referenceValueListSpec), ...rest, filters: { category: [category], ...(status ? { status: [status] } : {}) } };
    return withTenantRead(database.pool, org, (db) => listReferenceValuesPage(db, query));
  };
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };

  before(async () => {
    database = (await createDisposableDatabase("referenceengine"))!;
    await admin(async (db) => {
      for (const org of [ORG_A, ORG_B]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
        for (const role of ["admin", "consultant"]) {
          await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [org, `${role}-${org}`, role]);
        }
        await db.query(`INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, sort_order, created_by, updated_by)
          VALUES ($1, 'industries', $1 || ':retail', 'Retail', 10, 'seed', 'seed'), ($1, 'industries', $1 || ':food', 'Food', 20, 'seed', 'seed')`, [org]);
      }
      // Two of A's clients chose Retail; one of B's did.
      await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, sector, sector_value_id) VALUES
        ($1, 'a1', 'Alpha', 'active', 'Retail', $1 || ':retail'), ($1, 'a2', 'Beta', 'active', 'Retail', $1 || ':retail')`, [ORG_A]);
      await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, sector, sector_value_id) VALUES ($1, 'b1', 'Gamma', 'active', 'Retail', $1 || ':retail')`, [ORG_B]);
    });
  });
  after(async () => { await database?.end(); });

  describe("migration 0138", () => {
    it("adds the ten lookups, and the engine offers exactly its twelve, in the design's order", async () => {
      const categories = await withTenantRead(database.pool, ORG_A, listLookupCategories);
      assert.deepEqual(categories.map((category) => category.key), [...LOOKUP_CATEGORIES]);
      assert.ok(categories.every((category) => !category.carriesCode || category.key === "industries"), "no new category carries a code (P4)");
      assert.ok(!categories.some((category) => (category.key as string) === "emission_category"), "the input spec's category is not edited here");
    });

    it("keeps categories migration-owned, and grants no DELETE on values or portfolio owners", async () => {
      await assert.rejects(withTenantWrite(database.pool, ORG_A, (db) => db.query(`INSERT INTO nzi_console.reference_categories (category_key, label, scope) VALUES ('x', 'X', 'organisation')`)), /permission denied/);
      await assert.rejects(withTenantWrite(database.pool, ORG_A, (db) => db.query(`DELETE FROM nzi_console.reference_values WHERE value_id = 'x'`)), /permission denied/);
      await assert.rejects(withTenantWrite(database.pool, ORG_A, (db) => db.query(`DELETE FROM nzi_console.portfolio_owners WHERE portfolio_value_id = 'x'`)), /permission denied/);
    });

    it("holds the import-provenance shape on values: an imported value names its v7 id and what it was loaded as", async () => {
      await assert.rejects(admin((db) => db.query(`INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, source_system, legacy_db_id, created_by, updated_by)
        VALUES ($1, 'positions', 'p:1', 'Analyst', 'nzi-pro-v7', '1', 's', 's')`, [ORG_A])), /reference_values_import_provenance_shape/);
    });

    it("links a client to a portfolio only through a real value, and keeps portfolio owners to their tenant", async () => {
      await assert.rejects(admin((db) => db.query(`UPDATE nzi_console.clients SET portfolio_value_id = 'nope' WHERE organisation_id = $1 AND client_id = 'a1'`, [ORG_A])), /clients_portfolio_reference_fk/);
      const portfolio = await createReferenceValue(database.pool, { categoryKey: "portfolios", label: "NZI" }, context());
      await withTenantWrite(database.pool, ORG_A, (db) => db.query(
        `INSERT INTO nzi_console.portfolio_owners (organisation_id, portfolio_value_id, owner_client_id, created_by, updated_by) VALUES ($1, $2, 'a1', 't', 't')`, [ORG_A, portfolio.data.valueId]));
      await assert.rejects(withTenantWrite(database.pool, ORG_A, (db) => db.query(
        `INSERT INTO nzi_console.portfolio_owners (organisation_id, portfolio_value_id, owner_client_id, created_by, updated_by) VALUES ($1, $2, 'b1', 't', 't')`, [ORG_B, portfolio.data.valueId])), /row-level security/);
      assert.deepEqual(await withTenantRead(database.pool, ORG_B, async (db) => (await db.query(`SELECT * FROM nzi_console.portfolio_owners`)).rows), []);
      const listed = await listOf(ORG_A, { category: "portfolios" });
      assert.equal(listed.rows[0]!.ownerClient, "Alpha", "the owner shows on the portfolio's row");
    });
  });

  describe("the commands", () => {
    it("adds a value as 'added here', after the last, with an audit record of what it became", async () => {
      const outcome = await createReferenceValue(database.pool, { categoryKey: "industries", label: "  Construction " }, context());
      assert.match(outcome.data.valueId, /^industries:[0-9a-f-]{36}$/);
      const row = (await listOf(ORG_A, { search: "Construction" })).rows[0]!;
      assert.deepEqual([row.label, row.sortOrder, row.provenance, row.version, row.active], ["Construction", 30, "added", 1, true]);
      const audit = await admin(async (db) => (await db.query(`SELECT action, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [outcome.auditEventId])).rows[0]);
      assert.equal(audit.action, "reference.value.created");
      assert.deepEqual(audit.after_json, { valueId: outcome.data.valueId, categoryKey: "industries", version: 1, active: true });
    });

    it("replays an idempotent retry instead of adding twice", async () => {
      const first = await createReferenceValue(database.pool, { categoryKey: "positions", label: "Analyst" }, context(ORG_A, "admin", undefined, "same-key"));
      const again = await createReferenceValue(database.pool, { categoryKey: "positions", label: "Analyst" }, context(ORG_A, "admin", undefined, "same-key"));
      assert.equal(again.replayed, true);
      assert.equal(again.data.valueId, first.data.valueId);
      assert.equal((await listOf(ORG_A, { category: "positions" })).total, 1);
    });

    it("refuses a second active value with the same label, a code where the lookup carries none, and a lookup it does not manage", async () => {
      await assert.rejects(createReferenceValue(database.pool, { categoryKey: "industries", label: "retail" }, context()), (error: { issues?: Array<{ code: string }> }) => error.issues?.[0]?.code === "DUPLICATE");
      await assert.rejects(createReferenceValue(database.pool, { categoryKey: "positions", label: "Lead", code: "L" }, context()), (error: { issues?: Array<{ field: string }> }) => error.issues?.[0]?.field === "code");
      await assert.rejects(createReferenceValue(database.pool, { categoryKey: "emission_category", label: "X" }, context()), (error: { issues?: Array<{ field: string }> }) => error.issues?.[0]?.field === "categoryKey");
    });

    it("is admin.lookups — a consultant cannot change a lookup", async () => {
      await assert.rejects(createReferenceValue(database.pool, { categoryKey: "industries", label: "Mining" }, context(ORG_A, "consultant")), /admin\.lookups|permission|capabilit/i);
    });

    it("edits a value as a versioned change, recording before and after — and refuses a stale edit", async () => {
      const edited = await updateReferenceValue(database.pool, { categoryKey: "industries", valueId: `${ORG_A}:food`, label: "Food & drink", sortOrder: 15, expectedVersion: 1 }, context());
      assert.equal(edited.data.version, 2);
      const audit = await admin(async (db) => (await db.query(`SELECT before_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [edited.auditEventId])).rows[0]);
      assert.deepEqual(audit.before_json, { label: "Food", code: null, sortOrder: 20, active: true });
      await assert.rejects(updateReferenceValue(database.pool, { categoryKey: "industries", valueId: `${ORG_A}:food`, label: "Food", sortOrder: 20, expectedVersion: 1 }, context()), /version|changed/i);
    });

    it("deactivates only with a reason, never deletes, reports who still uses it — and those records still show it", async () => {
      await assert.rejects(deactivateReferenceValue(database.pool, { categoryKey: "industries", valueId: `${ORG_A}:retail`, expectedVersion: 1 }, context()), (error: { issues?: Array<{ field: string }> }) => error.issues?.some((issue) => issue.field === "reason") === true);
      const done = await deactivateReferenceValue(database.pool, { categoryKey: "industries", valueId: `${ORG_A}:retail`, expectedVersion: 1 }, context(ORG_A, "admin", "Merged into Wholesale & retail"));
      assert.deepEqual([done.data.active, done.data.inUse], [false, 2]);
      const clients = await withTenantRead(database.pool, ORG_A, (db) => listAllClients(db));
      assert.equal(clients.find((client) => client.id === "a1")!.sector, "Retail", "a deactivated value still resolves on the record");
      const audit = await admin(async (db) => (await db.query(`SELECT reason FROM nzi_console.audit_events WHERE audit_event_id = $1`, [done.auditEventId])).rows[0]);
      assert.equal(audit.reason, "Merged into Wholesale & retail");
      assert.equal((await listOf(ORG_A, { status: "inactive" })).rows.map((row) => row.label).join(), "Retail");
    });

    it("reinstates — unless another active value has taken the label meanwhile", async () => {
      const taken = await createReferenceValue(database.pool, { categoryKey: "industries", label: "Retail" }, context());
      await assert.rejects(reinstateReferenceValue(database.pool, { categoryKey: "industries", valueId: `${ORG_A}:retail`, expectedVersion: 2 }, context()), (error: { issues?: Array<{ code: string }> }) => error.issues?.[0]?.code === "DUPLICATE");
      await deactivateReferenceValue(database.pool, { categoryKey: "industries", valueId: taken.data.valueId, expectedVersion: 1 }, context(ORG_A, "admin", "Duplicate of the original"));
      const back = await reinstateReferenceValue(database.pool, { categoryKey: "industries", valueId: `${ORG_A}:retail`, expectedVersion: 2 }, context());
      assert.deepEqual([back.data.active, back.data.version], [true, 3]);
    });

    it("never reaches another organisation's value", async () => {
      await assert.rejects(updateReferenceValue(database.pool, { categoryKey: "industries", valueId: `${ORG_B}:retail`, label: "Hijacked", sortOrder: 1, expectedVersion: 1 }, context()), (error: { issues?: Array<{ code: string }> }) => error.issues?.[0]?.code === "NOT_FOUND");
      const b = await listOf(ORG_B);
      assert.deepEqual(b.rows.map((row) => row.label).sort(), ["Food", "Retail"], "B's values are untouched and B sees only its own");
    });
  });

  describe("the list the Lookups screen reads", () => {
    it("counts 'in use' where a lookup has a consumer, and shows none (null) where it has none yet (P8)", async () => {
      const industries = await listOf(ORG_A);
      assert.equal(industries.rows.find((row) => row.label === "Retail" && row.active)!.inUse, 2);
      assert.equal(industries.rows.find((row) => row.label === "Construction")!.inUse, 0);
      assert.equal((await listOf(ORG_A, { category: "positions" })).rows[0]!.inUse, null);
    });

    it("counts the All / Active / Inactive segment from the data, and filters by it", async () => {
      const page = await listOf(ORG_A);
      assert.deepEqual(page.filterOptions.status.map((option) => [option.value, option.count]), [["active", 3], ["inactive", 1]]);
      assert.ok((await listOf(ORG_A, { status: "active" })).rows.every((row) => row.active));
    });

    it("scopes every count to the chosen lookup — an empty one is empty, not 'no match'", async () => {
      const processes = await listOf(ORG_A, { category: "processes" });
      assert.deepEqual([processes.total, processes.unfilteredTotal], [0, 0], "no values yet, though other lookups have some");
      assert.equal((await listOf(ORG_A, { category: "positions" })).unfilteredTotal, 1);
    });

    it("sorts by the value's own order by default, and by use when asked", async () => {
      assert.deepEqual((await listOf(ORG_A, { status: "active" })).rows.map((row) => row.label), ["Retail", "Food & drink", "Construction"]);
      assert.equal((await listOf(ORG_A, { sort: { key: "inUse", dir: "desc" } })).rows[0]!.label, "Retail");
    });
  });
});
