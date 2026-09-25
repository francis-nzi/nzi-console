import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * The real operating organisation exists, is provisioned, and grants nobody anything yet (0127).
 *
 * The v7 reference data loads into it, so it must exist before the import; it arrives provisioned like any new
 * organisation; and creating it opens no door — memberships are their own deliberate step.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "net-zero-international";

describe("the operating organisation, Net Zero International (0127)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("operatingorg"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("exists under the id the import targets", async () => {
    const found = await db.query(`SELECT name FROM nzi_console.organisations WHERE organisation_id=$1`, [ORG]);
    assert.deepEqual(found.rows, [{ name: "Net Zero International" }]);
  });

  it("is provisioned with the reference set, exactly once", async () => {
    const frameworks = await db.query(`SELECT framework_id FROM nzi_console.srs_frameworks WHERE organisation_id=$1`, [ORG]);
    assert.equal(frameworks.rows.length, 1, "the provisioning trigger did not give the organisation its SRS framework, or gave it twice");
  });

  it("grants nobody access yet", async () => {
    const members = await db.query(`SELECT 1 FROM nzi_console.memberships WHERE organisation_id=$1`, [ORG]);
    assert.equal(members.rows.length, 0, "creating the organisation opened it to somebody");
  });
});
