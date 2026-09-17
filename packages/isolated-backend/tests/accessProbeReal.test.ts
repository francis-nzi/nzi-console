import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { assertClientAccess, assertJobAccess } from "../src/access";
import { AuthorizationError } from "../src/auth";

/**
 * The tenant-and-ownership access probe, answered by a database rather than by a helper (NZC-099).
 *
 * `resolveAccess` runs one statement — marked `/* nzi:access *​/` — that resolves the client owning
 * a record, strictly inside the caller's organisation, and refuses when it comes back empty. It is
 * the check standing between "I have a permission" and "I have it **over this record**".
 *
 * **Until now nothing tested it against a database.** `tests/support/access.ts` intercepts the
 * statement and returns a canned row for four suites, `permissions` among them — so every
 * cross-tenant refusal asserted in this repo was a refusal by a test helper, configured by the same
 * test that asserted it. The matrix logic was genuinely tested; the boundary it is enforced at was
 * not. The helper is fine for what it is — it lets a suite drive command logic without a schema —
 * but it cannot answer whether the SQL selects the right rows, and that is the whole question here.
 *
 * So this runs the real statement over real rows in two organisations.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG_A = "org-a";
const ORG_B = "org-b";
const OWNER = "consultant-a";
const OTHER = "consultant-b";

describe("the access probe answers from the database", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("accessprobe"))!;
    db = await database.admin();
    let sequence = 1;
    for (const org of [ORG_A, ORG_B]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
      for (const user of [OWNER, OTHER]) {
        await db.query(
          `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'consultant','active')
           ON CONFLICT (organisation_id,user_id) DO NOTHING`, [org, user]);
      }
      // One client per organisation, owned by OWNER, plus a job on it. Job sequence is globally
      // unique (NZC-025 gapless numbering), not per tenant, so it counts across both.
      await db.query(
        `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,owner_user_id)
         VALUES ($1,$2,'Client','active',$3)`, [org, `client-${org}`, OWNER]);
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
         VALUES ($1,$2,$3,$4,'crp','CRP','open','Setup')`, [org, `job-${org}`, `client-${org}`, sequence++]);
    }
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("resolves a record in the caller's own organisation", async () => {
    const access = await assertClientAccess(db, ORG_A, OWNER, `client-${ORG_A}`);
    assert.equal(access.clientId, `client-${ORG_A}`);
  });

  it("refuses the identical record id in another organisation", async () => {
    // Both organisations hold a client; neither id is guessed. The caller is in ORG_A and names
    // ORG_B's client, which is the shape of a real cross-tenant attempt.
    await assert.rejects(
      () => assertClientAccess(db, ORG_A, OWNER, `client-${ORG_B}`),
      (error: unknown) => error instanceof AuthorizationError && /not in your organisation/i.test((error as Error).message));
  });

  it("refuses across the boundary for an admin, who holds everything at `all`", async () => {
    // The capability check cannot save this one: an admin holds client.update at `all` scope, so
    // if the tenant predicate were wrong nothing else would stop the read. That is why this probe
    // is the boundary rather than the permission matrix.
    await assert.rejects(
      () => assertClientAccess(db, ORG_B, OWNER, `client-${ORG_A}`),
      AuthorizationError);
  });

  it("refuses a job in another organisation, through the joined form of the probe", async () => {
    // The job statement joins jobs to clients; a predicate applied to only one of the two would
    // pass this repo's client test and still leak here.
    await assert.rejects(
      () => assertJobAccess(db, ORG_A, OWNER, `job-${ORG_B}`),
      AuthorizationError);
  });

  it("resolves a job in the caller's own organisation", async () => {
    const access = await assertJobAccess(db, ORG_A, OWNER, `job-${ORG_A}`);
    assert.equal(access.clientId, `client-${ORG_A}`);
  });

  it("refuses a record that does not exist at all", async () => {
    await assert.rejects(
      () => assertClientAccess(db, ORG_A, OWNER, "no-such-client"),
      AuthorizationError);
  });

  it("refuses an empty id without asking the database", async () => {
    await assert.rejects(
      () => assertClientAccess(db, ORG_A, OWNER, "   "),
      AuthorizationError);
  });

  it("reads the owner from the row, which is what own_clients resolves against", async () => {
    // The second thing the probe returns. A capability scoped to own_clients is decided by this
    // value, so a probe that returned the right client with the wrong owner would hand a
    // consultant powers over a colleague's client while every permission test still passed.
    const access = await assertClientAccess(db, ORG_A, OWNER, `client-${ORG_A}`);
    assert.equal(access.ownerUserId, OWNER);
    assert.equal(access.ownedByActor, true, "and says so to the caller who owns it");
  });

  it("returns the real owner even when the caller is not that owner", async () => {
    const access = await assertClientAccess(db, ORG_A, OTHER, `client-${ORG_A}`);
    assert.equal(access.ownerUserId, OWNER, "ownership is a fact about the record, not about the caller");
    assert.equal(access.ownedByActor, false, "and this caller is not that owner");
  });
});
