import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { EXTRACT_CONTRACT, V7_TABLES, type V7Extract, type V7Row, type V7Table } from "../src/v7ClientExtract";
import { planV7ClientImport } from "../src/v7ClientImport";
// @ts-expect-error — plain .mjs, deliberately untyped: it must run with no toolchain on the extracting machine.
import { extractSql, oneJobSql, preflightSql, v7ClientRiskSql } from "../scripts/v7-extract-sql.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadV7ClientPlan } from "../src/v7ClientLoad";
import { withTenantWrite } from "../src/postgres";
import { CommandValidationError } from "../src/postgresCommands";
import { summariseV7JobAsTheChainSees } from "../src/v7ImportIngest";
import { sanitiseV7ImportLabel, v7ImportLabelHasPii } from "../src/v7ImportLabel";
import { guardV7ImportViews, planV7JobFromViews, readV7JobFromViews, summariseV7JobFromViews, V7_IMPORT_VIEW_CONTRACT, withV7ViewSnapshot } from "../src/v7ImportView";
import { checkV7ImportViews } from "../scripts/v7-import-view-check";
import { createDisposableDatabase, ensureDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { LABEL_FIXTURES, PII_FIXTURES } from "./support/v7ImportLabelFixtures";
import { SENTINELS, syntheticRows } from "./support/v7SyntheticExtract";

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
      // Jobs configuration (admin C4): taken whole, except the completions — those of the in-scope jobs only.
      vat_rates_lookup: 3, milestone_templates: 3, milestone_template_items: 7, job_template_milestone_completions: 1, job_file_types_lookup: 3,
      // Currencies (admin E1): both of v7's tables, taken whole.
      currency_lookup: 5, currencies_lookup: 4,
      // The service catalogue (admin E2): taken whole.
      job_items: 5,
      // Job-type templates (admin E3): taken whole.
      job_type_items: 7,
      // Suppliers and their rate card (admin E4): taken whole; only the contract's columns — never v7's address or notes.
      suppliers: 4, supplier_service_items: 5,
      // Message templates (admin F1): taken whole; the importer decides which keys the console sends.
      message_templates: 4,
      // CRM and BD lookups (admin F2): each taken whole.
      crm_tags: 5, bd_service_lines: 4, bd_funnel_stages: 6,
      // Custom field definitions (admin F3): taken whole — the importer decides which it can carry.
      custom_field_definitions: 8,
      // Staff (admin B2): taken whole — the portal login too, which the importer refuses. Only the ruled columns are read.
      users: 6,
      // Organisation settings (admin D2): the 16 allow-listed keys of 20 — the bank rows and anything else stay behind.
      system_settings: 16,
      // Time (⚑7): every subject; the time on imported jobs only — the entry on job 999 (no such job) stays behind.
      time_subjects: 4, time_logs: 11,
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

  describe("--job: one named job and its own client (the re-sync's extract)", () => {
    // Every value as v7 writes it to CSV — text — so the files the importer would read are what the plan reads here.
    const raw = { getTypeParser: () => (value: string) => value };
    const take = async (job: string | null) => {
      const lines = (extractSql({ out: "unused", job }) as string).split("\n").filter((line) => line.startsWith("\\copy"));
      const extract = {} as Record<V7Table, V7Row[]>;
      const headers = {} as Record<V7Table, string[]>;
      for (const [index, table] of V7_TABLES.entries()) {
        const result = await db.query({ text: COPY_LINE.exec(lines[index]!)![1]!, types: raw });
        headers[table] = result.fields.map((field) => field.name);
        extract[table] = result.rows;
      }
      return { extract: extract as V7Extract, headers };
    };

    it("takes that job, its own client and what they reference; every configuration table whole", async () => {
      const whole = await take(null);
      const one = await take("J000612");
      assert.deepEqual(one.extract.clients.map((row) => row.db_id), ["1"]);
      assert.deepEqual(one.extract.jobs.map((row) => row.job_number), ["J000612"], "its client's other jobs stay behind");
      for (const table of V7_TABLES) {
        const filter = EXTRACT_CONTRACT[table].filter;
        const expected = table === "jobs" ? whole.extract.jobs.filter((row) => row.job_id === "100")
          : filter === "client" ? whole.extract[table].filter((row) => row.client_db_id === "1")
          : filter === "active-clients" ? whole.extract[table].filter((row) => row.db_id === "1")
          : filter === "job" || filter === "job-with-reference" ? whole.extract[table].filter((row) => row.job_id === "100")
          : filter === "referenced-datasets" ? null
          : whole.extract[table];
        if (expected) assert.deepEqual(one.extract[table], expected, `${table} (${filter})`);
      }
      assert.ok(one.extract.job_scope_rows.length > 0, "the job's own scope rows are taken");
      assert.ok(one.extract.datasets.every((row) => whole.extract.datasets.some((other) => other.dataset_id === row.dataset_id)));
      const risk = (await db.query<{ client_db_id: string }>(v7ClientRiskSql("J000612"))).rows;
      assert.deepEqual(risk.map((row) => row.client_db_id), ["1"], "v7's own client Risk, for that client only");
    });

    it("plans the job exactly as a whole extract plans it, with no refusal", async () => {
      const plan = (taken: Awaited<ReturnType<typeof take>>) =>
        planV7ClientImport({ extract: taken.extract, headers: taken.headers, extractSha256: "0".repeat(64) });
      const whole = plan(await take(null));
      const one = plan(await take("J000612"));
      assert.deepEqual(one.refusals, []);
      assert.deepEqual(one.clients.map((client) => client.jobs.map((job) => job.legacyJobNumber)), [["J000612"]]);
      const job = (of: typeof whole) => of.clients.flatMap((client) => client.jobs).find((planned) => planned.legacyJobNumber === "J000612");
      assert.deepEqual(job(one), job(whole), "the same planned job, rows and all");
    });

    it("stops before any \\copy unless the job is exactly one in-scope v7 job", async () => {
      await assert.doesNotReject(db.query(oneJobSql("J000612")));
      await assert.rejects(db.query(oneJobSql("J000701")), /J000701 is not exactly one in-scope v7 job.*Nothing was extracted/, "a prospect's job");
      await assert.rejects(db.query(oneJobSql("J009999")), /J009999 is not exactly one in-scope v7 job/, "no such job");
      const lines = (extractSql({ out: "unused", job: "J000612" }) as string).split("\n");
      assert.ok(lines.indexOf(oneJobSql("J000612")) < lines.findIndex((line) => line.startsWith("\\copy")), "checked before the first \\copy");
    });
  });
});

