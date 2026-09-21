import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import pg from "pg";
import { dateOnly } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * Public certificate verification, against the policies that govern it (NZC-123).
 *
 * This function is live and user-facing — `/verify/[verifyCode]` is in the deployed build — and until
 * now it had no test that touched a database at all. It is also one of the two reads that deliberately
 * cross a tenant boundary, which is a thing row-level security forbids by default and which worked only
 * because every owner it had ever run under held `BYPASSRLS` (NZC-122).
 *
 * So a test that ran before 0104 would have proved nothing: the property under test was switched off.
 * It runs here under a database owned by a role that bypasses nothing, which is the only arrangement in
 * which "a stranger can read this, and only this" is a claim rather than an assumption.
 *
 * ## What it has to establish
 *
 *   1. A stranger — no tenant context at all — can verify a code. That is the cross-tenant read.
 *   2. They get exactly the contracted columns, and no more. The `RETURNS TABLE` is the whole contract.
 *   3. A wrong code returns nothing, rather than a hint about which part was wrong.
 *   4. The role that makes this possible owns those two functions and nothing else — because the
 *      policies naming it are unrestricted on five training tables, so its ownership list *is* the
 *      boundary.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-cert";
const OTHER = "org-other";
const CODE = "VERIFY-ABC123";

describe("a stranger can verify a certificate, and see only what the contract says", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  /** One organisation's certificate, end to end: client → job → run → booking → certificate. */
  const seedCertificate = async (org: string, code: string, person: string, sequence: number) => {
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [org]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c','Acme','active')`, [org]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
       VALUES ($1,'j','c',$2,'training','Course','open','setup')`, [org, sequence]);
    await db.query(
      `INSERT INTO nzi_console.training_course_runs (organisation_id,course_run_id,job_id,run_name,workflow_stage_key,created_by)
       VALUES ($1,'run','j','Carbon Literacy','certified','seed')`, [org]);
    await db.query(
      `INSERT INTO nzi_console.training_course_sessions (organisation_id,session_id,course_run_id,session_date,status,created_by)
       VALUES ($1,'sess','run',DATE '2026-06-01','delivered','seed')`, [org]);
    await db.query(
      `INSERT INTO nzi_console.training_bookings (organisation_id,booking_id,course_run_id,person_name,created_by)
       VALUES ($1,'book','run',$2,'seed')`, [org, person]);
    await db.query(
      `INSERT INTO nzi_console.training_certificates
         (organisation_id,certificate_id,course_run_id,booking_id,certificate_number,
          attended_minutes,required_minutes,attendance_pct,certificate_hash,issued_by,verify_code)
       VALUES ($1,'cert','run','book','NZI-0001',360,360,100,'hash','seed',$2)`, [org, code]);
  };

  before(async () => {
    database = (await createDisposableDatabase("certverify"))!;
    db = await database.admin();
    await seedCertificate(ORG, CODE, "Ada Lovelace", 1);
    await seedCertificate(OTHER, "VERIFY-OTHER", "Grace Hopper", 2);
    // A stranger has no organisation. Cleared deliberately, because leaving one set would let a
    // tenant-scoped policy satisfy the read and the cross-tenant property would go untested.
    await db.query(`SELECT set_config('app.organisation_id', '', false)`);
  });

  after(async () => { await db?.end(); await database?.end(); });

  afterEach(async () => { await db.query("ROLLBACK").catch(() => undefined); });

  /** As the application role, with no tenant context — which is what an unauthenticated request is. */
  const asStranger = async <T>(work: () => Promise<T>): Promise<T> => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE nzi_console_app");
      await db.query(`SELECT set_config('app.organisation_id', '', true)`);
      const result = await work();
      await db.query("ROLLBACK");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  };

  it("verifies a code with no tenant context at all", async () => {
    const { rows } = await asStranger(() => db.query<{ person_name: string; course_name: string; completed_on: Date; status: string }>(
      `SELECT * FROM nzi_console.verify_training_certificate($1)`, [CODE]));
    assert.equal(rows.length, 1, "a stranger holding a valid code gets exactly one certificate");
    assert.equal(rows[0]!.person_name, "Ada Lovelace");
    assert.equal(rows[0]!.course_name, "Carbon Literacy");
    assert.equal(rows[0]!.status, "issued");
    assert.equal(dateOnly(rows[0]!.completed_on), "2026-06-01",
      "the completion date comes from the delivered session");
  });

  it("reaches another organisation's certificate too, which is the whole point", async () => {
    // Cross-tenant, stated: two organisations, one function, no context. Before 0104 this worked only
    // because the owner bypassed the policy; now it works because a policy names the owner.
    const { rows } = await asStranger(() => db.query<{ person_name: string }>(
      `SELECT * FROM nzi_console.verify_training_certificate('VERIFY-OTHER')`));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.person_name, "Grace Hopper");
  });

  it("returns exactly the contracted columns, and nothing that identifies further", async () => {
    // The RETURNS list is the contract. An address, an employer, the paying client or the person's other
    // training would each be a disclosure to a stranger holding one code.
    const { rows } = await asStranger(() => db.query(
      `SELECT * FROM nzi_console.verify_training_certificate($1)`, [CODE]));
    assert.deepEqual(Object.keys(rows[0]!).sort(), [
      "attendance_pct", "certificate_number", "completed_on", "course_name",
      "issued_on", "issuer", "person_name", "revoked_on", "status",
    ]);
  });

  it("says nothing at all about a wrong code", async () => {
    const { rows } = await asStranger(() => db.query(
      `SELECT * FROM nzi_console.verify_training_certificate('VERIFY-NOPE')`));
    assert.deepEqual(rows, [], "no row, rather than a hint about which part was wrong");
  });

  it("cannot be reached by reading the tables directly", async () => {
    // The function is the only door. Without it the application role sees nothing outside its own
    // tenant, and here it has no tenant — so a direct read must come back empty rather than deny, since
    // the policy filters rather than refuses.
    const { rows } = await asStranger(() => db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.training_certificates`));
    assert.equal(Number(rows[0]!.count), 0, "a stranger reading the table directly sees no certificates");
  });

  it("gives the definer role those two functions and nothing else", async () => {
    // Where the narrowness actually lives. The policies naming this role are unrestricted on five
    // training tables, which carry a person's name and address — so its ownership list is the boundary,
    // and a third function owned by it would inherit all of that silently.
    const { rows } = await db.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p
         JOIN pg_roles r ON r.oid = p.proowner
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'nzi_console' AND r.rolname = 'nzi_console_definer'
        ORDER BY p.proname`);
    assert.deepEqual(rows.map((row) => row.proname), ["open_subject_reviews", "verify_training_certificate"],
      "a function owned by the definer role inherits its cross-tenant reads — adding one is a deliberate act");
  });

  it("owns that role no bypass, so the policies are what is doing the work", async () => {
    // If this role could bypass, every policy above would be decoration and every assertion in this file
    // would pass for the wrong reason — which is exactly how this went unnoticed for so long.
    const { rows } = await db.query<{ rolbypassrls: boolean; rolcanlogin: boolean; rolsuper: boolean }>(
      `SELECT rolbypassrls, rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'nzi_console_definer'`);
    assert.equal(rows[0]!.rolbypassrls, false, "it bypasses nothing");
    assert.equal(rows[0]!.rolsuper, false, "and is no superuser");
    assert.equal(rows[0]!.rolcanlogin, false, "and cannot be logged into");
  });
});
