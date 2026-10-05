import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { figuresIn, plaintextIn } from "./support/payloadScan";
import { syntheticRows } from "./support/v7SyntheticExtract";
import { sealMembershipRow } from "../src/piiWriteThrough";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { withTenantWrite } from "../src/postgres";
import { loadV7Time, planV7Time, type TimeOutcome } from "../src/v7TimeLoad";

/**
 * load:v7-time (⚑7) against a real database, from the synthetic extract (invented rows only): v7's subjects into
 * activity_types with billable defaults; entries mapped by the address digest, the job import's identity and the
 * subject's label; minutes 1:1; the rate in force on the day or null — never a later rate; every not-imported class
 * counted; idempotent re-runs; a v7 change reported, not re-applied; no address, name or figure in the outcome or audit.
 */
describe("load:v7-time, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international";
  const TODAY = "2026-10-05";
  const RATE = { cost: 41.5, sell: 97.25 };
  let database: DisposableDatabase;
  const keys = resolveSealingKeys();
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const extract = (change?: (rows: ReturnType<typeof syntheticRows>) => void) => { const rows = syntheticRows(); change?.(rows); return { time_subjects: rows.time_subjects, time_logs: rows.time_logs }; };
  const run = (options: { commit: boolean }, change?: (rows: ReturnType<typeof syntheticRows>) => void) => loadV7Time(database.pool, ORG, planV7Time(extract(change), TODAY), { ...options, keys });
  /** The report as the CLI prints it — everything but the operator-only addresses. */
  const reportOf = ({ addressesForOperator: _a, ...report }: TimeOutcome) => report;
  const entries = () => q(
    `SELECT t.legacy_db_id, t.user_id, t.job_id, t.work_date::text AS work_date, t.minutes, v.label AS activity, t.billable, t.note, t.rate_id,
            t.cost_rate::float8 AS cost_rate, t.charge_rate::float8 AS charge_rate, t.rate_currency, t.billed_ref, t.source_system, t.legacy_values, t.active
       FROM nzi_console.time_entries t JOIN nzi_console.reference_values v ON (v.organisation_id, v.value_id) = (t.organisation_id, t.activity_value_id)
      WHERE t.organisation_id = $1 ORDER BY t.legacy_db_id`, [ORG]);

  before(async () => {
    // The organisation exists in every fresh database, with 0155's six activities already seeded for it.
    database = (await createDisposableDatabase("v7timeload"))!;
    // Ada is sealed (matched by the address digest); Ben and Cara are matched by the plaintext beside it.
    for (const [user, email] of [["ada.example", null], ["ben.example", "ben@example.test"], ["cara.example", "cara@example.test"]] as const) {
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, email) VALUES ($1, $2, 'consultant', 'active', $3)`, [ORG, user, email]);
    }
    await withTenantWrite(database.pool, ORG, (db) => sealMembershipRow({ db, organisationId: ORG, actorId: "t", keys }, { userId: "ada.example", displayName: "Ada Example", email: "ada@example.test" }));
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'v7-client-1', 'Synthetic Alpha Ltd', 'active')`, [ORG]);
    for (const [legacy, sequence] of [["100", 612], ["101", 613]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, source_system, legacy_db_id)
               VALUES ($1, $2, 'v7-client-1', $3, 'crp', 'Synthetic', 'open', 'Setup', 'nzi-pro-v7', $4)`, [ORG, `v7-job-${legacy}`, sequence, legacy]);
    }
    // Ada has a rate from 2024; Cara's only rate starts after her one entry — so it must not be used.
    await q(`INSERT INTO nzi_console.staff_rates (organisation_id, rate_id, user_id, effective_from, cost_per_hour, sell_per_hour, currency, recorded_by) VALUES
      ($1, 'rate-ada', 'ada.example', '2024-01-01', $2, $3, 'GBP', 'seed'), ($1, 'rate-cara', 'cara.example', '2025-07-01', 50, 120, 'GBP', 'seed')`, [ORG, RATE.cost, RATE.sell]);
  });
  after(async () => { await database?.end(); });

  it("plans from the extract alone: minutes 1:1, and the rows it refuses — over 24 h skipped, never clamped", () => {
    const plan = planV7Time(extract(), TODAY);
    assert.deepEqual(plan.refused, { "over-24-hours": 1, "future-work-date": 1, "no-minutes": 1, "user-not-an-email": 1 });
    assert.deepEqual(plan.entries.map((entry) => [entry.legacyDbId, entry.minutes]), [["9001", 90], ["9002", 45], ["9003", 480], ["9004", 30], ["9005", 30], ["9006", 60], ["9009", 60], ["9012", 120]]);
    assert.ok(!plan.entries.some((entry) => entry.legacyDbId === "9007"), "the 1,500-minute row is left out, not cut to 1,440");
    assert.deepEqual(plan.subjects.categories[0]!.values.map((value) => value.label), ["Client Calls", "Client Data Collection", "Client Reporting", "Fieldwork"]);
  });

  it("a dry run reports the whole load and writes nothing", async () => {
    const outcome = await run({ commit: false });
    assert.deepEqual([outcome.inserted, outcome.subjects.inserted, outcome.subjects.stamped, outcome.subjects.defaultsCreated], [4, 3, 1, 3]);
    assert.deepEqual([(await q(`SELECT count(*)::int AS n FROM nzi_console.time_entries`))[0].n, (await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE action = 'time.entries.imported'`))[0].n], [0, 0]);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = 'activity_types'`, [ORG]))[0].n, 6, "still only the six seeded");
  });

  it("commits: the subjects as billable activities, then the mapped entries with the rate in force on the day or none", async () => {
    const outcome = await run({ commit: true });
    assert.deepEqual(reportOf(outcome).subjects.defaultsKept, [{ label: "Fieldwork", billableDefault: true }], "a default set here is kept, never overwritten");
    const defaults = await q(`SELECT v.label, d.billable_default FROM nzi_console.reference_values v JOIN nzi_console.time_activity_defaults d USING (organisation_id, value_id)
      WHERE v.organisation_id = $1 AND v.label LIKE 'Client%' ORDER BY v.label`, [ORG]);
    assert.deepEqual(defaults.map((row) => [row.label, row.billable_default]), [["Client Calls", true], ["Client Data Collection", true], ["Client Reporting", true]]);

    const rows = await entries();
    assert.deepEqual(rows.map((row) => [row.legacy_db_id, row.user_id, row.job_id, row.work_date, row.minutes, row.activity, row.billable, row.note]), [
      ["9001", "ada.example", "v7-job-100", "2024-01-08", 90, "Client Calls", true, "Kick-off call"],
      ["9002", "ada.example", "v7-job-100", "2024-01-08", 45, "Client Reporting", true, null],
      ["9003", "ben.example", "v7-job-101", "2024-02-01", 480, "Fieldwork", true, null],
      ["9012", "cara.example", "v7-job-101", "2025-06-02", 120, "Client Data Collection", true, null],
    ]);
    const byId = new Map(rows.map((row) => [row.legacy_db_id, row]));
    assert.deepEqual([byId.get("9001")!.rate_id, byId.get("9001")!.cost_rate, byId.get("9001")!.charge_rate, byId.get("9001")!.rate_currency], ["rate-ada", RATE.cost, RATE.sell, "GBP"]);
    for (const id of ["9003", "9012"]) {
      assert.deepEqual([byId.get(id)!.rate_id, byId.get(id)!.cost_rate, byId.get(id)!.charge_rate], [null, null, null], `${id}: rate not recorded — Cara's later rate is never used`);
    }
    assert.ok(rows.every((row) => row.source_system === "nzi-pro-v7" && row.billed_ref === null && row.active));
    assert.deepEqual(rows.flatMap((row) => plaintextIn(row.legacy_values, [/@/, /example/i])), [], "provenance carries no address");

    assert.deepEqual(reportOf(outcome).rates, { recorded: 2, notRecorded: 2 });
    assert.deepEqual([outcome.unmatchedUsers.length, outcome.unmatchedUsers[0]!.entries, outcome.jobNotImported, outcome.noSubject], [1, 1, 1, 1]);
    assert.deepEqual(outcome.unmatchedSubjects, [{ label: "Site Survey", entries: 1 }]);
    assert.deepEqual(outcome.parity, { plannedMinutes: 735, consoleMinutes: 735, consoleEntries: 4 });
  });

  it("names nobody and states no figure — in the report or the audit (NZC-120)", async () => {
    const outcome = await run({ commit: false });
    const report = reportOf(outcome);
    assert.deepEqual(plaintextIn(report, [/@/, /ada|ben|cara|nobody/i]), [], "no address or name in the report");
    assert.deepEqual(figuresIn(report, [RATE.cost, RATE.sell]), [], "no rate in the report");
    assert.equal(outcome.addressesForOperator[0]!.email, "nobody@example.test", "the address is held apart, for the operator's terminal only");
    const [audit] = await q(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'time.entries.imported'`, [ORG]);
    assert.deepEqual(plaintextIn(audit.after_json, [/@/, /ada|ben|cara|nobody/i]), []);
    assert.deepEqual(figuresIn(audit.after_json, [RATE.cost, RATE.sell]), []);
    assert.deepEqual([audit.after_json.inserted, audit.after_json.ratesRecorded, audit.after_json.ratesNotRecorded], [4, 2, 2]);
  });

  it("re-runs write nothing twice — and a change in v7 since is reported, not re-applied", async () => {
    const again = await run({ commit: true });
    assert.deepEqual([again.inserted, again.alreadyImported, again.changedInV7, again.subjects.unchanged, again.subjects.defaultsCreated], [0, 4, 0, 4, 0]);
    const changed = await run({ commit: true }, (rows) => { rows.time_logs.find((row) => row.time_id === "9001")!.minutes = "120"; });
    assert.deepEqual([changed.inserted, changed.alreadyImported, changed.changedInV7], [0, 4, 1]);
    assert.equal((await entries()).find((row) => row.legacy_db_id === "9001")!.minutes, 90, "the imported entry stands");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE action = 'time.entries.imported'`))[0].n, 1, "a run that writes nothing records nothing");
  });
});
