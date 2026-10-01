import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticRows } from "./support/v7SyntheticExtract";
import { listJobTypeTemplates, listTemplateCatalogue, setJobTypeItems } from "../src/jobTypeTemplates";
import { listJobItemsPage } from "../src/serviceCatalogue";
import { withTenantRead } from "../src/postgres";
import { SOURCE_SYSTEM } from "../src/v7ClientImport";
import type { V7Row, V7Table } from "../src/v7ClientExtract";
import { JOB_TYPE_ITEMS_RUN_PREFIX, loadV7JobTypeItems, planV7JobTypeItems } from "../src/v7JobTypeItemsLoad";

/**
 * Job-type templates (admin Phase E3; ruled `phaseE-commercial-catalogue-plan.md`, E-Q5/E-Q10) against a real database:
 * 0147's guarantees (a pair fixed, nothing deleted, tenant-confined, the template's own version), job_type.items.set
 * (set whole and in order; dropped items kept as not included; an item must be active to be added and a held one stays;
 * the type's definition version untouched), the catalogue's "in use", and load:v7-job-type-items (types and items by
 * their v7 identities, the unresolved reported, R4).
 */
const ORG = "templates-org";
const OTHER = "templates-other";
type Rows = ReturnType<typeof syntheticRows>;
const extract = (mutate?: (rows: Rows) => void): Partial<Record<V7Table, V7Row[]>> => { const rows = syntheticRows(); mutate?.(rows); return syntheticExtract(rows); };

describe("planning the templates import (no database)", () => {
  it("parses each row, defaulting quantity and flag, and leaves out a repeated pair and a zero quantity", () => {
    const plan = planV7JobTypeItems(extract());
    assert.deepEqual(plan.values.map((value) => [value.legacyDbId, value.jobTypeLegacyId, value.itemLegacyId, value.quantity, value.isRequired]), [
      ["1", "1", "1", 1, true], ["2", "1", "2", 2.5, false], ["3", "2", "5", 3, true], ["4", "1", "4", 1, true], ["5", "99", "1", 1, true]]);
    assert.deepEqual(plan.skipped, [
      { legacyDbId: "6", reason: "the same job type and item as v7 row 1" },
      { legacyDbId: "7", reason: "a quantity that is not above 0, to two places" }]);
  });
});

