import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { withTenantRead } from "../src/postgres";
import { getTraineePortal } from "../src/traineePortal";

/**
 * 0144 against a real database: the trainee's record reads their pending sign-in change as `nzi_console_app` — which
 * failed with "permission denied" on every database before it — through a grant on exactly the columns that read uses.
 * The rest of the row (the confirmation token's hash, the current address, the sealed and index columns) stays the
 * auth role's, the app role still writes nothing there, and row-level security still confines the read to the tenant.
 */
const ORG = "org-pending";
const OTHER = "org-other";
const EXPECTED_COLUMNS = ["cancelled_at", "confirmed_at", "expires_at", "new_email", "organisation_id", "requested_at", "trainee_id"];

describe("A trainee's pending sign-in change, read by the app role (0144)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;

  /** One statement as `nzi_console_app` in a tenant — the role and setting `withTenantRead` uses. */
  const asApp = async (tenant: string, sql: string, params: unknown[] = []) => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE nzi_console_app");
      await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [tenant]);
      return (await client.query(sql, params)).rows;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  };

  before(async () => {
    database = (await createDisposableDatabase("pendingemail"))!;
    admin = await database.admin();
    for (const [org, trainee, email] of [[ORG, "tr-1", "alan@example.test"], [OTHER, "tr-2", "grace@example.test"]]) {
      await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await admin.query(`SELECT set_config('app.organisation_id', $1, false)`, [org]);
      await admin.query(`INSERT INTO nzi_console.trainees (organisation_id, trainee_id, full_name, personal_email, status, created_by) VALUES ($1, $2, 'A Person', $3, 'active', 'seed')`, [org, trainee, email]);
      // An expired change, then the live one — the record shows the live one.
      await admin.query(`INSERT INTO nzi_console.trainee_email_changes (organisation_id, change_id, trainee_id, current_email, new_email, token_hash, expires_at, requested_at)
        VALUES ($1, $2, $3, $4, 'old-request@example.test', $5, now() - interval '1 day', now() - interval '2 days'),
               ($1, $6, $3, $4, $7, $8, now() + interval '1 day', now())`,
        [org, `${org}-expired`, trainee, email, `hash-${org}-expired`, `${org}-live`, `new-${trainee}@example.test`, `hash-${org}-live`]);
    }
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("lets the trainee's record read the pending change as nzi_console_app — refused before 0144", async () => {
    const model = await withTenantRead(database.pool, ORG, (db) => getTraineePortal(db, { traineeId: "tr-1", asAt: "2026-10-01", organisationShortName: "Acme" }));
    assert.equal(model.details.pendingEmail, "new-tr-1@example.test");
  });

  it("does not show a change the person cancelled as pending, though it has not expired", async () => {
    await admin.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    // A newer request, cancelled an hour later: unexpired, unconfirmed — and not pending.
    await admin.query(`INSERT INTO nzi_console.trainee_email_changes (organisation_id, change_id, trainee_id, current_email, new_email, token_hash, expires_at, requested_at, cancelled_at)
      VALUES ($1, 'cancelled', 'tr-1', 'alan@example.test', 'withdrawn@example.test', 'hash-cancelled', now() + interval '1 day', now() + interval '1 minute', now() + interval '1 hour')`, [ORG]);
    const model = await withTenantRead(database.pool, ORG, (db) => getTraineePortal(db, { traineeId: "tr-1", asAt: "2026-10-01", organisationShortName: "Acme" }));
    assert.equal(model.details.pendingEmail, "new-tr-1@example.test", "the live request, not the newer cancelled one");
    // Cancel the live one too: nothing is pending.
    await admin.query(`UPDATE nzi_console.trainee_email_changes SET cancelled_at = now() WHERE change_id = $1`, [`${ORG}-live`]);
    const none = await withTenantRead(database.pool, ORG, (db) => getTraineePortal(db, { traineeId: "tr-1", asAt: "2026-10-01", organisationShortName: "Acme" }));
    assert.equal(none.details.pendingEmail, null, "a cancelled change is not pending");
    // Put the fixture back for the tests that follow.
    await admin.query(`UPDATE nzi_console.trainee_email_changes SET cancelled_at = NULL WHERE change_id = $1`, [`${ORG}-live`]);
    await admin.query(`DELETE FROM nzi_console.trainee_email_changes WHERE change_id = 'cancelled'`);
  });

  it("grants exactly the columns that read uses, and nothing at table level", async () => {
    const { rows: columns } = await admin.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
        WHERE grantee = 'nzi_console_app' AND table_schema = 'nzi_console' AND table_name = 'trainee_email_changes'
        ORDER BY column_name`);
    assert.deepEqual(columns.map((row) => [row.column_name, row.privilege_type]), EXPECTED_COLUMNS.map((column) => [column, "SELECT"]));
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const { rows: [row] } = await admin.query<{ granted: boolean }>(
        `SELECT has_table_privilege('nzi_console_app', 'nzi_console.trainee_email_changes', $1) AS granted`, [privilege]);
      assert.equal(row!.granted, false, `no table-level ${privilege}`);
    }
  });

  it("keeps the confirmation token's hash, the current address and the sealed columns from the app role", async () => {
    for (const column of ["token_hash", "current_email", "change_id", "new_email_sealed", "current_email_bidx"]) {
      await assert.rejects(asApp(ORG, `SELECT ${column} FROM nzi_console.trainee_email_changes`), /permission denied/, column);
    }
  });

  it("still writes nothing there as the app role", async () => {
    await assert.rejects(asApp(ORG, `UPDATE nzi_console.trainee_email_changes SET confirmed_at = now()`), /permission denied/);
    await assert.rejects(asApp(ORG, `DELETE FROM nzi_console.trainee_email_changes`), /permission denied/);
    await assert.rejects(asApp(ORG, `INSERT INTO nzi_console.trainee_email_changes (organisation_id, change_id, trainee_id, current_email, new_email, token_hash, expires_at)
      VALUES ($1, 'forged', 'tr-1', 'a@example.test', 'b@example.test', 'h', now())`, [ORG]), /permission denied/);
  });

  it("stays confined to the tenant", async () => {
    const rows = await asApp(ORG, `SELECT organisation_id, trainee_id, new_email FROM nzi_console.trainee_email_changes ORDER BY requested_at`);
    assert.deepEqual(rows.map((row) => row.organisation_id), [ORG, ORG], "only this tenant's two rows");
    assert.equal((await asApp(ORG, `SELECT 1 FROM nzi_console.trainee_email_changes WHERE trainee_id = 'tr-2'`)).length, 0, "the other tenant's change is not visible");
  });
});
