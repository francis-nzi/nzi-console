import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { EXTRACT_CONTRACT, parseV7Csv, readV7Extract, V7_TABLES } from "../src/v7ClientExtract";
// @ts-expect-error — plain .mjs, deliberately untyped: it must run with no toolchain on the extracting machine.
import { assertOutsideRepository, columnsFor, extractSql, parseOmit, parseTables, PARITY_FILE, preflightColumns, QUERY_COLUMNS, REFERENCE_COLUMNS, REPOSITORY_ROOT, V7_RISK_CASE_SQL, v7ClientRiskSql, writeExtractSql } from "../scripts/v7-extract-sql.mjs";
// @ts-expect-error — as above.
import { buildManifest, countCsv } from "../scripts/v7-extract-manifest.mjs";
import { syntheticRows, writeSyntheticExtract } from "./support/v7SyntheticExtract";

/**
 * The v7 extract helpers (Appendix B): the psql script generated from the contract, and the manifest built from the
 * files it writes. The importer and the helpers read one contract file, so what is extracted is what is read.
 */

const here = dirname(fileURLToPath(import.meta.url));
const scripts = resolve(here, "../scripts");
const COPY_LINE = /^\\copy \((.*)\) TO '(.*)' WITH \(FORMAT csv, HEADER true, ENCODING 'UTF8'\)$/;
const selectedColumns = (query: string): string[] => {
  const list = /\) SELECT (.*?) FROM (?:\w+) [rt] (?:JOIN|WHERE|ORDER)/.exec(query)![1]!;
  return list.split(/, (?=r\.|t\.|CASE)/).map((item) => (/ AS (\w+)$/.exec(item)?.[1] ?? item.replace(/^[rt]\./, "")));
};

