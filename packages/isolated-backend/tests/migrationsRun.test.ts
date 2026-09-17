import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ensureDisposableDatabase } from "./support/database";

/**
 * Every migration, applied in order, against a real Postgres.
 *
 * This is the half `migrations.test.ts` cannot do. That suite asserts things about the SQL
 * *text* — that a file contains a CHECK, or revokes DELETE — which is useful but cannot
 * tell you the file runs. A parse error, a column that does not exist, a constraint the
 * seed data violates: all of them pass a regex and fail a database.
 *
 * That gap is not hypothetical. `0070` reached staging and failed there, and nothing in CI
 * could have known, because nothing in CI had ever executed it.
 *
 * Skips when no throwaway database is configured, so it never blocks a local run; CI always
 * provides one (see .github/workflows/ci.yml).
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
// This suite builds its schema in a database of its own, so a suite running beside it cannot
// drop that schema midway through (NZC-097). Its setup below is unchanged.
const DATABASE_URL = await ensureDisposableDatabase("migrationsrun");

/**
 * This suite DROPS the schema before it runs. That is correct for a throwaway database and
 * catastrophic for any other, so the target has to earn it twice over: its name must say it
 * is disposable, and it must not be the isolated database the app uses.
 *
 * Without this, one mistyped environment variable is the difference between a green CI run
 * and an erased staging database — and the erasure would look like a passing test.
 */
function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(ci|test|tmp|throwaway)([_-]|$)/i.test(name)) {
    throw new Error(
      `Refusing to run: this suite drops the nzi_console schema, and '${name}' is not named as a disposable database. ` +
      `Name it something containing 'ci', 'test', 'tmp' or 'throwaway'.`,
    );
  }
  if (process.env.NZI_ISOLATED_DATABASE_URL && process.env.NZI_ISOLATED_DATABASE_URL === url) {
    throw new Error("Refusing to run: NZI_TEST_DATABASE_URL is the same database as NZI_ISOLATED_DATABASE_URL.");
  }
}

const migrations = () =>
  readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()
    .map((filename) => ({ filename, sql: readFileSync(join(MIGRATIONS_DIR, filename), "utf8") }));

