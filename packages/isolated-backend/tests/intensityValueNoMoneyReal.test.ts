import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { figuresIn } from "./support/payloadScan";
import { setJobIntensityValue } from "../src/intensityMetrics";

/**
 * NZC-120's live leak, fixed (Phase 3c, ruled #13): a job's intensity Value can be money — the turnover a per-£m intensity
 * divides by — so `job.intensityValue.set` says only whether a Value is recorded, before and after, the job.fee.set way.
 * No figure reaches the audit's after_json or before_json, the idempotency record, or the outbox event — on the first
 * record, on a correction (the case that leaked: the previous turnover went into before_json), or on clearing it; and for
 * a `text` turnover metric as much as a `currency` one. The figure itself is kept in its column.
 */
const ORG = "iv-org";
const CLIENT = "iv-client";
const JOB = "iv-job";
// Values chosen so no version number, year or count in a payload can equal one by chance.
const FIRST = 12_500_000.25;
const CORRECTED = 13_750_000.75;
const HEADCOUNT = 431.5;
const MONEY = [FIRST, CORRECTED, HEADCOUNT, 12.5, 13.75];

describe("an intensity Value never reaches a payload (NZC-120, ruled #13), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: "ada-iv", principal: "staff", idempotencyKey: `iv-${keys}`, correlationId: `corr-iv-${keys}`, grant: commandGrantForRole("admin", ORG, "ada-iv") };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  /** The four places a command writes: the audit's after_json and before_json, the idempotency outcome, the outbox event. */
  const payloadsOf = async (auditEventId: string) => {
    const [audit] = await q(`SELECT after_json, before_json, correlation_id FROM nzi_console.audit_events WHERE audit_event_id = $1`, [auditEventId]);
    const idempotency = await q(`SELECT outcome_json FROM nzi_console.command_idempotency WHERE organisation_id = $1 AND outcome_json->>'auditEventId' = $2`, [ORG, auditEventId]);
    const outbox = await q(`SELECT payload_json FROM nzi_console.transactional_outbox WHERE organisation_id = $1 AND correlation_id = $2`, [ORG, audit.correlation_id]);
    assert.deepEqual([idempotency.length, outbox.length], [1, 1], "the idempotency record and the outbox event were both found");
    return { after: audit.after_json, before: audit.before_json, idempotency: idempotency[0].outcome_json.data, outbox: outbox[0].payload_json };
  };
  const assertNoMoney = async (auditEventId: string) => {
    const payloads = await payloadsOf(auditEventId);
    for (const [where, value] of Object.entries(payloads)) assert.deepEqual(figuresIn(value, MONEY), [], `a Value reached the ${where}`);
    return payloads;
  };
  const stored = async (metricKey: string) => (await q(`SELECT value::float8 AS value, version FROM nzi_console.job_intensity_values WHERE job_id = $1 AND metric_key = $2`, [JOB, metricKey]))[0];
  const set = (metricKey: string, value: number | null, expectedVersion: number) =>
    setJobIntensityValue(database.pool, { jobId: JOB, reportingYear: 2026, metricKey, value, expectedVersion }, context());

  before(async () => {
    database = (await createDisposableDatabase("intensityvalue"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada-iv', 'admin', 'active', 'Ada')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Co', 'active')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
             VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB, CLIENT]);
    // Turnover as 0071 seeded it — a `text` metric worded "£m" — beside a currency one and a headcount.
    await q(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, unit_kind, set_by, correlation_id) VALUES
             ($1, $2, 'turnover', 1, 'Turnover', '£m', 1000000, 'currency', true, 'text', 's', 's'),
             ($1, $2, 'revenue', 1, 'Revenue', 'GBP', 1000000, 'currency', false, 'currency', 's', 's'),
             ($1, $2, 'employees', 1, 'Employees', 'employee', 1, 'people', true, 'text', 's', 's')`, [ORG, CLIENT]);
  });
  after(async () => { await database?.end(); });

  it("records a turnover Value and says only that one is recorded", async () => {
    const done = await set("turnover", FIRST, 0);
    assert.equal(done.data.valueRecorded, true);
    const payloads = await assertNoMoney(done.auditEventId);
    assert.deepEqual(payloads.before, { valueRecorded: false });
    assert.equal((await stored("turnover")).value, FIRST, "the figure is kept in its column");
  });

  it("corrects it — the case that leaked the previous turnover into before_json — and still no figure anywhere", async () => {
    const done = await set("turnover", CORRECTED, 1);
    const payloads = await assertNoMoney(done.auditEventId);
    assert.deepEqual(payloads.before, { valueRecorded: true });
    assert.deepEqual(Object.keys(payloads.after).sort(), ["jobId", "metricKey", "reportingYear", "valueRecorded", "version"]);
    assert.equal((await stored("turnover")).value, CORRECTED);
  });

  it("clears it, and says so without a figure", async () => {
    const done = await set("turnover", null, 2);
    assert.equal(done.data.valueRecorded, false);
    assert.deepEqual((await assertNoMoney(done.auditEventId)).before, { valueRecorded: true });
  });

  it("holds for a currency metric and for a non-money one alike — every metric, not just currency", async () => {
    for (const [metric, value] of [["revenue", FIRST], ["employees", HEADCOUNT]] as const) {
      await assertNoMoney((await set(metric, value, 0)).auditEventId);
      await assertNoMoney((await set(metric, value + 1, 1)).auditEventId);
    }
  });
});