describe("the v7 extract script, generated from the contract", () => {
  const sql: string = extractSql({ out: "C:\\v7 extract\\", generatedAt: "2026-09-29" });
  const copies = sql.split("\n").filter((line) => line.startsWith("\\copy"));

  it("copies every contract table once, in order, each on one line, into the named directory — then v7's own client Risk", () => {
    // job_plan is a contract table (PR 2), so the parity file is derived beside it, last, in the same snapshot.
    assert.equal(copies.length, V7_TABLES.length + 1);
    copies.forEach((line, index) => {
      const match = COPY_LINE.exec(line);
      assert.ok(match, `not a single-line \\copy: ${line.slice(0, 80)}`);
      assert.equal(match[2], `C:/v7 extract/${index < V7_TABLES.length ? V7_TABLES[index] : PARITY_FILE}.csv`);
    });
  });

  it("selects exactly the importer's columns for each table — the contract round-trips", () => {
    V7_TABLES.forEach((table, index) => {
      const query = COPY_LINE.exec(copies[index]!)![1]!;
      const expected = [...EXTRACT_CONTRACT[table].required, ...EXTRACT_CONTRACT[table].optional];
      assert.deepEqual(selectedColumns(query), expected, `${table}'s column set differs from EXTRACT_CONTRACT`);
      assert.deepEqual(columnsFor(table), expected);
    });
    const scopeRows = COPY_LINE.exec(copies[V7_TABLES.indexOf("job_scope_rows")]!)![1]!;
    for (const column of REFERENCE_COLUMNS) assert.match(scopeRows, new RegExp(`END AS ${column}`), `${column} is computed by the lookup, not read`);
    assert.match(scopeRows, /LEFT JOIN LATERAL .* ref1 ON true LEFT JOIN LATERAL .* ref2 ON true/);
  });

  it("is read-only on v7: a read-only session, UTF-8, stop on error, and no statement that writes", () => {
    assert.match(sql, /^\\set ON_ERROR_STOP on$/m);
    assert.match(sql, /^\\encoding UTF8$/m);
    assert.match(sql, /^SET default_transaction_read_only = on;$/m);
    const code = sql.split("\n").filter((line) => !line.startsWith("--")).join("\n").replace(/'(?:[^']|'')*'/g, "''");
    assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY [a-z_]+ FROM)\b/i);
    assert.doesNotMatch(sql, /\.pdf|clients\/|job_data_uploads/i, "no PDFs, no client-data folders");
  });

  it("runs every \\copy inside one read-only, repeatable-read, time-bounded transaction", () => {
    const lines = sql.split("\n");
    const at = (text: string) => lines.indexOf(text);
    const firstCopy = lines.findIndex((line) => line.startsWith("\\copy"));
    const lastCopy = lines.length - 1 - [...lines].reverse().findIndex((line) => line.startsWith("\\copy"));
    const opening = ["BEGIN ISOLATION LEVEL REPEATABLE READ;", "SET TRANSACTION READ ONLY;",
      "SET LOCAL statement_timeout = '30min';", "SET LOCAL idle_in_transaction_session_timeout = '5min';"];
    opening.forEach((line, index) => {
      assert.ok(at(line) >= 0, `missing: ${line}`);
      assert.ok(at(line) < firstCopy, `${line} must come before the first \\copy`);
      if (index > 0) assert.ok(at(line) > at(opening[index - 1]!), `${line} out of order`);
    });
    assert.ok(at("SET default_transaction_read_only = on;") < at("BEGIN ISOLATION LEVEL REPEATABLE READ;"));
    assert.equal(lines.filter((line) => line.trim()).at(-1), "COMMIT;", "COMMIT closes the script");
    assert.ok(at("COMMIT;") > lastCopy);
    assert.equal(lines.filter((line) => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(line)).length, 2, "one transaction, no other");
  });

  it("leaves out the free-text and personal columns the importer never reads (ruled 28 Sep 2026)", () => {
    const never = ["job_emission_sources.employee_name", "job_emission_sources.source_name", "job_emission_sources.notes",
      "job_emission_sources.detail_json", "job_spend_entries.spend_description", "job_spend_entries.notes"];
    for (const column of never) {
      const [table, name] = column.split(".") as [keyof typeof EXTRACT_CONTRACT, string];
      assert.ok(![...EXTRACT_CONTRACT[table].required, ...EXTRACT_CONTRACT[table].optional].includes(name), `${column} is still in the contract`);
      assert.ok(!selectedColumns(COPY_LINE.exec(copies[V7_TABLES.indexOf(table)]!)![1]!).includes(name), `${column} is still extracted`);
    }
  });

  it("preflights every column it reads — contract and query alike — before the first \\copy, in one statement", () => {
    const lines = sql.split("\n");
    const preflight = lines.findIndex((line) => line.startsWith("DO $preflight$"));
    assert.ok(preflight > lines.indexOf("SET LOCAL idle_in_transaction_session_timeout = '5min';"), "inside the read-only transaction");
    assert.ok(preflight < lines.findIndex((line) => line.startsWith("\\copy")), "before anything is copied");
    assert.match(lines[preflight]!, /RAISE EXCEPTION 'v7 schema drift: % item\(s\) the extract reads are missing: %/);
    const checked = new Set<string>(preflightColumns().map(([table, column]: [string, string]) => `${table}.${column}`));
    for (const table of V7_TABLES) {
      for (const column of [...EXTRACT_CONTRACT[table].required, ...EXTRACT_CONTRACT[table].optional]) {
        if (REFERENCE_COLUMNS.includes(column)) continue;
        assert.ok(checked.has(`${table}.${column}`), `${table}.${column} is read but not preflighted`);
      }
    }
    for (const [table, columns] of Object.entries(QUERY_COLUMNS) as Array<[string, string[]]>) {
      for (const column of columns) assert.ok(checked.has(`${table}.${column}`), `query column ${table}.${column} not preflighted`);
    }
    const omitted = new Set(preflightColumns(parseOmit(["clients.client_manager"])).map(([table, column]: [string, string]) => `${table}.${column}`));
    assert.ok(!omitted.has("clients.client_manager"), "an omitted column is not asked for");
    assert.ok(![...checked].some((pair) => pair.endsWith(".reference_factor")), "computed columns are not table columns");
  });

  it("asks only for what live v7 has — the 28 Sep 2026 information_schema dump", () => {
    // v7 has created_at only on its job-level tables. The contract read clients.created_at, which live v7 lacks; the
    // importer needed nothing from it (the console's own created_at is the import time), so it left the contract.
    for (const table of ["clients", "client_sites", "client_contacts", "job_report_versions"] as const) {
      assert.ok(![...EXTRACT_CONTRACT[table].required, ...EXTRACT_CONTRACT[table].optional].includes("created_at"), `${table} has no created_at in v7`);
    }
    assert.ok(EXTRACT_CONTRACT.jobs.optional.includes("created_at"), "jobs does, and keeps it");
    assert.ok(EXTRACT_CONTRACT.job_report_versions.optional.includes("generated_at"), "report versions carry generated_at instead");
  });

  it("drops an absent optional column on request, and never a required one", () => {
    const omit = parseOmit(["clients.client_manager,job_scope_rows.reference_factor", "report_reviews.published_by"]);
    const trimmed: string = extractSql({ out: "x", omit });
    const line = (table: string) => COPY_LINE.exec(trimmed.split("\n").filter((row) => row.startsWith("\\copy"))[V7_TABLES.indexOf(table as never)]!)![1]!;
    assert.ok(!selectedColumns(line("clients")).includes("client_manager"));
    assert.ok(!selectedColumns(line("job_scope_rows")).includes("reference_factor"));
    assert.ok(selectedColumns(line("job_scope_rows")).includes("reference_ghg_unit"));
    assert.match(trimmed, /-- Omitted optional columns \(absent from this v7\): clients\.client_manager/);
    assert.throws(() => parseOmit(["clients.db_id"]), /required/);
    assert.throws(() => parseOmit(["clients.nonsense"]), /not a column the contract reads/);
    assert.throws(() => parseOmit(["nowhere.db_id"]), /contract table/);
  });
});

