import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * The schema for the v7 client and job import (0132–0134; docs/CLIENT_JOB_IMPORT_DESIGN.md §4, §5.1):
 * provenance and its identity key; a migrated emissions row that is v7's figure, closed, and immutable except for
 * whether it is enabled; and a job-number counter that catches up to imported v7 numbers without ever running
 * ahead of them. Synthetic rows only.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "net-zero-international";
const V7 = "nzi-pro-v7";

const record = (over: Record<string, unknown> = {}) => ({
  qty: 1000, uom: "kWh", factor: 0.2, ghg_unit: "kgCO2e", original_id: "7_400_4000_5_1",
  reported_tco2e: 0.2, stored_calc_tco2e: 0.2, data_source: "Company Data", enabled: true, ...over,
});

describe("the v7 import's schema: provenance, migrated rows, job numbers (0132–0134)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let rows = 0;

  const scopeRow = (over: { id?: string; origin?: string; record?: unknown; sourceSystem?: string | null; legacyId?: string | null } = {}) => {
    rows += 1;
    const id = over.id ?? `row-${rows}`;
    return db.query(
      `INSERT INTO nzi_console.job_scope_rows
         (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,calculated_tco2e,origin,migrated_record,source_system,legacy_db_id)
       VALUES ($1,$2,'job-v7-612','2','Electricity','Electricity','Scope 2','Electricity',1000,'kWh',0.2,$3,$4::jsonb,$5,$6)`,
      [ORG, id, over.origin ?? "migrated", over.record === undefined ? JSON.stringify(record()) : over.record === null ? null : JSON.stringify(over.record),
        over.sourceSystem === undefined ? V7 : over.sourceSystem, over.legacyId === undefined ? `${rows}` : over.legacyId]).then(() => id);
  };
  const counter = async () => (await db.query<{ n: number }>(`SELECT last_sequence AS n FROM nzi_console.job_number_counter`)).rows[0]!.n;

  before(async () => {
    database = (await createDisposableDatabase("importschema"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,source_system,legacy_db_id) VALUES ($1,'client-v7-1','Synthetic Co','active',$2,'1')`, [ORG, V7]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,source_system,legacy_db_id,legacy_job_number)
       VALUES ($1,'job-v7-612','client-v7-1',612,'crp','CRP 2023','complete','Completed',2023,$2,'4012','J000612')`, [ORG, V7]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  // ── Provenance (0132) ──────────────────────────────────────────────────────────────────────────────────

  it("gives the six import tables source_system and legacy_db_id, keyed per organisation", async () => {
    const columns = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema='nzi_console' AND column_name='legacy_db_id'
        AND table_name IN ('clients','client_sites','client_contacts','jobs','job_scope_rows','client_factors') ORDER BY 1`);
    assert.deepEqual(columns.rows.map((row) => row.table_name), ["client_contacts", "client_factors", "client_sites", "clients", "job_scope_rows", "jobs"]);
    const job = await db.query(`SELECT sequence, job_number, legacy_job_number FROM nzi_console.jobs WHERE job_id='job-v7-612'`);
    assert.deepEqual(job.rows, [{ sequence: 612, job_number: "J000612", legacy_job_number: "J000612" }], "v7's number did not become the console's");
  });

  it("refuses a second row for one v7 id, and a half-stated provenance", async () => {
    await assert.rejects(db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,source_system,legacy_db_id) VALUES ($1,'client-dup','Dup','active',$2,'1')`, [ORG, V7]),
      /clients_import_identity_key/);
    await assert.rejects(db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,source_system) VALUES ($1,'client-half','Half','active',$2)`, [ORG, V7]),
      /clients_import_provenance_shape/);
    await assert.rejects(db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,legacy_db_id) VALUES ($1,'client-id-only','Id','active','9')`, [ORG]),
      /clients_import_provenance_shape/);
    await assert.rejects(db.query(`UPDATE nzi_console.jobs SET legacy_job_number='J000001' WHERE false OR job_id IN (SELECT job_id FROM nzi_console.jobs WHERE source_system IS NULL LIMIT 1)`)
      .then(() => db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,legacy_job_number) VALUES ($1,'job-here',
        'client-v7-1',7001,'crp','Here','open','Setup','J999999')`, [ORG])), /jobs_legacy_numbers_are_imported/);
  });

  // ── Migrated rows (0133) ───────────────────────────────────────────────────────────────────────────────

  it("takes a migrated row carrying v7's record and provenance; keeps a live row free of one", async () => {
    const id = await scopeRow();
    const stored = await db.query(`SELECT origin, migrated_record->>'reported_tco2e' AS reported FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [id]);
    assert.deepEqual(stored.rows, [{ origin: "migrated", reported: "0.2" }]);
    await scopeRow({ origin: "live", record: null, sourceSystem: null, legacyId: null });
    await assert.rejects(scopeRow({ origin: "live", sourceSystem: null, legacyId: null }), /job_scope_rows_migrated_shape/, "a live row carried a migrated record");
  });

  it("refuses a migrated row without its record, without provenance, or missing what v7 recorded", async () => {
    await assert.rejects(scopeRow({ record: null }), /job_scope_rows_migrated_shape/);
    await assert.rejects(scopeRow({ sourceSystem: null, legacyId: null }), /job_scope_rows_migrated_shape/);
    const { reported_tco2e: _dropped, ...withoutFigure } = record();
    await assert.rejects(scopeRow({ record: withoutFigure }), /job_scope_rows_migrated_shape/);
  });

  it("refuses any key outside the closed list — so no name or free text can ride in", async () => {
    for (const extra of [{ employee_name: "A Person" }, { notes: "free text" }, { detail_json: {} }, { override_reason: "why" }]) {
      await assert.rejects(scopeRow({ record: record(extra) }), /job_scope_rows_migrated_shape/, `accepted ${Object.keys(extra)[0]}`);
    }
    await scopeRow({ record: record({ months: [1, 2], evidence: { spend_entries: 3 }, flags: ["monthly-relookup"], dataset: { id: 8, year: 2023 } }) });
  });

  it("lets a migrated row be disabled and re-enabled — and changes nothing else", async () => {
    const id = await scopeRow();
    await db.query(`UPDATE nzi_console.job_scope_rows SET enabled=false, version=version+1, updated_at=now() WHERE scope_row_id=$1`, [id]);
    await db.query(`UPDATE nzi_console.job_scope_rows SET enabled=true, version=version+1 WHERE scope_row_id=$1`, [id]);
    for (const [change, sql] of [
      ["the figure", `UPDATE nzi_console.job_scope_rows SET calculated_tco2e=9 WHERE scope_row_id=$1`],
      ["the quantity", `UPDATE nzi_console.job_scope_rows SET quantity=1 WHERE scope_row_id=$1`],
      ["the factor", `UPDATE nzi_console.job_scope_rows SET factor_id='uk-ghg-7_400_4000_5_1' WHERE scope_row_id=$1`],
      ["v7's record", `UPDATE nzi_console.job_scope_rows SET migrated_record = migrated_record || '{"reported_tco2e": 9}' WHERE scope_row_id=$1`],
      ["its notes", `UPDATE nzi_console.job_scope_rows SET notes='edited' WHERE scope_row_id=$1`],
      ["its origin", `UPDATE nzi_console.job_scope_rows SET origin='live', migrated_record=NULL WHERE scope_row_id=$1`],
    ] as const) {
      await assert.rejects(db.query(sql, [id]), /migrated history: only whether it is enabled may change/, `changed ${change}`);
    }
    const after = await db.query(`SELECT calculated_tco2e::text AS t, quantity::text AS q, enabled FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [id]);
    assert.deepEqual(after.rows, [{ t: "0.2", q: "1000", enabled: true }]);
  });

  it("refuses deleting a migrated row, and turning a live row into one; live rows keep behaving as before", async () => {
    const migrated = await scopeRow();
    await assert.rejects(db.query(`DELETE FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [migrated]), /cannot be deleted; disable it instead/);
    const live = await scopeRow({ origin: "live", record: null, sourceSystem: null, legacyId: null });
    await assert.rejects(db.query(`UPDATE nzi_console.job_scope_rows SET origin='migrated', migrated_record=$2::jsonb, source_system=$3, legacy_db_id='x' WHERE scope_row_id=$1`,
      [live, JSON.stringify(record()), V7]), /cannot become migrated history/);
    await db.query(`UPDATE nzi_console.job_scope_rows SET quantity=5, calculated_tco2e=NULL WHERE scope_row_id=$1`, [live]);
    await db.query(`DELETE FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [live]);
  });

  it("holds as the application role, not only as the owner", async () => {
    const id = await scopeRow();
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE nzi_console_app");
      await db.query(`SELECT set_config('app.organisation_id', $1, true)`, [ORG]);
      await db.query("SAVEPOINT a");
      await assert.rejects(db.query(`UPDATE nzi_console.job_scope_rows SET calculated_tco2e=9 WHERE scope_row_id=$1`, [id]), /only whether it is enabled may change/);
      await db.query("ROLLBACK TO SAVEPOINT a");
      await assert.rejects(db.query(`DELETE FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [id]), /cannot be deleted/);
      await db.query("ROLLBACK TO SAVEPOINT a");
      await db.query(`UPDATE nzi_console.job_scope_rows SET enabled=false WHERE scope_row_id=$1`, [id]);
    } finally { await db.query("ROLLBACK"); }
  });

  // ── The job-number counter (0134) ──────────────────────────────────────────────────────────────────────

  it("catches the counter up to the highest existing job, never back, never ahead — callable by the application role", async () => {
    const before = await counter();
    assert.ok(before < 612, `the counter started at ${before}, already past the imported number`);
    await db.query("BEGIN");
    let settled: number;
    try {
      await db.query("SET LOCAL ROLE nzi_console_app");
      await db.query(`SELECT set_config('app.organisation_id', $1, true)`, [ORG]);
      settled = (await db.query<{ n: number }>(`SELECT nzi_console.advance_job_sequence_past_existing() AS n`)).rows[0]!.n;
      assert.equal((await db.query<{ o: string }>(`SELECT current_setting('app.organisation_id', true) AS o`)).rows[0]!.o, ORG,
        "the function left the caller in another tenant");
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    assert.equal(settled, 612);
    assert.equal(await counter(), 612);

    // Never backwards: a counter already ahead stays where it is.
    await db.query(`UPDATE nzi_console.job_number_counter SET last_sequence = 700`);
    await db.query(`SELECT nzi_console.advance_job_sequence_past_existing()`);
    assert.equal(await counter(), 700);

    // And the next job allocated continues after it.
    const next = (await db.query<{ n: number }>(`SELECT nzi_console.allocate_job_sequence() AS n`)).rows[0]!.n;
    assert.equal(next, 701);
  });
});
