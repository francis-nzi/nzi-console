import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { EXTRACT_CONTRACT, parseV7Csv, readV7Extract, V7_TABLES } from "../src/v7ClientExtract";
// @ts-expect-error — plain .mjs, deliberately untyped: it must run with no toolchain on the extracting machine.
import { columnsFor, extractSql, parseOmit, REFERENCE_COLUMNS } from "../scripts/v7-extract-sql.mjs";
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

  it("copies every contract table once, in order, each on one line, into the named directory", () => {
    assert.equal(copies.length, V7_TABLES.length);
    copies.forEach((line, index) => {
      const match = COPY_LINE.exec(line);
      assert.ok(match, `not a single-line \\copy: ${line.slice(0, 80)}`);
      assert.equal(match[2], `C:/v7 extract/${V7_TABLES[index]}.csv`);
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

describe("the helpers run on bare Node, with nothing installed", () => {
  it("generates the script and writes the manifest with `node` alone — no tsx, no loader", () => {
    const directory = mkdtempSync(join(tmpdir(), "v7-bare-"));
    try {
      const generated = spawnSync(process.execPath, [join(scripts, "v7-extract-sql.mjs"), "--out", directory], { encoding: "utf8" });
      assert.equal(generated.status, 0, generated.stderr);
      assert.equal(generated.stdout.split("\n").filter((line) => line.startsWith("\\copy")).length, V7_TABLES.length);
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
