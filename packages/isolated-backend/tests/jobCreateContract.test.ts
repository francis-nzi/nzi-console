import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { CommandValidationError, createJob } from "../src/index";

/**
 * Creating a job, end to end, against a real database (redesign Part 1).
 *
 * **This is the test that would otherwise have been missing.** Every existing test of `createJob`
 * drives a fake pool that records SQL and hands back canned rows — useful for asserting which
 * statements run and in what order, and structurally unable to notice that the INSERT names
 * fifteen columns and passes fourteen values, or that a new column does not exist, or that a
 * foreign key refuses the row. The statement is never executed.
 *
 * That is the same shape of gap as the portal preview: thirteen unit tests passing while the
 * feature could not render. So this one executes the real statement against the real schema and
 * reads back the row that results.
 *
 * Skips without a throwaway database; CI always provides one.
 */

/**
 * Read `date` columns as the strings they are.
 *
 * By default node-postgres turns a `date` into a Date at **local** midnight, and
 * `toISOString()` then shifts it back across the UTC offset: under BST, 30/09/2026 reads as
 * 2026-09-29. A calendar date has no time zone, and converting it through one is how an
 * off-by-one-day assertion looks like a bug in the code under test. Parser 1082 is `date`.
 */
pg.types.setTypeParser(1082, (value: string) => value);

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const DATABASE_URL = process.env.NZI_TEST_DATABASE_URL;
const ORG = "ci-jobcreate-org";
const ACTOR = "ci-jobcreate-consultant";
const MANAGER = "ci-jobcreate-manager";
const CLIENT = "ci-jobcreate-client";

function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(ci|test|tmp|throwaway)([_-]|$)/i.test(name)) {
    throw new Error(`Refusing to run: '${name}' is not named as a disposable database.`);
  }
  if (process.env.NZI_ISOLATED_DATABASE_URL === url) {
    throw new Error("Refusing to run: NZI_TEST_DATABASE_URL is the same database as NZI_ISOLATED_DATABASE_URL.");
  }
}

const context = (key: string) => ({
  organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole("consultant", ORG, ACTOR),
});

/** A period that is not the client's calendar year, so a reconstruction could not have produced it. */
const PERIOD = { reportingPeriodStart: "2025-04-01", reportingPeriodEnd: "2026-03-31" };
const BASE = {
  clientId: CLIENT, family: "crp" as const, title: "FY25 CRP", workflowStage: "Setup",
  owner: "CI Manager", clientManagerUserId: MANAGER,
  startDate: "2026-01-05", dueDate: "2026-09-30", ...PERIOD,
};

describe("creating a job writes what was entered", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let pool: pg.Pool;

  before(async () => {
    assertDisposable(DATABASE_URL!);
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS nzi_console CASCADE`);
    for (const role of ["nzi_console_app", "nzi_console_worker", "nzi_console_auth"]) {
      await admin.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }
    for (const filename of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, filename), "utf8"));
      if (filename.startsWith("0001_")) {
        await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $2)`, [ORG, "CI"]);
      }
    }
    await admin.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await admin.query(
      `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, financial_year_end_month)
       VALUES ($1, $2, 'CI Job Client', 'active', 3)`, [ORG, CLIENT]);
    for (const user of [ACTOR, MANAGER]) {
      await admin.query(
        `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status)
         VALUES ($1, $2, 'consultant', 'active')
         ON CONFLICT (organisation_id, user_id) DO UPDATE SET status='active'`, [ORG, user]);
    }
    await admin.end();
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, application_name: "nzi-jobcreate-ci" });
  });

  after(async () => { await pool?.end(); });

  const jobRow = (jobId: string) => pool.query<{
    reporting_period_start: string | null; reporting_period_end: string | null; reporting_year: number | null;
    client_manager_user_id: string | null; owner_name: string | null; start_date: string; due_date: string;
  }>(`SELECT reporting_period_start, reporting_period_end, reporting_year, client_manager_user_id,
             owner_name, start_date, due_date
        FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2`, [ORG, jobId]).then((result) => result.rows[0]!);

  it("stores the four dates, and the statement actually executes", async () => {
    const created = await createJob(pool, BASE, context("job-dates"));
    const row = await jobRow(created.data.jobId);
    assert.equal(row.start_date, "2026-01-05");
    assert.equal(row.due_date, "2026-09-30");
    assert.equal(row.reporting_period_start, "2025-04-01");
    assert.equal(row.reporting_period_end, "2026-03-31");
  });

  it("derives the reporting year from the period end, not from the start", async () => {
    // The client has a March year end, which is the case where the two rules disagree: the
    // start-year convention would label this 2025, the end-year rule labels it 2026.
    const created = await createJob(pool, { ...BASE, title: "Derived" }, context("job-derived"));
    assert.equal((await jobRow(created.data.jobId)).reporting_year, 2026);
  });

  it("records the client manager as a reference and as a name", async () => {
    const created = await createJob(pool, { ...BASE, title: "Manager" }, context("job-manager"));
    const row = await jobRow(created.data.jobId);
    assert.equal(row.client_manager_user_id, MANAGER, "the id a later rename reaches");
    assert.equal(row.owner_name, "CI Manager", "the name that survives if they leave the roster");
  });

  it("gives the emissions config the entered period, not a reconstructed year", async () => {
    // The client's financial_year_end_month is 3, so a reconstruction from a labelled year would
    // have produced 01/04/2025–31/03/2026 here by coincidence. The part-year case below is the one
    // that could not exist before.
    const created = await createJob(pool, { ...BASE, title: "Part year", reportingPeriodStart: "2025-04-01", reportingPeriodEnd: "2025-09-30" }, context("job-partyear"));
    const config = await pool.query<{ reporting_from: string; reporting_to: string }>(
      `SELECT reporting_from, reporting_to FROM nzi_console.job_emissions_config WHERE organisation_id=$1 AND job_id=$2`,
      [ORG, created.data.jobId]);
    assert.equal(config.rows[0]!.reporting_from, "2025-04-01");
    assert.equal(config.rows[0]!.reporting_to, "2025-09-30");
  });

  it("refuses the implausible year before it reaches the database", async () => {
    // The live bug, at the layer that can actually stop it.
    await assert.rejects(
      () => createJob(pool, { ...BASE, title: "Bad", startDate: "98655-11-22" }, context("job-bad-year")),
      CommandValidationError);
  });

  it("refuses a period that ends before it starts", async () => {
    await assert.rejects(
      () => createJob(pool, { ...BASE, title: "Backwards", reportingPeriodStart: "2026-03-31", reportingPeriodEnd: "2025-04-01" }, context("job-backwards")),
      CommandValidationError);
  });

  it("refuses a client manager who is not a member of this organisation", async () => {
    // The foreign key, not the validator — the guarantee that survives a future writer who forgets
    // to check. A fake pool cannot observe this at all.
    await assert.rejects(
      () => createJob(pool, { ...BASE, title: "Ghost", clientManagerUserId: "not-a-member" }, context("job-ghost")));
  });

  it("creates a job with no client manager at all", async () => {
    // Not every family runs through a client manager, and a null reference is a recorded absence
    // rather than a broken row.
    const created = await createJob(pool, { ...BASE, title: "Unmanaged", clientManagerUserId: null }, context("job-unmanaged"));
    assert.equal((await jobRow(created.data.jobId)).client_manager_user_id, null);
  });
});
