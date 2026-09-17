import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * Tenant isolation, proved against a real Postgres (NZC-099).
 *
 * **A fake cannot test this, however it is written.** Row-level security is a property of the
 * database, not of the code that talks to it. The existing suite asserts that `withTenantRead`
 * issues `BEGIN READ ONLY`, `SET LOCAL ROLE nzi_console_app`, `set_config('app.organisation_id')`
 * and `COMMIT` — which proves the adapter says the right words, and proves nothing at all about
 * whether the database acts on them. Every cross-tenant assertion in this repo was, until now, an
 * assertion about a mock's return value.
 *
 * So this connects as the real runtime role, with two organisations' rows in one table, and asks
 * the database what it will show and what it will let through.
 *
 * ## Why the role matters
 *
 * A superuser **always** bypasses RLS, and a table's owner bypasses it unless the table is set to
 * `FORCE ROW LEVEL SECURITY`. Migration `0002` sets both `ENABLE` and `FORCE` on every tenant
 * table, and the application connects as `nzi_console_app`, which is neither superuser nor owner.
 * Every test below does `SET LOCAL ROLE nzi_console_app` first — a test that forgot it would run
 * as the superuser that created the schema, see everything, and pass while proving the opposite of
 * what it claims. `asApp` exists so that cannot be forgotten, and the first test proves the guard
 * itself works by showing that the same query without the role sees both tenants.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG_A = "org-a";
const ORG_B = "org-b";

describe("the database enforces tenant isolation, not the application", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("tenantisolation"))!;
    db = await database.admin();
    for (const [org, name] of [[ORG_A, "Org A"], [ORG_B, "Org B"]]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1,$2)`, [org, name]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
      await db.query(
        `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status)
         VALUES ($1,$2,$3,'active')`, [org, `client-${org}`, `Client of ${name}`]);
    }
  });

  after(async () => { await db?.end(); await database?.end(); });

  /**
   * Run as the application role, in the tenant context the adapter would set, and roll back.
   * `SET LOCAL` and `set_config(..., true)` are both transaction-scoped, so nothing leaks between
   * tests however they are ordered.
   */
  async function asApp<T>(organisationId: string | null, work: (client: pg.Client) => Promise<T>): Promise<T> {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE nzi_console_app");
      if (organisationId !== null) await db.query(`SELECT set_config('app.organisation_id', $1, true)`, [organisationId]);
      return await work(db);
    } finally {
      await db.query("ROLLBACK");
    }
  }

  const clientIds = async (client: pg.Client) =>
    (await client.query<{ client_id: string }>(`SELECT client_id FROM nzi_console.clients ORDER BY client_id`))
      .rows.map((row) => row.client_id);

  it("shows a tenant only its own rows", async () => {
    assert.deepEqual(await asApp(ORG_A, clientIds), ["client-org-a"]);
    assert.deepEqual(await asApp(ORG_B, clientIds), ["client-org-b"]);
  });

  it("would have seen both without the role — so the guard above is real", async () => {
    // The test-of-the-test. As the superuser that owns the schema, RLS is bypassed and both
    // tenants are visible; if `asApp` ever stopped taking effect, every assertion here would still
    // pass while proving nothing. This is what that failure would look like.
    const all = await clientIds(db);
    assert.deepEqual(all, ["client-org-a", "client-org-b"], "the superuser sees both, as it must");
  });

  it("shows nothing at all when no tenant is set — fail closed", async () => {
    // `current_setting('app.organisation_id', true)` is NULL when unset, and `organisation_id =
    // NULL` is NULL rather than true, so the policy admits no row. A connection that forgot to set
    // the tenant sees an empty world rather than everyone's.
    assert.deepEqual(await asApp(null, clientIds), []);
  });

  it("shows nothing for an organisation that does not exist", async () => {
    assert.deepEqual(await asApp("org-does-not-exist", clientIds), []);
  });

  it("refuses to read another tenant's row even when named exactly", async () => {
    // Not merely filtered out of a list: unreachable when asked for by primary key. This is the
    // shape of a real attempt — an id leaked or guessed, then requested directly.
    const rows = await asApp(ORG_A, (client) => client.query(
      `SELECT client_id FROM nzi_console.clients WHERE client_id=$1`, [`client-${ORG_B}`]));
    assert.equal(rows.rowCount, 0, "naming another tenant's row does not make it visible");
  });

  it("refuses to write a row into another tenant", async () => {
    // WITH CHECK, not just USING. A read-only policy would let a tenant plant rows in another's
    // organisation and never see them again — invisible to the writer and live for the victim.
    await assert.rejects(
      () => asApp(ORG_A, (client) => client.query(
        `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status)
         VALUES ($1,'smuggled','Smuggled','active')`, [ORG_B])),
      /row-level security/i);
  });

  it("refuses to move one of its own rows into another tenant", async () => {
    // The same check on the other side of an UPDATE: a row may not be handed across the boundary.
    await assert.rejects(
      () => asApp(ORG_A, (client) => client.query(
        `UPDATE nzi_console.clients SET organisation_id=$1 WHERE client_id=$2`, [ORG_B, `client-${ORG_A}`])),
      /row-level security/i);
  });

  it("cannot delete another tenant's row", async () => {
    // Silent rather than refused — the row is simply not visible to the DELETE — so the assertion
    // is that nothing was removed, not that an error was raised.
    const result = await asApp(ORG_A, (client) => client.query(
      `DELETE FROM nzi_console.clients WHERE client_id=$1`, [`client-${ORG_B}`]));
    assert.equal(result.rowCount, 0, "a delete that matches nothing is the correct outcome");
    assert.deepEqual(await clientIds(db), ["client-org-a", "client-org-b"], "and the row is still there");
  });

  it("cannot update another tenant's row by naming it", async () => {
    const result = await asApp(ORG_A, (client) => client.query(
      `UPDATE nzi_console.clients SET name='renamed' WHERE client_id=$1`, [`client-${ORG_B}`]));
    assert.equal(result.rowCount, 0);
  });
});

