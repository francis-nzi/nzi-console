import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * A throwaway database of this suite's own, migrated and ready.
 *
 * **Why a database each rather than a schema each.** Nine test files drop and rebuild
 * `nzi_console` on the database `NZI_TEST_DATABASE_URL` points at, and `node --test` runs files in
 * parallel processes. Each one's `DROP SCHEMA … CASCADE` deletes the tables the others are midway
 * through using, so which suite fails depends on which finished first — `reportFreeze` passed alone
 * and failed beside `portalPreviewContract`, and a red like that is indistinguishable from a real
 * one. The schema name is written into every migration (`CREATE SCHEMA … nzi_console`, and every
 * statement is `nzi_console.`-qualified), so a schema each would mean rewriting the SQL under test,
 * which defeats the point of testing against real migrations. A database each needs no such change
 * and isolates by construction rather than by scheduling.
 *
 * Roles are cluster-wide and deliberately shared: they are created if missing and never dropped.
 *
 * Returns null when no test database is configured, so a suite can skip rather than fail.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const RUNTIME_ROLES = ["nzi_console_app", "nzi_console_worker", "nzi_console_auth"];

/**
 * The role that owns the test database and applies its migrations — deliberately **not** a superuser
 * (NZC-122).
 *
 * ## Why the owner is the thing that matters
 *
 * A `SECURITY DEFINER` function runs as its owner, and `FORCE ROW LEVEL SECURITY` applies to a table's
 * owner. So whether such a function can read across tenants turns on one property of whoever ran the
 * migrations: does that role hold `BYPASSRLS`.
 *
 * CI connects as `postgres` on the official image, which does. Production is Supabase, where `postgres`
 * also does — by a provider default that no migration grants and nothing stated until NZC-122. So every
 * definer function has always been exercised with row-level security switched off underneath it, and one
 * that works only for a bypassing owner has never had anywhere to fail.
 *
 * Owning the database with a role that cannot bypass makes that failure happen here, on a throwaway
 * database, rather than on the day a provider changes a default. Same family as the `NOLOGIN` roles
 * whose refused *login* was mistaken for a refused *privilege*, and as the suite whose fixture never set
 * a tenant context and passed because a superuser did not need one: in each, the database identity the
 * work ran under is what made the result meaningless.
 *
 * ## What this increment deliberately does not do
 *
 * The suites' own connections stay as they were. Moving those to a non-superuser role as well is worth
 * doing and is a different change: it makes every fixture insert subject to the policies at once, so a
 * missing tenant context would fail in a great many places, and mixing the two would leave neither
 * result legible.
 */
/**
 * Extensions the schema needs, which the platform provides and the application only uses
 * (NZC-124).
 *
 * `pg_trgm` supplies the `gin_trgm_ops` operator class that 0086 indexes the knowledge library with.
 * Supabase pre-provisions it; here the superuser bootstrap does, so the owner never installs anything
 * and the shape matches production rather than working by a privilege production does not grant.
 *
 * ## Installed into `nzi_console`, and the reason is not cosmetic
 *
 * An operator class is found through the search path, and every migration runs on one connection, so
 * a session-level `SET search_path` in one file is still in force in the next. 0060 sets it to
 * `nzi_console` alone, with no `public`, and 0086 comes after. Installing into `public` therefore puts
 * `gin_trgm_ops` somewhere 0086 cannot see, and the index fails with "operator class does not exist"
 * — which reads like a missing extension and is a missing *schema on the path*.
 *
 * That is also why this runs after 0001 rather than before the migrations: `nzi_console` does not
 * exist until 0001 creates it.
 */
const REQUIRED_EXTENSIONS = ["pg_trgm"] as const;

