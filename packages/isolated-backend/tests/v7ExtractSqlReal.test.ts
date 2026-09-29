import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { EXTRACT_CONTRACT, V7_TABLES, type V7Table } from "../src/v7ClientExtract";
// @ts-expect-error — plain .mjs, deliberately untyped: it must run with no toolchain on the extracting machine.
import { extractSql, preflightSql, v7ClientRiskSql } from "../scripts/v7-extract-sql.mjs";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticRows } from "./support/v7SyntheticExtract";

/**
 * The generated extract queries, run against a v7-shaped schema holding the synthetic v7 rows: every query parses,
 * returns exactly the contract's columns, keeps decision 8's scope, and computes the factor-lookup reference as v7
 * would. Nothing here touches the console's schema — the v7 tables live in their own schema, dropped with the database.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const COPY_LINE = /^\\copy \((.*)\) TO '(.*)' WITH \(FORMAT csv, HEADER true, ENCODING 'UTF8'\)$/;
const BOOLEAN = new Set(["archived", "enabled", "is_deleted", "is_registered_office", "is_primary", "is_crp", "is_custom_entry", "is_auto_generated", "submitted_by_portal"]);
const INTEGER = new Set(["year"]);
/** job_plan's real types, which v7's Risk arithmetic needs: dates compared with a date minus an interval. */
const JOB_PLAN_TYPE = (column: string) => column.endsWith("_due") ? "date" : column.endsWith("_completed_at") || column === "updated_at" ? "timestamp" : null;

