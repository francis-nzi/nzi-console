import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { buildSpendImportIdentity, loadSpendImportContext } from "../src/index";

/**
 * The spend template's period and the job's period are read the same way, by both sides (NZC-115).
 *
 * **This is the point of the fix, not the one-line change that preceded it.**
 *
 * `commitSpendImport` accepts an import only when the period signed into the downloaded template
 * equals the period read from the job at commit time. Two functions compute that period — the token
 * is minted by `buildSpendImportIdentity`, the check is made against `loadSpendImportContext` — and
 * nothing bound them together. So when NZC-106 corrected one and deliberately held the other, they
 * began to disagree, and every spend import was refused with `WRONG_PERIOD` wherever the server ran
 * ahead of UTC. Both had been wrong before, identically, which is why the equality had held.
 *
 * A pair like that is fixed or held as a pair, never one side. This test is what makes that
 * structural rather than remembered: it fails the moment the two computations diverge again, for
 * any reason, on any of the periods below.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const ACTOR = "consultant-a";

/** Periods chosen for where a day-shift shows: month edges, a year edge, and a part year. */
const PERIODS: Array<{ jobId: string; from: string; to: string; why: string }> = [
  { jobId: "job-apr", from: "2025-04-01", to: "2026-03-31", why: "an April–March financial year" },
  { jobId: "job-cal", from: "2025-01-01", to: "2025-12-31", why: "a calendar year, both ends on a year boundary" },
  { jobId: "job-part", from: "2025-11-01", to: "2026-03-31", why: "a part-year first engagement" },
  { jobId: "job-mid", from: "2025-06-15", to: "2026-06-14", why: "a period starting mid-month" },
];

describe("the template's period equals the job's period (NZC-115)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("spendpairing"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, CLIENT]);
    let sequence = 0;
    for (const period of PERIODS) {
      sequence += 1;
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,start_date,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',2025,$5::date,$5::date,$6::date)`,
        [ORG, period.jobId, CLIENT, sequence, period.from, period.to]);
      await db.query(
        `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
         VALUES ($1,$2,$3::date,$4::date,'GB')`, [ORG, period.jobId, period.from, period.to]);
    }
  });

  after(async () => { await db?.end(); await database?.end(); });

  for (const period of PERIODS) {
    it(`agrees on ${period.why}`, async () => {
      const identity = await buildSpendImportIdentity(db, ORG, period.jobId);
      const context = await loadSpendImportContext(db, ORG, period.jobId);
      assert.ok(identity && context, "both sides resolve");

      // The equality `commitSpendImport` actually makes. If this fails, every spend import against
      // this job is refused with WRONG_PERIOD and the message tells the consultant to download a
      // fresh template — which will not help, because the fresh one disagrees too.
      assert.equal(identity!.reportingFrom, context!.reportingFrom, "reportingFrom");
      assert.equal(identity!.reportingTo, context!.reportingTo, "reportingTo");

      // And both agree with what was stored, so the pair is right rather than merely consistent.
      // Two identically wrong readings would satisfy the equality above; that is exactly how this
      // went unnoticed until one of them was corrected.
      assert.equal(identity!.reportingFrom, period.from, "the period the consultant configured");
      assert.equal(identity!.reportingTo, period.to);
    });
  }

  it("derives the reporting year from the start date the same way", async () => {
    // The third reading of a `date` in this module, and the same class of defect: a job starting
    // 1 January would fall back to the previous year.
    const bare = "job-no-year";
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,start_date)
       VALUES ($1,$2,$3,90,'crp','CRP','open','Data entry',NULL,'2026-01-01'::date)`, [ORG, bare, CLIENT]);
    const identity = await buildSpendImportIdentity(db, ORG, bare);
    assert.equal(identity!.reportingYear, 2026, "the year the job starts in, not the one before it");
    // With no emissions config the period falls back to that year, and both ends must agree with it.
    assert.equal(identity!.reportingFrom, "2026-01-01");
    assert.equal(identity!.reportingTo, "2026-12-31");
  });
});
