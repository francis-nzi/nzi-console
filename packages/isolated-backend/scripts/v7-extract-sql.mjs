#!/usr/bin/env node
/**
 * Write the psql script that takes the v7 extract (docs/CLIENT_JOB_IMPORT_DESIGN.md Appendix B).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract > extract.sql
 *   psql "<live v7 url>" -f extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract
 *
 * Plain Node, no dependencies and no install: it reads `src/v7ExtractContract.json` — the same file the importer's
 * `EXTRACT_CONTRACT` is — so the script can never ask for a column set the importer does not read.
 *
 * **Read-only on v7, twice over.** The session is set read-only, and every `\copy` runs inside one
 * `BEGIN ISOLATION LEVEL REPEATABLE READ; SET TRANSACTION READ ONLY;` … `COMMIT;`, with statement and idle timeouts — so
 * a wrong column or filter can fail, but cannot write a v7 row. The script selects only; every `\copy` writes to a file
 * on the machine running psql, and the one snapshot makes the fourteen files consistent with each other. No PDFs, and
 * nothing from v7's client-data folders.
 *
 * **An optional column v7 does not have.** v7 adds columns on first use, so a deployment may lack an optional one. psql
 * then stops at that table (`ON_ERROR_STOP`) with "column … does not exist": re-generate with
 * `--omit <table>.<column>` (repeatable, or comma-separated) and run again. A required column cannot be omitted — the
 * importer refuses an extract without it.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const CONTRACT = JSON.parse(readFileSync(resolve(here, "../src/v7ExtractContract.json"), "utf8"));

/** Decision 8, and the jobs of those clients: every query's prelude, one line (a `\copy` query is a single line). */
export const PRELUDE =
  "WITH ac AS (SELECT db_id FROM clients WHERE COALESCE(status,'Active') IN ('Active','Portfolio Owner') AND NOT COALESCE(archived,false)), " +
  "aj AS (SELECT j.job_id FROM jobs j JOIN ac ON ac.db_id = j.client_db_id)";

/** How long one query may run, and how long the transaction may sit idle between `\copy` calls. */
export const STATEMENT_TIMEOUT = "30min";
export const IDLE_TIMEOUT = "5min";

/** The two columns computed by the lookup v7 makes at report time, not read from `job_scope_rows` itself. */
export const REFERENCE_COLUMNS = ["reference_factor", "reference_ghg_unit"];

/** Appendix B's factor-lookup reference, verbatim, joined onto `job_scope_rows r`. */
export const REFERENCE_JOIN =
  "LEFT JOIN LATERAL (SELECT fl.factor, fl.ghg_unit FROM factor_lookup fl WHERE r.dataset_id IS NOT NULL AND fl.dataset_id = r.dataset_id " +
  "AND fl.original_id = substring(r.notes FROM '(?i)(?:^|[;( ])factor_original_id=([^;)\\s]+)') AND (trim(r.scope) = '' OR fl.scope = trim(r.scope)) " +
  "ORDER BY CASE WHEN fl.scope = trim(r.scope) THEN 0 ELSE 1 END, fl.db_id LIMIT 1) ref1 ON true " +
  "LEFT JOIN LATERAL (SELECT fl.factor, fl.ghg_unit FROM factor_lookup fl LEFT JOIN datasets d ON d.dataset_id = fl.dataset_id " +
  "WHERE trim(COALESCE(r.original_id, '')) <> '' AND fl.original_id = trim(r.original_id) ORDER BY COALESCE(d.year, 0) DESC, fl.db_id DESC LIMIT 1) ref2 ON true";
const REFERENCE_SELECT = {
  reference_factor: "CASE WHEN ref1.factor IS NOT NULL THEN ref1.factor ELSE ref2.factor END AS reference_factor",
  reference_ghg_unit: "CASE WHEN ref1.factor IS NOT NULL THEN NULLIF(trim(ref1.ghg_unit), '') " +
    "ELSE COALESCE(NULLIF(trim(ref2.ghg_unit), ''), NULLIF(trim(ref1.ghg_unit), '')) END AS reference_ghg_unit",
};

