import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listScopeRowRollforwardPreview, listSpendRollforwardPreview } from "../src/readModels";

/**
 * The rollforward's two questions, on a client where they give different answers (NZC-101).
 *
 * The preview used to answer both with one derivation: it re-picked "the prior job" on every read
 * and then reported that job's rows and their lineage. So changing the derivation changed what a
 * **completed** job appeared to have done — rows genuinely rolled forward from one job stopped
 * being listed once the candidate became another, and the screen offered to roll the same work
 * forward again from a different year.
 *
 * The fixture is a September-year-end client whose labels and periods disagree:
 *
 * ```
 *   job-older    01/10/2023 – 30/09/2024   reporting_year 2024   has rows
 *   job-newer    01/10/2024 – 30/09/2025   reporting_year 2025   has rows
 *   job-target   01/10/2025 – 30/09/2026   reporting_year 2025   ← being rolled into
 * ```
 *
 * `job-target` carries the label 2025 because it predates the end-year rule; `job-newer` carries
 * 2025 because it follows it. Under the old `reporting_year < targetYear` the immediately
 * preceding job is **excluded** — 2025 is not less than 2025 — and the candidate falls back to
 * `job-older`, skipping a year. Under period order the candidate is `job-newer`, whose period ends
 * the day before the target's begins.
 *
 * And `job-target` has already rolled a row forward from `job-older`. That lineage must not move
 * when the candidate does.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const OLDER = "job-older";
const NEWER = "job-newer";
const TARGET = "job-target";

describe("the candidate moves with the period; the recorded lineage does not", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("rollforwardorigins"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,financial_year_end_month)
       VALUES ($1,$2,'Client','active',9)`, [ORG, CLIENT]);

    const jobs: Array<[string, number, string, string, number]> = [
      [OLDER, 2024, "2023-10-01", "2024-09-30", 1],
      [NEWER, 2025, "2024-10-01", "2025-09-30", 2],
      [TARGET, 2025, "2025-10-01", "2026-09-30", 3],
    ];
    for (const [jobId, year, from, to, sequence] of jobs) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,$4,'crp',$5,'open','Data entry',$6,$7,$8)`,
        [ORG, jobId, CLIENT, sequence, jobId, year, from, to]);
    }

    // Both earlier jobs have a canonical row and a spend source, so either could be a candidate.
    for (const jobId of [OLDER, NEWER]) {
      await db.query(
        `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quality_tier,enabled)
         VALUES ($1,$2,$3,'1',$4,$4,'Scope 1','Direct','measured',true)`, [ORG, `row-${jobId}`, jobId, `Row from ${jobId}`]);
      await db.query(
        `INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,data_source,enabled)
         VALUES ($1,$2,$3,'3.1','spend',$4,'ledger',true)`, [ORG, `src-${jobId}`, jobId, `Spend from ${jobId}`]);
    }

    // The target has ALREADY rolled one canonical row forward — from job-older, not from the
    // period-adjacent job. This is the recorded fact that must survive the basis change.
    await db.query(
      `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quality_tier,enabled,rolled_forward_from_row_id)
       VALUES ($1,'row-target-from-older',$2,'1','Carried over','Carried over','Scope 1','Direct','measured',true,$3)`,
      [ORG, TARGET, `row-${OLDER}`]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("suggests the period-adjacent job, not the one with a smaller label", async () => {
    // Fails before the change: `reporting_year < 2025` excludes job-newer for being equal, and the
    // candidate falls back to job-older — skipping the year immediately before this one.
    const preview = await listScopeRowRollforwardPreview(db, TARGET);
    assert.equal(preview.priorJob?.id, NEWER, "the job whose period ends the day before this one starts");
  });

  it("suggests the same job to the spend mechanism", async () => {
    // Both previews must agree. The data only exercised the scope-row mechanism, but a rule applied
    // to one of two mechanisms is a rule that will disagree with itself.
    const preview = await listSpendRollforwardPreview(db, TARGET);
    assert.equal(preview.priorJob?.id, NEWER);
  });

  it("reports the lineage that was actually recorded, which is a different job", async () => {
    // The point of the separation. The candidate is job-newer; the work already done came from
    // job-older; both are true at once and neither overwrites the other.
    const preview = await listScopeRowRollforwardPreview(db, TARGET);
    assert.deepEqual(preview.origins.map((origin) => origin.id), [OLDER]);
    assert.equal(preview.origins[0]!.rows, 1, "one row came from it");
    assert.equal(preview.origins[0]!.number.length > 0, true, "and it is named");
  });

  it("does not flip alreadyRolledForward when the candidate basis changes", async () => {
    // Before the change the candidate was job-older, so its row listed as alreadyRolledForward.
    // Now the candidate is job-newer, whose row has NOT been rolled forward — and the job-older
    // row that has been is reported through `origins` rather than vanishing.
    const preview = await listScopeRowRollforwardPreview(db, TARGET);
    const offered = preview.rows.map((row) => ({ id: row.priorRowId, done: row.alreadyRolledForward }));
    assert.deepEqual(offered, [{ id: `row-${NEWER}`, done: false }],
      "the candidate's own row is offered and is genuinely not yet rolled forward");
    assert.deepEqual(preview.origins.map((origin) => origin.id), [OLDER],
      "and the completed lineage is still reported, from the rows themselves");
  });

  it("still marks a row already taken from the candidate itself", async () => {
    // The flag must keep working where it always did: roll job-newer's row forward and it stops
    // being offered as new work.
    await db.query(
      `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quality_tier,enabled,rolled_forward_from_row_id)
       VALUES ($1,'row-target-from-newer',$2,'1','Carried over again','Carried over again','Scope 1','Direct','measured',true,$3)`,
      [ORG, TARGET, `row-${NEWER}`]);
    const preview = await listScopeRowRollforwardPreview(db, TARGET);
    assert.deepEqual(preview.rows.map((row) => row.alreadyRolledForward), [true]);
    assert.deepEqual(preview.origins.map((origin) => origin.id).sort(), [NEWER, OLDER].sort(),
      "and now two origins are recorded, which a single prior_job_id could not have held");
  });

  it("reports no origins for a job that has rolled nothing forward", async () => {
    const preview = await listScopeRowRollforwardPreview(db, NEWER);
    assert.deepEqual(preview.origins, []);
  });

  it("offers no candidate to the earliest job, and says so without inventing one", async () => {
    const preview = await listScopeRowRollforwardPreview(db, OLDER);
    assert.equal(preview.priorJob, null);
    assert.deepEqual(preview.rows, []);
  });
});
