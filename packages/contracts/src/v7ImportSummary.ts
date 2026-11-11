import type { CommandIssue } from "./commands";

/**
 * The import workbench, Phase 1 (BRIEF-v7-import-workbench-phase1; DESIGN-v7-import-workbench): the reconciliation summary of
 * one job — what the console holds of the previous system's records against what that system holds now, row by row.
 *
 * Diff-at-the-edge (provisional R-A): the extract never reaches the service. The operator's machine reads the extract and the
 * console's rows, and only this summary is uploaded. It is **closed by construction**: every key is listed below, every string
 * is an id or a code of a fixed shape, and a summary carrying anything else — a label, a name, a quantity, a free-text field —
 * is refused, not trimmed. It carries no client name, contact, address or activity row: ids, codes, statuses and tCO2e only.
 */

export const V7_IMPORT_SUMMARY_FORMAT = "nzi.import-summary/1";
export const V7_IMPORT_SOURCE_SYSTEM = "nzi-pro-v7";

/**
 * Each row's state against the console's copy:
 *   matched             — the console's copy equals the record now;
 *   changed             — the record moved, but nothing the crosswalk keyed on: the re-sync and re-plan carry it;
 *   needs-mapping       — the record moved in what the crosswalk keyed on (scope, unit, factor, dataset): a person maps it;
 *   new                 — in the previous system, not in the console: a person maps it;
 *   withdrawn           — on in the console, gone from the previous system: a person confirms it goes off;
 *   linked-pair-changed — a changed, new or withdrawn row of an auto-generated pair: a person decides how the pair carries.
 */
export const V7_IMPORT_ROW_STATUSES = ["matched", "changed", "needs-mapping", "new", "withdrawn", "linked-pair-changed"] as const;
export type V7ImportRowStatus = (typeof V7_IMPORT_ROW_STATUSES)[number];

/** The job's verdict: blocked on a pair outranks needing a mapping, which outranks clean. */
export const V7_IMPORT_VERDICTS = ["clean", "needs-mapping", "blocked-on-pairs"] as const;
export type V7ImportVerdict = (typeof V7_IMPORT_VERDICTS)[number];

export type V7ImportScope = "1" | "2" | "3";
export const V7_IMPORT_SCOPES: readonly V7ImportScope[] = ["1", "2", "3"];

/**
 * The columns a row's comparison may name (the loader's compared columns), and the crosswalk keys inside the stored record.
 * Names only — never a value.
 */
export const V7_IMPORT_CHANGED_FIELDS = [
  "job_id", "scope", "source_label", "report_label", "level_1", "level_2", "level_3", "level_4", "column_text", "quantity", "unit",
  "dataset_id", "factor_id", "calculated_tco2e", "review_status", "enabled", "apply_pct", "data_confidence", "site_id",
  "is_auto_generated", "auto_pair_kind", "linked_row_id", "provenance_json", "lineage_json", "origin", "migrated_record",
  "migrated_record.uom", "migrated_record.dataset", "migrated_record.factor_db_id", "migrated_record.original_id",
  "migrated_record.ghg_unit", "migrated_record.factor",
] as const;

export type V7ImportSummaryRow = {
  /** The import identity: the previous system and its record id. */
  sourceSystem: typeof V7_IMPORT_SOURCE_SYSTEM; legacyDbId: string;
  status: V7ImportRowStatus;
  /** The factor code the record names (its `original_id`), or null — gone from the previous system, or none. */
  code: string | null;
  /** The record's scope now, or the console's for a withdrawn row. */
  scope: V7ImportScope;
  /** The console copy's scope, or null when the console has no copy. */
  consoleScope: V7ImportScope | null;
  /** Reported tCO2e on each side; null where that side has no row. */
  v7Figure: number | null; consoleFigure: number | null;
  v7Enabled: boolean | null; consoleEnabled: boolean | null;
  /** The console's current row id for it (`v7-row-…`), or null when new. */
  consoleRowId: string | null;
  /** The row it is paired with (an auto-generated pair), or null. */
  pairRef: string | null;
  /** The compared columns that differ — names only. */
  changedFields: string[];
};
export const V7_IMPORT_SUMMARY_ROW_KEYS = ["sourceSystem", "legacyDbId", "status", "code", "scope", "consoleScope", "v7Figure", "consoleFigure",
  "v7Enabled", "consoleEnabled", "consoleRowId", "pairRef", "changedFields"] as const;

