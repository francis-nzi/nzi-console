// The import, server-side — Phase B (BRIEF-v7-import-server-side-phase-b; DESIGN-v7-import-rethink R-3, R-6): `import.refresh`.
//
// One command, run in the console service. It reads the job's current rows from the previous system through the Phase A view
// set (`readV7JobRowsFromViews`: one read-only snapshot, the guard first, every label through the R-1 rule), and the job's
// decisions (0228), and drives the chain the import workbench's ingest already runs (`runV7ResyncChain`, with
// `chainOptions`): revert the standing re-ingest → re-sync (carried pairs let through) → re-plan the committed crosswalk plan
// onto the current rows → complete it from the decisions → re-ingest. All in ONE transaction, with the re-ingest's D7 the
// automatic floor: it reconciles (Σ live = Σ previous system per scope, row by row) or it refuses and nothing is kept.
//
//   preview — the whole command, rolled back: its validation, its access check, the chain, and the audit it would write. The
//             caller gets the reconciliation and the rows that still need a person; the database keeps nothing.
//   commit  — the same chain, kept. A reason is required. It names the summary and the decisions the preview showed, by their
//             fingerprints, and refuses if either moved (SUMMARY_MOVED / DECISIONS_MOVED). It stores the summary it ran from
//             (the import view's latest, as an upload would) and records the run in v7_import_ingests (0229), as the ingest does.
//
// Who: `import.refresh` (matrix v15) — Admin and the CRM. An organisation may require an Admin to commit (0231; off until set).
// The inner steps run under their own system principals, exactly as the ingest's do. The audit holds ids, counts and codes —
// never a figure; Σ per scope is in the 0229 record.
//
// Nothing of the previous system's rows travels in the command's input, and nothing of them is stored but what the re-sync
// itself writes (the previous system's records, as the import always has).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import {
  datasetLabelFromId, datasetSeriesKey, resolveV7Import, v7FiguresRowKey, v7FiguresScope, v7ImportPeriodIssue, v7ImportSummaryIssues, v7PeriodSpansTwoYears, v7ScopeAgreement,
  v7SpanningReconcile, v7SpanningRefusal, V7_DERIVED_SOURCE_SYSTEM, V7_IMPORT_TWO_DATASET_YEARS_UNREAD,
  type CommandContext, type V7ImportPeriod, type CommandInputMap, type V7FiguresRowFigures, type V7ImportDecision, type V7ImportIngestTotals, type V7ImportRefreshCommitted,
  type V7ImportRefreshException, type V7ImportRefreshPreview, type V7ImportScope, type V7ImportSummary, type V7ReingestJobInput, type V7RowReconcileInput,
  type V7RowReconcileReason, type V7SpanningReconcile,
} from "@nzi/contracts";
import { AuthorizationError } from "./auth";
import { v7SpanEditions } from "./monthlyPricing";
import { readImportPolicy } from "./organisationSettings";
import { withTenantRead, withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { carryV7DerivedRows, type V7DerivedCarry } from "./v7DerivedRows";
import { readConsoleScopeTotals, type V7RowFiguresClient, type V7RowFiguresRead } from "./v7Drift";
import { sameV7Unit } from "./v7Reingest";
import { CommandValidationError, runPostgresCommand, runPostgresCommandInTransaction, type StoredOutcome } from "./postgresCommands";
import type { PlannedRow } from "./v7ClientImport";
import { currentDecisions, invalidApplied, lockV7Job } from "./v7ImportDecision";
import {
  chainInput, chainOptions, countsOf, insertIngest, summariseV7JobAsTheChainSees, totalsOf, v7ImportDecisionsSha256,
  type PlanCounts, type V7ImportIngestRun,
} from "./v7ImportIngest";
import { storeV7ImportSession } from "./v7ImportSummary";
import { readV7JobRowsFromViews } from "./v7ImportView";
import { emptyRehearsalReport, runV7ResyncChain, type V7RehearsalReport } from "./v7ResyncRehearsal";

const fail = (field: string, code: string, message: string): never => { throw new CommandValidationError([{ field, code, message }]); };
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value ?? null);
const sha256 = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

/**
 * Where the job's rows come from: the previous system's current records of it, planned, and the fingerprint of what was read.
 * In the service, the view set (`v7ImportViewSource`); a test may hand in planned rows directly.
 */
