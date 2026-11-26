// The drift guard (BRIEF-v7-import-j000663 Part C; CONTRACT-v7-import-figures v1; ruled 25 Nov 2026).
//
// V7 is the live system, so a job imported from it must not be reported once it has fallen behind V7. A check reads V7's own scope
// totals for one job — the contract's endpoint 1, computed by V7's report code — and the console's, and stores the result (0236).
// The banner, the Admin list and the publish gate read the latest stored check: nothing calls V7 inside a publish.
//
//   * The read: one bounded HTTPS call per job, outside any transaction, through `V7FiguresClient`. The service's client
//     (`v7FiguresClientFromEnv`) refuses to run unless NZI_V7_FIGURES_URL is HTTPS and not the console's own address; unset, every
//     check is `unknown` ("not-configured") and nothing is called.
//   * The reply is checked against the contract (`v7FiguresJobTotalsIssue`): anything else is `unknown` ("contract"), never zero.
//   * The run (`runV7DriftChecks`): every imported job, one at a time, with the batch's pacing (a 2 s floor, adaptive to 60 s) and a
//     breaker (three jobs in a row with the source not answering stop the run). From the Admin list ("Check now") and nightly.
//   * The gate (`refuseDriftedPublish`): in `issueReportVersion`, so publish and final approval alike. See `v7DriftPublishIssue`.
//
// The audit holds ids, the outcome and the scopes behind — never a figure; the figures are in the check row.
import { randomUUID } from "node:crypto";
import {
  v7BehindLine, v7DriftOf, v7DriftPublishIssue, v7FiguresJobTotalsIssue, v7FiguresRowsIssue, v7PeriodSpansTwoYears, v7TotalsOf, V7_DRIFT_UNKNOWN_LINE,
  type V7DriftLatest, type V7DriftOutcome, type V7DriftScope, type V7DriftTrigger, type V7DriftUnknownReason, type V7FiguresJobTotals, type V7FiguresRowFigures, type V7ScopeTotals,
} from "@nzi/contracts";
import { withTenantRead, withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import { V7_IMPORT_BATCH_PACING, v7ImportBatchPauseAfter } from "./v7ImportBatch";
import { readV7ImportPeriod } from "./v7ImportRefresh";

export const V7_DRIFT_ACTOR = "policy:v7-drift-check";
/** One reply's bound (the contract: 5 s to connect, 30 s per reply; fetch takes one deadline for both). */
export const V7_FIGURES_TIMEOUT_MS = 30_000;

export type V7FiguresRead = { ok: true; body: V7FiguresJobTotals } | { ok: false; reason: V7DriftUnknownReason };
/** Endpoint 1 for one job: the previous system's job id and its J number (the reply must name the same). */
export type V7FiguresClient = (job: { v7JobId: string; legacyJobNumber: string }) => Promise<V7FiguresRead>;

export class V7FiguresConnectionRefused extends Error {}

/**
 * The service's client on the contract's endpoint 1. Refused (thrown) when the URL is not HTTPS or names the console itself; absent,
 * a client that answers `not-configured` without calling anything, so a check is honestly unknown until V7 provides the endpoint.
 */
/** The endpoints' root and token from the service's environment, null when unset; thrown when the URL is not HTTPS or is the console's. */
function figuresEndpoint(env: Readonly<Record<string, string | undefined>>): { root: string; token: string } | null {
  const raw = env.NZI_V7_FIGURES_URL?.trim();
  const token = env.NZI_V7_FIGURES_TOKEN?.trim();
  if (!raw || !token) return null;
  let base: URL;
  try { base = new URL(raw); } catch { throw new V7FiguresConnectionRefused("NZI_V7_FIGURES_URL is not a URL."); }
  if (base.protocol !== "https:") throw new V7FiguresConnectionRefused("NZI_V7_FIGURES_URL must be HTTPS.");
  const own = env.NZI_ISOLATED_API_URL?.trim();
  if (own) { try { if (new URL(own).host === base.host) throw new V7FiguresConnectionRefused("NZI_V7_FIGURES_URL names the console itself; it must name the previous system."); } catch (error) { if (error instanceof V7FiguresConnectionRefused) throw error; } }
  return { root: base.href.replace(/\/+$/, ""), token };
}

export function v7FiguresClientFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, fetchImpl: typeof fetch = fetch): V7FiguresClient {
  const endpoint = figuresEndpoint(env);
  if (!endpoint) return async () => ({ ok: false, reason: "not-configured" });
  const { root, token } = endpoint;
  return async ({ v7JobId, legacyJobNumber }) => {
    if (!/^\d{1,12}$/.test(v7JobId)) return { ok: false, reason: "not-found" };
    let response: Response;
    try {
      response = await fetchImpl(`${root}/api/console-import/v1/jobs/${v7JobId}/scope-totals`, {
        method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(V7_FIGURES_TIMEOUT_MS) });
    } catch (error) {
      return { ok: false, reason: (error as { name?: string })?.name === "TimeoutError" || (error as { name?: string })?.name === "AbortError" ? "timeout" : "unreachable" };
    }
    if (response.status === 404) return { ok: false, reason: "not-found" };
    if (response.status === 422) return { ok: false, reason: "cannot-compute" };
    if (response.status === 503 || response.status === 429) return { ok: false, reason: "busy" };
    if (response.status !== 200) return { ok: false, reason: "refused" };
    let body: unknown;
    try { body = await response.json(); } catch { return { ok: false, reason: "contract" }; }
    return v7FiguresJobTotalsIssue(body, legacyJobNumber) === null ? { ok: true, body: body as V7FiguresJobTotals } : { ok: false, reason: "contract" };
  };
}

