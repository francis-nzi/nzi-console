import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { DemoRetirementRefused, retireDemoJobNumbers } from "../src/demoJobNumberRetirement";
import { planV7ClientImport } from "../src/v7ClientImport";
import { loadV7ClientPlan } from "../src/v7ClientLoad";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticHeaders } from "./support/v7SyntheticExtract";

/**
 * Retiring the demo organisation's job-number clashes before the v7 load (decision 1a): the demo's numbers move above
 * v7's range in order, audited, with the counter caught up — and net-zero-international is never touched.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const NZI = "net-zero-international";
const DEMO = "demo-retire";

describe("retiring demo job-number clashes", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const jobsOf = async (org: string) => {
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [org]);
    return (await db.query<{ job_id: string; job_number: string; version: number }>(
      `SELECT job_id, job_number, version FROM nzi_console.jobs WHERE organisation_id=$1 ORDER BY job_id`, [org])).rows;
  };

  before(async () => {
    database = (await createDisposableDatabase("retiredemo"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Demo') ON CONFLICT DO NOTHING`, [DEMO]);
    // Demo jobs issued from the counter, as createJob does: J000001… — and one already above the range.
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [DEMO]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'demo-client','Demo client','active')`, [DEMO]);
    for (const [id, sequence] of [["demo-a", 1], ["demo-b", 2], ["demo-c", 614], ["demo-d", 900]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
        VALUES ($1,$2,'demo-client',$3,'crp','Demo','open','Setup')`, [DEMO, id, sequence]);
    }
    // A real job of net-zero-international, numbered in the range too, which must never move.
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [NZI]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'nzi-client','NZI client','active')`, [NZI]);
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
      VALUES ($1,'nzi-live','nzi-client',3,'crp','Live','open','Setup')`, [NZI]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("refuses net-zero-international outright, and a nonsense ceiling", async () => {
    await assert.rejects(retireDemoJobNumbers(database.pool, { organisationId: NZI, above: 764, commit: true }), DemoRetirementRefused);
    await assert.rejects(retireDemoJobNumbers(database.pool, { organisationId: DEMO, above: 0, commit: true }), DemoRetirementRefused);
  });

  it("aborts and rolls back if net-zero-international changes during the run — the check is not decoration", async () => {
    // A test-only trigger that, whenever a demo job is renumbered, quietly touches net-zero-international's job too.
    await db.query(`CREATE FUNCTION nzi_console.test_leak_into_nzi() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = nzi_console, pg_temp AS $f$ BEGIN
        IF NEW.organisation_id = 'demo-retire' THEN
          PERFORM set_config('app.organisation_id', 'net-zero-international', true);
          UPDATE nzi_console.jobs SET version = version + 1 WHERE organisation_id = 'net-zero-international';
          PERFORM set_config('app.organisation_id', 'demo-retire', true);
        END IF; RETURN NEW; END $f$`);
    await db.query(`CREATE TRIGGER test_leak AFTER UPDATE OF sequence ON nzi_console.jobs FOR EACH ROW WHEN (pg_trigger_depth() = 0)
      EXECUTE FUNCTION nzi_console.test_leak_into_nzi()`);
    try {
      const demoBefore = await jobsOf(DEMO);
      const nziBefore = await jobsOf(NZI);
      await assert.rejects(retireDemoJobNumbers(database.pool, { organisationId: DEMO, above: 764, commit: true }),
        /net-zero-international changed during the run/);
      assert.deepEqual(await jobsOf(DEMO), demoBefore, "the demo's moves were rolled back with it");
      assert.deepEqual(await jobsOf(NZI), nziBefore, "and so was the leak");
    } finally {
      await db.query(`DROP TRIGGER test_leak ON nzi_console.jobs`);
      await db.query(`DROP FUNCTION nzi_console.test_leak_into_nzi()`);
    }
  });

  it("dry-runs the move and keeps nothing", async () => {
    const before = await jobsOf(DEMO);
    const outcome = await retireDemoJobNumbers(database.pool, { organisationId: DEMO, above: 764, commit: false });
    assert.deepEqual(outcome.moved.map((move) => `${move.from}→${move.to}`), ["J000001→J000901", "J000002→J000902", "J000614→J000903"]);
    assert.deepEqual(await jobsOf(DEMO), before);
  });

  it("moves the demo's numbers above v7's range and past its own highest, in order, audited — and touches nothing else", async () => {
    const nziBefore = await jobsOf(NZI);
    const outcome = await retireDemoJobNumbers(database.pool, { organisationId: DEMO, above: 764, commit: true });
    assert.deepEqual(outcome.protectedCheck, { organisationId: NZI, jobs: 1, auditEvents: 0, unchanged: true },
      "net-zero-international checked before, inside and after: its one job untouched, no audit written there");
    assert.equal(outcome.moved.length, 3);
    assert.deepEqual((await jobsOf(DEMO)).map((job) => [job.job_id, job.job_number]),
      [["demo-a", "J000901"], ["demo-b", "J000902"], ["demo-c", "J000903"], ["demo-d", "J000900"]]);
    assert.ok(outcome.counterAt! >= 903, "the counter is caught up to the moved numbers, so the next job comes after them");
    assert.deepEqual(await jobsOf(NZI), nziBefore, "net-zero-international is untouched");
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [DEMO]);
    const audit = await db.query(`SELECT before_json->>'jobNumber' AS was, after_json->>'jobNumber' AS now FROM nzi_console.audit_events
      WHERE organisation_id=$1 AND action='job.renumbered' ORDER BY now`, [DEMO]);
    assert.deepEqual(audit.rows, [{ was: "J000001", now: "J000901" }, { was: "J000002", now: "J000902" }, { was: "J000614", now: "J000903" }]);

    const again = await retireDemoJobNumbers(database.pool, { organisationId: DEMO, above: 764, commit: true });
    assert.deepEqual(again.moved, [], "a second run finds nothing in the range");
  });

  it("clears the way: the v7 load no longer refuses the client whose number the demo held", async () => {
    const plan = planV7ClientImport({ extract: syntheticExtract(), headers: syntheticHeaders(), extractSha256: "synthetic" });
    // net-zero-international's own live job at 3 is not in the synthetic extract's numbers, so only the demo mattered.
    const outcome = await loadV7ClientPlan(database.pool, plan, { commit: false });
    assert.deepEqual(outcome.clients.map((client) => client.state), ["loaded", "loaded"], "J000614 is free for v7's job");
  });

  it("refuses an organisation that holds imported history", async () => {
    const plan = planV7ClientImport({ extract: syntheticExtract(), headers: syntheticHeaders(), extractSha256: "synthetic", organisationId: DEMO });
    await loadV7ClientPlan(database.pool, plan, { commit: true });
    await assert.rejects(retireDemoJobNumbers(database.pool, { organisationId: DEMO, above: 764, commit: true }), /imported job/);
  });
});
