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

  const cluster = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await cluster.connect();
  try {
    for (const role of RUNTIME_ROLES) {
      await cluster.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }
    await cluster.query(`DROP DATABASE IF EXISTS "${name}"`);
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
  const cluster = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await cluster.connect();
  try {
    for (const role of RUNTIME_ROLES) {
      await cluster.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }
    await cluster.query(`DROP DATABASE IF EXISTS "${name}"`);
    // UTF8 explicitly: the cluster default on Windows is WIN1252, under which a migration
    // containing a "→" fails to apply at all.
    await cluster.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await cluster.end();
  }

  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  for (const filename of readdirSync(MIGRATIONS_DIR).filter((entry) => entry.endsWith(".sql")).sort()) {
    await admin.query(readFileSync(join(MIGRATIONS_DIR, filename), "utf8"));
    await options.onMigration?.(filename, admin);
  }
  await admin.end();

  const pool = new pg.Pool({ connectionString: target.toString(), max: 4, application_name: `nzi-${suite}-ci` });
  return {
    pool,
    url: target.toString(),
    admin: async () => {
      const client = new pg.Client({ connectionString: target.toString() });
      await client.connect();
      return client;
    },
    // The database is left in place after the run: it costs nothing, it is recreated from nothing
    // next time, and a failed suite's rows are the first thing anyone wants to look at.
    end: async () => { await pool.end(); },
  };
}
