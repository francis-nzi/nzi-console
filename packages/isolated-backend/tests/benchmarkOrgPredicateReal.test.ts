import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { getBenchmarkInForce } from "../src/clientTargetRecords";

/**
 * The benchmark in force reads its own organisation's client — on a connection that bypasses row-level security.
 *
 * Found by the GATE 2 dry run: the staging script role holds BYPASSRLS, and `getBenchmarkInForce` read `clients` by client id
 * alone. Through `withTenantRead`/`withTenantWrite` that is confined all the same — they `SET LOCAL ROLE nzi_console_app`,
 * which bypasses nothing — but a read on a raw connection that sets the tenant and keeps its own role (as a script or a
 * psql session does) was confined by nothing. The query now pins the organisation itself, with the tenant policy's own
 * expression, so the code does not depend on which role it runs as.
 *
 * So the tenant here is set on a raw admin connection, with no role switch: the first test proves that connection bypasses
 * RLS, so every other assertion is about the query's own predicate, not a policy doing the work.
 */
describe("getBenchmarkInForce pins the organisation, without row-level security", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const A = "bench-org-a", B = "bench-org-b";
  let database: DisposableDatabase;
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const client = (org: string, id: string, baselineYear: number, total: number) => q(
    `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, location, owner_name, website, baseline_period_start, baseline_period_end, baseline_total_tco2e)
     VALUES ($1, $2, $3, 'active', NULL, NULL, NULL, $4, $5, $6)`,
    [org, id, `Client ${id}`, `${baselineYear}-01-01`, `${baselineYear}-12-31`, total]);
  // The tenant set as a script would set it: in a transaction, on the connection's own role — no SET ROLE.
  const asScript = async <T,>(org: string, work: (db: Awaited<ReturnType<DisposableDatabase["admin"]>>) => Promise<T>) => {
    const db = await database.admin();
    try {
      await db.query("BEGIN READ ONLY");
      await db.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
      return await work(db);
    } finally { await db.query("ROLLBACK").catch(() => undefined); await db.end(); }
  };
  const benchmark = (org: string, clientId: string) => asScript(org, (db) => getBenchmarkInForce(db, clientId));

  before(async () => {
    database = (await createDisposableDatabase("benchorg"))!;
    for (const org of [A, B]) await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [org]);
    // The same client id in both organisations, with different baselines.
    await client(A, "shared", 2021, 100);
    await client(B, "shared", 2023, 300);
    // A client id that exists only in B.
    await client(B, "only-b", 2022, 200);
  });
  after(async () => { await database?.end(); });

  it("runs on a connection that bypasses row-level security, as the staging script role does", async () => {
    const rows = await asScript(A, async (db) => (await db.query<{ bypass: boolean; visible: number }>(
      `SELECT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
              (SELECT count(*)::int FROM nzi_console.clients WHERE client_id IN ('shared', 'only-b')) AS visible`)).rows);
    assert.equal(rows[0]!.bypass, true, "the connection bypasses RLS, so the policies are not what confines the read");
    assert.equal(rows[0]!.visible, 3, "and it can see both organisations' rows");
  });

  it("reads each organisation's own baseline when a client id is in both", async () => {
    assert.equal((await benchmark(A, "shared"))?.year, 2021);
    assert.equal((await benchmark(A, "shared"))?.totalTco2e, 100);
    assert.equal((await benchmark(B, "shared"))?.year, 2023);
    assert.equal((await benchmark(B, "shared"))?.totalTco2e, 300);
  });

  it("never reads another organisation's client: a client id only in B has no benchmark in A", async () => {
    assert.equal(await benchmark(A, "only-b"), null);
    assert.equal((await benchmark(B, "only-b"))?.year, 2022);
  });

  it("with no tenant context it reads nothing, rather than any organisation's row", async () => {
    const db = await database.admin();
    try { assert.equal(await getBenchmarkInForce(db, "only-b"), null); } finally { await db.end(); }
  });
});
