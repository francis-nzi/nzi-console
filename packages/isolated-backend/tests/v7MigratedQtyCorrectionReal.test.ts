import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { correctStaleMigratedQty, MIGRATED_IMMUTABLE_TRIGGER, QTY_CORRECTION_ACTION, V7_STALE_QTY_ROWS } from "../src/v7MigratedQtyCorrection";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * RULING 29 Oct 2026 — the stale migrated quantities, corrected through 0133's sanctioned bypass, against a real database:
 *   - a dry run is the whole correction, rolled back: no row, no audit event, the trigger still on;
 *   - a commit sets `migrated_record.qty` to the months' sum, keeps every other key, re-enables the trigger, and audits by id
 *     with no figures in the event;
 *   - it refuses (and writes nothing) when a ruled job has a completed run, when the scan finds an enabled stale row that is
 *     not ruled, or when a ruled row is not stale; a disabled or within-rounding difference is reported, never touched;
 *   - the shipped ruled set names the 11 rows on the 7 jobs.
 */
const ORG = "v7-qty-correction";
const ACTOR = "francis";
const CROSSWALK_SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
const months = (values: number[]) => values.map((value) => value);
type Row = { id: string; job: string; qty: number; months: number[]; enabled?: boolean };
const ROWS: Row[] = [
  { id: "a1", job: "job-a", qty: 1186404, months: [1315, 1303, 2479, 1775, 2729, 2056, 2283, 3435, 1336, 1515, 1952, 1243] },
  { id: "a2", job: "job-a", qty: 3000, months: [550, 500, 225, 125, 150, 50, 75, 150, 325, 325] },
  { id: "b1", job: "job-b", qty: 0, months: [100, 100, 100] },
  { id: "ok", job: "job-b", qty: 300, months: [100, 100, 100] },
  { id: "rounding", job: "job-b", qty: 9.9996, months: [10] },
  { id: "disabled", job: "job-b", qty: 59213, months: [79056], enabled: false },
];
const RULED = [{ jobId: "job-a", rowIds: ["a1", "a2"] }, { jobId: "job-b", rowIds: ["b1"] }];