export type V7RowFiguresRead = { ok: true; body: V7FiguresRowFigures } | { ok: false; reason: V7DriftUnknownReason };
/** Endpoint 2 for one job: the previous system's job id (the reply must name the same). */
export type V7RowFiguresClient = (job: { v7JobId: string }) => Promise<V7RowFiguresRead>;

/**
 * The pace every row-figures call in this process goes through (the contract's load rule; the batch's floor): one call at a time,
 * and each starts at least `V7_IMPORT_BATCH_PACING.pauseMs` after the last one ended. `sleep` and `now` are injectable for tests.
 */
export function v7FiguresPacer(floorMs: number = V7_IMPORT_BATCH_PACING.pauseMs as number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)), now: () => number = Date.now) {
  let tail: Promise<unknown> = Promise.resolve();
  let lastEnded = -Infinity;
  return <T>(call: () => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      const wait = lastEnded + floorMs - now();
      if (wait > 0) await sleep(wait);
      try { return await call(); } finally { lastEnded = now(); }
    });
    tail = run.catch(() => undefined);
    return run;
  };
}
// Made on first use (this module and the refresh import each other; nothing of either is read while they load).
let processPacerHeld: ReturnType<typeof v7FiguresPacer> | null = null;
const processPacer = <T>(call: () => Promise<T>): Promise<T> => (processPacerHeld ??= v7FiguresPacer())(call);

/**
 * The service's client on the contract's endpoint 2, under the same guard as endpoint 1's (HTTPS, never the console itself; unset →
 * `not-configured` without calling anything) and through the process's pace. One bounded call, outside any transaction.
 */
export function v7RowFiguresClientFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, fetchImpl: typeof fetch = fetch,
  pace: <T>(call: () => Promise<T>) => Promise<T> = processPacer): V7RowFiguresClient {
  const endpoint = figuresEndpoint(env);
  if (!endpoint) return async () => ({ ok: false, reason: "not-configured" });
  const { root, token } = endpoint;
  return async ({ v7JobId }) => {
    if (!/^\d{1,12}$/.test(v7JobId)) return { ok: false, reason: "not-found" };
    return pace(async (): Promise<V7RowFiguresRead> => {
      let response: Response;
      try {
        response = await fetchImpl(`${root}/api/console-import/v1/jobs/${v7JobId}/row-figures`, {
          method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(V7_FIGURES_TIMEOUT_MS) });
      } catch (error) {
        return { ok: false, reason: (error as { name?: string })?.name === "TimeoutError" || (error as { name?: string })?.name === "AbortError" ? "timeout" : "unreachable" };
      }
      if (response.status === 404) return { ok: false, reason: "not-found" };
      if (response.status === 422) return { ok: false, reason: "cannot-compute" };
      if (response.status === 503 || response.status === 429) return { ok: false, reason: "busy" };
      if (response.status !== 200) return { ok: false, reason: "refused" };
      let body: unknown;
      try { body = await response.json(); } catch { return { ok: false, reason: "contract" }; }
      return v7FiguresRowsIssue(body, Number(v7JobId)) === null ? { ok: true, body: body as V7FiguresRowFigures } : { ok: false, reason: "contract" };
    });
  };
}