describe("the generated extract queries, against a v7-shaped schema", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const queries = new Map<V7Table, string>();

  before(async () => {
    database = (await createDisposableDatabase("v7extractsql"))!;
    db = await database.admin();
    await db.query(`CREATE SCHEMA v7`);
    await db.query(`SET search_path = v7`);
    for (const table of V7_TABLES) {
      const columns = [...EXTRACT_CONTRACT[table].required, ...EXTRACT_CONTRACT[table].optional]
        .filter((column) => !(table === "job_scope_rows" && column.startsWith("reference_")));
      await db.query(`CREATE TABLE v7.${table} (${columns.map((column) =>
        `${column} ${(table === "job_plan" && JOB_PLAN_TYPE(column)) || (BOOLEAN.has(column) ? "boolean" : INTEGER.has(column) ? "integer" : "text")}`).join(", ")})`);
      for (const row of syntheticRows()[table]) {
        const present = columns.filter((column) => row[column] !== undefined);
        await db.query(`INSERT INTO v7.${table} (${present.join(",")}) VALUES (${present.map((_, index) => `$${index + 1}`).join(",")})`,
          present.map((column) => row[column]));
      }
    }
    await db.query(`CREATE TABLE v7.factor_lookup (db_id integer, dataset_id text, scope text, original_id text, factor numeric, ghg_unit text)`);
    // Row 1000 has no token: v7 falls back to its original_id in any dataset. Row 1006 carries a token in its notes.
    await db.query(`INSERT INTO v7.factor_lookup VALUES (1,'7','Scope 1','7_400_4000_5_1',0.18,'kgCO2e'), (2,'7','Scope 1','TOKEN-1',5,' tCO2e ')`);
    await db.query(`UPDATE v7.job_scope_rows SET notes='checked; factor_original_id=TOKEN-1', dataset_id='7' WHERE row_id='1006'`);

    const sql: string = extractSql({ out: "unused" });
    const lines = sql.split("\n").filter((line) => line.startsWith("\\copy"));
    V7_TABLES.forEach((table, index) => queries.set(table, COPY_LINE.exec(lines[index]!)![1]!));
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("parses and returns exactly the contract's columns for every table", async () => {
    for (const table of V7_TABLES) {
      const result = await db.query(queries.get(table)!);
      assert.deepEqual(result.fields.map((field) => field.name),
        [...EXTRACT_CONTRACT[table].required, ...EXTRACT_CONTRACT[table].optional], `${table}'s columns`);
    }
  });

  it("takes only decision 8's clients, their jobs and what those reference", async () => {
    const counts: Record<string, number> = {};
    for (const table of V7_TABLES) counts[table] = (await db.query(queries.get(table)!)).rows.length;
    assert.deepEqual(counts, {
      clients: 2, client_sites: 3, client_contacts: 4, job_types: 5, jobs: 6, crp_job_details: 1, datasets: 1,
      job_scope_rows: 9, job_emission_groups: 1, job_emission_sources: 5, job_spend_entries: 3, lca_assessments: 2,
      job_report_versions: 3, report_reviews: 2, portfolios_lookup: 4, job_plan: 3,
      // The admin lookups (A3): configuration, taken whole — `all`, not scoped by client.
      industries_lookup: 3, referrals_lookup: 1, payment_terms_lookup: 2, positions_lookup: 1, processes_lookup: 1, client_teams_lookup: 1,
      action_categories_lookup: 1, governance_subjects_lookup: 1, bd_bin_reasons_lookup: 1, uom_lookup: 2, job_item_categories_lookup: 2,
    }, "the prospect and the archived client, their site, the client-less job and the prospect's job stay behind");
    const clients = (await db.query(queries.get("clients")!)).rows.map((row) => row.db_id);
    assert.deepEqual(clients, ["1", "2"]);
  });

  it("runs the emitted script's statements in order: every \\copy works read-only, and no write gets through", async () => {
    // One session, as psql would hold: the script's own SQL lines verbatim, each \copy as the SELECT it wraps.
    const session = await database.admin();
    try {
      await session.query(`SET search_path = v7`);
      const sql: string = extractSql({ out: "unused" });
      let copies = 0;
      for (const line of sql.split("\n")) {
        if (!line.trim() || line.startsWith("--") || /^\\(set|encoding|echo)\b/.test(line)) continue;
        if (line.startsWith("\\copy")) { await session.query(COPY_LINE.exec(line)![1]!); copies += 1; continue; }
        if (line === "COMMIT;") {
          // Just before the script commits: inside its transaction, a write is refused outright.
          await session.query(`SAVEPOINT probe`);
          await assert.rejects(session.query(`UPDATE v7.clients SET client_name = 'changed' WHERE db_id = '1'`), /read-only transaction/);
          await session.query(`ROLLBACK TO SAVEPOINT probe`);
        }
        await session.query(line);
      }
      assert.equal(copies, V7_TABLES.length + 1, "every \\copy — the parity file's too — ran inside the read-only transaction");
      await assert.rejects(session.query(`UPDATE v7.clients SET client_name = 'changed' WHERE db_id = '1'`), /read-only transaction/,
        "and after it, the session itself still refuses writes");
      const untouched = await db.query(`SELECT client_name FROM v7.clients WHERE db_id = '1'`);
      assert.deepEqual(untouched.rows, [{ client_name: "Synthetic Alpha Ltd" }]);
    } finally {
      await session.end();
    }
  });

  it("passes its preflight on a v7 with every column — and reports ALL drift at once when there is some", async () => {
    await db.query(preflightSql());
    const session = await database.admin();
    try {
      await session.query(`SET search_path = v7`);
      await session.query("BEGIN");
      // Three kinds of drift in three places: a contract column, a monthly column, and a table the lookup joins.
      await session.query(`ALTER TABLE v7.clients DROP COLUMN client_manager`);
      await session.query(`ALTER TABLE v7.job_scope_rows DROP COLUMN month_3`);
      await session.query(`ALTER TABLE v7.factor_lookup RENAME TO factor_lookup_moved`);
      await assert.rejects(session.query(preflightSql()), (error: Error) => {
        assert.match(error.message, /v7 schema drift: 3 item\(s\) the extract reads are missing: clients\.client_manager, factor_lookup \(table absent\), job_scope_rows\.month_3\. Nothing was extracted/);
        return true;
      });
      await session.query("ROLLBACK");
      await session.query(preflightSql()); // and the rollback put it all back
      await assert.doesNotReject(session.query(preflightSql(new Set(["clients.client_manager"]))), "an omitted column is not asked for");
    } finally {
      await session.query("ROLLBACK").catch(() => undefined);
      await session.end();
    }
  });

  it("computes v7's own client Risk on the London day, at v7's thresholds (ruled A1)", async () => {
    // Milestones placed relative to the London day the query itself computes, so the test holds on any date. One client
    // per case, each with one job and one milestone: v7's rule is Overdue below −1, Due up to +7, else Healthy.
    const session = await database.admin();
    try {
      await session.query("SET search_path = v7");
      await session.query("BEGIN");
      const day = (await session.query("SELECT (now() AT TIME ZONE 'Europe/London')::date AS d")).rows[0].d as Date;
      const cases: Array<[string, number | null, boolean, string]> = [
        ["901", -2, false, "red"], ["902", -1, false, "amber"], ["903", 0, false, "amber"], ["904", 7, false, "amber"],
        ["905", 8, false, "green"], ["906", -30, true, "green"], ["907", null, false, "green"],
      ];
      for (const [id, offset, done] of cases) {
        await session.query("INSERT INTO v7.clients (db_id, client_name, status, archived) VALUES ($1, 'Parity', 'Active', false)", [id]);
        await session.query("INSERT INTO v7.jobs (job_id, client_db_id, job_number, status) VALUES ($1, $1, 'J1', 'Open')", [id]);
        await session.query(
          "INSERT INTO v7.job_plan (job_id, data_collection_due, data_collection_completed_at) VALUES ($1, $2::date + $3::int, CASE WHEN $4 THEN now()::timestamp END)",
          [id, day, offset, done]);
      }
      await session.query("UPDATE v7.job_plan SET data_collection_due = NULL WHERE job_id = '907'");
      const rows = (await session.query<{ client_db_id: string; operating_day: Date; v7_milestone_status: string }>(v7ClientRiskSql())).rows;
      const status = Object.fromEntries(rows.filter((row) => row.client_db_id >= "901").map((row) => [row.client_db_id, row.v7_milestone_status]));
      assert.deepEqual(status, Object.fromEntries(cases.map(([id, , , expected]) => [id, expected])));
      assert.equal(new Set(rows.map((row) => String(row.operating_day))).size, 1, "one operating day for the whole snapshot");
      assert.ok(rows.some((row) => row.client_db_id === "1") && !rows.some((row) => row.client_db_id === "3"), "decision 8's clients only");
    } finally {
      await session.query("ROLLBACK").catch(() => undefined);
      await session.end();
    }
  });

  it("computes the factor-lookup reference as v7 does: the notes token first, then the row's own code", async () => {
    const rows = (await db.query(queries.get("job_scope_rows")!)).rows;
    const reference = (id: string) => rows.filter((row) => row.row_id === id).map((row) => [row.reference_factor, row.reference_ghg_unit])[0];
    assert.deepEqual(reference("1006"), ["5", "tCO2e"], "the token in the notes, in the row's dataset — unit trimmed");
    assert.deepEqual(reference("1000"), ["0.18", "kgCO2e"], "no token: the row's original_id, any dataset");
    assert.deepEqual(reference("1003"), [null, null], "nothing to find: both NULL, which the importer reads as known-absent");
  });
});