export type V7ImportCounts = { matched: number; changed: number; needsMapping: number; new: number; withdrawn: number; linkedPairChanged: number };
export type V7ImportScopeTotals = Record<V7ImportScope, { consoleRows: number; consoleTco2e: number; v7Rows: number; v7Tco2e: number }>;

export type V7ImportSummary = {
  format: typeof V7_IMPORT_SUMMARY_FORMAT;
  /** The console's job, and its J number. */
  jobId: string; legacyJobNumber: string;
  /** The one-job extract the summary was made from (its manifest sha256). */
  extractSha256: string;
  generatedAt: string;
  rows: V7ImportSummaryRow[];
  counts: V7ImportCounts; scopeTotals: V7ImportScopeTotals; verdict: V7ImportVerdict;
};
export const V7_IMPORT_SUMMARY_KEYS = ["format", "jobId", "legacyJobNumber", "extractSha256", "generatedAt", "rows", "counts", "scopeTotals", "verdict"] as const;

export const V7_IMPORT_MAX_ROWS = 5000;
const LEGACY_DB_ID = /^(source:)?[0-9A-Za-z_-]{1,64}$/;
const ROW_ID = /^v7-(row|source)-[0-9A-Za-z_-]{1,80}$/;
const CODE = /^[0-9A-Za-z_.:-]{1,64}$/;
const JOB_NUMBER = /^J\d{6}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const COUNT_KEY: Record<V7ImportRowStatus, keyof V7ImportCounts> = {
  matched: "matched", changed: "changed", "needs-mapping": "needsMapping", new: "new", withdrawn: "withdrawn", "linked-pair-changed": "linkedPairChanged",
};
export const v7ImportCountKey = (status: V7ImportRowStatus): keyof V7ImportCounts => COUNT_KEY[status];
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** The counts, per-scope Σ and verdict a summary's rows imply. The emitter writes them; the upload recomputes and compares. */
export function deriveV7ImportTotals(rows: readonly V7ImportSummaryRow[]): Pick<V7ImportSummary, "counts" | "scopeTotals" | "verdict"> {
  const counts: V7ImportCounts = { matched: 0, changed: 0, needsMapping: 0, new: 0, withdrawn: 0, linkedPairChanged: 0 };
  const scopeTotals = Object.fromEntries(V7_IMPORT_SCOPES.map((scope) => [scope, { consoleRows: 0, consoleTco2e: 0, v7Rows: 0, v7Tco2e: 0 }])) as V7ImportScopeTotals;
  for (const row of rows) {
    counts[COUNT_KEY[row.status]] += 1;
    if (row.v7Enabled && row.v7Figure !== null) { scopeTotals[row.scope].v7Rows += 1; scopeTotals[row.scope].v7Tco2e += row.v7Figure; }
    if (row.consoleEnabled && row.consoleFigure !== null && row.consoleScope) {
      scopeTotals[row.consoleScope].consoleRows += 1; scopeTotals[row.consoleScope].consoleTco2e += row.consoleFigure;
    }
  }
  for (const entry of Object.values(scopeTotals)) { entry.v7Tco2e = round6(entry.v7Tco2e); entry.consoleTco2e = round6(entry.consoleTco2e); }
  const verdict: V7ImportVerdict = counts.linkedPairChanged > 0 ? "blocked-on-pairs" : counts.needsMapping + counts.new > 0 ? "needs-mapping" : "clean";
  return { counts, scopeTotals, verdict };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e12;
const nullableFigure = (value: unknown) => value === null || finite(value);
const nullableBoolean = (value: unknown) => value === null || typeof value === "boolean";
const nullableMatch = (value: unknown, pattern: RegExp) => value === null || (typeof value === "string" && pattern.test(value));
const scopeOf = (value: unknown): value is V7ImportScope => typeof value === "string" && (V7_IMPORT_SCOPES as readonly string[]).includes(value);
const extraKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).filter((key) => !allowed.includes(key));
/** JSON with every object's keys in order, so two equal values compare equal whatever order they were written in. */
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : isRecord(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value ?? null);