/** The console's scope totals: the job's enabled rows, the override where one stands (as the report sums them). */
export async function readConsoleScopeTotals(db: Queryable, organisationId: string, jobId: string): Promise<V7ScopeTotals> {
  const rows = (await db.query<{ scope: string; t: string }>(
    `SELECT split_part(scope, '.', 1) AS scope, coalesce(sum(coalesce(override_tco2e, calculated_tco2e, 0)), 0)::text AS t
       FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND enabled GROUP BY 1`, [organisationId, jobId])).rows;
  const of = (scope: string) => Number(rows.find((row) => row.scope === scope)?.t ?? 0);
  return { "1": of("1"), "2": of("2"), "3": of("3") };
}

type ImportedJob = { job_id: string; client_id: string; legacy_db_id: string | null; legacy_job_number: string | null; job_family: string };
const readJob = async (db: Queryable, organisationId: string, jobId: string) => (await db.query<ImportedJob>(
  `SELECT job_id, client_id, legacy_db_id, legacy_job_number, job_family FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [organisationId, jobId])).rows[0] ?? null;
const isImported = (job: ImportedJob | null) => job !== null && job.job_family === "crp" && job.legacy_job_number !== null;

export type V7DriftCheck = { checkId: string; jobId: string; outcome: V7DriftOutcome; unknownReason: V7DriftUnknownReason | null; scopes: V7DriftScope[] | null; checkedAt: string };
export type V7DriftCheckOptions = { trigger: V7DriftTrigger; requestedBy: string; correlationId: string; principal: "staff" | "system" };

/**
 * One job's check: V7's totals read (outside any transaction), then — in one transaction — the console's totals, the stored check and
 * its audit. A job not imported from the previous system is refused (NOT_IMPORTED); nothing is stored for it.
 */
export async function checkV7Drift(pool: PoolLike, client: V7FiguresClient, organisationId: string, jobId: string, options: V7DriftCheckOptions): Promise<V7DriftCheck> {
  const job = await withTenantRead(pool, organisationId, (db) => readJob(db, organisationId, jobId));
  if (!isImported(job)) throw new CommandValidationError([{ field: "jobId", code: "NOT_IMPORTED", message: "This job was not imported from the previous system, so there is nothing to check it against." }]);
  const read: V7FiguresRead = job!.legacy_db_id ? await client({ v7JobId: job!.legacy_db_id, legacyJobNumber: job!.legacy_job_number! }) : { ok: false, reason: "not-found" };
  return withTenantWrite(pool, organisationId, async (db) => {
    const consoleTotals = await readConsoleScopeTotals(db, organisationId, jobId);
    const drift = read.ok ? v7DriftOf(consoleTotals, v7TotalsOf(read.body)) : null;
    const outcome: V7DriftOutcome = drift ? drift.outcome : "unknown";
    const checkId = randomUUID();
    const created = (await db.query<{ created_at: Date }>(
      `INSERT INTO nzi_console.v7_drift_checks (organisation_id, check_id, job_id, outcome, trigger, unknown_reason, console_scope1_tco2e, console_scope2_tco2e, console_scope3_tco2e,
         v7_scope1_tco2e, v7_scope2_tco2e, v7_scope3_tco2e, max_difference_tco2e, v7_computed_at, v7_rows_updated_at, requested_by, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING created_at`,
      [organisationId, checkId, jobId, outcome, options.trigger, read.ok ? null : read.reason, consoleTotals["1"], consoleTotals["2"], consoleTotals["3"],
        read.ok ? read.body.scope_totals.scope_1 : null, read.ok ? read.body.scope_totals.scope_2 : null, read.ok ? read.body.scope_totals.scope_3 : null,
        drift?.maxDifference ?? null, read.ok ? read.body.computed_at : null, read.ok ? read.body.rows_updated_at : null, options.requestedBy, options.correlationId])).rows[0]!;
    await db.query(`INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json, client_id)
      VALUES ($1, $2, $3, $4, 'import.drift.checked', 'job', $5, $6, NULL, $7::jsonb, $8)`,
      [organisationId, randomUUID(), options.requestedBy, options.principal, jobId, options.correlationId,
        JSON.stringify({ checkId, outcome, trigger: options.trigger, behind: drift?.behind ?? [], ...(read.ok ? {} : { unknownReason: read.reason }) }), job!.client_id]);
    return { checkId, jobId, outcome, unknownReason: read.ok ? null : read.reason, scopes: drift?.scopes ?? null, checkedAt: created.created_at.toISOString() };
  });
}

type CheckRow = { outcome: V7DriftOutcome; created_at: Date; c1: string; c2: string; c3: string; v1: string | null; v2: string | null; v3: string | null };
const scopesOf = (row: CheckRow): V7DriftScope[] | null => row.v1 === null ? null
  : v7DriftOf({ "1": Number(row.c1), "2": Number(row.c2), "3": Number(row.c3) }, { "1": Number(row.v1), "2": Number(row.v2), "3": Number(row.v3) }).scopes;
const CHECK_COLUMNS = `outcome, created_at, console_scope1_tco2e::text AS c1, console_scope2_tco2e::text AS c2, console_scope3_tco2e::text AS c3,
  v7_scope1_tco2e::text AS v1, v7_scope2_tco2e::text AS v2, v7_scope3_tco2e::text AS v3`;

/** The job's latest check, or null when it has never been checked. */
export async function readLatestV7Drift(db: Queryable, organisationId: string, jobId: string): Promise<V7DriftLatest> {
  const row = (await db.query<CheckRow>(`SELECT ${CHECK_COLUMNS} FROM nzi_console.v7_drift_checks WHERE organisation_id = $1 AND job_id = $2
    ORDER BY created_at DESC, check_id DESC LIMIT 1`, [organisationId, jobId])).rows[0];
  return row ? { outcome: row.outcome, scopes: scopesOf(row), checkedAt: row.created_at.toISOString() } : null;
}

/** What the job's banner says, from its latest check: behind (the brief's line), unknown, or nothing. Null for a job not imported. */
export type V7DriftBanner = { tone: "behind" | "unknown" | "level" | "unchecked"; line: string | null; checkedAt: string | null; spansTwoYears: boolean } | null;
export async function readV7DriftBanner(db: Queryable, organisationId: string, jobId: string): Promise<V7DriftBanner> {
  const job = await readJob(db, organisationId, jobId);
  if (!isImported(job)) return null;
  const spansTwoYears = v7PeriodSpansTwoYears(await readV7ImportPeriod(db, organisationId, jobId));
  const latest = await readLatestV7Drift(db, organisationId, jobId);
  if (!latest) return { tone: "unchecked", line: spansTwoYears ? "Not yet checked against the previous system. This job spans two dataset years, so it can't be published until a check says its figures are level." : null, checkedAt: null, spansTwoYears };
  if (latest.outcome === "behind") return { tone: "behind", line: v7BehindLine(latest.scopes ?? []), checkedAt: latest.checkedAt, spansTwoYears };
  if (latest.outcome === "unknown") return { tone: "unknown", line: V7_DRIFT_UNKNOWN_LINE, checkedAt: latest.checkedAt, spansTwoYears };
  return { tone: "level", line: null, checkedAt: latest.checkedAt, spansTwoYears };
}

/**
 * The publish gate, in the caller's transaction (`issueReportVersion`): refused when the latest check says behind, or — the job's period
 * spanning two dataset years — unless it says level. Reads stored checks only; never calls the previous system.
 */
export async function refuseDriftedPublish(db: Queryable, organisationId: string, jobId: string): Promise<void> {
  const job = await readJob(db, organisationId, jobId);
  if (!isImported(job)) return;
  const spansTwoYears = v7PeriodSpansTwoYears(await readV7ImportPeriod(db, organisationId, jobId));
  const issue = v7DriftPublishIssue({ imported: true, spansTwoYears }, await readLatestV7Drift(db, organisationId, jobId));
  if (issue) throw new CommandValidationError([issue]);
}

// ── The Admin list ──────────────────────────────────────────────────────────────────────────────────────────────────

export type V7DriftListItem = {
  jobId: string; jobNumber: string; clientId: string; clientName: string; spansTwoYears: boolean;
  outcome: V7DriftOutcome | "unchecked"; checkedAt: string | null; unknownReason: string | null;
  /** Per scope at the latest check: the console's, V7's (null when unknown) and console − V7. */
  scopes: Array<{ scope: "1" | "2" | "3"; console: number | null; previous: number | null; difference: number | null }>;
  maxDifference: number | null;
  /** The job's enabled scope rows in the console now (0: "no rows in the console"). */
  consoleRows: number;
  /** The latest completed re-ingest by the earlier runner (`v7_reingest_runs`), or null when it was never re-ingested. */
  reingestedAt: string | null;
  /** The job's last few checks, newest first (the latest is the row's own): outcome, trigger and console − V7 per scope. */
  history: V7DriftHistoryEntry[];
};
export type V7DriftHistoryEntry = {
  checkedAt: string; outcome: V7DriftOutcome; trigger: V7DriftTrigger; unknownReason: string | null;
  /** console − V7 per scope 1, 2, 3; null when the previous system gave no figure. */
  differences: [number | null, number | null, number | null];
};
/** How many checks each job's history carries. */
export const V7_DRIFT_HISTORY_DEPTH = 5;

const differenceOf = (consoleTotal: string, v7: string | null | undefined) =>
  v7 === null || v7 === undefined ? null : Math.round((Number(consoleTotal) - Number(v7)) * 1e6) / 1e6;

/**
 * Every job imported from the previous system with its latest check — one read of the console's own tables, totals only, nothing of
 * V7's rows and no call to V7. Sorted by the largest difference first; unknown and unchecked after, in job order. Each job also carries
 * its enabled-row count, its October re-ingest (if any) and its last few checks, so the page can filter and show history without
 * another read.
 */
export async function listV7Drift(db: Queryable, organisationId: string): Promise<V7DriftListItem[]> {
  const rows = (await db.query<CheckRow & { job_id: string; sequence: number; client_id: string; client_name: string; period_from: string | null; period_to: string | null;
    unknown_reason: string | null; max_difference: string | null; checked: boolean; console_rows: number; reingested_at: Date | null }>(
    `SELECT j.job_id, j.sequence, j.client_id, c.name AS client_name,
            coalesce(j.reporting_period_start, e.reporting_from)::text AS period_from, coalesce(j.reporting_period_end, e.reporting_to)::text AS period_to,
            k.check_id IS NOT NULL AS checked, k.outcome, k.created_at, k.unknown_reason, k.max_difference_tco2e::text AS max_difference,
            k.console_scope1_tco2e::text AS c1, k.console_scope2_tco2e::text AS c2, k.console_scope3_tco2e::text AS c3,
            k.v7_scope1_tco2e::text AS v1, k.v7_scope2_tco2e::text AS v2, k.v7_scope3_tco2e::text AS v3,
            (SELECT count(*) FROM nzi_console.job_scope_rows r WHERE (r.organisation_id, r.job_id) = (j.organisation_id, j.job_id) AND r.enabled)::int AS console_rows,
            (SELECT max(g.created_at) FROM nzi_console.v7_reingest_runs g WHERE (g.organisation_id, g.job_id) = (j.organisation_id, j.job_id) AND g.status = 'completed') AS reingested_at
       FROM nzi_console.jobs j
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
       LEFT JOIN nzi_console.job_emissions_config e ON (e.organisation_id, e.job_id) = (j.organisation_id, j.job_id)
       LEFT JOIN LATERAL (SELECT * FROM nzi_console.v7_drift_checks k WHERE (k.organisation_id, k.job_id) = (j.organisation_id, j.job_id)
                           ORDER BY k.created_at DESC, k.check_id DESC LIMIT 1) k ON true
      WHERE j.organisation_id = $1 AND j.job_family = 'crp' AND j.legacy_job_number IS NOT NULL
      ORDER BY k.max_difference_tco2e DESC NULLS LAST, j.sequence`, [organisationId])).rows;
  const history = new Map<string, V7DriftHistoryEntry[]>();
  for (const check of (await db.query<CheckRow & { job_id: string; trigger: V7DriftTrigger; unknown_reason: string | null }>(
    `SELECT job_id, trigger, unknown_reason, ${CHECK_COLUMNS}
       FROM (SELECT k.*, row_number() OVER (PARTITION BY k.job_id ORDER BY k.created_at DESC, k.check_id DESC) AS position
               FROM nzi_console.v7_drift_checks k WHERE k.organisation_id = $1) k
      WHERE position <= $2 ORDER BY job_id, created_at DESC, check_id DESC`, [organisationId, V7_DRIFT_HISTORY_DEPTH])).rows) {
    const entries = history.get(check.job_id) ?? [];
    entries.push({ checkedAt: check.created_at.toISOString(), outcome: check.outcome, trigger: check.trigger, unknownReason: check.unknown_reason,
      differences: [differenceOf(check.c1, check.v1), differenceOf(check.c2, check.v2), differenceOf(check.c3, check.v3)] });
    history.set(check.job_id, entries);
  }
  return rows.map((row) => {
    // Never checked: no figure on either side, not a zero.
    const scopes = (["1", "2", "3"] as const).map((scope, at) => {
      if (!row.checked) return { scope, console: null, previous: null, difference: null };
      const consoleTotal = [row.c1, row.c2, row.c3][at]!;
      const v7 = [row.v1, row.v2, row.v3][at];
      return { scope, console: Number(consoleTotal), previous: v7 === null || v7 === undefined ? null : Number(v7), difference: differenceOf(consoleTotal, v7) };
    });
    return { jobId: row.job_id, jobNumber: `J${String(row.sequence).padStart(6, "0")}`, clientId: row.client_id, clientName: row.client_name,
      spansTwoYears: v7PeriodSpansTwoYears({ from: row.period_from, to: row.period_to }),
      outcome: row.checked ? row.outcome : "unchecked", checkedAt: row.checked ? row.created_at.toISOString() : null, unknownReason: row.unknown_reason,
      scopes, maxDifference: row.max_difference === null ? null : Number(row.max_difference),
      consoleRows: row.console_rows, reingestedAt: row.reingested_at ? row.reingested_at.toISOString() : null, history: history.get(row.job_id) ?? [] };
  });
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type V7DriftRunOptions = V7DriftCheckOptions & {
  /** The least pause between jobs (the batch's floor unless set, never below it). */
  pauseMs?: number; maxPauseMs?: number;
  /** Consecutive jobs with the source not answering that stop the run (3 unless set). */
  breakerThreshold?: number;
  /** A test's clock and sleep. */
  now?: () => number; sleep?: (ms: number) => Promise<void>;
};
export type V7DriftRunResult = { checked: number; level: number; behind: number; unknown: number; stopped: "completed" | "source-unresponsive" | "not-configured" };

const SOURCE_DOWN: readonly V7DriftUnknownReason[] = ["unreachable", "timeout", "busy"];

/**
 * Every imported job of the organisation, one at a time, paced as the batch is, stopping when the source stops answering. With no
 * endpoint configured it stops at the first job (`not-configured`): one unknown check stored, nothing called.
 */
export async function runV7DriftChecks(pool: PoolLike, client: V7FiguresClient, organisationId: string, options: V7DriftRunOptions): Promise<V7DriftRunResult> {
  const jobs = await withTenantRead(pool, organisationId, async (db) => (await db.query<{ job_id: string }>(
    `SELECT job_id FROM nzi_console.jobs WHERE organisation_id = $1 AND job_family = 'crp' AND legacy_job_number IS NOT NULL ORDER BY sequence`, [organisationId])).rows.map((row) => row.job_id));
  const now = options.now ?? (() => performance.now());
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const floor = Math.max(options.pauseMs ?? V7_IMPORT_BATCH_PACING.pauseMs, V7_IMPORT_BATCH_PACING.pauseMs);
  const threshold = options.breakerThreshold ?? V7_IMPORT_BATCH_PACING.breakerThreshold;
  const result: V7DriftRunResult = { checked: 0, level: 0, behind: 0, unknown: 0, stopped: "completed" };
  let down = 0;
  for (const [at, jobId] of jobs.entries()) {
    const started = now();
    const check = await checkV7Drift(pool, client, organisationId, jobId, options);
    result.checked += 1; result[check.outcome] += 1;
    if (check.unknownReason === "not-configured") { result.stopped = "not-configured"; break; }
    down = check.unknownReason !== null && SOURCE_DOWN.includes(check.unknownReason) ? down + 1 : 0;
    if (down >= threshold) { result.stopped = "source-unresponsive"; break; }
    if (at < jobs.length - 1) await wait(v7ImportBatchPauseAfter(now() - started, floor, options.maxPauseMs ?? V7_IMPORT_BATCH_PACING.maxPauseMs));
  }
  return result;
}