describe("the stale migrated quantities are corrected through the sanctioned immutability bypass", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);
  const record = async (id: string) => (await db.query(`SELECT migrated_record AS r FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [id])).rows[0]!.r as Record<string, unknown>;
  const triggerOn = async () => (await db.query(`SELECT tgenabled::text AS t FROM pg_trigger WHERE tgrelid='nzi_console.job_scope_rows'::regclass AND tgname=$1`, [MIGRATED_IMMUTABLE_TRIGGER])).rows[0]!.t === "O";
  const audits = () => count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE organisation_id=$1 AND action=$2`, [ORG, QTY_CORRECTION_ACTION]);
  const run = (input: Partial<Parameters<typeof correctStaleMigratedQty>[1]> = {}) =>
    correctStaleMigratedQty(database.pool, { organisationId: ORG, actorId: ACTOR, commit: false, rows: RULED, ...input });
  const refused = async (input: Partial<Parameters<typeof correctStaleMigratedQty>[1]>, code: string) => {
    await assert.rejects(run(input), (error) => { assert.match(String(error), new RegExp(`^Error: ${code}:`)); return true; });
    assert.equal(await triggerOn(), true, "a refusal rolls the trigger bypass back");
    assert.equal(await audits(), 0, "and writes no audit event");
    assert.equal((await record("a1")).qty, 1186404, "and changes no row");
  };

  before(async () => {
    database = (await createDisposableDatabase("v7qty"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Qty Test','active')`, [ORG]);
    for (const [index, job] of ["job-a", "job-b"].entries())
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id)
        VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$4)`, [ORG, job, index + 1, String(index + 1)]);
    for (const row of ROWS) {
      const rec = { qty: row.qty, uom: "kWh", factor: 0.2, ghg_unit: "kgCO2e", original_id: "7_x", reported_tco2e: 0.5, data_source: "Company Data", data_confidence: null,
        enabled: row.enabled ?? true, apply_pct: 100, stored_calc_tco2e: 0.5, override_tco2e: null, review_status: null, months: months(row.months) };
      await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,level_3,quantity,unit,
          calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id,is_auto_generated)
        VALUES ($1,$2,$3,'1','Gas','Gas','v7 level 1','v7 level 2','v7 level 3',$4,'kWh',0.5,'pending',$5,'migrated',$6::jsonb,'nzi-pro-v7',$2,false)`,
        [ORG, row.id, row.job, row.months.reduce((a, b) => a + b, 0), row.enabled ?? true, JSON.stringify(rec)]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("a dry run is the whole correction, rolled back: nothing written, the trigger still on", async () => {
    const report = await run();
    assert.deepEqual([report.committed, report.corrected, report.jobs, report.rows, report.auditEvents, report.triggerEnabledAfter], [false, 3, 2, 3, 3, true]);
    assert.deepEqual([(await record("a1")).qty, (await record("a2")).qty, (await record("b1")).qty], [1186404, 3000, 0]);
    assert.equal(await audits(), 0);
    assert.equal(await triggerOn(), true);
  });

  it("refuses a ruled row that is not stale, and an enabled stale row that is not ruled", async () => {
    await refused({ rows: [{ jobId: "job-b", rowIds: ["b1", "ok"] }, { jobId: "job-a", rowIds: ["a1", "a2"] }] }, "SET_MISMATCH");
    await refused({ rows: [{ jobId: "job-a", rowIds: ["a1"] }, { jobId: "job-b", rowIds: ["b1"] }] }, "SET_MISMATCH"); // a2 is stale and unlisted
  });

  it("refuses when a ruled job has a completed re-ingest run", async () => {
    const runId = `v7-reingest-${randomUUID()}`;
    await db.query(`INSERT INTO nzi_console.v7_reingest_runs (organisation_id,run_id,job_id,crosswalk_version,crosswalk_sha256,status,v7_total_tco2e,native_total_tco2e,scope_totals_json,rows_by_disposition_json,created_by,correlation_id)
      VALUES ($1,$2,'job-b','v1',$3,'completed',1,1,'{}','{}','policy:v7-reingest','c')`, [ORG, runId, CROSSWALK_SHA]);
    await refused({}, "COMPLETED_RUN");
    await db.query(`UPDATE nzi_console.v7_reingest_runs SET status='reverted',reverted_by='x',reverted_at=now(),revert_reason='test' WHERE run_id=$1`, [runId]);
  });

  it("commits: qty = the months' sum, every other key kept, trigger back on, one audit event per row with no figures", async () => {
    const before = await Promise.all(["a1", "a2", "b1"].map(record));
    const report = await run({ commit: true });
    assert.deepEqual([report.committed, report.corrected, report.triggerEnabledAfter], [true, 3, true]);
    assert.deepEqual(report.withinRounding, ["rounding@job-b"], "a within-rounding difference is reported, not touched");
    assert.deepEqual(report.disabledMismatches, ["disabled@job-b"], "a disabled row's difference is reported, not touched");
    const sums: Record<string, number> = { a1: 23421, a2: 2475, b1: 300 };
    for (const [index, id] of ["a1", "a2", "b1"].entries()) {
      const now = await record(id);
      assert.equal(Number(now.qty), sums[id]);
      const { qty: _was, ...keptBefore } = before[index]!; const { qty: _is, ...keptNow } = now;
      assert.deepEqual(keptNow, keptBefore, `${id}: only qty moved`);
    }
    assert.deepEqual([(await record("rounding")).qty, (await record("disabled")).qty, (await record("ok")).qty], [9.9996, 59213, 300]);
    assert.equal(await triggerOn(), true);
    await assert.rejects(db.query(`UPDATE nzi_console.job_scope_rows SET migrated_record = jsonb_set(migrated_record,'{qty}','1') WHERE scope_row_id='a1'`), /migrated|immutable|only/i, "the bypass is closed again");
    assert.equal(await audits(), 3);
    const events = (await db.query(`SELECT entity_id, actor_id, before_json::text AS b, after_json::text AS a, reason FROM nzi_console.audit_events WHERE organisation_id=$1 AND action=$2`, [ORG, QTY_CORRECTION_ACTION])).rows;
    assert.deepEqual(events.map((event) => event.entity_id).sort(), ["a1", "a2", "b1"]);
    assert.ok(events.every((event) => event.actor_id === ACTOR));
    assert.ok(events.every((event) => !/\d{3,}/.test(`${event.b} ${event.a}`.replace(/job-[a-z]/g, ""))), "no figures in the event");
  });

  it("is a no-op the second time: the ruled rows are no longer stale, so it refuses", async () => {
    await assert.rejects(run({ commit: true }), /^Error: SET_MISMATCH:/);
    assert.equal(await audits(), 3);
  });

  it("the shipped ruled set is the 11 rows on the 7 jobs", () => {
    assert.equal(V7_STALE_QTY_ROWS.length, 7);
    assert.deepEqual(V7_STALE_QTY_ROWS.flatMap((entry) => entry.rowIds).sort(),
      ["v7-row-1063", "v7-row-1066", "v7-row-3617", "v7-row-3618", "v7-row-3619", "v7-row-3621", "v7-row-5969", "v7-row-1083", "v7-row-1358", "v7-row-1359", "v7-row-1628"].sort());
  });
});
