import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, dateOnly } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createClient, listJobReportingMonths, loadSpendImportContext, updateClient } from "../src/index";

/**
 * A SQL `date` keeps its day, end to end, against a real database (NZC-106).
 *
 * **Assert-correct, not pin-current.** Every assertion here is what the platform should do; the
 * ones that were wrong were red before the consolidation and are green after it.
 *
 * Why this cannot be a unit test: the defect is not in arithmetic, it is in what
 * `node-postgres` hands back. A `date` column arrives as a JS `Date` at *local* midnight, and
 * every way of reading that as an instant answers with the previous day wherever the process
 * runs ahead of UTC. A fake pool returns whatever the fixture author typed — a string, usually,
 * which is exactly the value that cannot reproduce the defect. Four separate fake-pool suites
 * asserted these paths and none of them could have caught this.
 *
 * Run under a zone matrix, not just one zone. `TZ=Europe/London` is the case that matters most
 * because the platform's day is London and the staging server resolves it server-side, but
 * `Pacific/Auckland` (+13) and `America/Los_Angeles` (−7) are what prove the reads no longer
 * depend on the answer at all.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const JOB = "job-a";
const ACTOR = "consultant-a";

/** An April–March reporting year: the shape where a day's shift changes the month count. */
const PERIOD_FROM = "2025-04-01";
const PERIOD_TO = "2026-03-31";

const context = (key: string) => ({
  organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole("admin", ORG, ACTOR),
});

const identity = { name: "Client", status: "active" as const, sector: "Food and Drink", location: "Wick, UK", owner: "D. Hawes" };
/** A baseline period starting on the first of a month — where the shift lands on a month edge. */
const profile = {
  financialYearEndMonth: 3,
  baselinePeriodStart: "2022-04-01", baselinePeriodEnd: "2023-03-31",
};

describe("a date keeps its day (NZC-106)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("dateshift"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       SELECT $1,$2,$3,1,'crp','CRP','open','Data entry',2025,$4::date,$5::date`,
      [ORG, JOB, CLIENT, PERIOD_FROM, PERIOD_TO]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("is handed back by the driver as local midnight, which is why the helpers exist", async () => {
    // Not a behaviour this repository controls — a fact about the driver, asserted so the
    // reason for `dateOnly` is written down where the next person will look for it.
    const { rows } = await db.query<{ reporting_period_start: Date }>(
      `SELECT reporting_period_start FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2`, [ORG, JOB]);
    const value = rows[0]!.reporting_period_start;
    assert.ok(value instanceof Date, "a `date` column arrives as a Date, not a string");
    assert.equal(value.getHours(), 0, "at midnight");
    assert.equal(dateOnly(value), PERIOD_FROM);
    // And the expression the consolidation removed, shown disagreeing wherever the process runs
    // ahead of UTC. In UTC and behind it the two agree, which is how this went unnoticed.
    const naive = value.toISOString().slice(0, 10);
    const offsetMinutes = -value.getTimezoneOffset();
    assert.equal(naive === PERIOD_FROM, offsetMinutes <= 0,
      `the naive read is wrong exactly when the offset is positive (offset ${offsetMinutes}m, read ${naive})`);
  });

  it("gives a spend import the period it was told, not the day before", async () => {
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,$3::date,$4::date,'GB')`, [ORG, JOB, PERIOD_FROM, PERIOD_TO]);
    const loaded = await loadSpendImportContext(db, ORG, JOB);
    assert.ok(loaded, "expected a context for a job with an emissions config");
    // These two bound whether an imported row counts as in-period. Shifted back a day, a
    // transaction dated 31 March is accepted into a period that starts on 1 April.
    assert.equal(loaded!.reportingFrom, PERIOD_FROM);
    assert.equal(loaded!.reportingTo, PERIOD_TO);
  });

  it("counts an April–March reporting year as twelve months", async () => {
    const months = await listJobReportingMonths(db, JOB);
    assert.equal(months.length, 12, `expected twelve months, got ${months.length}: ${months.join(",")}`);
    assert.equal(months[0], "2025-04");
    assert.equal(months.at(-1), "2026-03");
    assert.ok(!months.includes("2025-03"), "the month before the period never appears");
  });

  /** The version a command must quote to edit, read back rather than assumed. */
  const versionOf = async (clientId: string) => {
    const { rows } = await db.query<{ version: number }>(
      `SELECT version FROM nzi_console.clients WHERE organisation_id=$1 AND client_id=$2`, [ORG, clientId]);
    return rows[0]!.version;
  };

  it("does not record a rebaseline when nothing about the baseline changed", async () => {
    const created = await createClient(pool, { ...identity, ...profile }, context("client-create"));
    const clientId = created.data.clientId;
    // The same values, saved again. The stored dates now come back as Date objects while the
    // input is still a day string, and comparing the two as instants made them differ — so a
    // governed rebaseline was recorded for an edit that changed no baseline at all.
    await updateClient(pool, {
      clientId, expectedVersion: await versionOf(clientId), ...identity, ...profile,
    }, context("client-update"));

    const { rows } = await db.query<{ action: string; before_json: unknown }>(
      `SELECT action, before_json FROM nzi_console.audit_events
       WHERE organisation_id=$1 AND entity_id=$2 AND action='client_rebaselined'`, [ORG, clientId]);
    assert.deepEqual(rows, [], "a save that changed nothing must not be recorded as a rebaseline");
  });

  it("still records a rebaseline when the baseline period really moves", async () => {
    // The other half of the guarantee: the fix must not have made the governed event
    // unreachable. A real change is still a governed act.
    const created = await createClient(pool, { ...identity, name: "Moved", ...profile }, context("client-create-2"));
    const clientId = created.data.clientId;
    await updateClient(pool, {
      clientId, expectedVersion: await versionOf(clientId), ...identity, name: "Moved", ...profile,
      baselinePeriodStart: "2023-04-01", baselinePeriodEnd: "2024-03-31",
    }, { ...context("client-update-2"), reason: "Restated to the audited period" });

    const { rows } = await db.query<{ before_json: { baselinePeriodStart?: string } }>(
      `SELECT before_json FROM nzi_console.audit_events
       WHERE organisation_id=$1 AND entity_id=$2 AND action='client_rebaselined'`, [ORG, clientId]);
    assert.equal(rows.length, 1, "moving a baseline period is a governed act");
    // And the day it moved *from* is recorded as the day it was, not the day before.
    assert.equal(rows[0]!.before_json.baselinePeriodStart, "2022-04-01");
  });
});
