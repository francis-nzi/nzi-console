import type { CommandIssue } from "./commands";
import { V7_DRIFT_TOLERANCE_TCO2E, V7_FIGURES_CONTRACT, type V7DriftScope } from "./v7ImportDrift";
import { agreesToOneDecimalPlace } from "./v7ImportMatch";
import type { V7ImportScope } from "./v7ImportSummary";

/**
 * Endpoint 2 of CONTRACT-v7-import-figures v1 — the previous system's own figure for every row of a job, with its spans (one per
 * run of months priced from one dataset), computed by V7's report code. It is what a spanning job is reconciled against before it
 * may be brought in (Datasets Part 2, increment 2): the job's re-ingested rows, priced by month, must equal V7's own figures within
 * 0.1 t in every scope, or SPANS_TWO_DATASET_YEARS still refuses it — naming the rows that differ and why.
 *
 * Ids, codes, numbers, dates and booleans only: no label, note, site or client field crosses.
 */
export type V7FiguresSpan = {
  /** `YYYY-MM`; null on a single span when V7 holds no period. */
  from: string | null; to: string | null;
  /** V7's own dataset id, or null for a client's custom factor (then `dataset_year` is the custom value's year). */
  dataset_id: number | null; dataset_year: number | null;
  factor: number | null; ghg_unit: string | null;
  tco2e: number;
};
export type V7FiguresRow = {
  /** V7's row id, or `source:<id>` for a register source. */
  row_id: number | string;
  /** V7's label for the scope: "Scope 1", "Scope 2", "Scope 3". */
  scope: string;
  enabled: boolean;
  /** V7's report figure for the row, unrounded. */
  tco2e: number;
  blended: boolean;
  custom_factor: boolean;
  spans: V7FiguresSpan[];
};
export type V7FiguresRowFigures = { contract: typeof V7_FIGURES_CONTRACT; job_id: number; computed_at: string; rows: V7FiguresRow[] };

const exactKeys = (value: unknown, keys: readonly string[]) => typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const finiteOrNull = (value: unknown) => value === null || finite(value);
const intOrNull = (value: unknown) => value === null || Number.isInteger(value);
const textOrNull = (value: unknown) => value === null || typeof value === "string";
const month = (value: unknown) => value === null || (typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value));

/**
 * The contract check on endpoint 2: exactly the v1 fields, each of its type, and the job asked for (V7's own job id: endpoint 2 names
 * no job number). Any difference refuses the reply, as endpoint 1's and the view set's are. Names the field, never its value.
 */
export function v7FiguresRowsIssue(body: unknown, expectedV7JobId: number): string | null {
  if (!exactKeys(body, ["contract", "job_id", "computed_at", "rows"])) return "fields";
  const reply = body as Record<string, unknown>;
  if (reply.contract !== V7_FIGURES_CONTRACT) return "contract";
  if (reply.job_id !== expectedV7JobId) return "job_id";
  if (typeof reply.computed_at !== "string" || Number.isNaN(Date.parse(reply.computed_at))) return "computed_at";
  if (!Array.isArray(reply.rows)) return "rows";
  for (const row of reply.rows as unknown[]) {
    if (!exactKeys(row, ["row_id", "scope", "enabled", "tco2e", "blended", "custom_factor", "spans"])) return "rows.fields";
    const r = row as Record<string, unknown>;
    if (!(Number.isInteger(r.row_id) || (typeof r.row_id === "string" && /^source:\d{1,12}$/.test(r.row_id)))) return "rows.row_id";
    if (typeof r.scope !== "string") return "rows.scope";
    if (typeof r.enabled !== "boolean" || typeof r.blended !== "boolean" || typeof r.custom_factor !== "boolean") return "rows.flags";
    if (!finite(r.tco2e)) return "rows.tco2e";
    if (!Array.isArray(r.spans) || r.spans.length === 0) return "rows.spans";
    for (const span of r.spans as unknown[]) {
      if (!exactKeys(span, ["from", "to", "dataset_id", "dataset_year", "factor", "ghg_unit", "tco2e"])) return "rows.spans.fields";
      const s = span as Record<string, unknown>;
      if (!month(s.from) || !month(s.to) || !intOrNull(s.dataset_id) || !intOrNull(s.dataset_year) || !finiteOrNull(s.factor) || !textOrNull(s.ghg_unit) || !finite(s.tco2e)) return "rows.spans.value";
    }
  }
  return null;
}

/** The row's id as the console keys the previous system's rows (`legacyDbId`): the digits, or `source:<id>`. */
export const v7FiguresRowKey = (row: Pick<V7FiguresRow, "row_id">): string => String(row.row_id);
/** V7's scope label as the console's top-level scope, or null when it names none. */
export function v7FiguresScope(label: string): V7ImportScope | null {
  const found = /^\s*scope\s*([123])\b/i.exec(label);
  return found ? (found[1] as V7ImportScope) : null;
}