describe("a subset extract — job_plan alone, for the milestone backfill (ruled R2)", () => {
  const subset: string = extractSql({ out: "C:/v7-extract", tables: parseTables(["job_plan"]) });
  const copies = subset.split("\n").filter((line) => line.startsWith("\\copy"));

  it("copies job_plan and v7's own client Risk, and nothing else — no client personal data is re-written", () => {
    assert.deepEqual(copies.map((line) => COPY_LINE.exec(line)![2]), ["C:/v7-extract/job_plan.csv", `C:/v7-extract/${PARITY_FILE}.csv`]);
    assert.match(subset, /-- A subset \(--tables\): job_plan\. Build the manifest with the same --tables\./);
  });

  it("keeps decision 8's scope: only the plans of in-scope clients' jobs", () => {
    assert.match(COPY_LINE.exec(copies[0]!)![1]!, /FROM job_plan t WHERE t\.job_id IN \(SELECT job_id FROM aj\)/);
  });

  it("still runs in one read-only, repeatable-read transaction, preflighted first", () => {
    const lines = subset.split("\n");
    const begin = lines.indexOf("BEGIN ISOLATION LEVEL REPEATABLE READ;");
    const preflight = lines.findIndex((line) => line.startsWith("DO $preflight$"));
    const commit = lines.indexOf("COMMIT;");
    assert.ok(begin >= 0 && begin < preflight && preflight < lines.indexOf(copies[0]!) && lines.indexOf(copies[1]!) < commit);
  });

  it("preflights only what the subset reads — job_plan's columns and the scope's, not the factor lookup", () => {
    const checked = new Set<string>(preflightColumns(new Set(), ["job_plan"]).map(([table, column]: [string, string]) => `${table}.${column}`));
    for (const column of [...EXTRACT_CONTRACT.job_plan.required, ...EXTRACT_CONTRACT.job_plan.optional]) assert.ok(checked.has(`job_plan.${column}`), column);
    for (const pair of ["clients.db_id", "clients.status", "clients.archived", "jobs.job_id", "jobs.client_db_id"]) assert.ok(checked.has(pair), pair);
    assert.ok(![...checked].some((pair) => /^(factor_lookup|datasets|job_scope_rows|job_emission|clients\.client_name)/.test(pair)), "nothing the subset does not read");
  });

  it("refuses a table the contract does not name", () => {
    assert.throws(() => parseTables(["job_plans"]), /not a contract table/);
    assert.deepEqual(parseTables([]), V7_TABLES, "none named is every table");
  });

  it("requires the milestone dates and completions, so an omitted one cannot silently read as unfinished", () => {
    for (const kind of ["data_collection", "first_draft", "final_report"]) {
      assert.throws(() => parseOmit([`job_plan.${kind}_due`]), /required/);
      assert.throws(() => parseOmit([`job_plan.${kind}_completed_at`]), /required/);
      assert.doesNotThrow(() => parseOmit([`job_plan.${kind}_completed_by`]));
    }
  });
});