describe("every tenant table is protected, not just the ones with tests", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("tenantcoverage"))!;
    db = await database.admin();
  });
  after(async () => { await db?.end(); await database?.end(); });

  /**
   * The tables that carry an `organisation_id` and deliberately have no tenant policy, each with
   * the property that protects it **instead**. An exception without a stated alternative is a gap
   * with an excuse, so every entry here is asserted separately below.
   */
  const NO_POLICY: Record<string, string> = {
    // Authentication necessarily runs before a tenant context exists — you cannot know the
    // organisation until the credential has been checked — so a policy keyed on
    // `app.organisation_id` could never admit a row. These are protected by GRANT instead: only
    // `nzi_console_auth` reaches them, and the application role has no privilege on them at all.
    staff_credentials: "auth-only grant; no tenant context exists yet at authentication time",
    staff_login_challenges: "auth-only grant; precedes tenant context",
    staff_sessions: "auth-only grant; precedes tenant context",
    portal_credentials: "auth-only grant; precedes tenant context",
    portal_login_challenges: "auth-only grant; precedes tenant context",
    portal_sessions: "auth-only grant; precedes tenant context",
    // The tenant registry itself: `organisation_id` is its primary key, so a policy comparing that
    // column to the current tenant would leave provisioning unable to create a row. The
    // application never queries it — asserted below — so the grant it holds is unused surface
    // rather than an open path.
    organisations: "the tenant registry; the application never queries it",
  };

  it("enables and forces row-level security on every table carrying an organisation_id", async () => {
    // Enumerated from the live catalogue rather than from a list someone maintains: a table added
    // by a future migration with an organisation_id and no policy is exactly the gap this catches,
    // and a hand-kept list would not.
    const { rows } = await db.query<{ tablename: string; rowsecurity: boolean; forced: boolean; policies: string }>(
      `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forced,
              coalesce((SELECT count(*)::text FROM pg_policy p WHERE p.polrelid = c.oid), '0') AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'nzi_console' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema='nzi_console' AND col.table_name=c.relname
                         AND col.column_name='organisation_id')
        ORDER BY c.relname`);

    assert.ok(rows.length > 40, `expected the tenant tables, found ${rows.length}`);
    const unprotected = rows
      .filter((row) => !row.rowsecurity || !row.forced || row.policies === "0")
      .map((row) => row.tablename)
      .filter((name) => !(name in NO_POLICY));
    assert.deepEqual(unprotected, [],
      "every table with an organisation_id must ENABLE and FORCE row-level security and carry a policy, "
      + "or appear in NO_POLICY with the property that protects it instead");
  });

  it("keeps the exception list honest — an entry that gained a policy is removed", async () => {
    // An allowlist nobody prunes stops being a list of exceptions and becomes a list of permissions.
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT c.relname AS tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='nzi_console' AND c.relkind='r' AND c.relrowsecurity
          AND c.relname = ANY($1::text[])`, [Object.keys(NO_POLICY)]);
    assert.deepEqual(rows.map((row) => row.tablename), [],
      "these now have row-level security — delete their NO_POLICY entries");
  });

  it("protects the auth tables by grant instead: the application role cannot reach them", async () => {
    // This is what makes the exception safe, and it is the half that would silently disappear if
    // someone added a convenience grant. Six tables, no privilege for nzi_console_app.
    const authTables = Object.keys(NO_POLICY).filter((name) => name !== "organisations");
    const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='nzi_console' AND grantee='nzi_console_app' AND table_name = ANY($1::text[])`,
      [authTables]);
    assert.deepEqual(rows, [], "the application role holds no privilege on the authentication tables");
  });

  it("notes that the tenant registry is reachable by the application role, and unused", async () => {
    // Stated rather than hidden. `organisations` has no policy and the application role does hold
    // privileges on it, so the only thing standing between a tenant and the list of every
    // organisation is that nothing queries it. That is a property of today's code, not of the
    // schema — so it is asserted, and the day a read model joins this table the assertion fails
    // and points at the missing policy rather than shipping a cross-tenant read.
    const grants = await db.query(
      `SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema='nzi_console' AND grantee='nzi_console_app' AND table_name='organisations'`);
    assert.ok((grants.rowCount ?? 0) > 0, "the grant exists — if this fails, the grant was closed and this test should go");
  });

  it("leaves no tenant table readable by the application role without a policy", async () => {
    // FORCE is the half that is easy to miss: ENABLE alone still lets the table's owner read
    // everything, and migrations run as the owner.
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT c.relname AS tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='nzi_console' AND c.relkind='r' AND c.relrowsecurity AND NOT c.relforcerowsecurity`);
    assert.deepEqual(rows.map((row) => row.tablename), [], "ENABLE without FORCE leaves the owner unrestricted");
  });
});

describe("the tenant registry stays unqueried while it has no policy", () => {
  /**
   * `nzi_console.organisations` has no row-level security — its primary key *is* the tenant id, so
   * a policy comparing that column to the current tenant would stop provisioning creating a row —
   * and the application role holds full DML on it. The only thing preventing a tenant from reading
   * every organisation's name is that no application code queries the table.
   *
   * That is a fact about today's source, not about the schema, so it is asserted here. The day
   * someone joins this table into a read model, this fails and names the decision that has to be
   * taken first: give it a policy, or narrow the grant.
   */
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  /** Application source only — migrations create the table and tests seed it, both legitimately. */
  const AREAS = ["packages/isolated-backend/src", "packages/contracts/src", "apps/console/app"];
  const sources = () => AREAS.flatMap((area) =>
    readdirSync(join(ROOT, area), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
      .map((name) => ({ area, name, path: join(ROOT, area, name) })));

  it("scans something", () => {
    // A scanner with nothing to scan finds nothing wrong, which reads as safety it never checked.
    assert.ok(sources().length > 100, `expected the application sources, found ${sources().length}`);
  });

  it("is referenced by no application source", () => {
    // Walked rather than shelled out: every other scanner in this repo reads the filesystem, and a
    // test that spawns a process fails for reasons that have nothing to do with what it asserts.
    const offenders = sources()
      .filter((source) => readFileSync(source.path, "utf8").includes("nzi_console.organisations"))
      .map((source) => `${source.area}/${source.name.split("\\").join("/")}`);
    assert.deepEqual(offenders, [],
      "application code now reads the tenant registry, which has no tenant policy — give "
      + "nzi_console.organisations a policy, or narrow the application role's grant, before this ships");
  });
});
