import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createClient } from "../src/postgresCommands";
import { deactivateClientIntensityTarget, listClientIntensityTargets, setClientIntensityTarget } from "../src/clientIntensityTargets";
import { getClientWorkspace } from "../src/readModels";
import { withTenantRead } from "../src/postgres";

/**
 * Redesign Phase 1b (0158) against a real database: a client's intensity target per metric — set on an active metric
 * only, versioned and append-only, the baseline guarded (moving it needs a reason), withdrawn with a reason and never
 * deleted, re-set after; the shape refused by the command and, independently, by the table; and the Client's read model.
 */
const ORG = "intensity-org";

describe("client intensity targets (0158), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (reason?: string, actor = "ada", role: StaffRole = "admin"): CommandContext => {
    counter += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `it-${counter}`, correlationId: `corr-it-${counter}`, grant: commandGrantForRole(role, ORG, actor), ...(reason ? { reason } : {}) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const refusedWith = (code: string) => (error: any) => error.issues?.some((issue: any) => issue.code === code);
  const list = () => withTenantRead(database.pool, ORG, (db) => listClientIntensityTargets(db, clientId));
  const target = (over: Record<string, unknown> = {}) => ({ clientId, metricKey: "employees", expectedVersion: 0, baselineYear: 2022, baselineIntensity: 4.5,
    interimYear: 2030, interimReductionPct: 42, targetYear: 2040, targetReductionPct: 90, ...over }) as never;
  let clientId = "";

  before(async () => {
    database = (await createDisposableDatabase("intensitytargets"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
    clientId = (await createClient(database.pool, { name: "Acme", status: "active", sector: "Manufacturing", location: "Leeds, UK", owner: "Ada Admin" } as never, context())).data.clientId;
    await q(`DELETE FROM nzi_console.client_intensity_metrics WHERE organisation_id = $1 AND client_id = $2`, [ORG, clientId]).catch(() => undefined);
    for (const [key, label, unit, active] of [["employees", "Employees", "employee", true], ["turnover", "Turnover", "£m turnover", true], ["retired", "Old metric", "unit", false]] as const) {
      await q(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, set_by, correlation_id)
               VALUES ($1, $2, $3, 1, $4, $5, 1, 'people', false, 'entered', $6, 1, 'seed', 'seed') ON CONFLICT DO NOTHING`, [ORG, clientId, key, label, unit, active]);
    }
  });
  after(async () => { await database?.end(); });

  it("sets a first target on an active metric, and the Client reads it with the metric's label and unit", async () => {
    const set = await setClientIntensityTarget(database.pool, target(), context());
    assert.deepEqual([set.data.version, set.data.active], [1, true]);
    assert.deepEqual((await list()).map((t) => [t.metricKey, t.metricLabel, t.unitWording, t.version, t.baselineIntensity, t.interimYear, t.targetReductionPct]),
      [["employees", "Employees", "employee", 1, 4.5, 2030, 90]]);
    const workspace = await withTenantRead(database.pool, ORG, (db) => getClientWorkspace(db, clientId));
    assert.equal(workspace!.intensityTargets.length, 1, "on the client workspace");
  });

  it("refuses a target on a metric that is not active, or not the client's", async () => {
    await assert.rejects(() => setClientIntensityTarget(database.pool, target({ metricKey: "retired" }), context()), refusedWith("METRIC_NOT_ACTIVE"));
    await assert.rejects(() => setClientIntensityTarget(database.pool, target({ metricKey: "nope" }), context()), refusedWith("METRIC_NOT_ACTIVE"));
  });

  it("refuses a malformed target in the command: half a pair, before the baseline, interim not before target, nothing set", async () => {
    const t = (over: Record<string, unknown>) => setClientIntensityTarget(database.pool, target({ metricKey: "turnover", ...over }), context());
    await assert.rejects(() => t({ interimReductionPct: null }), refusedWith("PAIR"));
    await assert.rejects(() => t({ interimYear: 2021 }), refusedWith("AFTER_BASELINE"));
    await assert.rejects(() => t({ interimYear: 2041 }), refusedWith("ORDER"));
    await assert.rejects(() => t({ interimYear: null, interimReductionPct: null, targetYear: null, targetReductionPct: null }), refusedWith("REQUIRED"));
  });

  it("an edit that keeps the baseline needs no reason; moving the baseline needs one, and records it", async () => {
    const kept = await setClientIntensityTarget(database.pool, target({ expectedVersion: 1, targetReductionPct: 95 }), context());
    assert.equal(kept.data.version, 2);
    await assert.rejects(() => setClientIntensityTarget(database.pool, target({ expectedVersion: 2, baselineIntensity: 5 }), context()), refusedWith("REASON_REQUIRED"));
    const moved = await setClientIntensityTarget(database.pool, target({ expectedVersion: 2, baselineIntensity: 5 }), context("restated after the 2022 headcount audit"));
    assert.equal(moved.data.version, 3);
    assert.equal((await q(`SELECT reason FROM nzi_console.client_intensity_targets WHERE client_id = $1 AND metric_key = 'employees' AND version = 3`, [clientId]))[0].reason, "restated after the 2022 headcount audit");
    await assert.rejects(() => setClientIntensityTarget(database.pool, target({ expectedVersion: 1 }), context()), /version|conflict/i);
  });

  it("withdraws only with a reason — kept, no longer in force — and can be set again", async () => {
    await assert.rejects(() => deactivateClientIntensityTarget(database.pool, { clientId, metricKey: "employees", expectedVersion: 3 }, context()), refusedWith("REQUIRED"));
    const off = await deactivateClientIntensityTarget(database.pool, { clientId, metricKey: "employees", expectedVersion: 3 }, context("metric no longer reported"));
    assert.deepEqual([off.data.version, off.data.active], [4, false]);
    assert.deepEqual(await list(), [], "a withdrawn target is not in force");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.client_intensity_targets WHERE client_id = $1`, [clientId]))[0].n, 4, "every version kept");
    await assert.rejects(() => deactivateClientIntensityTarget(database.pool, { clientId, metricKey: "employees", expectedVersion: 4 }, context("again")), refusedWith("ALREADY_INACTIVE"));
    const again = await setClientIntensityTarget(database.pool, target({ expectedVersion: 4 }), context());
    assert.equal(again.data.version, 5);
    assert.equal((await list()).length, 1);
  });

  it("two writers of the same next version: one wins, the other is told the record moved — never a raw error", async () => {
    const first = await setClientIntensityTarget(database.pool, target({ metricKey: "turnover", expectedVersion: 0 }), context());
    assert.equal(first.data.version, 1);
    // The loser of a race read the version before the winner committed. Reproduce that read deterministically: a pool
    // whose read of the latest version still sees none, so the insert meets the winner's v1 at the primary key.
    const stale = { connect: async () => {
      const client = await database.pool.connect();
      const query = client.query.bind(client);
      (client as any).query = (sql: unknown, values?: unknown) =>
        typeof sql === "string" && sql.startsWith("SELECT version, baseline_year") ? Promise.resolve({ rows: [] }) : query(sql as never, values as never);
      return client;
    } } as never;
    await assert.rejects(() => setClientIntensityTarget(stale, target({ metricKey: "turnover", expectedVersion: 0 }), context()),
      (error: any) => /version conflict/i.test(error.message) && error.code !== "23505");
  });

  it("the table holds the line on its own: append-only, and its CHECKs", async () => {
    const insert = (over: string) => q(`INSERT INTO nzi_console.client_intensity_targets (organisation_id, client_id, metric_key, version, baseline_year, baseline_intensity, interim_year, interim_reduction_pct, target_year, target_reduction_pct, active, reason, set_by, correlation_id)
      VALUES ($1, $2, 'turnover', 9, 2022, 1, ${over}, 'x', 'x')`, [ORG, clientId]);
    await assert.rejects(() => insert(`2030, NULL, NULL, NULL, true, NULL`), /client_intensity_targets_interim_pair/);
    await assert.rejects(() => insert(`2020, 10, NULL, NULL, true, NULL`), /client_intensity_targets_after_baseline/);
    await assert.rejects(() => insert(`2040, 50, 2030, 90, true, NULL`), /client_intensity_targets_interim_before_target/);
    await assert.rejects(() => insert(`2030, 50, NULL, NULL, false, NULL`), /client_intensity_targets_deactivation_reason/);
    const grants = await q(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'nzi_console' AND table_name = 'client_intensity_targets' AND grantee = 'nzi_console_app' ORDER BY 1`);
    assert.deepEqual(grants.map((g) => g.privilege_type), ["INSERT", "SELECT"], "append-only for the application");
  });
});
