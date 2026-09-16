import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { strategyDeadline } from "@nzi/contracts";
import { seedPortalAcceptance, STRATEGY_CASES } from "../src/portalAcceptanceSeed";
import { listClientStrategies } from "../src/reductionStrategies";
import { getSrsAssessment } from "../src/srsReadinessRecords";
import { withTenantRead } from "../src/postgres";

/**
 * The whole seed sequence, against a real Postgres.
 *
 * This suite exists because the seed's first three failures were each found by running it on
 * staging — a round-trip apiece, and each one left a half-applied fixture in a real client's
 * plan. Two of the three were invisible to typecheck by construction: the command inputs type
 * `status` and `expectedVersion` loosely, and the third was a rule enforced only at runtime
 * (`client.strategy.update` refuses a withdrawn row). Nothing short of executing the commands
 * against a database could have caught them.
 *
 * So the bar here is the whole sequence through to a completed assessment, run **twice**, because
 * every one of those failures appeared on the second run rather than the first.
 *
 * Skips when no throwaway database is configured, so a local run is never blocked; CI always
 * provides one.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const DATABASE_URL = process.env.NZI_TEST_DATABASE_URL;
const ORG = "ci-organisation";
const ACTOR = "ci-seed-actor";
const CLIENT = "ci-client";

/** Same guard as the migrations suite: this drops the schema, so the target must be disposable. */
function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(ci|test|tmp|throwaway)([_-]|$)/i.test(name)) {
    throw new Error(`Refusing to run: '${name}' is not named as a disposable database.`);
  }
  if (process.env.NZI_ISOLATED_DATABASE_URL === url) {
    throw new Error("Refusing to run: NZI_TEST_DATABASE_URL is the same database as NZI_ISOLATED_DATABASE_URL.");
  }
}

describe("the portal acceptance seed", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let pool: pg.Pool;

  before(async () => {
    assertDisposable(DATABASE_URL!);
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS nzi_console CASCADE`);
    for (const role of ["nzi_console_app", "nzi_console_worker", "nzi_console_auth"]) {
      await admin.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }

    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
    for (const filename of files) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, filename), "utf8"));
      // No migration creates an organisation, and the per-organisation seeds are
      // `INSERT ... SELECT ... FROM organisations`, so one has to exist before they run.
      if (filename.startsWith("0001_")) {
        await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $2)`, [ORG, "CI"]);
      }
    }
    // Gives the org its SRS framework and its reduction-strategy library — the two catalogues the
    // seed reads before it writes anything.
    await admin.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await admin.query(
      `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status)
       VALUES ($1, $2, 'CI Client', 'active') ON CONFLICT DO NOTHING`, [ORG, CLIENT]);
    await admin.query(
      `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status)
       VALUES ($1, $2, 'admin', 'active')
       ON CONFLICT (organisation_id, user_id) DO UPDATE SET role_id='admin', status='active'`, [ORG, ACTOR]);
    await admin.end();

    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, application_name: "nzi-seed-ci" });
  });

  after(async () => { await pool?.end(); });

  const read = () => withTenantRead(pool, ORG, (db) => listClientStrategies(db, CLIENT));

  /** Filled by the first run, so later assertions identify rows by id rather than re-deriving them. */
  let first: Awaited<ReturnType<typeof seedPortalAcceptance>>;
  const idFor = (caseId: string) => {
    const match = first.strategies.find((entry) => entry.caseId === caseId);
    assert.ok(match, `the seed reported no strategy for case ${caseId}`);
    return match.clientStrategyId;
  };
  const rowFor = async (caseId: string) => {
    const row = (await read()).find((entry) => entry.id === idFor(caseId));
    assert.ok(row, `case ${caseId} is not on the client's plan`);
    return row;
  };

  it("runs the whole sequence through to a completed assessment", async () => {
    first = await seedPortalAcceptance(pool, { organisationId: ORG, actorId: ACTOR, clientId: CLIENT });

    assert.equal(first.strategies.length, STRATEGY_CASES.length, "every case produced a strategy");
    assert.ok(first.assessmentId, "an assessment was created");
    assert.equal(first.assessmentState, "completed");

    const assessment = await withTenantRead(pool, ORG, (db) => getSrsAssessment(db, first.assessmentId!));
    assert.equal(assessment?.status, "complete", "the portal only shows a completed assessment");
    assert.ok((assessment?.items.length ?? 0) >= 10, "a met/gap mix was recorded across requirements");
  });

  it("is re-runnable — replays, resumes, and creates no duplicates", async () => {
    // The run that mattered. Every failure this suite was written for appeared on the second run:
    // an already-withdrawn strategy being updated again, a draft assessment blocking a fresh
    // start, a version threaded from the wrong entity.
    const firstIds = (await read()).map((row) => row.id).sort();

    const summary = await seedPortalAcceptance(pool, { organisationId: ORG, actorId: ACTOR, clientId: CLIENT });
    assert.equal(summary.assessmentState, "already-complete", "the completed assessment is left alone");

    const secondIds = (await read()).map((row) => row.id).sort();
    assert.deepEqual(secondIds, firstIds, "no duplicate strategies on a re-run");
  });

  it("produces all four due states, plus a completed strategy that is not late", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const stateOf = async (caseId: string) => strategyDeadline(await rowFor(caseId), today).state;

    assert.equal(await stateOf("overdue"), "overdue");
    assert.equal(await stateOf("approaching"), "approaching");
    assert.equal(await stateOf("scheduled"), "scheduled");
    assert.equal(await stateOf("undated"), "none", "no date invents no signal");
    // The case the portal is most likely to get wrong on its own: finished work is not late.
    assert.equal(await stateOf("complete-past"), "none");
  });

  it("leaves the withdrawn case deactivated, never deleted", async () => {
    const strategies = await read();
    const withdrawn = strategies.filter((row) => !row.active);
    assert.equal(withdrawn.length, 1, "exactly the one case that withdraws");
    assert.equal(withdrawn[0]!.id, idFor("gap-withdrawn"), "and it is the case that was meant to");
    assert.equal(strategies.length, STRATEGY_CASES.length, "the row is still there — deactivated, not deleted");
  });

  it("hides the two out-of-report strategies without removing them", async () => {
    const strategies = await read();
    const hidden = strategies.filter((row) => !row.includeInReport);
    assert.equal(hidden.length, 2, "the hidden case and the out-of-report gap case");
    for (const row of hidden) assert.ok(row.active, "out of report is not the same as withdrawn");
  });

  it("aligns every strategy to at least one requirement", async () => {
    // The database enforces this with a deferred constraint trigger; a seed that went around the
    // commands could produce a row that violates it, which is the argument for going through them.
    for (const row of await read()) {
      assert.ok(row.srsRequirementIds.length > 0, `${row.id} has no SRS alignment`);
    }
  });
});