const inJobs = "IN (SELECT job_id FROM aj)";
const FILTERS = {
  "active-clients": (t) => `FROM ${t} t WHERE t.db_id IN (SELECT db_id FROM ac)`,
  client: (t) => `FROM ${t} t WHERE t.client_db_id IN (SELECT db_id FROM ac)`,
  job: (t) => `FROM ${t} t WHERE t.job_id ${inJobs}`,
  all: (t) => `FROM ${t} t`,
  "referenced-datasets": (t) => `FROM ${t} t WHERE t.dataset_id IN (SELECT dataset_id FROM job_scope_rows WHERE job_id ${inJobs} ` +
    `UNION SELECT dataset_id FROM job_emission_sources WHERE job_id ${inJobs} UNION SELECT dataset_id FROM job_emission_groups WHERE job_id ${inJobs})`,
};

/** The columns a table's file will carry: the contract's, required then optional, less any omitted. */
export function columnsFor(table, omit = new Set()) {
  const entry = CONTRACT[table];
  return [...entry.required, ...entry.optional].filter((column) => !omit.has(`${table}.${column}`));
}

/** One table's SELECT, as the text inside `\copy ( … )`. */
export function selectFor(table, omit = new Set()) {
  const entry = CONTRACT[table];
  const columns = columnsFor(table, omit);
  const key = entry.required[0];
  if (entry.filter === "job-with-reference") {
    const list = columns.map((column) => REFERENCE_SELECT[column] ?? `r.${column}`).join(", ");
    return `${PRELUDE} SELECT ${list} FROM ${table} r JOIN aj USING (job_id) ${REFERENCE_JOIN} ORDER BY r.${key}`;
  }
  const filter = FILTERS[entry.filter];
  if (!filter) throw new Error(`${table}: unknown filter "${entry.filter}" in the contract`);
  return `${PRELUDE} SELECT ${columns.map((column) => `t.${column}`).join(", ")} ${filter(table)} ORDER BY t.${key}`;
}

/** Check `--omit` entries: real tables, real optional columns, never a required one. */
export function parseOmit(values) {
  const omit = new Set();
  for (const value of values.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean)) {
    const [table, column, extra] = value.split(".");
    const entry = CONTRACT[table];
    if (!entry || !column || extra !== undefined) throw new Error(`--omit ${value}: expected <table>.<column> for a contract table`);
    if (entry.required.includes(column)) throw new Error(`--omit ${value}: required — the importer refuses an extract without it`);
    if (!entry.optional.includes(column)) throw new Error(`--omit ${value}: not a column the contract reads`);
    omit.add(value);
  }
  return omit;
}

/**
 * Columns the queries read that are not extract columns of their own: the in-scope filters and the factor-lookup join.
 * A missing one fails the \copy as surely as a missing contract column, so the preflight checks them too.
 */
export const QUERY_COLUMNS = {
  clients: ["db_id", "status", "archived"],
  jobs: ["job_id", "client_db_id"],
  job_scope_rows: ["job_id", "dataset_id", "scope", "original_id", "notes"],
  job_emission_sources: ["job_id", "dataset_id"],
  job_emission_groups: ["job_id", "dataset_id"],
  factor_lookup: ["db_id", "dataset_id", "scope", "original_id", "factor", "ghg_unit"],
  datasets: ["dataset_id", "year"],
};

/** Every (table, column) the script reads, contract and query alike, less any omitted — sorted, de-duplicated. */
export function preflightColumns(omit = new Set()) {
  const pairs = new Set();
  for (const table of Object.keys(CONTRACT)) {
    for (const column of columnsFor(table, omit)) if (!REFERENCE_COLUMNS.includes(column)) pairs.add(`${table}.${column}`);
  }
  for (const [table, columns] of Object.entries(QUERY_COLUMNS)) for (const column of columns) pairs.add(`${table}.${column}`);
  return [...pairs].sort().map((pair) => pair.split("."));
}

