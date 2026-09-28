#!/usr/bin/env node
/**
 * Write the psql script that takes the v7 extract (docs/CLIENT_JOB_IMPORT_DESIGN.md Appendix B).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract --file C:/v7-extract/extract.sql
 *   psql "<live v7 url>" -f C:/v7-extract/extract.sql
 *
 * **Use --file, not a shell redirect.** Windows PowerShell's `>` re-encodes to UTF-16 with a byte-order mark, which psql
 * cannot read. --file writes UTF-8 with no BOM and LF line endings itself, and refuses a path inside this repository —
 * a generated script belongs with the extract, outside version control, and is deleted with it.
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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
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
  ];
  for (const table of Object.keys(CONTRACT)) {
    lines.push(`\\echo ${table}`);
    lines.push(`\\copy (${selectFor(table, omit)}) TO ${quoted(`${directory}/${table}.csv`)} WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')`);
  }
  lines.push("", "COMMIT;");
  return lines.join("\n") + "\n";
}

/** The repository this script sits in. A generated extract script is never written inside it. */
export const REPOSITORY_ROOT = resolve(here, "../../..");

/** Where --file may write: anywhere outside the repository. */
export function assertOutsideRepository(path) {
  const within = relative(REPOSITORY_ROOT, resolve(path));
  if (!within.startsWith("..") && !isAbsolute(within)) {
    throw new Error(`--file ${path}: inside the repository. Write the extract script beside the extract (e.g. <out>/extract.sql), outside version control.`);
  }
}

/** Write the script as UTF-8, no byte-order mark, LF line endings — exactly the bytes psql reads. */
export function writeExtractSql(path, text) {
  assertOutsideRepository(path);
  writeFileSync(path, Buffer.from((text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n"), "utf8"));
}

function main(argv) {
  const values = (flag) => argv.flatMap((item, index) => (item === flag && argv[index + 1] ? [argv[index + 1]] : []));
  const out = values("--out")[0];
  if (!out) throw new Error("Usage: v7-extract-sql.mjs --out <directory for the CSVs> [--file <path for the script>] [--omit <table>.<column>]…");
  const text = extractSql({ out, omit: parseOmit(values("--omit")) });
  const file = values("--file")[0];
  if (!file) { process.stdout.write(text); return; }
  writeExtractSql(file, text);
  process.stderr.write(`Wrote ${file} (UTF-8, no BOM). Next: psql "<live v7 url>" -f ${file}
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`v7-extract-sql: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
