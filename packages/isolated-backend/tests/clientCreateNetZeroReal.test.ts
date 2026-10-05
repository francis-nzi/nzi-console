import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { CommandValidationError, createClient } from "../src/postgresCommands";

/**
 * NET-ZERO follow-ups, Part A (Francis, off #403 flag #1): client.create defaults the net-zero pair to 90% by 2050 when
 * the caller omits **both** fields — omitted-only, create-only; a supplied target is kept as sent; half a pair is refused.
 */
describe("client.create's net-zero default, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "nz-create-org";
  let database: DisposableDatabase;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `nzc-${keys}`, correlationId: `corr-nzc-${keys}`, grant: commandGrantForRole("admin", ORG, "ada") };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const base = (name: string) => ({ name, status: "onboarding" as const, sector: "Manufacturing", location: "Leeds", owner: "Ada" });
  const pairOf = async (clientId: string) => {
    const [row] = await q(`SELECT net_zero_target_year AS year, net_zero_target_reduction_pct::float8 AS pct FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [ORG, clientId]);
    return [row.year, row.pct];
  };
  const refusedOn = (field: string) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((item) => item.field === field && item.code === "PAIRED");

  before(async () => {
    database = (await createDisposableDatabase("clientcreatenetzero"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, 'ada', 'admin', 'active')`, [ORG]);
  });
  after(async () => { await database?.end(); });

  it("defaults a client created with no net-zero target to 2050 / 90 — the wizard's pair", async () => {
    const created = await createClient(database.pool, base("No Target Ltd") as never, context());
    assert.deepEqual(await pairOf(created.data.clientId), [2050, 90]);
  });

  it("keeps a supplied target as sent — a more ambitious one, and a deliberately cleared one", async () => {
    const ambitious = await createClient(database.pool, { ...base("Ambitious Ltd"), netZeroTargetYear: 2040, netZeroTargetReductionPct: 100 } as never, context());
    assert.deepEqual(await pairOf(ambitious.data.clientId), [2040, 100]);
    const cleared = await createClient(database.pool, { ...base("Cleared Ltd"), netZeroTargetYear: null, netZeroTargetReductionPct: null } as never, context());
    assert.deepEqual(await pairOf(cleared.data.clientId), [null, null], "null is a value sent, not an omission");
  });

  it("still refuses half a pair, either way round — the default never completes one", async () => {
    await assert.rejects(createClient(database.pool, { ...base("Year Only Ltd"), netZeroTargetYear: 2045 } as never, context()), refusedOn("netZeroTargetReductionPct"));
    await assert.rejects(createClient(database.pool, { ...base("Pct Only Ltd"), netZeroTargetReductionPct: 95 } as never, context()), refusedOn("netZeroTargetYear"));
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.clients WHERE organisation_id = $1 AND name IN ('Year Only Ltd', 'Pct Only Ltd')`, [ORG]))[0].n, 0);
  });
});
