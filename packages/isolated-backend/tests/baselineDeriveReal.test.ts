import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { chooseJob, consoleFyLabel, loadBaselineDerive, type Candidate } from "../src/baselineDerive";

/**
 * The job-derived baseline (BASELINE-derive-build-kickoff.md) against a real database: the ruled precedence (stated
 * period → earliest complete period → most complete); held and left-out clients; through client.update — an initial
 * baseline or the governed re-baseline — with the rule step and job as the reason; nothing else on the record changed;
 * a dry run writes nothing; a re-run derives nothing.
 */
describe("derive:baselines, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international";
  let database: DisposableDatabase;
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const baselineOf = async (clientId: string) => (await q(
    `SELECT baseline_period_start::text AS ps, baseline_period_end::text AS pe, baseline_scope1_tco2e::float8 AS s1, baseline_scope2_tco2e::float8 AS s2,
            baseline_scope3_tco2e::float8 AS s3, baseline_total_tco2e::float8 AS total FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [ORG, clientId]))[0];
  let sequence = 9300;
  const job = async (clientId: string, id: string, start: string | null, end: string | null, rows: Array<[string, number]>, status = "complete") => {
    sequence += 1;
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, source_system, legacy_db_id, reporting_period_start, reporting_period_end)
             VALUES ($1, $2, $3, $4, 'crp', 'CRP', $5, 'Report', 'nzi-pro-v7', $2, $6, $7)`, [ORG, id, clientId, sequence, status, start, end]);
    for (const [index, [scope, tco2e]] of rows.entries()) {
      await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id, scope_row_id, job_id, scope, source_label, report_label, level_1, level_2, calculated_tco2e)
               VALUES ($1, $2, $3, $4, 'x', 'x', 'x', 'x', $5)`, [ORG, `${id}-r${index}`, id, scope, tco2e]);
    }
  };

  before(async () => {
    database = (await createDisposableDatabase("baselinederive"))!;
    const client = (id: string, name: string, stated: [string, string] | null = null, inForce = false) => q(
      `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, location, owner_name, website, baseline_period_start, baseline_period_end, baseline_total_tco2e)
       VALUES ($1, $2, $3, 'active', NULL, NULL, NULL, $4, $5, $6)`, [ORG, id, name, stated?.[0] ?? null, stated?.[1] ?? null, inForce ? 500 : null]);
    await client("only", "Only Job Ltd");
    await job("only", "j-only", "2021-04-01", "2022-03-31", [["1", 10], ["3.1", 20.5], ["2", 99], ["3.6", 1]]);
    // A disabled row never counts; an override replaces the calculated figure.
    await q(`UPDATE nzi_console.job_scope_rows SET enabled = false WHERE scope_row_id = 'j-only-r2'`);
    await q(`UPDATE nzi_console.job_scope_rows SET override_tco2e = 4, override_reason = 'restated' WHERE scope_row_id = 'j-only-r3'`);
    await client("stated", "Stated Period Ltd", ["2022-01-01", "2022-12-31"]);
    await job("stated", "j-st-a", "2021-01-01", "2021-12-31", [["1", 8], ["2", 1], ["3.6", 2]]);
    await job("stated", "j-st-b", "2022-01-01", "2022-12-31", [["1", 9]]);
    await client("earliest", "Earliest Ltd");
    await job("earliest", "j-ea-a", "2021-04-01", "2022-03-31", [["1", 6], ["2", 3], ["3.1", 1]]);
    await job("earliest", "j-ea-b", "2020-04-01", "2021-03-31", [["1", 5]]);
    await client("tie", "Same Period Ltd");
    await job("tie", "j-ti-a", "2022-01-01", "2022-12-31", [["1", 4]]);
    await job("tie", "j-ti-b", "2022-01-01", "2022-12-31", [["1", 4], ["2", 2]]);
    await client("held", "Held Stated Ltd", ["2019-01-01", "2019-12-31"]);
    await job("held", "j-held", "2021-01-01", "2021-12-31", [["1", 3]]);
    await client("zero", "All Zero Ltd");
    await job("zero", "j-zero", "2021-01-01", "2021-12-31", [["1", 0]]);
    await client("inforce", "Already Baselined Ltd", ["2020-01-01", "2020-12-31"], true);
    await job("inforce", "j-inforce", "2021-01-01", "2021-12-31", [["1", 7]]);
    await client("cancelled", "Cancelled Only Ltd");
    await job("cancelled", "j-cancelled", "2021-01-01", "2021-12-31", [["1", 7]], "cancelled");
  });
  after(async () => { await database?.end(); });

  it("chooses by the ruled precedence (pure)", () => {
    const c = (jobNumber: string, start: string | null, scopes: [number | null, number | null, number | null]): Candidate =>
      ({ jobId: jobNumber, jobNumber, periodStart: start, periodEnd: start ? `${start.slice(0, 4)}-12-31` : null, scope1: scopes[0], scope2: scopes[1], scope3: scopes[2], total: 1 });
    const a = c("J1", "2021-01-01", [1, null, null]), b = c("J2", "2022-01-01", [1, 1, 1]), d = c("J3", "2021-01-01", [1, 1, null]);
    assert.deepEqual(chooseJob([a, b], "2022-01-01"), { job: b, step: "stated benchmark period" }, "the stated period wins over the earliest");
    assert.deepEqual(chooseJob([a, b], null), { job: a, step: "earliest complete period" });
    assert.deepEqual(chooseJob([a, d, b], null), { job: d, step: "most complete" }, "an earliest-period tie goes to the more complete");
    assert.deepEqual(chooseJob([a, b], "2019-01-01"), { held: true }, "a stated period no candidate matches is held");
    assert.equal(consoleFyLabel("2021-04-01"), "FY21");
  });

  it("a dry run plans every class and writes nothing", async () => {
    const outcome = await loadBaselineDerive(database.pool, ORG, { commit: false });
    assert.deepEqual(outcome.plan.derive.map((p) => [p.clientId, p.job.jobId, p.ruleStep]).sort(), [
      ["earliest", "j-ea-b", "earliest complete period"], ["only", "j-only", "only candidate"], ["stated", "j-st-b", "stated benchmark period"], ["tie", "j-ti-b", "most complete"],
    ]);
    assert.deepEqual(outcome.plan.held.map((h) => [h.clientId, h.clientName]), [["held", "Held Stated Ltd"]]);
    assert.deepEqual(outcome.plan.noUsableTotal.map((n) => n.clientId), ["zero"]);
    assert.ok(!outcome.plan.derive.some((p) => ["inforce", "cancelled"].includes(p.clientId)), "a baseline in force, or only a cancelled job, is not a candidate");
    assert.deepEqual(outcome.results.map((r) => r.result), ["written", "written", "written", "written"], "every planned client would save");
    assert.deepEqual(await baselineOf("only"), { ps: null, pe: null, s1: null, s2: null, s3: null, total: null }, "nothing written");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE actor_id = 'policy:job-derived-baseline'`))[0].n, 0);
  });

  it("commits each baseline through client.update — initial or governed — with the rule step and job as the reason, and nothing else changed", async () => {
    const outcome = await loadBaselineDerive(database.pool, ORG, { commit: true });
    assert.deepEqual(outcome.results.map((r) => [r.clientId, r.result, r.governed, r.otherChanges]).sort(), [
      ["earliest", "written", false, []], ["only", "written", false, []], ["stated", "written", true, []], ["tie", "written", false, []],
    ], "nothing besides the baseline changes");
    assert.deepEqual(outcome.results[0]!.emptyNormalised, ["contact_email", "contact_name", "contact_role"],
      "client.update's NULL → \"\" on the legacy contact columns is reported apart, not hidden");
    assert.deepEqual(await baselineOf("only"), { ps: "2021-04-01", pe: "2022-03-31", s1: 10, s2: null, s3: 24.5, total: 34.5 },
      "enabled rows only, the override over the calculated figure; a scope with no enabled rows stays unset, never 0");
    assert.deepEqual(await baselineOf("stated"), { ps: "2022-01-01", pe: "2022-12-31", s1: 9, s2: null, s3: null, total: 9 });
    assert.deepEqual(await baselineOf("earliest"), { ps: "2020-04-01", pe: "2021-03-31", s1: 5, s2: null, s3: null, total: 5 });
    assert.deepEqual((await baselineOf("tie")).total, 6);
    const audits = await q(`SELECT entity_id, action, reason, principal_type FROM nzi_console.audit_events WHERE actor_id = 'policy:job-derived-baseline' ORDER BY entity_id, action`);
    assert.deepEqual(audits.map((a) => [a.entity_id, a.action, a.principal_type]), [
      ["earliest", "client_updated", "system"], ["only", "client_updated", "system"], ["stated", "client_rebaselined", "system"], ["stated", "client_updated", "system"], ["tie", "client_updated", "system"],
    ], "the governed re-baseline adds its own event where a baseline field was held");
    assert.equal(audits.find((a) => a.entity_id === "stated")!.reason, "policy: job-derived baseline, stated benchmark period (job J009303, id j-st-b)",
      "the reason carries the provenance: rule step, job number and job id");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.baseline_change_events WHERE client_id = 'stated' AND reason LIKE 'policy: job-derived baseline%'`))[0].n, 1);
    assert.deepEqual(await baselineOf("held"), { ps: "2019-01-01", pe: "2019-12-31", s1: null, s2: null, s3: null, total: null }, "the held client is untouched");
    assert.equal((await baselineOf("inforce")).total, 500, "a baseline in force is never touched");
  });

  it("a re-run derives nothing — the derived clients now have a baseline in force", async () => {
    const again = await loadBaselineDerive(database.pool, ORG, { commit: false });
    assert.deepEqual([again.plan.derive.length, again.plan.held.length, again.plan.noUsableTotal.length], [0, 1, 1]);
  });
});
