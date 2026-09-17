import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { resolveCrpReportingChain } from "../src/readModels";

/**
 * The assurance chain's prior-year selection, executed against a real database (NZC-098).
 *
 * `buildReportingChain` is pure and tested as such; the query that feeds it was not tested at all,
 * and this change rewrote it — new joins for the job's period and the client's baseline period, and
 * the removal of the `reportingYear < currentYear` filter that used to do the selecting. A pure
 * test cannot notice a column that does not exist or a join that drops every row, so this drives
 * the real resolver over real rows.
 *
 * The client has a **September year end**, which is where the label and the calendar disagree.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "o";
const CLIENT = "c";
const HASH = `sha256:${"a".repeat(64)}`;

describe("the assurance chain selects priors by period, against a real database", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("chainordering"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    // Baseline ends 31/12/2022 — a calendar baseline against a September-year-end client, which is
    // exactly the pairing where comparing labels goes wrong.
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,financial_year_end_month,baseline_period_end)
       VALUES ($1,$2,'Client','active',9,'2022-12-31')`, [ORG, CLIENT]);

    // Three consecutive September years. The labels are deliberately what each convention would
    // have produced: the two older jobs carry the end-year label, the current one the start-year
    // label — so `year < currentYear` cannot separate them.
    const jobs: Array<[string, number, string, string]> = [
      ["j-2024", 2024, "2023-10-01", "2024-09-30"],
      ["j-2025", 2025, "2024-10-01", "2025-09-30"],
      ["j-current", 2025, "2025-10-01", "2026-09-30"],
    ];
    let sequence = 1;
    for (const [jobId, year, from, to] of jobs) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,$4,'crp','CRP','open','Setup',$5,$6,$7)`,
        [ORG, jobId, CLIENT, sequence++, year, from, to]);
      if (jobId === "j-current") continue;
      await db.query(
        `INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by)
         VALUES ($1,$2,$3,1,1,$4,$5::jsonb,'preparer')`,
        [ORG, `snap-${jobId}`, jobId, HASH,
         JSON.stringify({ jobNumber: jobId, client: "Client", reportingYear: year, measurements: [], annualComparison: [] })]);
    }
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("includes the immediately preceding period even though its label is not smaller", () => {
    // j-2025 covers 01/10/2024–30/09/2025 and is labelled 2025; the current job is also labelled
    // 2025. `reportingYear < currentYear` excluded it, dropping the immediately preceding year out
    // of the client's assurance trend with nothing reporting the omission.
    //
    // This is the assertion that fails before the change.
    return resolveCrpReportingChain(db, "j-current").then((chain) => {
      assert.ok(chain, "the chain resolves for a CRP job");
      const priors = chain!.entries.filter((entry) => entry.kind === "prior").map((entry) => entry.year);
      assert.deepEqual(priors, [2024, 2025], "both earlier periods, oldest first");
    });
  });

  it("puts the current job last and never among its own priors", async () => {
    const chain = (await resolveCrpReportingChain(db, "j-current"))!;
    assert.equal(chain.entries.at(-1)!.kind, "current");
    assert.equal(chain.entries.filter((entry) => entry.kind === "current").length, 1);
  });

  it("refuses a job whose period has not ended before the one being reported", async () => {
    // Resolved for the middle job: only the 2024 period precedes it. The current job's own later
    // period must not appear as a prior, which a label comparison would have allowed here because
    // the two share the number 2025.
    const chain = (await resolveCrpReportingChain(db, "j-2025"))!;
    const priors = chain.entries.filter((entry) => entry.kind === "prior").map((entry) => entry.year);
    assert.deepEqual(priors, [2024], "the later period sharing this label is not a prior");
  });

  it("returns null for a job that is not CRP", async () => {
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
       VALUES ($1,'j-training',$2,99,'training','Course','open','Course setup')`, [ORG, CLIENT]);
    assert.equal(await resolveCrpReportingChain(db, "j-training"), null);
  });
});