/** One row's shape and its status's rule (what each side must hold). An issue names the row by its position, never by content. */
function rowIssues(row: unknown, at: number): CommandIssue[] {
  const field = `rows[${at}]`;
  const bad = (message: string): CommandIssue[] => [{ field, code: "INVALID_ROW", message }];
  if (!isRecord(row)) return bad("Each row is an object.");
  const extra = extraKeys(row, V7_IMPORT_SUMMARY_ROW_KEYS);
  // The PII guard: a row carries the listed keys and nothing else. The unknown key is named, its value never.
  if (extra.length) return [{ field, code: "UNKNOWN_FIELD", message: `A summary row carries only ids, codes, statuses and figures; it has ${extra.slice(0, 5).join(", ")}.` }];
  if (row.sourceSystem !== V7_IMPORT_SOURCE_SYSTEM) return bad("The source system is the previous system's code.");
  if (typeof row.legacyDbId !== "string" || !LEGACY_DB_ID.test(row.legacyDbId)) return bad("The record id is an id of the previous system.");
  if (typeof row.status !== "string" || !(V7_IMPORT_ROW_STATUSES as readonly string[]).includes(row.status)) return bad("Unknown status.");
  if (!nullableMatch(row.code, CODE)) return bad("The code is a factor code, or none.");
  if (!scopeOf(row.scope) || !(row.consoleScope === null || scopeOf(row.consoleScope))) return bad("A scope is 1, 2 or 3.");
  if (!nullableFigure(row.v7Figure) || !nullableFigure(row.consoleFigure)) return bad("A figure is a number of tCO2e, or none.");
  if (!nullableBoolean(row.v7Enabled) || !nullableBoolean(row.consoleEnabled)) return bad("Enabled is true, false or none.");
  if (!nullableMatch(row.consoleRowId, ROW_ID) || !nullableMatch(row.pairRef, ROW_ID)) return bad("A row reference is a console row id, or none.");
  if (!Array.isArray(row.changedFields) || row.changedFields.length > V7_IMPORT_CHANGED_FIELDS.length
    || row.changedFields.some((name) => !(V7_IMPORT_CHANGED_FIELDS as readonly unknown[]).includes(name))) return bad("Changed fields are compared column names.");
  const v7Side = row.v7Figure !== null && row.v7Enabled !== null;
  const v7None = row.v7Figure === null && row.v7Enabled === null && row.code === null;
  const consoleSide = row.consoleFigure !== null && row.consoleEnabled !== null && row.consoleRowId !== null && row.consoleScope !== null;
  const consoleNone = row.consoleFigure === null && row.consoleEnabled === null && row.consoleRowId === null && row.consoleScope === null;
  if (!(v7Side || v7None) || !(consoleSide || consoleNone)) return bad("Each side is whole, or absent.");
  const changed = row.changedFields.length > 0;
  const status = row.status as V7ImportRowStatus;
  const ok = status === "matched" ? v7Side && consoleSide && !changed
    : status === "changed" || status === "needs-mapping" ? v7Side && consoleSide && changed
      : status === "new" ? v7Side && consoleNone
        : status === "withdrawn" ? v7None && consoleSide && row.consoleEnabled === true
          : (v7Side || consoleSide) && row.pairRef !== null;
  return ok ? [] : bad(`A ${status} row does not have the sides that status needs.`);
}

