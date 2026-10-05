import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { loadNetZeroFill, NET_ZERO_REASON } from "../src/netZeroTargetBackfill";

/**
 * The net-zero target fill (NET-ZERO follow-ups, Part B) against a real database: through client.targets.set; the year
 * from the client record where set, else 2050; 90%; fill-blank-only — a held target is never replaced; other targets
 * carried forward; not-active and baseline-less clients left out by class; a refusal isolated and reported; a dry run
 * writes nothing; a re-run fills nothing more.
 */
describe("fill:net-zero-targets, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international";
  let database: DisposableDatabase;
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const latest = async (clientId: string) => (await q(
    `SELECT version, net_zero_year, net_zero_pct::float8 AS net_zero_pct, near_term_year, near_term_pct::float8 AS near_term_pct, scope1_year, scope1_pct::float8 AS scope1_pct,
            benchmark_year, reason, set_by FROM nzi_console.client_targets WHERE organisation_id = $1 AND client_id = $2 ORDER BY version DESC LIMIT 1`, [ORG, clientId]))[0];

  before(async () => {
    database = (await createDisposableDatabase("netzerofill"))!;
    const client = (id: string, name: string, opts: { status?: string; baseline?: boolean; recordYear?: number | null } = {}) => q(
      `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, location, owner_name, website, baseline_period_start, baseline_period_end, baseline_total_tco2e, net_zero_target_year)
       VALUES ($1, $2, $3, $4, NULL, NULL, NULL, $5, $6, $7, $8)`,
      [ORG, id, name, opts.status ?? "active", opts.baseline === false ? null : "2021-01-01", opts.baseline === false ? null : "2021-12-31", opts.baseline === false ? null : 100, opts.recordYear ?? null]);
    const targets = (clientId: string, values: { nearTerm?: [number, number]; netZero?: [number, number]; scope1?: [number, number] }) => q(
      `INSERT INTO nzi_console.client_targets (organisation_id, client_id, version, near_term_year, near_term_pct, net_zero_year, net_zero_pct, scope1_year, scope1_pct,
         benchmark_year, benchmark_total_tco2e, benchmark_source, set_by, correlation_id)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, 2021, 100, 'client-record', 'fixture', 'fixture')`,
      [ORG, clientId, values.nearTerm?.[0] ?? null, values.nearTerm?.[1] ?? null, values.netZero?.[0] ?? null, values.netZero?.[1] ?? null, values.scope1?.[0] ?? null, values.scope1?.[1] ?? null]);
    // Refused by validation: net zero must come after the held near-term year.
    await client("afternear", "After Near Term Ltd");
    await targets("afternear", { nearTerm: [2055, 60] });
    // A database error mid-client (an injected fault), ahead of others in the run: the transaction must recover.
    await client("dbfail", "Database Fault Ltd");
    // Outside nzi_console: a test's own fault, not a schema object.
    await q(`CREATE FUNCTION public.netzero_fill_test_fault() RETURNS trigger LANGUAGE plpgsql AS $f$
             BEGIN IF NEW.client_id = 'dbfail' THEN RAISE EXCEPTION 'injected fault'; END IF; RETURN NEW; END $f$`);
    await q(`CREATE TRIGGER test_fault BEFORE INSERT ON nzi_console.client_targets FOR EACH ROW EXECUTE FUNCTION public.netzero_fill_test_fault()`);
    await client("fresh", "Fresh Ltd");
    await client("early", "Early Commitment Ltd", { recordYear: 2040 });
    await client("carry", "Carry Forward Ltd");
    await targets("carry", { nearTerm: [2030, 42], scope1: [2030, 50] });
    await client("held", "Held Target Ltd", { recordYear: 2040 });
    await targets("held", { netZero: [2045, 95] });
    await client("nobase", "No Baseline Ltd", { baseline: false });
    await client("onboard", "Onboarding Ltd", { status: "onboarding" });
    await client("past", "Past Year Ltd", { recordYear: 2020 });
  });
  after(async () => { await database?.end(); });

  it("a dry run plans every class and writes nothing", async () => {
    const outcome = await loadNetZeroFill(database.pool, ORG, { commit: false });
    assert.deepEqual(outcome.plan.fill.map((p) => [p.clientId, p.year, p.pct, p.yearSource, p.expectedVersion, p.carried]), [
      ["afternear", 2050, 90, "default 2050", 1, ["near_term"]], ["carry", 2050, 90, "default 2050", 1, ["near_term", "scope1"]],
      ["dbfail", 2050, 90, "default 2050", 0, []], ["early", 2040, 90, "client record", 0, []],
      ["fresh", 2050, 90, "default 2050", 0, []], ["past", 2020, 90, "client record", 0, []],
    ], "the record year where set, else 2050; always 90%");
    assert.equal(outcome.plan.held, 1, "a held net-zero target is never planned");
    assert.deepEqual(outcome.plan.notActive.map((n) => [n.clientId, n.status]), [["onboard", "onboarding"]]);
    assert.deepEqual(outcome.plan.noBaseline.map((n) => n.clientId), ["nobase"]);
    assert.match(outcome.results[2]!.refusal ?? "", /injected fault/, "a database error is reported, and the clients after it still save");
    assert.deepEqual(outcome.results.map((r) => [r.clientId, r.result, r.clientId === "dbfail" ? "fault" : r.refusal]), [
      ["afternear", "refused", "netZero.year ORDER"], ["carry", "written", null], ["dbfail", "refused", "fault"], ["early", "written", null], ["fresh", "written", null], ["past", "refused", "nearTerm.year AFTER_BENCHMARK"],
    ], "a refusal is isolated and reported; the rest would save");
    assert.ok(outcome.results.every((r) => r.postConditionMisses.length === 0));
    assert.equal(await latest("fresh"), undefined, "nothing written");
    assert.equal((await latest("carry")).version, 1);
  });

  it("commits through client.targets.set — the ruled pair, other targets carried forward, a held target untouched", async () => {
    const outcome = await loadNetZeroFill(database.pool, ORG, { commit: true });
    assert.deepEqual(outcome.results.map((r) => [r.clientId, r.result, r.version, r.postConditionMisses]), [
      ["afternear", "refused", null, []], ["carry", "written", 2, []], ["dbfail", "refused", null, []], ["early", "written", 1, []], ["fresh", "written", 1, []], ["past", "refused", null, []],
    ]);
    assert.deepEqual(await latest("fresh"), { version: 1, net_zero_year: 2050, net_zero_pct: 90, near_term_year: null, near_term_pct: null, scope1_year: null, scope1_pct: null,
      benchmark_year: 2021, reason: NET_ZERO_REASON, set_by: "policy:net-zero-minimum" });
    assert.equal((await latest("early")).net_zero_year, 2040, "the client record's earlier year is kept");
    assert.deepEqual(await latest("carry"), { version: 2, net_zero_year: 2050, net_zero_pct: 90, near_term_year: 2030, near_term_pct: 42, scope1_year: 2030, scope1_pct: 50,
      benchmark_year: 2021, reason: NET_ZERO_REASON, set_by: "policy:net-zero-minimum" }, "near-term and scope targets carried forward");
    assert.deepEqual([(await latest("held")).version, (await latest("held")).net_zero_year, Number((await latest("held")).net_zero_pct)], [1, 2045, 95], "a held target is never replaced");
    assert.equal(await latest("past"), undefined, "the refused client is untouched");
    assert.equal(await latest("nobase"), undefined);
    assert.equal(await latest("onboard"), undefined);
    const audits = await q(`SELECT entity_id, action, principal_type, reason FROM nzi_console.audit_events WHERE actor_id = 'policy:net-zero-minimum' ORDER BY entity_id`);
    assert.deepEqual(audits.map((a) => [a.entity_id, a.principal_type, a.reason]), [["carry", "system", NET_ZERO_REASON], ["early", "system", NET_ZERO_REASON], ["fresh", "system", NET_ZERO_REASON]]);
  });

  it("a re-run fills nothing more — only the refused client is planned again", async () => {
    const again = await loadNetZeroFill(database.pool, ORG, { commit: false });
    assert.deepEqual(again.plan.fill.map((p) => p.clientId), ["afternear", "dbfail", "past"]);
    assert.equal(again.plan.held, 4);
  });
});