describe("v7's own client Risk, for the parity check (ruled A1)", () => {
  it("is v7's _RISK_CASE_SQL verbatim, with only CURRENT_DATE replaced by the London operating day", () => {
    const sql: string = v7ClientRiskSql();
    const expected = V7_RISK_CASE_SQL.replaceAll("CURRENT_DATE", "od.d").replace(/\s+/g, " ").trim();
    assert.ok(sql.includes(expected), "the rule is v7's, character for character bar the day");
    assert.doesNotMatch(sql, /CURRENT_DATE/, "never v7's UTC clock");
    assert.match(sql, /od AS \(SELECT \(now\(\) AT TIME ZONE 'Europe\/London'\)::date AS d\)/);
    assert.equal((V7_RISK_CASE_SQL.match(/CURRENT_DATE/g) ?? []).length, 6, "six comparisons in v7's rule, all substituted");
  });

  it("rolls up over every job of the client, as v7's list does — no status predicate", () => {
    assert.match(v7ClientRiskSql(), /FROM ac c CROSS JOIN od LEFT JOIN jobs j ON j\.client_db_id = c\.db_id LEFT JOIN job_plan jp ON jp\.job_id = j\.job_id GROUP BY c\.db_id, od\.d/);
  });
});

describe("the v7 extract manifest, built from the written files", () => {
  it("counts records as the importer's reader does — quoted newlines, doubled quotes, NULL rows", () => {
    const text = 'a,b\n"x\ny","1 ""q"""\n,\n"",\n';
    assert.equal(countCsv(text).rows, parseV7Csv(text).rows.length);
    assert.deepEqual(countCsv(text), { header: ["a", "b"], rows: 2 });
    assert.deepEqual(countCsv("a,b\n"), { header: ["a", "b"], rows: 0 });
  });

  it("reproduces the extract's manifest exactly, and the importer reads the extract clean", () => {
    const directory = mkdtempSync(join(tmpdir(), "v7-manifest-"));
    try {
      writeSyntheticExtract(directory);
      const expected = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
      unlinkSync(join(directory, "manifest.json"));
      const { manifest, problems } = buildManifest(directory, { extractedAt: "synthetic" });
      assert.deepEqual(problems, []);
      assert.deepEqual(manifest.tables, expected.tables, "every file's rows and sha256 as the writer recorded them");
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
      assert.deepEqual(readV7Extract(directory).problems, []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });


  it("records a subset and its parity file, and a subset reader refuses any other table", () => {
    const directory = mkdtempSync(join(tmpdir(), "v7-manifest-"));
    try {
      writeSyntheticExtract(directory);
      const { manifest, problems } = buildManifest(directory, { extractedAt: "synthetic", only: ["job_plan"] });
      assert.deepEqual(problems, []);
      assert.deepEqual(Object.keys(manifest.tables), ["job_plan"]);
      assert.deepEqual(manifest.subset, ["job_plan"]);
      assert.equal(manifest.derived.v7_client_risk.rows, 2);
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
      const read = readV7Extract(directory, { tables: ["job_plan"] });
      assert.deepEqual(read.problems, []);
      assert.equal(read.extract.job_plan.length, 3);
      assert.equal(read.parity?.length, 2);
      assert.match(readV7Extract(directory, { tables: ["clients"] }).problems[0]!, /a subset \(job_plan\) and does not include it/);
      assert.ok(readV7Extract(directory).problems.length > 0, "a whole-extract reader refuses a subset");

      unlinkSync(join(directory, "v7_client_risk.csv"));
      assert.match(buildManifest(directory, { only: ["job_plan"] }).problems.join(), /v7_client_risk\.csv: missing/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a parity file that does not hash to the manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "v7-manifest-"));
    try {
      writeSyntheticExtract(directory);
      writeFileSync(join(directory, "v7_client_risk.csv"), "client_db_id,operating_day,v7_milestone_status\n1,2026-09-29,green\n2,2026-09-29,red\n");
      assert.match(readV7Extract(directory, { tables: ["job_plan"] }).problems.join(), /v7_client_risk: v7_client_risk\.csv does not hash/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records a header-only file as zero rows, and refuses a missing file or a missing required column", () => {
    const directory = mkdtempSync(join(tmpdir(), "v7-manifest-"));
    try {
      const rows = syntheticRows();
      rows.lca_assessments = [];
      writeSyntheticExtract(directory, rows);
      assert.equal(buildManifest(directory).manifest.tables.lca_assessments.rows, 0);

      const csv = join(directory, "jobs.csv");
      writeFileSync(csv, readFileSync(csv, "utf8").replace(/^job_id,/, "jobid,"));
      unlinkSync(join(directory, "datasets.csv"));
      assert.deepEqual(buildManifest(directory).problems, [
        "jobs.csv: lacks required column(s) job_id",
        "datasets.csv: missing — every contract table needs a file, header-only when nothing is in scope",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("writing the script with --file — the bytes psql reads, never a shell's re-encoding", () => {
  it("writes UTF-8 with no byte-order mark and LF endings, byte-identical to what stdout gives", () => {
    const directory = mkdtempSync(join(tmpdir(), "v7-file-"));
    try {
      const path = join(directory, "extract.sql");
      const run = spawnSync(process.execPath, [join(scripts, "v7-extract-sql.mjs"), "--out", "C:/v7-extract", "--file", path], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stderr, /\(UTF-8, no BOM\)\. Next: psql/);
      const bytes = readFileSync(path);
      assert.equal(bytes.subarray(0, 2).toString("latin1"), "--", "starts with the comment, not a byte-order mark");
      assert.ok(!bytes.includes(Buffer.from("\r\n")), "LF only");
      assert.ok(!bytes.includes(0), "no NUL bytes — not UTF-16");
      const stdout = spawnSync(process.execPath, [join(scripts, "v7-extract-sql.mjs"), "--out", "C:/v7-extract"], { encoding: "utf8" }).stdout;
      assert.equal(bytes.toString("utf8"), stdout);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("normalises a BOM or CRLF away, and refuses to write inside the repository", () => {
    const directory = mkdtempSync(join(tmpdir(), "v7-file-"));
    try {
      const path = join(directory, "extract.sql");
      writeExtractSql(path, "\uFEFF-- a\r\n\\echo x\r\n");
      assert.deepEqual([...readFileSync(path)], [...Buffer.from("-- a\n\\echo x\n", "utf8")]);
      assert.throws(() => assertOutsideRepository(join(REPOSITORY_ROOT, "extract.sql")), /inside the repository/);
      assert.throws(() => assertOutsideRepository(join(REPOSITORY_ROOT, "packages", "x.sql")), /inside the repository/);
      assert.doesNotThrow(() => assertOutsideRepository(path));
      const refused = spawnSync(process.execPath, [join(scripts, "v7-extract-sql.mjs"), "--out", "x", "--file", join(REPOSITORY_ROOT, "extract.sql")], { encoding: "utf8" });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /inside the repository/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the helpers run on bare Node, with nothing installed", () => {
  it("generates the script and writes the manifest with `node` alone — no tsx, no loader", () => {
    const directory = mkdtempSync(join(tmpdir(), "v7-bare-"));
    try {
      const generated = spawnSync(process.execPath, [join(scripts, "v7-extract-sql.mjs"), "--out", directory], { encoding: "utf8" });
      assert.equal(generated.status, 0, generated.stderr);
      assert.equal(generated.stdout.split("\n").filter((line) => line.startsWith("\\copy")).length, V7_TABLES.length + 1);
      const usage = spawnSync(process.execPath, [join(scripts, "v7-extract-sql.mjs")], { encoding: "utf8" });
      assert.equal(usage.status, 1);

      writeSyntheticExtract(directory);
      unlinkSync(join(directory, "manifest.json"));
      const built = spawnSync(process.execPath, [join(scripts, "v7-extract-manifest.mjs"), directory], { encoding: "utf8" });
      assert.equal(built.status, 0, built.stderr);
      assert.match(built.stdout, /manifest\.json written — extract sha256 [0-9a-f]{64}/);
      assert.deepEqual(readV7Extract(directory).problems, []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