/** Install the extensions as the superuser, into the schema the migrations actually search. */
async function provisionExtensions(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, ...CONNECTION_GUARDS });
  await client.connect();
  try {
    for (const extension of REQUIRED_EXTENSIONS) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${extension} WITH SCHEMA nzi_console`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Timeouts on every connection this helper opens, so a block surfaces as an error naming the
 * statement rather than as a step that runs until CI kills it.
 *
 * A hang and a slow pass look identical from outside, and a fourteen-minute one teaches everybody to
 * stop reading the step. Same principle as checking `pg_available_extensions` before building
 * anything: an environment problem should say what it is, once, quickly.
 *
 * `lock_timeout` is deliberately much shorter than `statement_timeout`, because they separate two
 * faults. A statement that runs long is doing work; one that waits ten seconds for a lock is waiting
 * on something that is not going to let go, and the error names the relation.
 * `connectionTimeoutMillis` covers the third case — a server that accepts a socket and never answers,
 * which `pg` will otherwise wait on for ever.
 */
const CONNECTION_GUARDS = {
  connectionTimeoutMillis: 10_000,
  statement_timeout: 60_000,
  lock_timeout: 10_000,
} as const;

/**
 * Name the stage a failure happened in.
 *
 * Building a database is half a dozen distinct things and "it hung" does not say which. The label is
 * carried into the error, so the next run reports the stage rather than a line number in a helper.
 */
/** How long any one stage may take before the server is asked what it is doing. */
const PHASE_WATCHDOG_MS = 45_000;

/**
 * What the server is doing, when a stage takes too long.
 *
 * The timeouts above catch a statement that blocks. They cannot catch work that never blocks — a loop
 * issuing fast queries for ever looks exactly like a slow suite, and no timeout fires. So when a stage
 * overruns, a separate connection reads `pg_stat_activity` and the answer goes into the error: a lock
 * wait names its wait event, and a spinning loop shows the same query over and over.
 */
async function serverActivity(): Promise<string> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL, ...CONNECTION_GUARDS });
  try {
    await client.connect();
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT pid, datname, usename, state, wait_event_type, wait_event,
              left(query, 140) AS query
         FROM pg_stat_activity WHERE pid <> pg_backend_pid() ORDER BY state, pid`);
    return rows.map((row) => JSON.stringify(row)).join("\n      ");
  } catch (error) {
    return `(could not read pg_stat_activity: ${error instanceof Error ? error.message : String(error)})`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function phase<T>(label: string, work: () => Promise<T>): Promise<T> {
  let overran: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    overran = setTimeout(() => {
      void serverActivity().then((activity) => reject(new Error(
        `while ${label}: still running after ${PHASE_WATCHDOG_MS}ms. No statement timed out, so nothing ` +
        `is blocked — the server sees:
      ${activity}`)));
    }, PHASE_WATCHDOG_MS);
  });
  try {
    return await Promise.race([work(), watchdog]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw message.startsWith(`while ${label}`) ? error : new Error(`while ${label}: ${message}`, { cause: error });
  } finally {
    if (overran) clearTimeout(overran);
  }
}

const OWNER_ROLE = "nzi_console_test_owner";
const OWNER_PASSWORD = "nzi_console_test_owner";

/** The same target, reached as the owning role rather than as the cluster superuser. */
const asOwner = (url: string): string => {
  const owned = new URL(url);
  owned.username = OWNER_ROLE;
  owned.password = OWNER_PASSWORD;
  return owned.toString();
};

export const TEST_DATABASE_URL = process.env.NZI_TEST_DATABASE_URL;

/** A suite name is part of a database name, so it may only contain what an identifier may. */
const assertSuiteName = (suite: string): void => {
  if (!/^[a-z][a-z0-9_]{0,24}$/.test(suite)) {
    throw new Error(`Suite name '${suite}' must be lower-case letters, digits and underscores.`);
  }
};

/**
 * The same refusal every script in this repo makes, kept here so a suite cannot forget it: the
 * target must be named as disposable, and must never be the isolated (staging) database.
 */
function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(ci|test|tmp|throwaway)([_-]|$)/i.test(name)) {
    throw new Error(`Refusing to run: '${name}' is not named as a disposable database.`);
  }
  if (process.env.NZI_ISOLATED_DATABASE_URL === url) {
    throw new Error("Refusing to run: NZI_TEST_DATABASE_URL is the same database as NZI_ISOLATED_DATABASE_URL.");
  }
}

/**
 * This suite's own empty database, returned as a URL — for a suite that already knows how to build
 * its schema and only needs somewhere private to do it.
 *
 * Most of these suites predate the problem and each has its own carefully-arranged fixture. Giving
 * them a private database and leaving their setup exactly as written isolates them by construction
 * with a one-line change, rather than nine rewrites of working code on a carbon path. Their
 * `DROP SCHEMA` then does what it always meant: clear this suite's own world.
 *
 * Returns undefined when no test database is configured, so the suite's existing skip still works.
 */
export async function ensureDisposableDatabase(suite: string): Promise<string | undefined> {
  if (!TEST_DATABASE_URL) return undefined;
  assertSuiteName(suite);
  assertDisposable(TEST_DATABASE_URL);

  const name = `${new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "")}_${suite}`;
  const target = new URL(TEST_DATABASE_URL);
  target.pathname = `/${name}`;
  assertDisposable(target.toString());

  const cluster = new pg.Client({ connectionString: TEST_DATABASE_URL, ...CONNECTION_GUARDS });
  await phase("connecting to the cluster", () => cluster.connect());
  try {
    await phase("creating the runtime roles", async () => {
      for (const role of RUNTIME_ROLES) {
        await cluster.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
      }
    });
    // The classic block: DROP DATABASE waits on any session still attached to it. With a lock
    // timeout it says so in ten seconds instead of waiting for the job to be killed.
    await phase(`dropping the previous ${name}`, () => cluster.query(`DROP DATABASE IF EXISTS "${name}"`));
    await cluster.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await cluster.end();
  }
  return target.toString();
}

