import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { requestTraineeEmailChange, updateTraineeDetails } from "../src/traineeAuth";

/**
 * Trainee self-service against real Postgres, because it has never been run against it.
 *
 * Found while surveying the write paths for encryption, and written *before* being treated as a fact:
 * the reading was that trainee self-service cannot work under row-level security, and a reading is not
 * a defect until something has run.
 *
 * ## What the reading says
 *
 * `updateTraineeDetails`, `requestTraineeEmailChange` and `confirmTraineeEmailChange` all run inside
 * `withAuthTransaction`, which is `SET LOCAL ROLE nzi_console_auth` plus the pseudo-tenant
 * `app.organisation_id = 'authentication'`. `nzi_console.trainees` has `ENABLE` *and* `FORCE ROW LEVEL
 * SECURITY` with `tenant_isolation` on `organisation_id = current_setting('app.organisation_id', true)`,
 * and the trainee's `organisation_id` is a real organisation. So the policy should exclude every trainee
 * row from that context, whatever the statement's own `WHERE` clause says.
 *
 * `FORCE` is the load-bearing word: without it the table owner would be exempt and the suite's admin
 * connection would see everything, which is exactly how this could have been missed by a test that ran
 * the SQL without becoming the role.
 *
 * ## How this is arranged so the answer is conclusive either way
 *
 * The first test states the mechanism and passes whatever the outcome — it reports what the auth context
 * can and cannot see. It is the confirmation.
 *
 * The two after it exercise the real entry points and assert that self-service *works*, which is what it
 * is supposed to do. They are marked `todo` so that a red does not block an unrelated increment while
 * being impossible to overlook: node's runner prints them either way, so "todo but passed" would say the
 * reading was wrong and the tests should simply be promoted. They are not `skip`, because a skipped test
 * proves nothing and this exists to prove something.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-trainee";
const TRAINEE = "trainee-1";
const AUTH_TENANT = "authentication";

const TRACKED = "tracked defect: the authentication context cannot reach a trainee row under forced RLS — fixed alongside the SECURITY DEFINER auth bridge";

describe("trainee self-service against real Postgres", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("traineeself"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Trainees')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.trainees (organisation_id,trainee_id,full_name,personal_email,status,created_by)
       VALUES ($1,$2,'Alan Turing','alan@example.test','active','seed')`, [ORG, TRAINEE]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  /** What one role-and-tenant combination can see of the trainee row. */
  const visibleAs = async (role: string, tenant: string): Promise<number> => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [tenant]);
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM nzi_console.trainees WHERE organisation_id=$1 AND trainee_id=$2`,
        [ORG, TRAINEE]);
      await client.query("COMMIT");
      return Number(rows[0]!.count);
    } finally {
      client.release();
    }
  };

  it("hides every trainee row from the authentication context", async () => {
    // The mechanism, asserted rather than reported. `SET LOCAL ROLE` plus a tenant setting is the
    // technique this repo settled on after three privilege tests "proved" a denial by connecting as a
    // NOLOGIN role and were really watching the login fail.
    //
    // Both assertions are claims that can be wrong, which is the point: a test whose branches all pass
    // is not a confirmation of anything. If the second one fails, the reading behind this file was
    // wrong, the two `todo` tests below should be promoted, and nothing needs fixing.
    assert.equal(await visibleAs("nzi_console_auth", ORG), 1,
      "the auth role can read a trainee in the trainee's own organisation — a 0 here would mean the grant is the problem, not the policy");
    assert.equal(await visibleAs("nzi_console_auth", AUTH_TENANT), 0,
      `under app.organisation_id='${AUTH_TENANT}' the policy hides the row, so every self-service statement matches nothing whatever its own WHERE clause says`);
  });

  it("lets a trainee maintain their own details", { todo: TRACKED }, async () => {
    // The `FOR UPDATE` select inside this runs first, so the symptom is not a missing row but a wrong
    // sentence: an active trainee is told their account is not active.
    const saved = await updateTraineeDetails(database.pool, {
      organisationId: ORG, traineeId: TRAINEE,
      update: { fullName: "Alan M Turing", phone: "+44 20 7000 0002" },
      consentVersion: "v1",
    });
    assert.equal(saved.traineeId, TRAINEE);
    assert.ok(saved.version > 1, "the version bumped");

    const { rows } = await db.query<{ full_name: string; phone: string }>(
      `SELECT full_name, phone FROM nzi_console.trainees WHERE organisation_id=$1 AND trainee_id=$2`, [ORG, TRAINEE]);
    assert.equal(rows[0]!.full_name, "Alan M Turing", "and the row actually changed");
  });

  it("lets a trainee propose a change of sign-in address", { todo: TRACKED }, async () => {
    const proposed = await requestTraineeEmailChange(database.pool, {
      organisationId: ORG, traineeId: TRAINEE, newEmail: "alan.turing@example.test",
    });
    assert.equal(proposed.newEmail, "alan.turing@example.test");

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.trainee_email_changes
        WHERE organisation_id=$1 AND trainee_id=$2 AND confirmed_at IS NULL AND cancelled_at IS NULL`,
      [ORG, TRAINEE]);
    assert.equal(Number(rows[0]!.count), 1, "the pending change was recorded");
  });
});