/**
 * One statement, before any \copy: every column the script reads, resolved exactly as the queries will resolve it
 * (`to_regclass` on the search path, then the table's own columns), and ONE error listing everything missing — so a
 * drifted schema shows its whole drift on the first run, not one column per run under ON_ERROR_STOP. A missing table
 * is reported as the table, once. Read-only: it only reads the catalogue.
 */
export function preflightSql(omit = new Set()) {
  const values = preflightColumns(omit).map(([table, column]) => `('${table}','${column}')`).join(",");
  return "DO $preflight$ DECLARE missing text; count integer; BEGIN " +
    "SELECT string_agg(item, ', ' ORDER BY item), count(*) INTO missing, count FROM (" +
    "SELECT DISTINCT CASE WHEN to_regclass(w.t) IS NULL THEN w.t || ' (table absent)' ELSE w.t || '.' || w.c END AS item " +
    `FROM (VALUES ${values}) AS w(t, c) ` +
    "WHERE to_regclass(w.t) IS NULL OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(w.t) AND a.attname = w.c AND a.attnum > 0 AND NOT a.attisdropped)" +
    ") m; IF missing IS NOT NULL THEN RAISE EXCEPTION 'v7 schema drift: % item(s) the extract reads are missing: %. Nothing was extracted. Required columns are a contract change; an absent optional column can be left out with --omit <table>.<column>.', count, missing; END IF; END $preflight$;";
}

/** The whole psql script. */
export function extractSql({ out = ".", omit = new Set(), generatedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const directory = out.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
  const quoted = (path) => `'${path.replace(/'/g, "''")}'`;
  const lines = [
    `-- The v7 client-and-job extract (docs/CLIENT_JOB_IMPORT_DESIGN.md Appendix B), generated ${generatedAt}`,
    "-- from packages/isolated-backend/src/v7ExtractContract.json by scripts/v7-extract-sql.mjs.",
    "-- READ-ONLY: every statement is a SELECT, and the session refuses writes. Files land on this machine, never the server.",
    `-- Output: ${directory}/<table>.csv. Then: node packages/isolated-backend/scripts/v7-extract-manifest.mjs ${directory}`,
    ...(omit.size ? [`-- Omitted optional columns (absent from this v7): ${[...omit].sort().join(", ")}`] : []),
    "\\set ON_ERROR_STOP on",
    "\\encoding UTF8",
    // Belt and braces: the session refuses writes, and so does the one transaction every \copy runs inside. Repeatable
    // read gives all fourteen files one consistent snapshot of v7; the timeouts bound how long it can hold one.
    "SET default_transaction_read_only = on;",
    "BEGIN ISOLATION LEVEL REPEATABLE READ;",
    "SET TRANSACTION READ ONLY;",
    `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}';`,
    `SET LOCAL idle_in_transaction_session_timeout = '${IDLE_TIMEOUT}';`,
    "",
    "\\echo preflight: every column the extract reads, checked against this v7 before anything is copied",
    preflightSql(omit),
    "",
  ];
  for (const table of Object.keys(CONTRACT)) {
    lines.push(`\\echo ${table}`);
    lines.push(`\\copy (${selectFor(table, omit)}) TO ${quoted(`${directory}/${table}.csv`)} WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')`);
  }
  lines.push("", "COMMIT;");
  return lines.join("\n") + "\n";
}

function main(argv) {
  const values = (flag) => argv.flatMap((item, index) => (item === flag && argv[index + 1] ? [argv[index + 1]] : []));
  const out = values("--out")[0];
  if (!out) throw new Error("Usage: v7-extract-sql.mjs --out <directory for the CSVs> [--omit <table>.<column>]… > extract.sql");
  process.stdout.write(extractSql({ out, omit: parseOmit(values("--omit")) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`v7-extract-sql: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