export type DisposableDatabase = {
  pool: pg.Pool;
  /** A fresh admin client, for setup a pooled connection should not do. */
  admin(): Promise<pg.Client>;
  url: string;
  end(): Promise<void>;
};

/**
 * Build this suite's database from nothing and apply every migration in order.
 *
 * `onMigration` runs after the named migration file, for the rows a later migration needs — the
 * organisation row after `0001`, most often.
 */
export async function createDisposableDatabase(
  suite: string,
  options: { onMigration?: (filename: string, admin: pg.Client) => Promise<void> } = {},
): Promise<DisposableDatabase | null> {
  if (!TEST_DATABASE_URL) return null;
  assertSuiteName(suite);
  assertDisposable(TEST_DATABASE_URL);

  const base = new URL(TEST_DATABASE_URL);
  const baseName = base.pathname.replace(/^\//, "");
  const name = `${baseName}_${suite}`;
  const target = new URL(TEST_DATABASE_URL);
  target.pathname = `/${name}`;
  assertDisposable(target.toString());

  // DROP DATABASE cannot run inside a transaction or against a database in use, so this is done
  // from the base database, which this suite never connects to for anything else.
  const cluster = new pg.Client({ connectionString: TEST_DATABASE_URL, ...CONNECTION_GUARDS });
  await phase("connecting to the cluster", () => cluster.connect());
  try {
    await phase("creating the runtime roles", async () => {
      for (const role of RUNTIME_ROLES) {
        await cluster.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
      }
    });
    await cluster.query(
      `DO $$ BEGIN CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${OWNER_PASSWORD}'; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    // Stated every run rather than only at creation, so a role left from an earlier run cannot carry
    // attributes this one does not expect. NOBYPASSRLS is the point; CREATEROLE is what the migrations
    // need, and it confers no exemption from a policy.
    await cluster.query(
      `ALTER ROLE ${OWNER_ROLE} WITH LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB`);
    // The migrations grant the runtime roles to CURRENT_USER, which needs ADMIN OPTION on roles this
    // one did not create — they were made just above, as the superuser.
    await cluster.query(`GRANT ${RUNTIME_ROLES.join(", ")} TO ${OWNER_ROLE} WITH ADMIN OPTION`);

    // Checked once, here, rather than discovered as a failing index in every suite in turn. An image
    // without the extension is an environment problem and should say so in one line.
    const available = await cluster.query<{ name: string }>(
      `SELECT name FROM pg_available_extensions WHERE name = ANY($1::text[])`,
      [[...REQUIRED_EXTENSIONS]]);
    const missing = REQUIRED_EXTENSIONS.filter((name) => !available.rows.some((row) => row.name === name));
    if (missing.length > 0) {
      throw new Error(
        `This PostgreSQL has no ${missing.join(", ")} available to install. The schema needs it for ` +
        `gin_trgm_ops (0086). Install the contrib package, or use an image that ships it.`);
    }

    // The classic block: DROP DATABASE waits on any session still attached to it. With a lock
    // timeout it says so in ten seconds instead of waiting for the job to be killed.
    await phase(`dropping the previous ${name}`, () => cluster.query(`DROP DATABASE IF EXISTS "${name}"`));
    // UTF8 explicitly: the cluster default on Windows is WIN1252, under which a migration
    // containing a "→" fails to apply at all.
    await cluster.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0 OWNER ${OWNER_ROLE}`);
  } finally {
    await cluster.end();
  }

  // Applied as the owner, so every table, policy and SECURITY DEFINER function belongs to a role that
  // cannot bypass row-level security.
  const owner = new pg.Client({ connectionString: asOwner(target.toString()), ...CONNECTION_GUARDS });
  await phase(`connecting as ${OWNER_ROLE}`, () => owner.connect());
  for (const filename of readdirSync(MIGRATIONS_DIR).filter((entry) => entry.endsWith(".sql")).sort()) {
    await phase(`applying ${filename}`, () => owner.query(readFileSync(join(MIGRATIONS_DIR, filename), "utf8")));
    // As soon as the schema exists, and before anything indexes with an operator class from one.
    if (filename.startsWith("0001_")) {
      await phase("provisioning extensions", () => provisionExtensions(target.toString()));
    }
    await phase(`the fixture hook after ${filename}`, async () => { await options.onMigration?.(filename, owner); });
  }
  await owner.end();

  const pool = new pg.Pool({ connectionString: target.toString(), max: 4, application_name: `nzi-${suite}-ci`, ...CONNECTION_GUARDS });
  return {
    pool,
    url: target.toString(),
    admin: async () => {
      const client = new pg.Client({ connectionString: target.toString(), ...CONNECTION_GUARDS });
      await client.connect();
      return client;
    },
    // The database is left in place after the run: it costs nothing, it is recreated from nothing
    // next time, and a failed suite's rows are the first thing anyone wants to look at.
    end: async () => { await pool.end(); },
  };
}
