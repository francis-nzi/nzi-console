import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
 * What the importer reads from each file. `required` columns must be in the header or the load refuses — a live
 * schema that differs from the code's is a refusal at dry run, never a silent NULL. `optional` columns are read when
 * present (v7 adds columns on first use, so not every deployment has all of them).
 *
 * Columns that carry personal data or free text are listed because the importer must *handle* them — seal them, or
 * read a token out of them and drop the rest. What reaches the console from each is stated in the plan, not here.
 */
export const EXTRACT_CONTRACT = {
  clients: {
    required: ["db_id", "client_name", "status", "archived"],
    optional: ["industry", "description_long", "website", "year_end_month", "company_reg", "headquarters", "addr_line1",
      "addr_line2", "addr_city", "addr_region", "addr_postcode", "addr_country", "currency", "crm_owner", "client_manager",
      "portfolio", "referral", "net_zero_year", "interim_year", "interim_s1_pct", "interim_s2_pct", "interim_s3_pct",
      "target_s1_year", "target_s1_pct", "target_s2_year", "target_s2_pct", "target_s3_year", "target_s3_pct",
      "benchmark_year", "benchmark_period_start", "benchmark_period_end", "benchmark_scope_1_tco2e",
      "benchmark_scope_2_tco2e", "benchmark_scope_3_tco2e", "benchmark_total_tco2e", "created_at"],
  },
  client_sites: {
    required: ["site_id", "client_db_id", "site_name"],
    optional: ["location", "is_registered_office", "vacated_date", "archived", "latitude", "longitude"],
  },
  client_contacts: {
    required: ["contact_id", "client_db_id", "full_name"],
    optional: ["job_title", "email", "phone", "is_primary"],
  },
  job_types: {
    required: ["job_type_id", "name"],
    optional: ["job_family", "job_group", "is_crp"],
  },
  jobs: {
    required: ["job_id", "client_db_id", "job_number", "status"],
    optional: ["job_type_id", "job_type", "title", "legacy_job_no", "reporting_year", "reporting_period_start",
      "reporting_period_end", "start_date", "due_date", "crm_name", "archived", "created_at"],
  },
  crp_job_details: {
    required: ["job_id"],
    optional: ["reporting_period_from", "reporting_period_to"],
  },
  datasets: {
    required: ["dataset_id"],
    optional: ["year", "version"],
  },
  job_scope_rows: {
    required: ["row_id", "job_id", "scope", "original_id", "qty", "uom", "factor", "ghg_unit", "enabled"],
    optional: ["site_id", "dataset_id", "factor_db_id", "category", "level_1", "level_2", "level_3", "level_4",
      "column_text", "report_label", "notes", "apply_pct", ...Array.from({ length: 12 }, (_, index) => `month_${index + 1}`),
      "calc_tco2e", "override_tco2e", "data_source", "data_confidence", "is_custom_entry", "linked_row_id",
      "is_auto_generated", "auto_pair_kind", "review_status",
      // The factor-lookup reference v7 reads at report time (services/monthly_emissions.py row_metrics), computed by
      // the extract query (Appendix B). Only consulted where v7's unit or fallback decision depends on it.
      "reference_factor", "reference_ghg_unit"],
  },
  job_emission_groups: {
    required: ["group_id", "job_id"],
    optional: ["dataset_id", "factor_db_id", "original_id", "factor", "ghg_unit", "uom", "enabled"],
  },
  job_emission_sources: {
    required: ["source_id", "job_id", "scope", "source_type", "enabled"],
    optional: ["group_id", "source_subtype", "site_id", "category", "dataset_id", "factor_db_id", "original_id", "qty",
      "uom", "factor", "ghg_unit", "apply_pct", "calc_tco2e", "data_source", "data_confidence", "review_status",
      "employee_name", "source_name", "notes", "detail_json"],
  },
  job_spend_entries: {
    required: ["entry_id", "job_id", "amount_gross", "is_deleted"],
    optional: ["site_id", "factor_db_id", "factor_original_id", "mapped_scope", "conversion_currency", "currency",
      "submitted_by_portal", "review_status", "estimated_emissions_tco2e", "spend_description", "notes"],
  },
  lca_assessments: {
    required: ["assessment_id", "job_id", "review_status"],
    optional: ["resolved_lines_snapshot", "total_tco2e"],
  },
  job_report_versions: {
    required: ["report_version_id", "job_id", "version_number", "status", "snapshot_json", "data_hash"],
    optional: ["report_format", "version_label", "notes", "file_name", "file_path", "storage_provider",
      "external_item_id", "external_web_url", "external_path", "generated_at", "generated_by", "reviewed_at",
      "reviewed_by", "finalized_at", "finalized_by", "superseded_at", "superseded_by"],
  },
  report_reviews: {
    required: ["job_id", "portal_version_id"],
    optional: ["status", "approved_by_name", "approved_by_email", "published_at", "published_by"],
  },
} as const satisfies Record<string, { required: readonly string[]; optional: readonly string[] }>;

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
  tables: Partial<Record<V7Table, { file: string; rows: number; sha256: string }>>;
};

export type ReadExtract = {
  extract: V7Extract;
  /** SHA-256 of `manifest.json` as written — the extract's identity, recorded on every audit event of the run. */
  extractSha256: string;
  /** Each file's header, for the contract check the plan makes. */
  headers: Partial<Record<V7Table, string[]>>;
  /** A file whose bytes or row count disagree with the manifest, or a table the manifest does not name. */
  problems: string[];
};

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Read an extract directory. Everything that is wrong with it is returned, not thrown, so a dry run lists it all. */
export function readV7Extract(directory: string): ReadExtract {
  const manifestBytes = readFileSync(join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as ExtractManifest;
  const problems: string[] = [];
  const headers: Partial<Record<V7Table, string[]>> = {};
  const extract = {} as Record<V7Table, V7Row[]>;
  for (const table of V7_TABLES) {
    const entry = manifest.tables?.[table];
    if (!entry) { problems.push(`${table}: not in the manifest`); extract[table] = []; continue; }
    const bytes = readFileSync(join(directory, entry.file));
    if (sha256(bytes) !== entry.sha256) problems.push(`${table}: ${entry.file} does not hash to the manifest's sha256`);
    const parsed = parseV7Csv(bytes.toString("utf8"));
    if (parsed.rows.length !== entry.rows) problems.push(`${table}: ${parsed.rows.length} rows, the manifest says ${entry.rows}`);
    headers[table] = parsed.header;
    extract[table] = parsed.rows;
  }
  return { extract, extractSha256: sha256(manifestBytes), headers, problems };
}

/** The columns a header lacks, against the contract. */
export const missingColumns = (table: V7Table, header: readonly string[]): string[] =>
  EXTRACT_CONTRACT[table].required.filter((column) => !header.includes(column));