export type V7ImportRefreshSource = (consoleDb: Queryable, job: { organisationId: string; jobId: string; legacyJobNumber: string }) =>
  Promise<{ sourceSha256: string; rows: readonly PlannedRow[]; v7Categories?: V7RowCategories }>;
/**
 * The previous system's own category name per row (`row_id`, or `source:<id>`), as its views carry it — read by the import rows
 * modal to settle a factor filed under two categories (BRIEF-v7-import-rows-autopick-fix §5). The chain never reads it: the
 * planned rows, and the fingerprint of what was read, are as they were.
 */
export type V7RowCategories = Readonly<Record<string, string | null>>;

/** The service's source: the Phase A view set, through NZI_V7_VIEW_URL's pool (`v7ImportViewPoolConfig`). */
export const v7ImportViewSource = (pool: Pick<Pool, "connect">): V7ImportRefreshSource => (consoleDb, job) => readV7JobRowsFromViews(consoleDb, pool, job);

/** The summary's fingerprint as a commit names it: its content, not the moment it was made. */
export const v7ImportRefreshSummarySha256 = (summary: V7ImportSummary) => sha256({ ...summary, generatedAt: null });

const CROSSWALK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data", "v7-crosswalk-v1");

/**
 * The job's committed crosswalk plan (`data/v7-crosswalk-v1/plan-<job>.json`, in the repository), or — a job with none — an empty
 * one, so the decisions alone plan it. The same plan the operator's script reads.
 */
export function committedV7CrosswalkPlan(jobId: string, legacyJobNumber: string, dir = CROSSWALK_DIR): Omit<V7ReingestJobInput, "runId"> {
  if (!/^J\d{6}$/.test(legacyJobNumber)) fail("jobId", "JOB_NUMBER", "The job has no J number of the previous system.");
  const file = join(dir, `plan-${legacyJobNumber}.json`);
  if (!existsSync(file)) return { jobId, crosswalkVersion: "none", crosswalkSha256: createHash("sha256").update("").digest("hex"), vintageDatasetIds: [], rows: [] };
  const plan = JSON.parse(readFileSync(file, "utf8")) as Omit<V7ReingestJobInput, "runId">;
  if (plan.jobId !== jobId) fail("jobId", "PLAN_OF_ANOTHER_JOB", `The committed plan for ${legacyJobNumber} is another job's.`);
  return plan;
}

export type V7ImportRefreshOptions = {
  /** The committed plan; by default the repository's (`committedV7CrosswalkPlan`). */
  basePlan?: Omit<V7ReingestJobInput, "runId">;
  /**
   * Run inside the command's transaction, after the job is locked and read (and, for a commit, its fingerprints checked) and
   * before the chain. The fast path (Phase D) reads its eligibility here; a throw refuses as any step's refusal does.
   */
  within?: (db: Queryable, at: "preview" | "commit") => Promise<void>;
  /**
   * BRIEF-v7-import-rows-modal §B, the reconcile gate: a commit is refused (SCOPE_DOES_NOT_AGREE, nothing kept) unless every scope's
   * console total agrees with the previous system's to one decimal place. D7's own floor (the input carried exactly, R2) is
   * unchanged beneath it. The job's route sets it; the batch does not.
   */
  requireScopesAgree?: boolean;
  /**
   * BRIEF-v7-import-j000663 §B (ruled 24 Nov): bring the previous system's rows in on a snapshotted job. V7 is the source, so the
   * chain's revert and re-sync run as `bring-in` and the snapshot does not refuse them. Each of the job's snapshots is kept, never
   * edited, and recorded as superseded by this ingest (0234) in the same transaction; validate and publish then refuse it
   * (SNAPSHOT_SUPERSEDED), so the report is re-composed from a new snapshot. The job's route sets it; the batch does not.
   */
  allowSnapshotted?: boolean;
  /**
   * Datasets Part 2, increment 2: the previous system's own row figures (CONTRACT-v7-import-figures endpoint 2). For a job over two
   * calendar years they are read once, before the command's transaction, and the preview and the commit reconcile the rows they would
   * bring in against them (`v7SpanningReconcile`); with no client, or no read, such a job is refused as before. A one-year job never
   * calls it. The job's routes set it; the batch does not.
   */
  rowFigures?: V7RowFiguresClient;
  /** The read already made for this job (the fast path's preview hands its read to its commit: one call per bring-in). */
  spanningFigures?: SpanningFigures;
};