/** The whole summary: its closed shape, one job, the sha, every row, each identity once, and totals that follow from the rows. */
export function v7ImportSummaryIssues(summary: unknown): CommandIssue[] {
  if (!isRecord(summary)) return [{ field: "summary", code: "INVALID", message: "The summary is an object." }];
  const extra = extraKeys(summary, V7_IMPORT_SUMMARY_KEYS);
  if (extra.length) return [{ field: "summary", code: "UNKNOWN_FIELD", message: `A summary carries only its listed fields; it has ${extra.slice(0, 5).join(", ")}.` }];
  const issues: CommandIssue[] = [];
  if (summary.format !== V7_IMPORT_SUMMARY_FORMAT) issues.push({ field: "summary.format", code: "UNKNOWN_FORMAT", message: `This is not a ${V7_IMPORT_SUMMARY_FORMAT} summary.` });
  if (typeof summary.jobId !== "string" || !summary.jobId.trim()) issues.push({ field: "summary.jobId", code: "REQUIRED", message: "The summary names its job." });
  if (typeof summary.legacyJobNumber !== "string" || !JOB_NUMBER.test(summary.legacyJobNumber)) issues.push({ field: "summary.legacyJobNumber", code: "INVALID", message: "The job number is one J number, e.g. J000669." });
  if (typeof summary.extractSha256 !== "string" || !SHA256.test(summary.extractSha256)) issues.push({ field: "summary.extractSha256", code: "BAD_EXTRACT_SHA256", message: "The extract's sha256 is 64 lower-case hex characters." });
  if (typeof summary.generatedAt !== "string" || Number.isNaN(Date.parse(summary.generatedAt))) issues.push({ field: "summary.generatedAt", code: "INVALID", message: "When the summary was made, as a timestamp." });
  if (!Array.isArray(summary.rows) || summary.rows.length === 0) issues.push({ field: "summary.rows", code: "REQUIRED", message: "The summary has no rows." });
  else if (summary.rows.length > V7_IMPORT_MAX_ROWS) issues.push({ field: "summary.rows", code: "TOO_MANY_ROWS", message: `One job's summary is at most ${V7_IMPORT_MAX_ROWS} rows.` });
  if (issues.length) return issues;
  const rows = summary.rows as unknown[];
  const rowProblems = rows.flatMap(rowIssues);
  if (rowProblems.length) return rowProblems.slice(0, 20);
  const typed = rows as V7ImportSummaryRow[];
  const ids = typed.map((row) => row.legacyDbId);
  const repeated = ids.filter((id, at) => ids.indexOf(id) !== at);
  if (repeated.length) return [{ field: "summary.rows", code: "ROW_REPEATED", message: `${new Set(repeated).size} record id(s) appear more than once.` }];
  const derived = deriveV7ImportTotals(typed);
  const same = (a: unknown, b: unknown) => stable(a) === stable(b);
  if (!isRecord(summary.counts) || !same(Object.fromEntries(Object.keys(derived.counts).map((key) => [key, (summary.counts as Record<string, unknown>)[key]])), derived.counts)
    || extraKeys(summary.counts, Object.keys(derived.counts)).length) issues.push({ field: "summary.counts", code: "TOTALS_DISAGREE", message: "The counts do not follow from the rows." });
  if (!isRecord(summary.scopeTotals) || !same(Object.fromEntries(V7_IMPORT_SCOPES.map((scope) => [scope, (summary.scopeTotals as Record<string, unknown>)[scope]])), derived.scopeTotals)
    || extraKeys(summary.scopeTotals, V7_IMPORT_SCOPES).length) issues.push({ field: "summary.scopeTotals", code: "TOTALS_DISAGREE", message: "The per-scope totals do not follow from the rows." });
  if (summary.verdict !== derived.verdict) issues.push({ field: "summary.verdict", code: "TOTALS_DISAGREE", message: "The verdict does not follow from the rows." });
  return issues;
}
