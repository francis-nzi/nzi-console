import type { CommandIssue } from "./commands";
import type { V7ImportScope } from "./v7ImportSummary";

/**
 * The drift guard (BRIEF-v7-import-j000663 Part C; CONTRACT-v7-import-figures v1; ruled 25 Nov): never report a job that has fallen
 * behind the previous system. V7 is the live system, so the console catches up to it, never the reverse.
 *
 * V7's figure is read from V7 itself (the contract's job totals), never worked out here: the view set carries one factor per row,
 * so a recompute is blind exactly where the two disagree (a period over two dataset editions). Each read is stored (0236); the
 * banner, the Admin list and the publish gate read the latest one, so nothing calls V7 inside a publish.
 *
 *   level   — every scope within 0.1 t of V7's.
 *   behind  — some scope more than 0.1 t apart.
 *   unknown — V7 could not be read (the endpoint is not configured, did not answer, or answered outside the contract). Never a zero,
 *             never "level".
 */
export const V7_DRIFT_TOLERANCE_TCO2E = 0.1;
export const V7_FIGURES_CONTRACT = "v7-import-figures/1";

export type V7DriftOutcome = "level" | "behind" | "unknown";
/** When a check ran: from the Admin list, just before a publish, nightly, straight after a bring-in (0237), or after the reviewed backfill writes the job (0243). */
export type V7DriftTrigger = "admin" | "publish" | "nightly" | "bring-in" | "backfill";
export const V7_DRIFT_TRIGGERS: readonly V7DriftTrigger[] = ["admin", "publish", "nightly", "bring-in", "backfill"];
/** Why a check is unknown: a code, never a message from V7. */
export type V7DriftUnknownReason = "not-configured" | "unreachable" | "timeout" | "not-found" | "cannot-compute" | "busy" | "contract" | "refused";

export type V7ScopeTotals = Record<V7ImportScope, number>;

/** Endpoint 1 of the contract, as V7 returns it. */
export type V7FiguresJobTotals = {
  contract: typeof V7_FIGURES_CONTRACT; job_id: number; job_number: string; computed_at: string;
  period: { from: string | null; to: string | null };
  scope_totals: { scope_1: number; scope_2: number; scope_3: number; total: number };
  counted_rows: number; rows_updated_at: string | null;
};

const exactKeys = (value: unknown, keys: readonly string[]) => typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const isoDay = (value: unknown) => value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
const isoTime = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

/**
 * The contract check on endpoint 1: exactly the v1 fields, each of its type, and the job asked for. Any difference refuses the
 * reply (a change on either side is a v2), as the view set's columns are checked. Names the field, never its value.
 */
export function v7FiguresJobTotalsIssue(body: unknown, expectedJobNumber: string): string | null {
  if (!exactKeys(body, ["contract", "job_id", "job_number", "computed_at", "period", "scope_totals", "counted_rows", "rows_updated_at"])) return "fields";
  const reply = body as Record<string, unknown>;
  if (reply.contract !== V7_FIGURES_CONTRACT) return "contract";
  if (!Number.isInteger(reply.job_id)) return "job_id";
  if (reply.job_number !== expectedJobNumber) return "job_number";
  if (!isoTime(reply.computed_at)) return "computed_at";
  if (!exactKeys(reply.period, ["from", "to"]) || !isoDay((reply.period as Record<string, unknown>).from) || !isoDay((reply.period as Record<string, unknown>).to)) return "period";
  const totals = reply.scope_totals as Record<string, unknown>;
  if (!exactKeys(totals, ["scope_1", "scope_2", "scope_3", "total"]) || !["scope_1", "scope_2", "scope_3", "total"].every((key) => finite(totals[key]))) return "scope_totals";
  if (!Number.isInteger(reply.counted_rows) || (reply.counted_rows as number) < 0) return "counted_rows";
  if (reply.rows_updated_at !== null && !isoTime(reply.rows_updated_at)) return "rows_updated_at";
  return null;
}

export type V7DriftScope = { scope: V7ImportScope; console: number; previous: number; difference: number };
export type V7Drift = { outcome: "level" | "behind"; scopes: V7DriftScope[]; behind: V7ImportScope[]; maxDifference: number };

const SCOPES: readonly V7ImportScope[] = ["1", "2", "3"];
const r6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** The rule: behind when any scope is more than 0.1 t from V7's; `difference` is console − V7. */
export function v7DriftOf(consoleTotals: V7ScopeTotals, v7Totals: V7ScopeTotals): V7Drift {
  const scopes = SCOPES.map((scope) => ({ scope, console: r6(consoleTotals[scope]), previous: r6(v7Totals[scope]), difference: r6(consoleTotals[scope] - v7Totals[scope]) }));
  const behind = scopes.filter((entry) => Math.abs(entry.difference) > V7_DRIFT_TOLERANCE_TCO2E + 1e-9).map((entry) => entry.scope);
  return { outcome: behind.length ? "behind" : "level", scopes, behind, maxDifference: Math.max(...scopes.map((entry) => Math.abs(entry.difference))) };
}

export const v7TotalsOf = (body: V7FiguresJobTotals): V7ScopeTotals => ({ "1": body.scope_totals.scope_1, "2": body.scope_totals.scope_2, "3": body.scope_totals.scope_3 });

const oneDp = (value: number) => value.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** The banner's line, as the brief words it: "Behind the previous system: Scope 2 77.1 here, 2,121.2 in the previous system". */
export function v7BehindLine(scopes: readonly V7DriftScope[]): string {
  const off = scopes.filter((entry) => Math.abs(entry.difference) > V7_DRIFT_TOLERANCE_TCO2E + 1e-9);
  return `Behind the previous system: ${off.map((entry) => `Scope ${entry.scope} ${oneDp(entry.console)} here, ${oneDp(entry.previous)} in the previous system`).join(" · ")}`;
}
export const V7_DRIFT_UNKNOWN_LINE = "Can't check against the previous system just now.";

/** The latest stored check of a job, as the gate reads it. */
export type V7DriftLatest = { outcome: V7DriftOutcome; scopes: V7DriftScope[] | null; checkedAt: string } | null;

/**
 * The publish gate (ruled 25 Nov), for a job imported from the previous system:
 *   - the latest check says behind → refused, naming the scopes;
 *   - the job's period spans two dataset years → refused unless the latest check says level (they are known to be at risk);
 *   - otherwise (level, unknown, or never checked) → allowed, with the banner.
 * A job not imported from the previous system is never gated.
 */
export function v7DriftPublishIssue(job: { imported: boolean; spansTwoYears: boolean }, latest: V7DriftLatest): CommandIssue | null {
  if (!job.imported) return null;
  if (latest?.outcome === "behind") return { field: "jobId", code: "BEHIND_PREVIOUS_SYSTEM",
    message: `${v7BehindLine(latest.scopes ?? [])}. Bring its rows in from the previous system before publishing.` };
  if (job.spansTwoYears && latest?.outcome !== "level") return { field: "jobId", code: "NOT_CHECKED_AGAINST_PREVIOUS_SYSTEM",
    message: "This job spans two dataset years, so it can't be published until a check against the previous system says its figures are level." };
  return null;
}