/** What a spanning job's reads and gates are checked against: whether it spans, and the previous system's own figures once read. */
export type SpanningFigures = { spans: boolean; read: V7RowFiguresRead | null };

/**
 * For a job over two calendar years: the previous system's own row figures (endpoint 2), read once, outside any transaction. A job in
 * one year reads nothing — unless `anyPeriod` (a bring-in: its derived rows, cause 8, are on endpoint 2 alone). With no client to read
 * through, nothing is read. Only the job's V7 id crosses.
 */
export async function readSpanningFigures(pool: PoolLike, organisationId: string, jobId: string, client: V7RowFiguresClient | undefined,
  { anyPeriod = false }: { anyPeriod?: boolean } = {}): Promise<SpanningFigures> {
  const job = await withTenantRead(pool, organisationId, async (db) => ({ period: await readV7ImportPeriod(db, organisationId, jobId),
    v7JobId: (await db.query<{ legacy_db_id: string | null }>(`SELECT legacy_db_id FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [organisationId, jobId])).rows[0]?.legacy_db_id ?? null }));
  const spans = v7PeriodSpansTwoYears(job.period);
  if ((!spans && !anyPeriod) || !client) return { spans, read: null };
  return { spans, read: job.v7JobId ? await client({ v7JobId: job.v7JobId }) : { ok: false, reason: "not-found" } };
}

const spanningFiguresFor = (pool: PoolLike, organisationId: string, jobId: string, options: V7ImportRefreshOptions) =>
  options.spanningFigures ? Promise.resolve(options.spanningFigures) : readSpanningFigures(pool, organisationId, jobId, options.rowFigures, { anyPeriod: true });

/** The totals with the job's derived rows in (cause 8): V7 counts them, and so, once carried, does the console. */
const withDerived = (totals: V7ImportIngestTotals | null, derived: V7DerivedCarry | null): V7ImportIngestTotals | null => totals && derived
  ? Object.fromEntries((["1", "2", "3"] as const).map((scope) => [scope, { v7Tco2e: totals[scope].v7Tco2e + derived.scopeTotals[scope],
    liveTco2e: totals[scope].liveTco2e + derived.scopeTotals[scope] }])) as V7ImportIngestTotals : totals;

export type Refresh = {
  legacyJobNumber: string; sourceSha256: string; rows: readonly PlannedRow[]; v7Categories: V7RowCategories; summary: V7ImportSummary; summarySha256: string;
  decisions: V7ImportDecision[]; decisionsSha256: string; resolved: ReturnType<typeof resolveV7Import>; exceptions: V7ImportRefreshException[];
};

/**
 * Read everything the chain runs from, inside the command's transaction: the job (locked against a concurrent decision, as the
 * decision commands lock it), its rows from the source, its summary as the chain will see it, its decisions and what they
 * resolve. Writes nothing.
 */
export async function readRefresh(db: Queryable, source: V7ImportRefreshSource, organisationId: string, jobId: string): Promise<Refresh> {
  await lockV7Job(db, organisationId, jobId);
  const legacyJobNumber = (await db.query<{ legacy_job_number: string | null }>(
    `SELECT legacy_job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [organisationId, jobId])).rows[0]?.legacy_job_number ?? null;
  if (!legacyJobNumber) fail("jobId", "JOB_NUMBER", "The job has no J number of the previous system.");
  const { sourceSha256, rows, v7Categories = {} } = await source(db, { organisationId, jobId, legacyJobNumber: legacyJobNumber! });
  const summary = await summariseV7JobAsTheChainSees(db, { organisationId, jobId, legacyJobNumber: legacyJobNumber!, extractSha256: sourceSha256, rows });
  const decisions = (await currentDecisions(db, jobId)).get(jobId) ?? [];
  const resolved = resolveV7Import(summary.rows, decisions, await invalidApplied(db, organisationId, decisions));
  // What still needs a person: a row whose own status needs a decision it lacks (or has stood down), and a pair awaiting its carry.
  const exceptions = resolved.rows.flatMap((row, at): V7ImportRefreshException[] => {
    if (row.resolution !== "unresolved" && row.resolution !== "stale" && row.carry !== "awaiting" && row.carry !== "needs-fresh-summary") return [];
    const of = summary.rows[at]!;
    return [{ legacyDbId: row.legacyDbId, status: of.status, ownStatus: row.ownStatus, resolution: row.resolution, carry: row.carry, scope: of.scope, code: of.code, pairGroup: of.pairGroup }];
  });
  return { legacyJobNumber: legacyJobNumber!, sourceSha256, rows, v7Categories, summary, summarySha256: v7ImportRefreshSummarySha256(summary),
    decisions, decisionsSha256: v7ImportDecisionsSha256(decisions), resolved, exceptions };
}

/**
 * The job's reporting period, inclusive: the job's own, else its emissions window (on every imported job the two agree). Read inside
 * the caller's transaction; writes nothing.
 */
export async function readV7ImportPeriod(db: Queryable, organisationId: string, jobId: string): Promise<V7ImportPeriod> {
  const row = (await db.query<{ period_from: string | null; period_to: string | null }>(
    `SELECT coalesce(j.reporting_period_start, c.reporting_from)::text AS period_from, coalesce(j.reporting_period_end, c.reporting_to)::text AS period_to
       FROM nzi_console.jobs j LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
      WHERE j.organisation_id = $1 AND j.job_id = $2`, [organisationId, jobId])).rows[0];
  return { from: row?.period_from ?? null, to: row?.period_to ?? null };
}

/**
 * The period guard (`v7ImportPeriodIssue`), before the previous system's rows are read, in the preview and the commit alike — so the
 * modal, the fast path and the batch, which all run through them, are all held by it. A job with no period is refused. A job over two
 * calendar years goes on only with the previous system's own figures in hand (endpoint 2); without them it is refused here, and with
 * them the chain's result must reconcile with them (`assertSpanningReconciles`). The command's transaction rolls back: nothing written.
 */
async function assertPeriodCheckable(db: Queryable, organisationId: string, jobId: string, figures: SpanningFigures) {
  const issue = v7ImportPeriodIssue(await readV7ImportPeriod(db, organisationId, jobId));
  if (!issue) return;
  if (issue.code === "SPANS_TWO_DATASET_YEARS" && figures.spans && figures.read?.ok) return;
  throw new CommandValidationError([issue.code === "SPANS_TWO_DATASET_YEARS" ? { ...issue, message: V7_IMPORT_TWO_DATASET_YEARS_UNREAD } : issue]);
}

/**
 * The reconcile on a spanning job (Datasets Part 2, increment 2), read back from the table after the chain, in its transaction: the
 * job's counted rows per scope against the previous system's own enabled rows, and each re-ingested row against its own V7 row. Ids,
 * scopes and tCO₂e only.
 */
export async function reconcileSpanningJob(db: Queryable, organisationId: string, jobId: string, figures: V7FiguresRowFigures): Promise<V7SpanningReconcile> {
  const live = (await db.query<{ v7_id: string | null; scope: string; tco2e: string | null; dataset_id: string | null; unit: string | null; factor_unit: string | null }>(
    `SELECT m.legacy_db_id AS v7_id, r.scope, coalesce(r.override_tco2e, r.calculated_tco2e)::text AS tco2e, r.dataset_id, r.unit, f.activity_unit AS factor_unit
       FROM nzi_console.job_scope_rows r
       JOIN nzi_console.job_scope_rows m ON (m.organisation_id, m.scope_row_id) = (r.organisation_id, r.reingested_from_row_id)
       LEFT JOIN nzi_console.emission_factors_display f ON (f.organisation_id, f.dataset_id, f.factor_id) = (r.organisation_id, r.dataset_id, r.factor_id)
      WHERE r.organisation_id = $1 AND r.job_id = $2 AND r.origin = 'live' AND r.enabled
     UNION ALL
     -- Cause 8: a derived row is linked to its V7 row by its own import identity, <V7 job id>:<V7 row id>.
     SELECT split_part(d.legacy_db_id, ':', 2), d.scope, d.override_tco2e::text, NULL, NULL, NULL FROM nzi_console.job_scope_rows d
      WHERE d.organisation_id = $1 AND d.job_id = $2 AND d.origin = 'live' AND d.enabled AND d.source_system = $3`,
    [organisationId, jobId, V7_DERIVED_SOURCE_SYSTEM])).rows;
  const selected = (await db.query<{ dataset_id: string; year: number }>(
    `SELECT d.dataset_id, extract(year FROM d.valid_from)::int AS year FROM nzi_console.job_dataset_selections s
       JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (s.organisation_id, s.dataset_id)
      WHERE s.organisation_id = $1 AND s.job_id = $2`, [organisationId, jobId])).rows;
  const counted = figures.rows.filter((row) => row.enabled);
  const previous: Record<V7ImportScope, number> = { "1": 0, "2": 0, "3": 0 };
  for (const row of counted) { const scope = v7FiguresScope(row.scope); if (scope) previous[scope] += row.tco2e; }
  const consoleTotals = await readConsoleScopeTotals(db, organisationId, jobId);
  const byV7 = new Map<string, typeof live>();
  for (const row of live) if (row.v7_id) byV7.set(row.v7_id, [...(byV7.get(row.v7_id) ?? []), row]);
  const ownById = new Map(counted.map((row) => [v7FiguresRowKey(row), row]));
  const ids = [...new Set([...byV7.keys(), ...ownById.keys()])];
  const rows: V7RowReconcileInput[] = ids.map((id) => {
    const here = byV7.get(id) ?? [];
    const own = ownById.get(id) ?? null;
    const scope = (here[0]?.scope.split(".")[0] ?? (own ? v7FiguresScope(own.scope) : null) ?? "3") as V7ImportScope;
    const consoleFigure = here.length ? here.reduce((sum, row) => sum + Number(row.tco2e ?? 0), 0) : null;
    let reason: V7RowReconcileReason | null = null;
    let detail: string | null = null;
    if (!here.length || !own) reason = "v7-changed";
    else if (own.custom_factor) reason = "custom-factor";
    else {
      const datasetId = here[0]!.dataset_id;
      const series = datasetId ? datasetSeriesKey(datasetId) : null;
      const years = new Set(selected.filter((entry) => series !== null && datasetSeriesKey(entry.dataset_id) === series).map((entry) => entry.year));
      const missing = series === null ? [] : [...new Set(own.spans.map((span) => span.dataset_year).filter((year): year is number => year !== null && !years.has(year)))];
      if (missing.length) { reason = "dataset-not-on-job"; detail = missing.map((year) => datasetLabelFromId(`${series}-${year}`)).join(", "); }
      else if (here.some((row) => row.unit && row.factor_unit && !sameV7Unit(row.unit, row.factor_unit))) reason = "unit";
    }
    return { legacyDbId: id, scope, console: consoleFigure, previous: own?.tco2e ?? null, reason, detail };
  });
  return v7SpanningReconcile(rows, { console: consoleTotals, previous });
}

/** Refuses (SPANS_TWO_DATASET_YEARS, the rows named) unless the spanning job's chain reconciles; returns the reconcile when it does. */
async function assertSpanningReconciles(db: Queryable, organisationId: string, jobId: string, figures: SpanningFigures): Promise<V7SpanningReconcile | null> {
  if (!figures.spans || !figures.read?.ok) return null;
  const reconcile = await reconcileSpanningJob(db, organisationId, jobId, figures.read.body);
  if (!reconcile.reconciles) throw new CommandValidationError(v7SpanningRefusal(reconcile));
  return reconcile;
}

/** The preview's and the record's totals on a spanning job: the previous system's own per scope, beside the console's live ones. */
const withOwnTotals = (totals: V7ImportIngestTotals | null, reconcile: V7SpanningReconcile | null): V7ImportIngestTotals | null => totals && reconcile
  ? Object.fromEntries(reconcile.scopes.map((entry) => [entry.scope, { v7Tco2e: entry.previous, liveTco2e: totals[entry.scope].liveTco2e }])) as V7ImportIngestTotals : totals;

const notReady = (verdict: string) => ({ field: "jobId", code: "NOT_READY_TO_INGEST",
  message: `The job is ${verdict}, not ready to ingest: every row that differs needs its decision, and every decision must stand.` });

/**
 * The editions a spanning job's rows were priced from in the previous system (R1: the job's automatic editions, one for each calendar
 * year its period touches — which a job made before R1 may not hold yet, R2). For each row the plan brings in at a factor: the edition
 * of that factor's series, in its country, for each of the row's own V7 spans' dataset years, where the library holds one. Bring-in
 * adds them with the plan's own vintages (ruling 3: added, never removed), so each month is priced at its year's edition, as the
 * previous system priced it. A year the library holds no edition of is not added; the reconcile names it. Reads only.
 */
export async function v7SpanVintages(db: Queryable, organisationId: string, jobId: string,
  rows: ReadonlyArray<{ v7RowId: string; datasetId?: string | null; factorId?: string | null }>, figures: V7FiguresRowFigures): Promise<string[]> {
  const atFactor = rows.filter((row) => row.datasetId && row.factorId);
  if (!atFactor.length) return [];
  // The plan names the migrated row; its V7 row id is that row's own legacy id (as the reconcile reads it).
  const legacy = new Map((await db.query<{ scope_row_id: string; legacy_db_id: string | null }>(
    `SELECT scope_row_id, legacy_db_id FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = ANY($3::text[])`,
    [organisationId, jobId, atFactor.map((row) => row.v7RowId)])).rows.map((row) => [row.scope_row_id, row.legacy_db_id]));
  const own = new Map(figures.rows.map((row) => [v7FiguresRowKey(row), row]));
  const priced = atFactor.flatMap((row) => {
    const figure = own.get(legacy.get(row.v7RowId) ?? "");
    return figure ? [{ datasetId: row.datasetId!, factorId: row.factorId!, figure }] : [];
  });
  const editions = await v7SpanEditions(db, organisationId, jobId, priced);
  const out = new Set<string>();
  for (const { datasetId, factorId, figure } of priced) for (const span of figure.spans) {
    // A client's custom value is no edition's (cause 7).
    if (span.dataset_id === null || span.dataset_year === null) continue;
    const edition = editions.get(`${datasetId}|${factorId}`)?.get(span.dataset_year);
    if (edition) out.add(edition.datasetId);
  }
  return [...out].sort();
}

/** The chain, in the caller's transaction, from what `readRefresh` read. Returns whether the re-ingest went through. */
async function runChain(db: Queryable, read: Refresh, organisationId: string, jobId: string, reason: string, suffix: string, basePlan: Omit<V7ReingestJobInput, "runId">, bringIn = false,
  figures: SpanningFigures | null = null) {
  const run: V7ImportIngestRun = { organisationId, jobId, legacyJobNumber: read.legacyJobNumber, reason, extractSha256: read.sourceSha256, rows: read.rows, basePlan };
  const counts: PlanCounts = { committed: 0, decided: 0 };
  const chain = chainInput(run);
  const report: V7RehearsalReport = emptyRehearsalReport(jobId);
  let planSha256: string | null = null;
  const options = chainOptions(run, { decisions: read.decisions, carriedPairGroups: read.resolved.groups.filter((group) => group.moved && group.carried).map((group) => group.pairGroup) }, counts);
  const own = figures?.spans && figures.read?.ok ? figures.read.body : null;
  const committed = await runV7ResyncChain(db, chain, report, { ...options, reingestReasonSuffix: suffix, bringIn,
    completePlan: async (db2, replan, superseded) => {
      const plan = await options.completePlan!(db2, replan, superseded);
      planSha256 = plan.crosswalkSha256;
      // A spanning job with the previous system's own figures read: every edition its rows' spans were priced from joins with them.
      if (!own) return plan;
      const spanned = await v7SpanVintages(db2, organisationId, jobId, plan.rows, own);
      return { ...plan, vintageDatasetIds: [...new Set([...plan.vintageDatasetIds, ...spanned])] };
    } });
  const ok = committed && report.refusal === null;
  // Cause 8: the rows the previous system derives, from its own figures when they were read — after the chain, in its transaction.
  const derived = ok && figures?.read?.ok
    ? await carryV7DerivedRows(db, { organisationId, jobId, reason: `${reason}${suffix}`, figures: figures.read.body }) : null;
  return { committed: ok, report, chain, counts, planSha256: planSha256 as string | null, derived };
}

class PreviewRollback extends Error {}

/**
 * import.refresh, `mode: "preview"` — the command run whole and rolled back: validated and access-checked as a commit is, the
 * chain run, the audit it would write discarded with everything else. Returns the reconciliation and what still needs a person.
 */
export async function previewV7ImportRefresh(pool: PoolLike, source: V7ImportRefreshSource, input: Extract<CommandInputMap["import.refresh"], { mode: "preview" }>,
  context: CommandContext, options: V7ImportRefreshOptions = {}): Promise<V7ImportRefreshPreview> {
  let preview: V7ImportRefreshPreview | null = null;
  const figures = await spanningFiguresFor(pool, context.organisationId, input.jobId, options);
  try {
    await withTenantWrite(pool, context.organisationId, async (db) => {
      const outcome = await runPostgresCommandInTransaction(db, "import.refresh", input, context, async (tx) => {
        await assertPeriodCheckable(tx, context.organisationId, input.jobId, figures);
        const read = await readRefresh(tx, source, context.organisationId, input.jobId);
        await options.within?.(tx, "preview");
        const base = { mode: "preview" as const, jobId: input.jobId, legacyJobNumber: read.legacyJobNumber, summarySha256: read.summarySha256,
          decisionsSha256: read.decisionsSha256, counts: read.summary.counts, verdict: read.resolved.verdict, exceptions: read.exceptions };
        let data: V7ImportRefreshPreview;
        if (read.resolved.verdict !== "ready-to-ingest") {
          data = { ...base, outcome: "refused", refusal: { stage: "ready", issues: [notReady(read.resolved.verdict)] }, chain: { resync: null, plan: null }, scopeTotals: null };
        } else {
          // Under a savepoint, so the command's own tail runs on a clean transaction whatever a step did — then all of it goes.
          await tx.query("SAVEPOINT v7_import_refresh_preview");
          try {
            const ran = await runChain(tx, read, context.organisationId, input.jobId, context.reason?.trim() || "import refresh preview", " — refresh preview, rolled back",
              options.basePlan ?? committedV7CrosswalkPlan(input.jobId, read.legacyJobNumber), options.allowSnapshotted === true, figures);
            // A spanning job: what the chain would bring in, against the previous system's own figures — or refused, the rows named.
            const reconcile = ran.committed ? await assertSpanningReconciles(tx, context.organisationId, input.jobId, figures) : null;
            data = { ...base, outcome: ran.committed ? "would-commit" : "refused",
              refusal: ran.committed ? null : ran.report.refusal ?? { stage: "reingest", issues: [{ field: "jobId", code: "NOT_COMMITTED", message: "The re-ingest did not commit." }] },
              chain: countsOf(ran.report, ran.counts), scopeTotals: ran.committed ? withOwnTotals(withDerived(totalsOf(ran.report), ran.derived), reconcile) : null,
              // Only when its own figures were read: an unread bring-in's preview and audit are as they were.
              ...(ran.derived ? { derived: ran.derived.carried } : {}) };
          } finally {
            await tx.query("ROLLBACK TO SAVEPOINT v7_import_refresh_preview");
          }
        }
        return { data, entityType: "job", entityId: input.jobId, topic: "import.refresh.previewed" };
      });
      preview = outcome.data;
      throw new PreviewRollback();
    });
  } catch (error) {
    if (!(error instanceof PreviewRollback)) throw error;
  }
  return preview!;
}

/**
 * import.refresh, `mode: "commit"` — the chain, kept, in the command's own transaction. Refused, with nothing written, when the
 * organisation requires an Admin and the caller is not one; when the summary or the decisions moved since the preview; when the
 * job is not ready to ingest; or when any step refuses — D7's reconciliation included.
 */
export async function commitV7ImportRefresh(pool: PoolLike, source: V7ImportRefreshSource, input: Extract<CommandInputMap["import.refresh"], { mode: "commit" }>,
  context: CommandContext, options: V7ImportRefreshOptions = {}): Promise<StoredOutcome<V7ImportRefreshCommitted>> {
  const figures = await spanningFiguresFor(pool, context.organisationId, input.jobId, options);
  return runPostgresCommand(pool, "import.refresh", input, context, async (db) => {
    if ((await readImportPolicy(db, context.organisationId)).refreshCommitRequiresAdmin && context.grant?.role !== "admin")
      throw new AuthorizationError("import.refresh", "This organisation requires an Admin to commit a refresh; a preview is still yours to run.");
    await assertPeriodCheckable(db, context.organisationId, input.jobId, figures);
    const read = await readRefresh(db, source, context.organisationId, input.jobId);
    if (read.summarySha256 !== input.summarySha256) fail("summarySha256", "SUMMARY_MOVED", "The job's rows have moved since the preview; preview again.");
    if (read.decisionsSha256 !== input.decisionsSha256) fail("decisionsSha256", "DECISIONS_MOVED", "The job's decisions changed since the preview; preview again.");
    if (read.resolved.verdict !== "ready-to-ingest") throw new CommandValidationError([notReady(read.resolved.verdict)]);
    await options.within?.(db, "commit");
    const ran = await runChain(db, read, context.organisationId, input.jobId, context.reason!.trim(), " — import refresh",
      options.basePlan ?? committedV7CrosswalkPlan(input.jobId, read.legacyJobNumber), options.allowSnapshotted === true, figures);
    if (!ran.committed) throw new CommandValidationError(ran.report.refusal?.issues ?? [{ field: "jobId", code: "NOT_COMMITTED", message: "The re-ingest did not commit." }]);
    // A spanning job reconciles with the previous system's own figures or nothing is kept. That is its agreement gate: the recompute
    // the gate below compares with is a single-factor figure, which over two editions is not the previous system's.
    const reconcile = await assertSpanningReconciles(db, context.organisationId, input.jobId, figures);
    if (options.requireScopesAgree && !reconcile) {
      // Named by scope, never by figure: the refusal is answered on screen, and the modal shows both totals from its preview.
      const totals = totalsOf(ran.report);
      const off = totals ? v7ScopeAgreement(totals).filter((entry) => !entry.agrees).map((entry) => entry.scope) : ["1", "2", "3"];
      if (off.length) throw new CommandValidationError(off.map((scope) => ({ field: "jobId", code: "SCOPE_DOES_NOT_AGREE",
        message: `The Scope ${scope} total does not agree with the previous system's to one decimal place, so nothing was brought in. Investigate the scope's rows first.` })));
    }
    // The summary it ran from, stored as the job's latest (closed, as an upload is), then the run's record against it.
    const issues = v7ImportSummaryIssues(read.summary);
    if (issues.length) throw new CommandValidationError(issues);
    const sessionId = await storeV7ImportSession(db, context, input.jobId, read.summary);
    const record = { sessionId, extractSha256: read.sourceSha256, decisionsSha256: read.decisionsSha256, planSha256: ran.planSha256, outcome: "committed" as const,
      refusedStage: null, refusalCodes: [], counts: countsOf(ran.report, ran.counts), scopeTotals: withOwnTotals(withDerived(totalsOf(ran.report), ran.derived), reconcile) };
    const ingestId = await insertIngest(db, context, input.jobId, "ingest", record, { resync: ran.chain.resyncRunId, reingest: ran.chain.reingestRunId });
    const governedEvents = [...(options.allowSnapshotted ? await supersedeSnapshots(db, context, input.jobId, ingestId) : []), ...(ran.derived?.event ? [ran.derived.event] : [])];
    const data: V7ImportRefreshCommitted = { mode: "commit", jobId: input.jobId, ingestId, sessionId, resyncRunId: ran.chain.resyncRunId, reingestRunId: ran.chain.reingestRunId,
      resync: record.counts.resync!, plan: record.counts.plan ?? { committed: 0, decided: 0 }, ...(ran.derived ? { derived: ran.derived.carried } : {}) };
    return { data, entityType: "job", entityId: input.jobId, topic: "import.refreshed", ...(governedEvents.length ? { governedEvents } : {}) };
  });
}

/**
 * §B: each of the job's snapshots not yet superseded, recorded as superseded by this ingest (0234) — the snapshot row untouched — with
 * one audit event each (ids only). Returns the events for the command to write beside its own.
 */
async function supersedeSnapshots(db: Queryable, context: CommandContext, jobId: string, ingestId: string) {
  const superseded = (await db.query<{ snapshot_id: string }>(
    `INSERT INTO nzi_console.reviewed_crp_snapshot_supersessions (organisation_id, snapshot_id, job_id, superseded_by_ingest_id, created_by, correlation_id)
     SELECT s.organisation_id, s.snapshot_id, s.job_id, $3, $4, $5 FROM nzi_console.reviewed_crp_snapshots s
      WHERE s.organisation_id = $1 AND s.job_id = $2
        AND NOT EXISTS (SELECT 1 FROM nzi_console.reviewed_crp_snapshot_supersessions x WHERE (x.organisation_id, x.snapshot_id) = (s.organisation_id, s.snapshot_id))
      ORDER BY s.snapshot_version RETURNING snapshot_id`,
    [context.organisationId, jobId, ingestId, context.actorId, context.correlationId])).rows;
  return superseded.map((row) => ({ action: "report.snapshot.superseded", entityType: "reviewed_snapshot", entityId: row.snapshot_id,
    before: { superseded: false }, after: { superseded: true, jobId, ingestId } }));
}