/**
 * Why a row the console would bring in does not reproduce the previous system's own figure:
 *   dataset-not-on-job — a span V7 priced from an edition the job does not select, so the console prices those months elsewhere;
 *   unit               — the console prices it per another unit than V7's;
 *   custom-factor      — V7 priced it from a client's custom year values, which the console does not carry yet (cause 7);
 *   v7-changed         — V7's row is not the one read: added, removed or switched since, so there is nothing to compare one to one;
 *   no-match           — on the same editions and unit, the figure still differs (the factor itself).
 */
export const V7_ROW_RECONCILE_REASONS = ["dataset-not-on-job", "unit", "custom-factor", "v7-changed", "no-match"] as const;
export type V7RowReconcileReason = (typeof V7_ROW_RECONCILE_REASONS)[number];
const REASON_WORDS: Record<V7RowReconcileReason, string> = {
  "dataset-not-on-job": "a dataset the previous system priced it from is not on the job", unit: "the unit differs",
  "custom-factor": "the previous system priced it from a client's custom factor", "v7-changed": "the previous system's row changed since it was read",
  "no-match": "the factor differs",
};

/** One row as the reconcile compares it: the console's figure (null when it brings no row in), V7's (null when V7 has none). */
export type V7RowReconcileInput = { legacyDbId: string; scope: V7ImportScope; console: number | null; previous: number | null; reason: V7RowReconcileReason | null; detail?: string | null };
export type V7RowReconcileMiss = { legacyDbId: string; scope: V7ImportScope; console: number | null; previous: number | null; reason: V7RowReconcileReason; detail: string | null };
export type V7SpanningReconcile = { reconciles: boolean; scopes: V7DriftScope[]; rows: V7RowReconcileMiss[] };

const r6 = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * The rule: each scope's console total within 0.1 t of the previous system's own (V7_DRIFT_TOLERANCE_TCO2E, the drift guard's), in
 * every scope. The rows named are those that do not agree to one decimal place, each with its reason (`no-match` when the caller
 * found none more particular). `scopeTotals` are the console's and V7's totals over the job's counted rows.
 */
export function v7SpanningReconcile(rows: readonly V7RowReconcileInput[], scopeTotals: { console: Record<V7ImportScope, number>; previous: Record<V7ImportScope, number> }): V7SpanningReconcile {
  const scopes = (["1", "2", "3"] as const).map((scope) => ({ scope, console: r6(scopeTotals.console[scope]), previous: r6(scopeTotals.previous[scope]),
    difference: r6(scopeTotals.console[scope] - scopeTotals.previous[scope]) }));
  const misses = rows.filter((row) => row.console === null || row.previous === null || !agreesToOneDecimalPlace(row.console, row.previous))
    .map((row): V7RowReconcileMiss => ({ legacyDbId: row.legacyDbId, scope: row.scope, console: row.console, previous: row.previous,
      reason: row.reason ?? (row.console === null || row.previous === null ? "v7-changed" : "no-match"), detail: row.detail ?? null }));
  return { reconciles: scopes.every((entry) => Math.abs(entry.difference) <= V7_DRIFT_TOLERANCE_TCO2E + 1e-9), scopes, rows: misses };
}

const oneDp = (value: number) => value.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** At most this many rows are named in one refusal; the rest are counted. */
export const V7_RECONCILE_ROWS_NAMED = 20;

/** The guard's words when the previous system's own figures could not be read: nothing can be checked, so nothing comes in. */
export const V7_IMPORT_TWO_DATASET_YEARS_UNREAD = "This job spans two dataset years, and the previous system's own figures can't be read just now, so it can't be checked against them. Nothing was written.";

/**
 * SPANS_TWO_DATASET_YEARS, for a spanning job that does not reconcile: one issue for the scopes apart, then one per row named, with
 * its reason, so the modal lists each. Figures in tCO₂e to one decimal place; ids and reasons, no label.
 */
export function v7SpanningRefusal(reconcile: V7SpanningReconcile): CommandIssue[] {
  const off = reconcile.scopes.filter((entry) => Math.abs(entry.difference) > V7_DRIFT_TOLERANCE_TCO2E + 1e-9);
  const head = `This job spans two dataset years, and its figures don't match the previous system's own${off.length
    ? `: ${off.map((entry) => `Scope ${entry.scope} ${oneDp(entry.console)} here, ${oneDp(entry.previous)} there`).join(" · ")}` : ""}. Nothing was written.`;
  const named = reconcile.rows.slice(0, V7_RECONCILE_ROWS_NAMED).map((row): CommandIssue => ({ field: `rows.${row.legacyDbId}`, code: "SPANS_TWO_DATASET_YEARS",
    message: `Row ${row.legacyDbId} (Scope ${row.scope}): ${row.console === null ? "not brought in" : `${oneDp(row.console)} here`}, ${row.previous === null ? "none in the previous system" : `${oneDp(row.previous)} there`} — ${REASON_WORDS[row.reason]}${row.detail ? ` (${row.detail})` : ""}.` }));
  const more = reconcile.rows.length - named.length;
  return [{ field: "jobId", code: "SPANS_TWO_DATASET_YEARS", message: head }, ...named,
    ...(more > 0 ? [{ field: "rows", code: "SPANS_TWO_DATASET_YEARS", message: `…and ${more} more row${more === 1 ? "" : "s"}.` }] : [])];
}
