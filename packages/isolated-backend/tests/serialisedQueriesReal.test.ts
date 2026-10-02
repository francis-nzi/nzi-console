import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticRows } from "./support/v7SyntheticExtract";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { serialisedQueryable, withTenantRead, withTenantWrite } from "../src/postgres";
import { listJobItemPickers } from "../src/serviceCatalogue";
import { readSupplierParts } from "../src/suppliers";
import { loadV7JobItems, planV7JobItems } from "../src/v7JobItemsLoad";
import { loadV7JobTypeItems, planV7JobTypeItems } from "../src/v7JobTypeItemsLoad";
import { loadV7Suppliers, planV7Suppliers } from "../src/v7SuppliersLoad";

/**
 * No query is asked of a transaction client while another is in flight (pg deprecates it; pg@9 refuses it).
 *
 * The tenant transaction hands its work a serialised view of the client, and the Phase E loaders read one query after
 * another. This suite listens for pg's own warning. pg emits it once per process (util.deprecate), so the guarded paths
 * run first and must emit nothing — and the last case asks a raw client for two queries at once and must emit it,
 * which proves the listener hears it (without that, "no warning" could only mean nothing was listening).
 */
const ORG = "serial-org";
const PG_WARNING = /already executing a query/;
const heard: string[] = [];
const listen = (warning: Error) => { if (PG_WARNING.test(warning.message)) heard.push(warning.message); };

describe("one query at a time on a transaction client", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;

  before(async () => {
    process.on("warning", listen);
    database = (await createDisposableDatabase("serialqueries"))!;
    const db = await database.admin();
    try { await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]); } finally { await db.end(); }
  });
  after(async () => { process.off("warning", listen); await database?.end(); });

  // The warning is emitted on the next tick after the call; give it a moment before deciding nothing was said.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it("serialises a reader's Promise.all inside withTenantRead — results intact, in order", async () => {
    const [pickers, parts, numbers] = await withTenantRead(database.pool, ORG, async (db) => Promise.all([
      listJobItemPickers(db, ORG),
      readSupplierParts(db, ORG, ["nobody"], { showRates: false }),
      Promise.all([1, 2, 3].map((n) => db.query<{ n: number }>(`SELECT $1::int AS n, pg_sleep(0.01)`, [n]))),
    ]));
    assert.equal(pickers.currency, "GBP");
    assert.deepEqual(parts, { nobody: { contacts: [], items: [] } });
    assert.deepEqual(numbers.map((result) => result.rows[0]!.n), [1, 2, 3]);
    await settle();
    assert.deepEqual(heard, []);
  });

  it("keeps the queue going past a failed query, and still reports the failure to its caller", async () => {
    await withTenantWrite(database.pool, ORG, async (db) => {
      await db.query("SAVEPOINT before_failure");
      const [failed, after] = await Promise.allSettled([db.query("SELECT 1/0"), db.query("ROLLBACK TO SAVEPOINT before_failure")]);
      assert.equal(failed.status, "rejected");
      assert.equal(after.status, "fulfilled", "the next query still ran");
    });
    await settle();
    assert.deepEqual(heard, []);
  });

  it("runs the Phase E loaders without the warning", async () => {
    const extract = syntheticExtract(syntheticRows());
    await loadV7JobItems(database.pool, ORG, planV7JobItems(extract), { commit: false });
    await loadV7JobTypeItems(database.pool, ORG, planV7JobTypeItems(extract), { commit: false });
    await loadV7Suppliers(database.pool, ORG, planV7Suppliers(extract), { commit: false, keys: resolveSealingKeys() });
    await withTenantWrite(database.pool, ORG, (db) => serialisedQueryable(db).query("SELECT 1"));
    await settle();
    assert.deepEqual(heard, []);
  });

  it("hears the warning when a raw client is asked for queries at once — the listener works", async () => {
    // pg warns when a query is asked for while another is already queued behind the running one: the third.
    const client = await database.pool.connect();
    try {
      await Promise.all([client.query("SELECT pg_sleep(0.01)"), client.query("SELECT 1"), client.query("SELECT 2")]);
    } finally { client.release(); }
    await settle();
    assert.equal(heard.length, 1, "pg's warning reached the listener");
  });
});
