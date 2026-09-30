import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Data, not code: the zero-dependency extract helpers (scripts/v7-extract-sql.mjs, v7-extract-manifest.mjs) read this
// same file with plain Node on the machine that takes the extract, where the TypeScript toolchain may not install.
import contract from "./v7ExtractContract.json";

/**
 * The v7 client-and-job extract (docs/CLIENT_JOB_IMPORT_DESIGN.md §8, Appendix B): one CSV per table, written by
 * `\copy (…) TO … CSV HEADER` on live v7, read-only, plus a `manifest.json` naming each file with its row count and
 * SHA-256. Never committed (NZC-020).
 *
 * This module reads it and nothing else: the contract of which columns each file must carry, a CSV reader that keeps
 * SQL NULL apart from the empty string, and the manifest check. The plan (`v7ClientImport`) works on what comes out.
 */

/** One extracted row: a column is a string, or null where v7 held NULL. Nothing coerced yet. */
export type V7Row = Readonly<Record<string, string | null>>;
export type V7Extract = Readonly<Record<V7Table, readonly V7Row[]>>;

/**
 * How the extract selects each table's rows (Appendix B): in-scope clients, their jobs, and what those reference.
 */
export type ExtractFilter = "active-clients" | "client" | "job" | "job-with-reference" | "referenced-datasets" | "all";
/** `keys` / `keyColumn`: the `keys` filter's allow-list (admin D2) — only those rows are copied. */
export type ExtractTableContract = { filter: string; required: readonly string[]; optional: readonly string[]; keyColumn?: string; keys?: readonly string[] };

/**
 * What the importer reads from each file. `required` columns must be in the header or the load refuses — a live
 * schema that differs from the code's is a refusal at dry run, never a silent NULL. `optional` columns are read when
 * present (v7 adds columns on first use, so not every deployment has all of them).
 *
 * Columns that carry personal data or free text are listed because the importer must *handle* them — seal them, or
 * read a token out of them and drop the rest. What reaches the console from each is stated in the plan, not here.
 */
export const EXTRACT_CONTRACT = contract satisfies Record<string, ExtractTableContract>;

export type V7Table = keyof typeof EXTRACT_CONTRACT;
export const V7_TABLES = Object.keys(EXTRACT_CONTRACT) as V7Table[];

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * RFC 4180, as `COPY … CSV` writes it: an **unquoted empty field is NULL**, a quoted empty field (`""`) is the empty
 * string. Kept apart because v7 distinguishes them and `snapshot_json` must come back byte for byte.
 */
export function parseV7Csv(text: string): { header: string[]; rows: V7Row[] } {
  const records: Array<Array<string | null>> = [];
  let field = "";
  let quotedField = false;
  let record: Array<string | null> = [];
  let inQuotes = false;
  const body = text.replace(/^﻿/, "");
  const endField = () => { record.push(quotedField || field !== "" ? field : null); field = ""; quotedField = false; };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (inQuotes) {
      if (char === "\"" && body[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") inQuotes = false;
      else field += char;
    } else if (char === "\"") { inQuotes = true; quotedField = true; }
    else if (char === ",") endField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index += 1;
      endField();
      if (record.some((cell) => cell !== null)) records.push(record);
      record = [];
    } else field += char;
  }
  endField();
  if (record.some((cell) => cell !== null)) records.push(record);
  const [header, ...rows] = records;
  if (!header) return { header: [], rows: [] };
  const names = header.map((name) => (name ?? "").trim());
  return { header: names, rows: rows.map((cells) => Object.fromEntries(names.map((name, column) => [name, cells[column] ?? null]))) };
}

// ── The manifest ────────────────────────────────────────────────────────────────────────────────────────────

export type ExtractManifest = {
  /** When and by whom it was taken — free text is not needed and not read. */
  extractedAt?: string;
  /** Present when the extract took only some tables (`--tables`, ruled R2): whole for these, and nothing else. */
  subset?: V7Table[];
  tables: Partial<Record<V7Table, { file: string; rows: number; sha256: string }>>;
  /** Files derived in the same snapshot rather than copied from a table — v7's own client Risk, for the parity check. */
  derived?: Partial<Record<"v7_client_risk", { file: string; rows: number; sha256: string }>>;
};

export type ReadExtract = {
  extract: V7Extract;
  /** SHA-256 of `manifest.json` as written — the extract's identity, recorded on every audit event of the run. */
  extractSha256: string;
  /** Each file's header, for the contract check the plan makes. */
  headers: Partial<Record<V7Table, string[]>>;
  /** A file whose bytes or row count disagree with the manifest, or a table the manifest does not name. */
  problems: string[];
  /** v7's own client Risk (the parity file), when the extract carries one — verified like any table. */
  parity: V7Row[] | null;
};

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * Read an extract directory. Everything that is wrong with it is returned, not thrown, so a dry run lists it all.
 *
 * `tables` reads only those (the milestone backfill reads `job_plan`); a manifest that says it is a subset is refused
 * for any table outside it, so a reader can never mistake a partial extract for a whole one.
 */
export function readV7Extract(directory: string, options: { tables?: readonly V7Table[] } = {}): ReadExtract {
  const manifestBytes = readFileSync(join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as ExtractManifest;
  const problems: string[] = [];
  const headers: Partial<Record<V7Table, string[]>> = {};
  const extract = {} as Record<V7Table, V7Row[]>;
  for (const table of V7_TABLES) extract[table] = [];
  for (const table of options.tables ?? V7_TABLES) {
    if (manifest.subset && !manifest.subset.includes(table)) { problems.push(`${table}: the extract is a subset (${manifest.subset.join(", ")}) and does not include it`); continue; }
    const entry = manifest.tables?.[table];
    if (!entry) { problems.push(`${table}: not in the manifest`); extract[table] = []; continue; }
    const bytes = readFileSync(join(directory, entry.file));
    if (sha256(bytes) !== entry.sha256) problems.push(`${table}: ${entry.file} does not hash to the manifest's sha256`);
    const parsed = parseV7Csv(bytes.toString("utf8"));
    if (parsed.rows.length !== entry.rows) problems.push(`${table}: ${parsed.rows.length} rows, the manifest says ${entry.rows}`);
    headers[table] = parsed.header;
    extract[table] = parsed.rows;
  }
  let parity: V7Row[] | null = null;
  const derived = manifest.derived?.v7_client_risk;
  if (derived) {
    const bytes = readFileSync(join(directory, derived.file));
    if (sha256(bytes) !== derived.sha256) problems.push(`v7_client_risk: ${derived.file} does not hash to the manifest's sha256`);
    parity = parseV7Csv(bytes.toString("utf8")).rows;
    if (parity.length !== derived.rows) problems.push(`v7_client_risk: ${parity.length} rows, the manifest says ${derived.rows}`);
  }
  return { extract, extractSha256: sha256(manifestBytes), headers, problems, parity };
}

/** The columns a header lacks, against the contract. */
export const missingColumns = (table: V7Table, header: readonly string[]): string[] =>
  EXTRACT_CONTRACT[table].required.filter((column) => !header.includes(column));