describe("job-type templates, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor: string, role: StaffRole, org = ORG): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `tpl-${keys}`, correlationId: `corr-tpl-${keys}`, grant: commandGrantForRole(role, org, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const asApp = async (org: string, sql: string) => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL ROLE nzi_console_app");
      await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [org]);
      const rows = (await client.query(sql)).rows; await client.query("COMMIT"); return rows;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  };
  const versions = async (jobTypeId: string) => (await q(`SELECT version, items_version FROM nzi_console.job_types WHERE organisation_id = $1 AND job_type_id = $2`, [ORG, jobTypeId]))[0];
  const included = async (jobTypeId: string) => (await withTenantRead(database.pool, ORG, (db) => listJobTypeTemplates(db)))[jobTypeId]!;

  before(async () => {
    database = (await createDisposableDatabase("jobtypetemplates"))!;
    for (const org of [ORG, OTHER]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'cal', 'consultant', 'active', 'Cal')`, [org]);
    }
    // Job types and catalogue items as C4 and E2 loaded them (v7 identities), plus one of each added here.
    await q(`INSERT INTO nzi_console.job_types (organisation_id, job_type_id, name, family, source_system, legacy_db_id, legacy_values, created_by, updated_by) VALUES
      ($1, 'job-type:v7-1', 'Carbon Reduction Plan', 'crp', $2, '1', '{}'::jsonb, 'seed', 'seed'),
      ($1, 'job-type:v7-2', 'Strategy Workshop', 'consultancy', $2, '2', '{}'::jsonb, 'seed', 'seed'),
      ($1, 'jt:own', 'Console only', 'consultancy', NULL, NULL, NULL, 'seed', 'seed')`, [ORG, SOURCE_SYSTEM]);
    await q(`INSERT INTO nzi_console.job_items (organisation_id, item_id, item_code, name, currency_code, source_system, legacy_db_id, legacy_values, created_by, updated_by) VALUES
      ($1, 'job-item:v7-1', 'ASSESS', 'Carbon assessment', 'GBP', $2, '1', '{}'::jsonb, 'seed', 'seed'),
      ($1, 'job-item:v7-2', 'REPORT', 'Carbon report', 'GBP', $2, '2', '{}'::jsonb, 'seed', 'seed'),
      ($1, 'job-item:v7-5', 'MONTHLY', 'Monthly monitoring', 'GBP', $2, '5', '{}'::jsonb, 'seed', 'seed'),
      ($1, 'job-item:own', 'WORKSHOP', 'Workshop day', 'GBP', NULL, NULL, NULL, 'seed', 'seed'),
      ($1, 'job-item:old', 'RETIRED', 'Retired service', 'GBP', NULL, NULL, NULL, 'seed', 'seed')`, [ORG, SOURCE_SYSTEM]);
    await q(`UPDATE nzi_console.job_items SET active = false WHERE item_id = 'job-item:old'`);
  });
  after(async () => { await database?.end(); });

  describe("job_type.items.set", () => {
    it("sets a template whole and in order, bumping its own version and never the definition's", async () => {
      const before = await versions("jt:own");
      assert.equal(before.items_version, 1, "0147's default");
      const set = await setJobTypeItems(database.pool, { jobTypeId: "jt:own", expectedItemsVersion: 1, items: [
        { itemId: "job-item:own", quantity: 2, isRequired: true }, { itemId: "job-item:v7-1", quantity: 0.5, isRequired: false }] }, context("ada", "admin"));
      assert.deepEqual([set.data.itemsVersion, set.data.dropped], [2, []]);
      const after = await versions("jt:own");
      assert.deepEqual([after.version, after.items_version], [before.version, 2], "the definition version is untouched");
      assert.deepEqual((await included("jt:own")).items.map((item) => [item.code, item.quantity, item.isRequired]), [["WORKSHOP", 2, true], ["ASSESS", 0.5, false]]);
    });

    it("reorders and drops — a dropped item kept as not included, never deleted — and takes one back", async () => {
      await setJobTypeItems(database.pool, { jobTypeId: "jt:own", expectedItemsVersion: 2, items: [{ itemId: "job-item:v7-1", quantity: 1, isRequired: true }] }, context("ada", "admin"));
      const rows = await q(`SELECT item_id, included, quantity::float8 AS quantity FROM nzi_console.job_type_items WHERE organisation_id = $1 AND job_type_id = 'jt:own' ORDER BY item_id`, [ORG]);
      assert.deepEqual(rows.map((row) => [row.item_id, row.included, row.quantity]), [["job-item:own", false, 2], ["job-item:v7-1", true, 1]]);
      const back = await setJobTypeItems(database.pool, { jobTypeId: "jt:own", expectedItemsVersion: 3, items: [
        { itemId: "job-item:v7-1", quantity: 1, isRequired: true }, { itemId: "job-item:own", quantity: 3, isRequired: true }] }, context("ada", "admin"));
      assert.equal(back.data.itemsVersion, 4);
      assert.deepEqual((await included("jt:own")).items.map((item) => [item.code, item.quantity]), [["ASSESS", 1], ["WORKSHOP", 3]]);
      const audit = await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE action = 'job_type.items_set' AND entity_id = 'jt:own' ORDER BY occurred_at DESC LIMIT 1`);
      assert.deepEqual(audit[0].before_json.items.map((item: { itemId: string }) => item.itemId), ["job-item:v7-1"]);
      assert.deepEqual(audit[0].after_json.items.map((item: { itemId: string }) => item.itemId), ["job-item:v7-1", "job-item:own"]);
    });

    it("refuses an inactive item to add, an unknown one, an unchanged template, a stale version and a consultant — and keeps a held item once deactivated", async () => {
      const refused = (code: string) => (error: Error & { issues?: Array<{ code: string }> }) => error.issues?.some((issue) => issue.code === code) === true;
      const items = [{ itemId: "job-item:v7-1", quantity: 1, isRequired: true }, { itemId: "job-item:own", quantity: 3, isRequired: true }];
      await assert.rejects(setJobTypeItems(database.pool, { jobTypeId: "jt:own", expectedItemsVersion: 4, items: [...items, { itemId: "job-item:old", quantity: 1, isRequired: true }] }, context("ada", "admin")), refused("INACTIVE"));
      await assert.rejects(setJobTypeItems(database.pool, { jobTypeId: "jt:own", expectedItemsVersion: 4, items: [{ itemId: "job-item:nope", quantity: 1, isRequired: true }] }, context("ada", "admin")), refused("NOT_FOUND"));
      await assert.rejects(setJobTypeItems(database.pool, { jobTypeId: "jt:own", expectedItemsVersion: 4, items }, context("ada", "admin")), refused("UNCHANGED"));
      await assert.rejects(setJobTypeItems(database.pool, { jobTypeId: "jt:own", expectedItemsVersion: 3, items: [items[0]!] }, context("ada", "admin")), /version/i);
      await assert.rejects(setJobTypeItems(database.pool, { jobTypeId: "jt:own", expectedItemsVersion: 4, items: [items[0]!] }, context("cal", "consultant")), /admin\.lookups|permission/i);
      await assert.rejects(setJobTypeItems(database.pool, { jobTypeId: "jt:own", expectedItemsVersion: 4, items: [items[0]!, items[0]!] }, context("ada", "admin")), /Command validation failed/, "an item is included once");
      // WORKSHOP is deactivated while the template holds it: it stays, and its quantity can still change.
      await q(`UPDATE nzi_console.job_items SET active = false WHERE item_id = 'job-item:own'`);
      await setJobTypeItems(database.pool, { jobTypeId: "jt:own", expectedItemsVersion: 4, items: [items[0]!, { ...items[1]!, quantity: 4 }] }, context("ada", "admin"));
      assert.equal((await included("jt:own")).items.find((item) => item.code === "WORKSHOP")?.active, false);
      await q(`UPDATE nzi_console.job_items SET active = true WHERE item_id = 'job-item:own'`);
    });

    it("fixes the pair and deletes nothing: the app role cannot move a row or delete one; tenant-confined", async () => {
      await assert.rejects(asApp(ORG, `UPDATE nzi_console.job_type_items SET item_id = 'job-item:v7-2' WHERE job_type_id = 'jt:own'`), /permission denied/);
      await assert.rejects(asApp(ORG, `DELETE FROM nzi_console.job_type_items`), /permission denied/);
      assert.equal((await asApp(OTHER, `SELECT count(*)::int AS n FROM nzi_console.job_type_items`))[0].n, 0);
    });

    it("feeds the catalogue's \"in use\" and the editor's picker", async () => {
      const page = await withTenantRead(database.pool, ORG, (db) => listJobItemsPage(db, { search: "", filters: {}, sort: { key: "code", dir: "asc" }, page: 1, pageSize: 50 }, { showAmounts: false }));
      assert.deepEqual(page.rows.map((row) => [row.code, row.inUse]), [["ASSESS", 1], ["MONTHLY", 0], ["REPORT", 0], ["RETIRED", 0], ["WORKSHOP", 1]]);
      const catalogue = await withTenantRead(database.pool, ORG, (db) => listTemplateCatalogue(db));
      assert.equal(catalogue.at(-1)?.code, "RETIRED", "inactive items last");
    });
  });

  describe("load:v7-job-type-items", () => {
    it("resolves types and items by their v7 identities, reports the unresolved, and bumps each template it writes", async () => {
      // A person already included REPORT on the CRP type: v7's row 2 names the same pair, and the person's values stand.
      await setJobTypeItems(database.pool, { jobTypeId: "job-type:v7-1", expectedItemsVersion: 1, items: [{ itemId: "job-item:v7-2", quantity: 9, isRequired: true }] }, context("ada", "admin"));
      const dry = await loadV7JobTypeItems(database.pool, ORG, planV7JobTypeItems(extract()), { commit: false });
      assert.deepEqual([dry.inserted, dry.stamped], [2, 1]);
      const outcome = await loadV7JobTypeItems(database.pool, ORG, planV7JobTypeItems(extract()), { commit: true, runId: `${JOB_TYPE_ITEMS_RUN_PREFIX}first` });
      assert.deepEqual([outcome.inserted, outcome.stamped, outcome.updated, outcome.unchanged], [2, 1, 0, 0]);
      assert.deepEqual(outcome.unresolved, ["v7 row 4: item 4 not loaded here", "v7 row 5: job type 99 not loaded here"]);
      const crp = await included("job-type:v7-1");
      assert.deepEqual(crp.items.map((item) => [item.code, item.quantity, item.isRequired]), [["ASSESS", 1, true], ["REPORT", 9, true]], "REPORT keeps the person's 9");
      assert.equal(crp.itemsVersion, 3, "set once by the person, bumped once by the import");
      assert.deepEqual((await included("job-type:v7-2")).items.map((item) => item.code), ["MONTHLY"]);
    });

    it("re-run unchanged writes nothing; v7 changed and still as imported → v7 wins; edited here since → refused (R4)", async () => {
      const again = await loadV7JobTypeItems(database.pool, ORG, planV7JobTypeItems(extract()), { commit: true, runId: `${JOB_TYPE_ITEMS_RUN_PREFIX}second` });
      assert.deepEqual([again.inserted, again.updated, again.unchanged], [0, 0, 3]);
      const workshop = await versions("job-type:v7-2");
      await setJobTypeItems(database.pool, { jobTypeId: "job-type:v7-2", expectedItemsVersion: workshop.items_version, items: [{ itemId: "job-item:v7-5", quantity: 6, isRequired: true }] }, context("ada", "admin"));
      const changed = extract((rows) => { rows.job_type_items[0]!.quantity = "2"; rows.job_type_items[2]!.quantity = "4"; });
      const outcome = await loadV7JobTypeItems(database.pool, ORG, planV7JobTypeItems(changed), { commit: true, runId: `${JOB_TYPE_ITEMS_RUN_PREFIX}third` });
      assert.deepEqual([outcome.updated, outcome.conflicts], [1, ["v7 row 3: changed in v7 since the last load, and edited here since"]]);
      assert.equal((await included("job-type:v7-1")).items.find((item) => item.code === "ASSESS")?.quantity, 2);
      assert.equal((await included("job-type:v7-2")).items[0]?.quantity, 6, "the person's edit stands");
    });
  });
});
