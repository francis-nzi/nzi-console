#!/usr/bin/env node
/**
 * Write `manifest.json` for a v7 extract directory (docs/CLIENT_JOB_IMPORT_DESIGN.md Appendix B).
 *
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract
 *
 * Plain Node, no dependencies. For every table in `src/v7ExtractContract.json` it reads `<table>.csv`, counts its
 * records the way the importer's reader does (a quoted field may hold commas and newlines, so lines are not records),
 * and records the file's SHA-256. A header-only file — a table with nothing in scope — is `"rows": 0`.
 *
 * It refuses, writing no manifest, when a file is missing, has no header, or lacks a column the importer requires: the
 * importer would refuse that extract anyway, and a manifest is a claim that the extract is whole.
 *
 * **A subset** (`--tables job_plan`, ruled R2): only the named tables are required, and the manifest says so under
 * `subset` — a reader then knows the extract is whole *for those tables* and nothing more. When `job_plan` is in the
 * extract, v7's own client Risk (`v7_client_risk.csv`, the parity check) is required too, and recorded under `derived`.
 *
 * Read-only on the files; it writes only `manifest.json` beside them.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(resolve(here, "../src/v7ExtractContract.json"), "utf8"));

/**
 * Header and record count, parsed as `COPY … CSV` writes and as `parseV7Csv` reads: quoted fields may hold commas,
 * doubled quotes and newlines; a record whose every field is unquoted-empty (NULL) is not counted, as the reader skips it.
 */
export function countCsv(text) {
  const body = text.replace(/^\uFEFF/, "");
  let header = null;
  let records = 0;
  let field = "", quoted = false, inQuotes = false, record = [];
  const endField = () => { record.push(quoted || field !== "" ? field : null); field = ""; quoted = false; };
  const endRecord = () => {
    endField();
    if (record.some((cell) => cell !== null)) {
      if (header === null) header = record.map((cell) => (cell ?? "").trim());
      else records += 1;
    }
    record = [];
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (inQuotes) {
      if (char === "\"" && body[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") inQuotes = false;
      else field += char;
    } else if (char === "\"") { inQuotes = true; quoted = true; }
    else if (char === ",") endField();
    else if (char === "\n" || char === "\r") { if (char === "\r" && body[index + 1] === "\n") index += 1; endRecord(); }
    else field += char;
  }
  if (field !== "" || quoted || record.length > 0) endRecord();
  return { header, rows: records };
}

const PARITY_FILE = "v7_client_risk";
const PARITY_COLUMNS = ["client_db_id", "operating_day", "v7_milestone_status"];

export function buildManifest(directory, { extractedAt = new Date().toISOString().slice(0, 10), only = Object.keys(CONTRACT) } = {}) {
  const problems = [];
  const tables = {};
  for (const [table, entry] of Object.entries(CONTRACT)) {
    if (!only.includes(table)) continue;
    const file = `${table}.csv`;
    const path = join(directory, file);
    if (!existsSync(path)) { problems.push(`${file}: missing — every contract table needs a file, header-only when nothing is in scope`); continue; }
    const bytes = readFileSync(path);
    const { header, rows } = countCsv(bytes.toString("utf8"));
    if (!header) { problems.push(`${file}: no header row`); continue; }
    const missing = entry.required.filter((column) => !header.includes(column));
    if (missing.length) problems.push(`${file}: lacks required column(s) ${missing.join(", ")}`);
    tables[table] = { file, rows, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const subset = only.length < Object.keys(CONTRACT).length ? only : undefined;
  let derived;
  if (only.includes("job_plan")) {
    const file = `${PARITY_FILE}.csv`;
    const path = join(directory, file);
    if (!existsSync(path)) problems.push(`${file}: missing — v7's own client Risk is written beside job_plan, for the parity check`);
    else {
      const bytes = readFileSync(path);
      const { header, rows } = countCsv(bytes.toString("utf8"));
      const missing = PARITY_COLUMNS.filter((column) => !(header ?? []).includes(column));
      if (missing.length) problems.push(`${file}: lacks column(s) ${missing.join(", ")}`);
      derived = { [PARITY_FILE]: { file, rows, sha256: createHash("sha256").update(bytes).digest("hex") } };
    }
  }
  return { manifest: { extractedAt, ...(subset ? { subset } : {}), tables, ...(derived ? { derived } : {}) }, problems };
}

/** `--tables`, as the SQL generator reads it: contract tables in contract order; none means every table. */
export function parseTables(values) {
  const named = values.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  if (named.length === 0) return Object.keys(CONTRACT);
  for (const table of named) if (!CONTRACT[table]) throw new Error(`--tables ${table}: not a contract table`);
  return Object.keys(CONTRACT).filter((table) => named.includes(table));
}

function main(argv) {
  const directory = argv[0];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: v7-extract-manifest.mjs <extract directory> [--tables <table>[,…]]");
  const only = parseTables(argv.flatMap((item, index) => (item === "--tables" && argv[index + 1] ? [argv[index + 1]] : [])));
  const { manifest, problems } = buildManifest(directory, { only });
  if (problems.length) throw new Error(`no manifest written:\n  ${problems.join("\n  ")}`);
  const text = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(directory, "manifest.json"), text, "utf8");
  for (const [table, entry] of [...Object.entries(manifest.tables), ...Object.entries(manifest.derived ?? {})]) process.stdout.write(`  ${table.padEnd(22)} ${String(entry.rows).padStart(7)} rows  ${entry.sha256.slice(0, 16)}…\n`);
  if (manifest.subset) process.stdout.write(`  (a subset: ${manifest.subset.join(", ")})\n`);
  process.stdout.write(`\nmanifest.json written — extract sha256 ${createHash("sha256").update(text).digest("hex")}\n`);
  process.stdout.write(`Compare the row counts with psql's COPY n lines. Next: npm run ${manifest.subset?.includes("job_plan") ? "load:v7-milestones" : "load:v7-clients"} -- <directory> (a dry run).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`v7-extract-manifest: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