/**
 * The import, server-side — Phase A (BRIEF-v7-import-server-side; NOTE-v7-import-server-side-phase-a, ruled 13 Nov 2026). The
 * view set (`v7-source/v7_import_views.sql`) applied to a v7-shaped database of synthetic rows — v7's own free text beside the
 * contract's columns — and read as cc_import_view: non-PII by construction, guarded, the label rule identical in SQL and
 * TypeScript, and the server-side diff off it equal to the extract-based summary of the same job. Read and diff only.
 */
describe("the import's view set, server-side: non-PII, guarded, and the extract's own summary", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const VIEW_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "v7-source", "v7_import_views.sql"), "utf8")
    .split("\n").filter((line) => !line.startsWith("\\")).join("\n");
  const ORG = "net-zero-international", JOB = "J000612", JOB_ID = "v7-job-100", AT = "2026-11-13T09:00:00.000Z";
  const raw = { getTypeParser: () => (value: string) => value };
  /** What must never leave the source through a view: the synthetic rows' names, plate, postcode, account and places. */
  const NEVER = [...SENTINELS, "ZZ12 ABC", "LS1 4AB", "Smith", "12345678", "Leeds", "Synthetic Alpha", "Head Office", "Example Street", "example.invalid", "Casey Owner", "CRP 2023"];
  let sourceUrl: string;
  let source: pg.Client;
  let viewPool: pg.Pool;
  let target: DisposableDatabase;

  const takeExtract = async (job: string | null) => {
    const lines = (extractSql({ out: "unused", job }) as string).split("\n").filter((line) => line.startsWith("\\copy"));
    const extract = {} as Record<V7Table, V7Row[]>;
    const headers = {} as Record<V7Table, string[]>;
    for (const [index, table] of V7_TABLES.entries()) {
      const result = await source.query({ text: COPY_LINE.exec(lines[index]!)![1]!, types: raw });
      headers[table] = result.fields.map((field) => field.name);
      extract[table] = result.rows;
    }
    return { extract: extract as V7Extract, headers };
  };
  const extractJob = async () => {
    const taken = await takeExtract(JOB);
    const plan = planV7ClientImport({ extract: taken.extract, headers: taken.headers, extractSha256: "e".repeat(64), organisationId: ORG });
    assert.deepEqual(plan.refusals, []);
    return plan.clients.flatMap((client) => client.jobs).find((job) => job.legacyJobNumber === JOB)!;
  };
  const fromExtract = async () => {
    const job = await extractJob();
    return withTenantWrite(target.pool, ORG, (db) => summariseV7JobAsTheChainSees(db, { organisationId: ORG, jobId: JOB_ID, legacyJobNumber: JOB, extractSha256: "e".repeat(64), rows: job.rows, generatedAt: AT }));
  };
  const fromViews = () => withTenantWrite(target.pool, ORG, (db) => summariseV7JobFromViews(db, viewPool, { organisationId: ORG, legacyJobNumber: JOB, generatedAt: AT }));
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const consolePrint = async () => (await target.pool.query<{ p: string }>(
    `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS p FROM nzi_console.job_scope_rows t`)).rows[0]!.p;

  before(async () => {
    sourceUrl = (await ensureDisposableDatabase("v7viewsrc"))!;
    source = new pg.Client({ connectionString: sourceUrl });
    await source.connect();
    const rows = syntheticRows();
    // A row a user typed by hand (a plate, a titled name, a postcode, an account number, a person) and a grey-fleet row.
    rows.job_scope_rows.push(
      { row_id: "1008", job_id: "100", scope: "Scope 1", original_id: "7_400_4001_5_1", qty: "40", uom: "litres", factor: "2.5", ghg_unit: "kgCO2e", enabled: "t",
        site_id: "11", factor_db_id: "552", dataset_id: "7", category: "Company vehicles", level_1: "Fuels", level_2: "Liquid fuels", level_3: "Van ZZ12 ABC for Mr Smith",
        column_text: "Leeds depot, LS1 4AB", report_label: `Fuel card 12345678 — ${SENTINELS[0]} Person`, data_source: "Company Data", is_custom_entry: "t" },
      { row_id: "1009", job_id: "100", scope: "Scope 3", original_id: "7_430_4300_2_1", qty: "120", uom: "km", factor: "0.1", ghg_unit: "kgCO2e", enabled: "t",
        site_id: "11", factor_db_id: "570", dataset_id: "7", level_1: "Grey fleet", level_2: "Cars (by size)", report_label: `${SENTINELS[0]} Person's own car`, data_source: "Company Data" });
    for (const table of V7_TABLES) {
      const contract = [...EXTRACT_CONTRACT[table].required, ...EXTRACT_CONTRACT[table].optional].filter((column) => !(table === "job_scope_rows" && column.startsWith("reference_")));
      // v7's own free text beside the contract's columns — names, notes, descriptions — so a view that reached for it would show.
      const extra = [...new Set(rows[table].flatMap((row) => Object.keys(row)))].filter((column) => !contract.includes(column));
      const columns = [...contract, ...extra];
      await source.query(`CREATE TABLE public.${table} (${columns.map((column) =>
        `${column} ${(table === "job_plan" && JOB_PLAN_TYPE(column)) || (BOOLEAN.has(column) ? "boolean" : INTEGER.has(column) ? "integer" : "text")}`).join(", ")})`);
      for (const row of rows[table]) {
        const present = columns.filter((column) => row[column] !== undefined);
        await source.query(`INSERT INTO public.${table} (${present.join(",")}) VALUES (${present.map((_, index) => `$${index + 1}`).join(",")})`, present.map((column) => row[column]));
      }
    }
    await source.query(`CREATE TABLE public.factor_lookup (db_id integer, dataset_id text, scope text, original_id text, factor numeric, ghg_unit text,
      level_1 text, level_2 text, level_3 text, column_text text)`);
    await source.query(`INSERT INTO public.factor_lookup VALUES (1,'7','Scope 1','7_400_4000_5_1',0.18,'kgCO2e',NULL,NULL,NULL,NULL), (2,'7','Scope 1','TOKEN-1',5,' tCO2e ',NULL,NULL,NULL,NULL),
      (551,'7','Scope 1','TAX-551',0.18,'kgCO2e','Fuels','Gaseous fuels','Natural gas',NULL), (552,'7','Scope 1','TAX-552',2.5,'kgCO2e','Fuels','Liquid fuels','Diesel',NULL),
      (555,'7','Scope 2','TAX-555',0.2,'kgCO2e','UK electricity','Electricity generated','Electricity: UK',NULL), (560,'7','Scope 3','TAX-560',0.3,'kgCO2e','Spend','Land transport',NULL,NULL),
      (570,'7','Scope 3','TAX-570',0.1,'kgCO2e','Business travel- land','Cars (by size)','Average car',NULL), (580,'7','Scope 3','TAX-580',0.15,'kgCO2e','Business travel- land','Rail','National rail',NULL)`);
    await source.query(VIEW_SQL);
    await source.query(`ALTER ROLE cc_import_view PASSWORD 'test-only-view'`);
    const viewUrl = new URL(sourceUrl);
    viewUrl.username = "cc_import_view";
    viewUrl.password = "test-only-view";
    viewPool = new pg.Pool({ connectionString: viewUrl.toString(), max: 2 });

    // The job as the import loaded it from an extract; then v7 moves on: a figure changes, a row goes, a row arrives.
    target = (await createDisposableDatabase("v7viewcon"))!;
    const whole = await takeExtract(null);
    const plan = planV7ClientImport({ extract: whole.extract, headers: whole.headers, extractSha256: "0".repeat(64), organisationId: ORG });
    assert.deepEqual(plan.refusals, []);
    await loadV7ClientPlan(target.pool, plan, { commit: true, runId: "view-load" });
    await source.query(`UPDATE public.job_scope_rows SET qty = '12000' WHERE row_id = '1000'`);
    await source.query(`DELETE FROM public.job_scope_rows WHERE row_id = '1006'`);
    await source.query(`INSERT INTO public.job_scope_rows (row_id, job_id, scope, original_id, qty, uom, factor, ghg_unit, enabled, site_id, dataset_id, factor_db_id,
      level_1, level_2, report_label, data_source) VALUES ('1010','100','Scope 1','7_400_4000_5_1','500','kWh','0.18','kgCO2e',true,'11','7','551','Fuels','Gaseous fuels','Natural gas','Company Data')`);
  });
  after(async () => { await viewPool?.end(); await source?.end(); await target?.end(); });

  it("applies idempotently, and cc_import_view reads the view set — and nothing else, and writes nothing", async () => {
    await source.query(VIEW_SQL);
    const client = await viewPool.connect();
    try {
      assert.ok(Number((await client.query(`SELECT count(*) AS n FROM v7_import.scope_rows`)).rows[0].n) > 0);
      await guardV7ImportViews(client);
      await assert.rejects(client.query(`SELECT client_name FROM public.clients`), /permission denied/);
      await assert.rejects(client.query(`SELECT notes FROM public.job_scope_rows`), /permission denied/);
      await assert.rejects(client.query(`UPDATE v7_import.datasets SET version = 'x'`), /read-only transaction|permission denied/);
      assert.equal((await client.query(`SHOW default_transaction_read_only`)).rows[0].default_transaction_read_only, "on");
    } finally {
      client.release();
    }
  });

  it("the label rule: SQL and TypeScript give the same output on every shared fixture", async () => {
    for (const fixture of LABEL_FIXTURES) {
      const { context } = fixture;
      const sql = (await source.query(`SELECT v7_import.sanitise_label($1, $2, $3, $4, $5, $6) AS s`,
        [fixture.value, fixture.allowed, context.personLinked, context.factorLabel, context.base, context.siteId])).rows[0].s;
      assert.equal(sql, sanitiseV7ImportLabel(fixture.value, fixture.allowed, context), fixture.why);
      assert.equal(sql, fixture.expected, fixture.why);
    }
    for (const { value } of PII_FIXTURES) {
      assert.equal((await source.query(`SELECT v7_import.label_has_pii($1) AS p`, [value])).rows[0].p, v7ImportLabelHasPii(value), value);
    }
  });

  it("no PII leaves: no view, no row, no column carries it — and the count-only check passes", async () => {
    const client = await viewPool.connect();
    try {
      for (const view of Object.keys(V7_IMPORT_VIEW_CONTRACT)) {
        const text = (await client.query(`SELECT t::text AS row FROM v7_import.${view} t`)).rows.map((row) => row.row as string).join("\n");
        for (const never of NEVER) assert.ok(!text.includes(never), `v7_import.${view} carries "${never}"`);
      }
      const labels = Object.fromEntries((await client.query(`SELECT row_id, category, level_1, level_3, column_text, report_label FROM v7_import.scope_rows WHERE row_id IN ('1005','1008','1009')`)).rows
        .map((row) => [row.row_id, [row.category, row.level_1, row.level_3, row.column_text, row.report_label]]));
      assert.deepEqual(labels["1008"], ["Fuels — site 11", "Fuels", "Fuels — site 11", "Fuels — site 11", "Fuels — site 11"], "free text replaced by <category> — site <id>");
      assert.deepEqual(labels["1009"], [null, "Average car", null, null, "Average car"], "grey fleet: the factor's own text, not the person");
      assert.deepEqual(labels["1005"], [null, "Business travel- land", null, null, "Average car"], "commuting: the factor's own text");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const check = await checkV7ImportViews(client);
      await client.query("ROLLBACK");
      assert.equal(check.passed, true);
      assert.ok(Object.values(check.piiHits).every((count) => count === 0));
      assert.equal(check.labels.unexplained, 0);
      assert.equal(check.grantsOutsideTheSet, 0);
      assert.ok(check.labels.generalised >= 3 && check.labels.scrubbedToSite >= 1 && check.labels.allowListed >= 1, JSON.stringify(check.labels));
    } finally {
      client.release();
    }
  });

  it("the guard refuses a column, a view or a gap the contract does not name — before anything is read", async () => {
    await source.query("BEGIN");
    try {
      const refused = async (change: string, expected: RegExp) => {
        await source.query("SAVEPOINT g");
        await source.query(change);
        await assert.rejects(guardV7ImportViews(source), (error: unknown) => {
          assert.deepEqual(codes(error), ["VIEW_NOT_AS_CONTRACTED"]);
          assert.match((error as CommandValidationError).issues[0]!.message, expected);
          return true;
        });
        await assert.rejects(readV7JobFromViews(source, JOB), (error: unknown) => codes(error)[0] === "VIEW_NOT_AS_CONTRACTED");
        await source.query("ROLLBACK TO SAVEPOINT g");
      };
      await refused(`CREATE OR REPLACE VIEW v7_import.clients AS SELECT c.db_id, c.status, c.archived, c.client_name FROM public.clients c`, /clients\.client_name \(not in the contract\)/);
      await refused(`CREATE VIEW v7_import.contacts AS SELECT full_name, email FROM public.client_contacts`, /contacts \(not in the contract\)/);
      await refused(`DROP VIEW v7_import.datasets`, /datasets \(missing\)/);
      await guardV7ImportViews(source);
    } finally {
      await source.query("ROLLBACK");
    }
  });

  it("plans the job off the views exactly as off the extract — the labels the rule replaced aside", async () => {
    const viewJob = await withV7ViewSnapshot(viewPool, async (db) => planV7JobFromViews(await readV7JobFromViews(db, JOB), JOB, ORG));
    const extracted = await extractJob();
    const unlabelled = (rows: typeof viewJob.rows) => rows.map((row) => ({ ...row, sourceLabel: null, reportLabel: null, level1: null, level2: null, level3: null, level4: null, columnText: null }));
    assert.deepEqual(unlabelled(viewJob.rows), unlabelled(extracted.rows), "every figure, code, flag, evidence id and lineage the same");
    const label = (rows: typeof viewJob.rows, id: string) => rows.find((row) => row.legacyDbId === id)!.reportLabel;
    assert.equal(label(viewJob.rows, "1000"), label(extracted.rows, "1000"), "taxonomy text crosses as it is");
    assert.equal(label(viewJob.rows, "1008"), "Fuels — site 11");
    await assert.rejects(withV7ViewSnapshot(viewPool, (db) => readV7JobFromViews(db, "J000701")), (error: unknown) => codes(error)[0] === "NOT_ONE_JOB", "a prospect's job is not in the view set");
  });

  it("the server-side diff off the views equals the extract-based summary, and writes nothing on either side", async () => {
    const before = await consolePrint();
    const extracted = await fromExtract();
    const viewed = await fromViews();
    assert.deepEqual({ ...viewed, extractSha256: "-" }, { ...extracted, extractSha256: "-" }, "the same rows, statuses, figures, Σ per scope and verdict");
    assert.match(viewed.extractSha256, /^[0-9a-f]{64}$/);
    const status = Object.fromEntries(viewed.rows.map((row) => [row.legacyDbId, row.status]));
    assert.deepEqual([status["1000"], status["1006"], status["1010"], status["1008"], status["1009"], status["source:5001"]], ["changed", "withdrawn", "new", "matched", "matched", "matched"]);
    assert.equal(await consolePrint(), before, "the console's rows untouched");
  });

  it("a label changed only inside free text reads as unchanged off the views — the rule's stated cost", async () => {
    await source.query(`UPDATE public.job_scope_rows SET report_label = 'Fuel card — another person' WHERE row_id = '1008'`);
    try {
      const extracted = await fromExtract();
      const viewed = await fromViews();
      const of = (summary: typeof viewed) => summary.rows.find((row) => row.legacyDbId === "1008")!.status;
      assert.deepEqual([of(extracted), of(viewed)], ["changed", "matched"]);
    } finally {
      await source.query(`UPDATE public.job_scope_rows SET report_label = $1 WHERE row_id = '1008'`, [`Fuel card 12345678 — ${SENTINELS[0]} Person`]);
    }
  });
});