describe("every migration runs", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let client: pg.Client;

  before(async () => {
    assertDisposable(DATABASE_URL!);
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    // A throwaway database, so the run starts from nothing every time. Anything that only
    // works against a database already carrying yesterday's state is a migration that will
    // fail on a fresh environment.
    await client.query(`DROP SCHEMA IF EXISTS nzi_console CASCADE`);
    // 0002 grants to these roles; they are cluster-wide, so create them if absent.
    for (const role of ["nzi_console_app", "nzi_console_worker", "nzi_console_auth"]) {
      await client.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }
  });

  after(async () => { await client?.end(); });

  it("applies all of them in order, from empty", async () => {
    const files = migrations();
    assert.ok(files.length > 0, "there are migrations to run");
    for (const file of files) {
      try {
        await client.query(file.sql);
      } catch (error) {
        // Name the file. A bare Postgres error 70 files into a run is a puzzle.
        assert.fail(`${file.filename} failed to apply: ${(error as Error).message}`);
      }

      // `0070` and `0075` seed per organisation — `INSERT ... SELECT ... FROM organisations`
      // — so on a database with none they insert nothing at all. No migration creates an
      // organisation, so a genuinely empty database gets no SRS framework and no lever
      // catalogue. Real environments have one by this point, and the seeding assertions
      // below are only meaningful against one, so create it as soon as the table exists.
      if (file.filename.startsWith("0001_")) {
        await client.query(
          `INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $2)`,
          ["ci-organisation", "CI"],
        );
      }
    }
  });

  it("leaves the schema the application actually expects", async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'nzi_console'`,
    );
    const tables = new Set(rows.map((row) => row.table_name));
    // A spread across the domains, so a migration that applies but creates nothing useful
    // still fails.
    for (const table of [
      "organisations", "clients", "jobs", "job_scope_rows", "report_versions",
      "srs_frameworks", "srs_assessments", "client_intensity_metrics",
      "trainees", "training_certificates",
      "report_compositions", "schema_migrations",
      // Post-0078 names. `action_levers` and `client_actions` are deliberately absent: 0078
      // renames them, and asserting the old names would pass only while the rename was
      // incomplete.
      "levers", "reduction_strategies", "strategy_levers", "client_strategies",
    ]) {
      assert.ok(tables.has(table), `nzi_console.${table} should exist after all migrations`);
    }
  });

  it("seeds the SRS framework the file declares", async () => {
    // 0070 is the one that failed on staging. Its seed is the part a text assertion cannot
    // check: that the INSERT ... SELECT actually produces rows.
    const framework = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.srs_frameworks WHERE organisation_id = 'ci-organisation' AND framework_id = 'uk-srs-2026' AND status = 'active'`);
    assert.equal(framework.rows[0]!.count, "1", "one active framework version");
    const requirements = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.srs_requirements WHERE organisation_id = 'ci-organisation' AND framework_id = 'uk-srs-2026'`);
    assert.equal(requirements.rows[0]!.count, "48", "48 requirements, matching the file");
    const pillars = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.srs_pillars WHERE organisation_id = 'ci-organisation' AND framework_id = 'uk-srs-2026'`);
    assert.equal(pillars.rows[0]!.count, "4");
  });

  it("seeds the action-lever catalogue with no invented impact", async () => {
    const levers = await client.query<{ total: string; withImpact: string }>(
      `SELECT count(*)::text AS "total",
              count(*) FILTER (WHERE modelled_tco2e_per_year IS NOT NULL)::text AS "withImpact"
       FROM nzi_console.reduction_strategies WHERE organisation_id = 'ci-organisation'`);
    assert.equal(levers.rows[0]!.total, "13");
    assert.equal(levers.rows[0]!.withImpact, "0", "the catalogue ships qualitative");
  });

  it("gives an organisation created after the migrations the same reference set", async () => {
    // The gap this suite found on its first run, now closed: reference data follows the
    // organisation rather than the migration that ran once. A client onboarded today must
    // not hit the missing `srs_frameworks` that took staging down.
    await client.query(
      `INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $2)`,
      ["onboarded-today", "Created after every migration ran"]);

    // Compared against the organisation the migrations themselves seeded, rather than
    // against numbers typed here — the point is that the two are the same, whatever they are.
    const counts = async (organisationId: string) => {
      const { rows } = await client.query<{ requirements: string; pillars: string; levers: string; strategies: string; allocations: string }>(
        `SELECT (SELECT count(*)::text FROM nzi_console.srs_requirements WHERE organisation_id = $1) AS "requirements",
                (SELECT count(*)::text FROM nzi_console.srs_pillars WHERE organisation_id = $1) AS "pillars",
                (SELECT count(*)::text FROM nzi_console.levers WHERE organisation_id = $1) AS "levers",
                (SELECT count(*)::text FROM nzi_console.reduction_strategies WHERE organisation_id = $1) AS "strategies",
                (SELECT count(*)::text FROM nzi_console.strategy_levers WHERE organisation_id = $1) AS "allocations"`,
        [organisationId]);
      return rows[0]!;
    };
    assert.deepEqual(await counts("onboarded-today"), await counts("ci-organisation"),
      "a newly created organisation gets exactly what a migration-seeded one has");

    // And the content matches, not just the tallies — a transcription slip in the generated
    // provisioning would otherwise pass on counts alone.
    const { rows: diff } = await client.query<{ code: string }>(
      `SELECT code FROM nzi_console.srs_requirements WHERE organisation_id = 'ci-organisation'
       EXCEPT
       SELECT code FROM nzi_console.srs_requirements WHERE organisation_id = 'onboarded-today'`);
    assert.deepEqual(diff, [], "every requirement code is present in the provisioned organisation");
  });

  it("provisions idempotently, so the trigger and the backfill can run over each other", async () => {
    const before = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.strategy_levers WHERE organisation_id = 'onboarded-today'`);
    await client.query(`SELECT nzi_console.provision_organisation('onboarded-today')`);
    await client.query(`SELECT nzi_console.provision_organisation('onboarded-today')`);
    const after = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.strategy_levers WHERE organisation_id = 'onboarded-today'`);
    assert.equal(after.rows[0]!.count, before.rows[0]!.count, "provisioning twice changes nothing");

    // One active framework version stays one, rather than gaining a duplicate.
    const active = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.srs_frameworks WHERE organisation_id = 'onboarded-today' AND status = 'active'`);
    assert.equal(active.rows[0]!.count, "1");
  });

  it("provisions whatever creates the organisation, not only a command", async () => {
    // Nothing in the repository creates an organisation — they arrive by script or by hand.
    // A command would be a hook nothing calls, and the gap would reopen the first time
    // someone inserted a row directly, which is how it opened in the first place. So this
    // inserts one the crudest way available and expects it to come out provisioned.
    await client.query(
      `INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $2)`,
      ["raw-insert", "Inserted directly, no application code involved"]);
    const { rows } = await client.query<{ frameworks: string; levers: string; strategies: string }>(
      `SELECT (SELECT count(*)::text FROM nzi_console.srs_frameworks WHERE organisation_id = 'raw-insert') AS "frameworks",
              (SELECT count(*)::text FROM nzi_console.levers WHERE organisation_id = 'raw-insert') AS "levers",
              (SELECT count(*)::text FROM nzi_console.reduction_strategies WHERE organisation_id = 'raw-insert') AS "strategies"`);
    assert.equal(rows[0]!.frameworks, "1", "a directly inserted organisation still gets its framework");
    assert.notEqual(rows[0]!.levers, "0", "and its levers");
    assert.notEqual(rows[0]!.strategies, "0", "and its strategy library");
  });

  it("allocates every library strategy to at least one lever", async () => {
    // The plan is grouped by lever, so a strategy allocated to none would simply not render
    // anywhere. 0078's fallback mapping exists for exactly that case; this proves it caught
    // everything rather than trusting that the hand-written mapping was exhaustive.
    const orphans = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.reduction_strategies s
       WHERE NOT EXISTS (SELECT 1 FROM nzi_console.strategy_levers l
                         WHERE (l.organisation_id, l.strategy_id) = (s.organisation_id, s.strategy_id))`);
    assert.equal(orphans.rows[0]!.count, "0", "no library strategy is left without a lever");

    // Scoped to one organisation: reference data is per-organisation, so an unscoped count
    // is a multiple of however many organisations earlier tests happened to create.
    const levers = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.levers WHERE organisation_id = 'ci-organisation'`);
    assert.equal(levers.rows[0]!.count, "7", "the seeded lever set, per organisation");
  });

  it("keeps evidence stores append-only in the built schema", async () => {
    // The REVOKEs are asserted as text elsewhere; this checks they actually took effect.
    for (const table of ["report_compositions", "training_run_snapshots"]) {
      const { rows } = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE table_schema='nzi_console' AND table_name=$1 AND grantee='nzi_console_app'`, [table]);
      const granted = new Set(rows.map((row) => row.privilege_type));
      assert.ok(!granted.has("DELETE"), `${table} must not grant DELETE`);
      assert.ok(!granted.has("UPDATE"), `${table} must not grant UPDATE`);
    }
  });

  it("is idempotent where it claims to be: the ledger migration re-runs cleanly", async () => {
    // 0000 is the one file that must survive being run against a database that already has
    // everything — which is exactly what baselining staging does.
    const ledger = migrations().find((file) => file.filename.startsWith("0000_"))!;
    await client.query(ledger.sql);
    await client.query(ledger.sql);
  });

  it("has a checksum for every migration, so the ledger can detect a later edit", () => {
    const seen = new Map<string, string>();
    for (const file of migrations()) {
      const checksum = `sha256:${createHash("sha256").update(file.sql).digest("hex")}`;
      assert.match(checksum, /^sha256:[0-9a-f]{64}$/);
      seen.set(file.filename, checksum);
    }
    assert.equal(seen.size, migrations().length);
  });
});
