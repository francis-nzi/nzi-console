// The reviewed backfill (R2; DESIGN-backfill-reprice-and-reselect, ruled 27 Nov 2026: BF-1 … BF-6 as proposed).
//
// Existing imported jobs moved onto the datasets-by-period rules (#662, #664), job by job, only on the owner's approval:
//   C. the job's country — the client's registered country through the import's country matcher; not recorded or not matched, GB is
//      kept and the job flagged (D-D);
//   B. its automatic selections re-derived by the per-year rule for the countries in scope; manual picks kept; a manual CEDA 2025
//      (Watershed) pick moved to its Cornerstone 2025 successor with its reason kept (L-4); a selection an enabled row cites is never
//      removed;
//   D. on a UAE job, each row re-pointed onto the UAE Activity & Spend factor of the same value: a `SWC-SPEND` row from its carried
//      client factor, and (BF-2) a `uk-ghg-gb` row onto its `uk-ghg-ae` twin — each only if it reproduces (± 0.005 t), else listed;
//   A. on a two-year job, each re-ingested row's months re-read from the live view set by calendar month (`v7MonthSlots`, as #662 maps
//      them) and the row re-priced by month through the one row calculation. Only rows whose months or figure change are written
//      (BF-5), so an unchanged approved row keeps its approval.
// The gate: a two-year job with re-ingested rows is written only if it then reconciles with the previous system's own figures
// (endpoint 2) within 0.1 t in every scope — all or nothing (BF-6): one that doesn't is listed whole, with its rows and reasons, and
// none of C, B or D is written for it either. Any other job's figures must not move beyond what D's row gate allows.
//
// Never touched: a job with a reviewed snapshot or a published console report (listed). A V7-issued PDF doesn't block (BF-1).
// One job per transaction; a dry run (the default) is each job's whole act, rolled back. A commit writes only the jobs named and
// approved, and only where the recomputed after equals the approved one (± 0.005 t per scope, BF-4); then a drift check (trigger
// `backfill`, 0243). Re-ingested rows are attest-only to everyone but the re-ingest's own principal, so the calculation runs as it,
// and the person signs the job's one audit event. Moved rows return to pending, as every calculation leaves them: `v7:batch-attest`.
// Ids, codes and tCO₂e only (NZC-120): no money, quantity or label in the output or the audit.
import { randomUUID } from "node:crypto";
import {
  commandGrantForRole, V7_DRIFT_TOLERANCE_TCO2E, V7_REINGEST_ACTOR, v7PeriodSpansTwoYears,
  type CommandContext, type V7DriftOutcome, type V7DriftUnknownReason, type V7FiguresRowFigures, type V7ImportScope, type V7RowReconcileMiss,
} from "@nzi/contracts";
import { automaticDatasetsFor, datasetCoverageWarnings, selectionReason } from "./datasetSelection";
import { ASSUMED_COUNTRY, jobCountryScope, registeredCountryCode } from "./datasetScope";
import { withTenantRead, withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError, recalculateScopeRowInTransaction, reportingMonthsFor } from "./postgresCommands";
import { personContext } from "./v7BatchAttest";
import { checkV7Drift, readConsoleScopeTotals, type V7FiguresClient, type V7RowFiguresClient } from "./v7Drift";
import { v7ImportBatchPauseAfter, V7_IMPORT_BATCH_PACING } from "./v7ImportBatch";
import { readSpanningFigures, reconcileSpanningJob, type V7ImportRefreshSource } from "./v7ImportRefresh";
import { v7MonthSlots } from "./v7Reingest";

export const V7_BACKFILL_AUDIT_ACTION = "v7.backfill.applied";
/** D's row gate and the approval's binding (BF-4): within this of the figure before / the approved after. */
export const V7_BACKFILL_ROW_TOLERANCE_TCO2E = 0.005;
const MIN_REASON = 8;
const SCOPES: readonly V7ImportScope[] = ["1", "2", "3"];
const SOURCE_DOWN: readonly V7DriftUnknownReason[] = ["unreachable", "timeout", "busy"];
const UAE = "AE";
const UK_SERIES_PREFIX = "uk-ghg-gb-";
const UAE_SERIES_PREFIX = "uk-ghg-ae-";
/** A V7 UAE Activity & Spend spend code (`SWC-SPEND-68.1-2`); the console's id is the series' prefix and the code. */
const SWC_SPEND = /^SWC-SPEND-/;
const UAE_FACTOR_PREFIX = "uk-ghg-";

export type V7BackfillStatus =
  | "would-write" | "written" | "unchanged"
  | "does-not-reconcile" | "listed-issued" | "v7-row-changed" | "refused" | "figures-unread"
  | "changed-since-approval" | "not-approved";

export type V7BackfillScope = { scope: V7ImportScope; before: number; after: number; previous: number | null };
/** A row the backfill did not move (D's gate, a calculation's refusal), or a row V7 changed since import: ids and codes only. */
export type V7BackfillRowNote = { rowId: string; code: string };
export type V7BackfillJob = {
  jobId: string; jobNumber: string; status: V7BackfillStatus;
  scopes: V7BackfillScope[];
  /** A: rows whose months moved; rows whose figure changed. D: rows re-pointed. */
  monthsMoved: number; repriced: number; repointed: number;
  selectionsAdded: string[]; selectionsRemoved: string[];
  countryBefore: string; countryAfter: string; countryAssumed: boolean;
  /** Rows not moved, and why (D's gate; A's refusals; V7 rows changed since import). */
  rows: V7BackfillRowNote[];
  /** A two-year job that doesn't reconcile: each row that differs from the previous system's own figure, with its reason. */
  misses: V7RowReconcileMiss[];
  codes: string[];
  drift: { outcome: V7DriftOutcome | "failed"; unknownReason: V7DriftUnknownReason | null } | null;
};
export type V7BackfillResult = { committed: boolean; jobs: V7BackfillJob[]; stopped: "completed" | "source-unresponsive"; auditEvents: number };

export type V7BackfillOptions = {
  organisationId: string;
  /** The Admin it runs as; they sign every audit event. */
  actorId: string;
  reason: string;
  commit: boolean;
  runId?: string;
  /** The live view set (`v7ImportViewSource`): each re-ingested row's months as V7 holds them now. */
  source: V7ImportRefreshSource;
  /** Endpoint 2, the previous system's own row figures: the gate of a two-year job. */
  rowFigures: V7RowFiguresClient;
  /** Endpoint 1, for the drift check after each job written. */
  figures: V7FiguresClient;
  /** Only these jobs (J numbers); every imported CRP job unless set. A commit requires them. */
  jobNumbers?: readonly string[];
  /** A commit's approved list (BF-4): each approved job's after per scope, as the dry run's CSV gave it. */
  approved?: ReadonlyMap<string, Readonly<Record<V7ImportScope, number>>>;
  breakerThreshold?: number;
  pauseMs?: number;
  maxPauseMs?: number;
  onJob?: (job: V7BackfillJob) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Every outcome but a write leaves the job exactly as it was: the transaction is rolled back with this. */
class Rollback extends Error { constructor(readonly status: V7BackfillStatus, readonly codes: string[] = []) { super(status); } }
const r6 = (value: number) => Math.round(value * 1e6) / 1e6;
const num = (value: string | number | null | undefined) => (value === null || value === undefined ? null : Number(value));

/** The organisation's imported CRP jobs with an emissions window, in job order — or only those named. */
export async function listV7BackfillJobs(pool: PoolLike, organisationId: string, jobNumbers?: readonly string[]): Promise<Array<{ jobId: string; jobNumber: string }>> {
  return withTenantRead(pool, organisationId, async (db) => (await db.query<{ job_id: string; legacy_job_number: string }>(
    `SELECT j.job_id, j.legacy_job_number FROM nzi_console.jobs j
       JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
      WHERE j.organisation_id = $1 AND j.job_family = 'crp' AND j.source_system = 'nzi-pro-v7' AND j.legacy_job_number IS NOT NULL
        AND ($2::text[] IS NULL OR j.legacy_job_number = ANY($2::text[]))
      ORDER BY j.sequence, j.job_id`, [organisationId, jobNumbers?.length ? [...jobNumbers] : null])).rows
    .map((row) => ({ jobId: row.job_id, jobNumber: row.legacy_job_number })));
}

/** The backfill, job by job. A job's own refusal is its outcome, never the run's; anything else stops the run. */
export async function runV7Backfill(pool: PoolLike, options: V7BackfillOptions): Promise<V7BackfillResult> {
  if (options.reason.trim().length < MIN_REASON) throw new Error(`REASON_REQUIRED: a reason of at least ${MIN_REASON} characters is required; it is recorded on every audit event.`);
  if (options.commit && (!options.jobNumbers?.length || !options.approved))
    throw new Error("APPROVAL_REQUIRED: --commit writes only the approved jobs: name them (--jobs) and give the approved list (--approved).");
  const person = await personContext(pool, { organisationId: options.organisationId, actorId: options.actorId, reason: options.reason, commit: options.commit });
  // An operator run, run as an Admin (as the spanning batch): the role, not a capability alone.
  if (person.grant.role !== "admin") throw new Error(`NOT_ADMIN: ${options.actorId} is not an Admin; the backfill runs as one.`);
  const runId = options.runId ?? randomUUID();
  const now = options.now ?? (() => performance.now());
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const floor = Math.max(options.pauseMs ?? V7_IMPORT_BATCH_PACING.pauseMs, V7_IMPORT_BATCH_PACING.pauseMs);
  const threshold = options.breakerThreshold ?? V7_IMPORT_BATCH_PACING.breakerThreshold;
  const jobs = await listV7BackfillJobs(pool, options.organisationId, options.jobNumbers);
  const out: V7BackfillJob[] = [];
  let down = 0, auditEvents = 0;
  for (const [at, job] of jobs.entries()) {
    const started = now();
    const { result, calledV7, sourceDown } = await oneJob(pool, { ...options, runId }, person, job);
    out.push(result);
    if (result.status === "written") auditEvents += 1;
    options.onJob?.(result);
    // Only a job that asked the previous system counts towards the breaker: one that never called it says nothing of it.
    if (calledV7) down = sourceDown ? down + 1 : 0;
    if (down >= threshold) return { committed: options.commit, jobs: out, stopped: "source-unresponsive", auditEvents };
    if (calledV7 && at < jobs.length - 1) await wait(v7ImportBatchPauseAfter(now() - started, floor, options.maxPauseMs ?? V7_IMPORT_BATCH_PACING.maxPauseMs));
  }
  return { committed: options.commit, jobs: out, stopped: "completed", auditEvents };
}

type Person = Awaited<ReturnType<typeof personContext>>;
type JobFacts = { issued: boolean; spanning: boolean; reingested: boolean; v7JobId: string | null; country: string };

async function readFacts(db: Queryable, org: string, jobId: string): Promise<JobFacts> {
  const row = (await db.query<{ issued: boolean; period_from: string; period_to: string; reingested: boolean; legacy_db_id: string | null; country_code: string }>(
    `SELECT EXISTS (SELECT 1 FROM nzi_console.reviewed_crp_snapshots s WHERE (s.organisation_id, s.job_id) = (j.organisation_id, j.job_id))
              OR EXISTS (SELECT 1 FROM nzi_console.report_versions v WHERE (v.organisation_id, v.job_id) = (j.organisation_id, j.job_id)
                           AND v.status IN ('published', 'in_client_review', 'client_approved')) AS issued,
            coalesce(j.reporting_period_start, c.reporting_from)::text AS period_from, coalesce(j.reporting_period_end, c.reporting_to)::text AS period_to,
            EXISTS (SELECT 1 FROM nzi_console.job_scope_rows r WHERE (r.organisation_id, r.job_id) = (j.organisation_id, j.job_id)
                      AND r.origin = 'live' AND r.enabled AND r.reingested_from_row_id IS NOT NULL) AS reingested,
            j.legacy_db_id, c.country_code
       FROM nzi_console.jobs j JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
      WHERE j.organisation_id = $1 AND j.job_id = $2`, [org, jobId])).rows[0]!;
  return { issued: row.issued, spanning: v7PeriodSpansTwoYears({ from: row.period_from, to: row.period_to }), reingested: row.reingested,
    v7JobId: row.legacy_db_id, country: row.country_code };
}

async function oneJob(pool: PoolLike, options: V7BackfillOptions & { runId: string }, person: Person, job: { jobId: string; jobNumber: string }):
  Promise<{ result: V7BackfillJob; calledV7: boolean; sourceDown: boolean }> {
  const org = options.organisationId;
  const facts = await withTenantRead(pool, org, (db) => readFacts(db, org, job.jobId));
  const before = await withTenantRead(pool, org, (db) => readConsoleScopeTotals(db, org, job.jobId));
  const result: V7BackfillJob = { ...job, status: "unchanged", scopes: SCOPES.map((scope) => ({ scope, before: r6(before[scope]), after: r6(before[scope]), previous: null })),
    monthsMoved: 0, repriced: 0, repointed: 0, selectionsAdded: [], selectionsRemoved: [], countryBefore: facts.country, countryAfter: facts.country, countryAssumed: false,
    rows: [], misses: [], codes: [], drift: null };
  // Issued figures are frozen (the console's snapshot or published report): listed, never written. A V7-issued PDF doesn't block (BF-1).
  if (facts.issued) return { result: { ...result, status: "listed-issued", codes: ["ISSUED"] }, calledV7: false, sourceDown: false };
  if (options.commit && !options.approved!.has(job.jobNumber)) return { result: { ...result, status: "not-approved", codes: ["NOT_APPROVED"] }, calledV7: false, sourceDown: false };
  // The gate's figures: endpoint 2, read once, outside the transaction (a bounded call, never inside one).
  const gated = facts.spanning && facts.reingested;
  let own: V7FiguresRowFigures | null = null;
  if (gated) {
    const read = await readSpanningFigures(pool, org, job.jobId, options.rowFigures);
    if (!read.read?.ok) {
      const reason = read.read?.reason ?? "not-configured";
      return { result: { ...result, status: "figures-unread", codes: [`FIGURES_UNREAD:${reason}`] }, calledV7: true, sourceDown: SOURCE_DOWN.includes(reason) };
    }
    own = read.read.body;
  }
  const context: CommandContext = { ...person, idempotencyKey: `v7-backfill:${options.runId}:${job.jobId}`, correlationId: `v7-backfill-${options.runId}` };
  // The re-ingest's own principal: the only one a re-ingested row's calculation admits. The person signs the audit event.
  const system: CommandContext = { organisationId: org, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `${context.idempotencyKey}:calc`,
    correlationId: context.correlationId, reason: context.reason, grant: commandGrantForRole("admin", org, V7_REINGEST_ACTOR) };
  try {
    await withTenantWrite(pool, org, async (db) => {
      await db.query(`SELECT 1 FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`, [org, job.jobId]);
      const window = (await db.query<{ from: string; to: string }>(
        `SELECT reporting_from::text AS from, reporting_to::text AS to FROM nzi_console.job_emissions_config WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`,
        [org, job.jobId])).rows[0]!;
      const step = new Step(db, org, job.jobId, options.runId, system, result);
      await step.country();
      const rule = await step.selections(window);
      await step.uae(window);
      if (gated) await step.months(options.source, job.jobNumber);
      await step.dropUnused(rule);
      const after = await readConsoleScopeTotals(db, org, job.jobId);
      for (const entry of result.scopes) entry.after = r6(after[entry.scope]);
      if (own) {
        const reconcile = await reconcileSpanningJob(db, org, job.jobId, own);
        for (const entry of result.scopes) entry.previous = reconcile.scopes.find((scope) => scope.scope === entry.scope)?.previous ?? null;
        if (!reconcile.reconciles) { result.misses = reconcile.rows; throw new Rollback("does-not-reconcile", ["DOES_NOT_RECONCILE"]); }
      } else if (result.scopes.some((entry) => Math.abs(entry.after - entry.before) > V7_DRIFT_TOLERANCE_TCO2E + 1e-9)) {
        // Only D moves a figure here, row by row within its gate: anything more is not this backfill's to write.
        throw new Rollback("refused", ["FIGURES_MOVED"]);
      }
      const changed = result.countryAfter !== result.countryBefore || result.selectionsAdded.length > 0 || result.selectionsRemoved.length > 0
        || result.monthsMoved > 0 || result.repriced > 0 || result.repointed > 0;
      if (!changed) throw new Rollback("unchanged");
      if (options.commit) {
        // BF-4: the commit binds to what was approved — the same after, per scope, as the approved list gave.
        const approved = options.approved!.get(job.jobNumber)!;
        if (result.scopes.some((entry) => Math.abs(entry.after - approved[entry.scope]) > V7_BACKFILL_ROW_TOLERANCE_TCO2E + 1e-9))
          throw new Rollback("changed-since-approval", ["CHANGED_SINCE_APPROVAL"]);
      }
      await db.query(
        `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json)
         VALUES ($1, $2, $3, 'staff', $4, 'job', $5, $6, $7, $8::jsonb, $9::jsonb)`,
        [org, randomUUID(), person.actorId, V7_BACKFILL_AUDIT_ACTION, job.jobId, context.correlationId, context.reason,
          JSON.stringify({ country: result.countryBefore, scopes: Object.fromEntries(result.scopes.map((entry) => [entry.scope, entry.before])) }),
          JSON.stringify({ runId: options.runId, jobNumber: job.jobNumber, country: result.countryAfter, countryAssumed: result.countryAssumed,
            scopes: Object.fromEntries(result.scopes.map((entry) => [entry.scope, entry.after])),
            previous: own ? Object.fromEntries(result.scopes.map((entry) => [entry.scope, entry.previous])) : null,
            monthsMoved: result.monthsMoved, repriced: result.repriced, repointed: result.repointed,
            selectionsAdded: result.selectionsAdded, selectionsRemoved: result.selectionsRemoved, notMoved: result.rows })]);
      if (!options.commit) throw new Rollback("would-write");
    });
    result.status = "written";
  } catch (error) {
    if (error instanceof Rollback) { result.status = error.status; result.codes = error.codes; }
    else if (error instanceof CommandValidationError) { result.status = "refused"; result.codes = [...new Set(error.issues.map((issue) => issue.code))]; }
    else throw error;
    // Nothing was written. The after is what the act would leave where the list is about it (would write, doesn't reconcile, changed
    // since approval); a job refused part-way, or unchanged, reports its figures as they stand.
    if (!(["would-write", "does-not-reconcile", "changed-since-approval"] as V7BackfillStatus[]).includes(result.status))
      for (const entry of result.scopes) entry.after = entry.before;
    return { result, calledV7: gated, sourceDown: false };
  }
  // The check a bring-in has, after the write: stored, so the banner and the publish gate read what the backfill left.
  try {
    const check = await checkV7Drift(pool, options.figures, org, job.jobId, { trigger: "backfill", requestedBy: person.actorId, correlationId: context.correlationId, principal: "staff" });
    result.drift = { outcome: check.outcome, unknownReason: check.unknownReason };
  } catch { result.drift = { outcome: "failed", unknownReason: null }; }
  return { result, calledV7: true, sourceDown: false };
}

/** The lineage titles the one row calculation writes itself: everything else a row carries (its import's marks) is carried forward. */
const CALCULATION_TITLES = new Set(["Activity data captured", "Factor resolved", "Client factor resolved", "Annual quantity split by month",
  "Priced as the previous system prices it", "Priced at its year's value", "Priced by month", "Priced at the nearest edition", "Emissions calculated",
  "Apportioned", "Monthly activity retained", "Calculated result overridden"]);

/** A job's steps, inside its transaction, recording what each did on the job's outcome. */
class Step {
  private savepoint = 0;
  constructor(private readonly db: Queryable, private readonly org: string, private readonly jobId: string, private readonly runId: string,
    private readonly system: CommandContext, private readonly out: V7BackfillJob) {}

  /** C: the client's registered country (R4), through the import's matcher; not recorded or not matched, GB kept and flagged (D-D). */
  async country(): Promise<void> {
    const registered = (await this.db.query<{ registered_country: string | null }>(
      `SELECT c.registered_country FROM nzi_console.clients c JOIN nzi_console.jobs j ON (j.organisation_id, j.client_id) = (c.organisation_id, c.client_id)
        WHERE j.organisation_id = $1 AND j.job_id = $2`, [this.org, this.jobId])).rows[0]?.registered_country ?? null;
    const code = registeredCountryCode(registered);
    this.out.countryAfter = code ?? ASSUMED_COUNTRY;
    this.out.countryAssumed = code === null;
    if (this.out.countryAfter !== this.out.countryBefore)
      await this.db.query(`UPDATE nzi_console.job_emissions_config SET country_code = $3, version = version + 1 WHERE organisation_id = $1 AND job_id = $2`,
        [this.org, this.jobId, this.out.countryAfter]);
  }

  /** B, first half: the rule's automatic picks added; L-4's manual moves. Returns the rule's picks, for the second half. */
  async selections(window: { from: string; to: string }): Promise<Set<string>> {
    const scope = await jobCountryScope(this.db, this.org, this.jobId, this.out.countryAfter);
    const picks = await automaticDatasetsFor(this.db, this.org, window, this.out.countryAfter, scope);
    const held = new Map((await this.db.query<{ dataset_id: string; selection_source: string; reason: string | null; status: string }>(
      `SELECT s.dataset_id, s.selection_source, s.reason, d.status FROM nzi_console.job_dataset_selections s
         JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (s.organisation_id, s.dataset_id)
        WHERE s.organisation_id = $1 AND s.job_id = $2`, [this.org, this.jobId])).rows.map((row) => [row.dataset_id, row]));
    // L-4: a manual pick of a superseded CEDA 2025 (Watershed) set moves to its Cornerstone 2025 successor, a manual pick still, its
    // reason kept. One with no successor (`ceda-ae-2025`) stays, with its warning. Never off an edition a row still cites.
    for (const pick of [...held.values()].filter((row) => row.selection_source === "manual" && row.status !== "active" && /^ceda-[a-z]+-2025$/.test(row.dataset_id))) {
      const successor = (await this.db.query<{ dataset_id: string; valid_from: string; valid_to: string; country_code: string; status: string }>(
        `SELECT dataset_id, valid_from::text AS valid_from, valid_to::text AS valid_to, country_code, status FROM nzi_console.emission_factor_datasets
          WHERE organisation_id = $1 AND dataset_id LIKE $2 || '-edition-%' AND status = 'active' ORDER BY dataset_id DESC LIMIT 1`, [this.org, pick.dataset_id])).rows[0];
      if (!successor || await this.cited(pick.dataset_id)) continue;
      if (!held.has(successor.dataset_id)) {
        const warnings = datasetCoverageWarnings({ validFrom: successor.valid_from, validTo: successor.valid_to, country: successor.country_code, status: successor.status }, window, this.out.countryAfter);
        await this.db.query(
          `INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, warnings_json, selected_by)
           VALUES ($1, $2, $3, 'manual', $4, $5::jsonb, $6)`,
          [this.org, this.jobId, successor.dataset_id, `${pick.reason ?? "Manual pick"} (moved from ${pick.dataset_id} to its Cornerstone successor, L-4; backfill ${this.runId})`,
            JSON.stringify(warnings), this.system.actorId]);
        held.set(successor.dataset_id, { dataset_id: successor.dataset_id, selection_source: "manual", reason: null, status: "active" });
        this.out.selectionsAdded.push(successor.dataset_id);
      }
      await this.db.query(`DELETE FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = $3`, [this.org, this.jobId, pick.dataset_id]);
      held.delete(pick.dataset_id);
      this.out.selectionsRemoved.push(pick.dataset_id);
    }
    for (const pick of picks) {
      if (held.has(pick.datasetId)) continue;
      await this.db.query(
        `INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by)
         VALUES ($1, $2, $3, 'automatic', $4, $5) ON CONFLICT DO NOTHING`,
        [this.org, this.jobId, pick.datasetId, selectionReason(pick, window), this.system.actorId]);
      this.out.selectionsAdded.push(pick.datasetId);
    }
    return new Set(picks.map((pick) => pick.datasetId));
  }

  /** B, second half, after D and A: an automatic pick the rule no longer makes goes — unless an enabled row cites it. */
  async dropUnused(rule: ReadonlySet<string>): Promise<void> {
    const dropped = (await this.db.query<{ dataset_id: string }>(
      `DELETE FROM nzi_console.job_dataset_selections s
        WHERE s.organisation_id = $1 AND s.job_id = $2 AND s.selection_source = 'automatic' AND NOT (s.dataset_id = ANY($3::text[]))
          AND NOT EXISTS (SELECT 1 FROM nzi_console.job_scope_rows r WHERE (r.organisation_id, r.job_id, r.dataset_id) = (s.organisation_id, s.job_id, s.dataset_id) AND r.enabled)
        RETURNING s.dataset_id`, [this.org, this.jobId, [...rule]])).rows.map((row) => row.dataset_id).sort();
    this.out.selectionsRemoved.push(...dropped);
  }

  private async cited(datasetId: string): Promise<boolean> {
    return (await this.db.query(`SELECT 1 FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = $3 AND enabled LIMIT 1`,
      [this.org, this.jobId, datasetId])).rows.length > 0;
  }

  /**
   * D (and BF-2): on a UAE job, each row onto the UAE Activity & Spend factor of the same value — a `SWC-SPEND` row from its carried
   * client factor to `uk-ghg-` + V7's code in the job year's `uk-ghg-ae` edition; a `uk-ghg-gb` row onto its `uk-ghg-ae` twin. A row
   * moves only if it reproduces (± 0.005 t); otherwise its savepoint rolls back and it is listed.
   */
  async uae(window: { from: string; to: string }): Promise<void> {
    if (this.out.countryAfter !== UAE) return;
    const year = window.to.slice(0, 4);
    const rows = (await this.db.query<{ scope_row_id: string; version: number; factor_source: string; dataset_id: string | null; factor_id: string | null; code: string | null; t: string | null }>(
      `SELECT r.scope_row_id, r.version, r.factor_source, r.dataset_id, r.factor_id, v.migrated_record->>'original_id' AS code, r.calculated_tco2e::text AS t
         FROM nzi_console.job_scope_rows r
         LEFT JOIN nzi_console.job_scope_rows v ON (v.organisation_id, v.scope_row_id) = (r.organisation_id, r.reingested_from_row_id)
        WHERE r.organisation_id = $1 AND r.job_id = $2 AND r.origin = 'live' AND r.enabled AND r.override_tco2e IS NULL
          AND ((r.factor_source = 'client' AND v.migrated_record->>'original_id' ~ '^SWC-SPEND-')
            OR (r.factor_source = 'dataset' AND r.dataset_id LIKE '${UK_SERIES_PREFIX}%'))
        ORDER BY r.scope_row_id FOR UPDATE OF r`, [this.org, this.jobId])).rows;
    for (const row of rows) {
      const target = row.factor_source === "client"
        ? { datasetId: `${UAE_SERIES_PREFIX}${year}`, factorId: `${UAE_FACTOR_PREFIX}${row.code!}` }
        : { datasetId: row.dataset_id!.replace(UK_SERIES_PREFIX, UAE_SERIES_PREFIX), factorId: row.factor_id! };
      if (row.factor_source === "client" && !SWC_SPEND.test(row.code ?? "")) continue;
      const exists = (await this.db.query(
        `SELECT 1 FROM nzi_console.emission_factors_display f JOIN nzi_console.job_dataset_selections s ON (s.organisation_id, s.job_id, s.dataset_id) = (f.organisation_id, $2, f.dataset_id)
          WHERE f.organisation_id = $1 AND f.dataset_id = $3 AND f.factor_id = $4 AND f.active`, [this.org, this.jobId, target.datasetId, target.factorId])).rows.length > 0;
      if (!exists) { this.out.rows.push({ rowId: row.scope_row_id, code: "NO_UAE_FACTOR" }); continue; }
      const name = await this.open();
      try {
        const moved = (await this.db.query<{ version: number }>(
          `UPDATE nzi_console.job_scope_rows SET factor_source = 'dataset', is_custom_entry = false, client_factor_id = NULL, dataset_id = $4, factor_id = $5,
                  version = version + 1, updated_at = now()
            WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 AND version = $6 RETURNING version`,
          [this.org, this.jobId, row.scope_row_id, target.datasetId, target.factorId, row.version])).rows[0]!;
        const after = await this.calculate(row.scope_row_id, moved.version,
          { title: "Moved to UAE Activity & Spend", detail: `${target.datasetId} · ${target.factorId} · same value · backfill ${this.runId}` });
        if (num(row.t) === null || Math.abs(after - num(row.t)!) > V7_BACKFILL_ROW_TOLERANCE_TCO2E + 1e-12) {
          await this.back(name); this.out.rows.push({ rowId: row.scope_row_id, code: "DOES_NOT_REPRODUCE" }); continue;
        }
        await this.release(name);
        this.out.repointed += 1;
      } catch (error) {
        if (!(error instanceof CommandValidationError)) throw error;
        await this.back(name);
        this.out.rows.push({ rowId: row.scope_row_id, code: error.issues[0]?.code ?? "REFUSED" });
      }
    }
  }

  /**
   * A: each re-ingested row's months, re-read from the live view set and mapped by calendar month (`v7MonthSlots`), then the row
   * re-priced by the one row calculation. A V7 row that changed since import (another quantity or months, or gone) is a bring-in, not
   * a backfill: the job is listed whole. Only rows whose months or figure change are kept (BF-5).
   */
  async months(source: V7ImportRefreshSource, jobNumber: string): Promise<void> {
    const rows = (await this.db.query<{ scope_row_id: string; version: number; overridden: boolean; calc: string | null; ma: Array<{ month: string; quantity: number | null }> | null;
      legacy_db_id: string | null; months: Array<number | null> | null; qty: string | null }>(
      `SELECT r.scope_row_id, r.version, r.override_tco2e IS NOT NULL AS overridden, r.calculated_tco2e::text AS calc, r.monthly_activity_json AS ma,
              m.legacy_db_id, m.migrated_record->'months' AS months, m.migrated_record->>'qty' AS qty
         FROM nzi_console.job_scope_rows r JOIN nzi_console.job_scope_rows m ON (m.organisation_id, m.scope_row_id) = (r.organisation_id, r.reingested_from_row_id)
        WHERE r.organisation_id = $1 AND r.job_id = $2 AND r.origin = 'live' AND r.enabled
        ORDER BY r.scope_row_id FOR UPDATE OF r`, [this.org, this.jobId])).rows;
    const live = new Map((await source(this.db, { organisationId: this.org, jobId: this.jobId, legacyJobNumber: jobNumber })).rows
      .map((row) => [row.legacyDbId, row.migratedRecord as { months?: Array<number | null>; qty?: number | null }]));
    const changed = rows.filter((row) => {
      const now = row.legacy_db_id === null ? undefined : live.get(row.legacy_db_id);
      return !now || !sameMonths(row.months, now.months ?? null) || num(row.qty) !== num(now.qty ?? null);
    });
    if (changed.length) {
      this.out.rows.push(...changed.map((row) => ({ rowId: row.scope_row_id, code: "V7_ROW_CHANGED" })));
      throw new Rollback("v7-row-changed", ["V7_ROW_CHANGED"]);
    }
    const reporting = await reportingMonthsFor(this.db, this.org, this.jobId);
    for (const row of rows.filter((item) => !item.overridden)) {
      const months = Array.isArray(row.months) ? row.months.map((value) => num(value)) : null;
      const { slots, outside } = v7MonthSlots(months, reporting);
      if (outside.length) { this.out.rows.push({ rowId: row.scope_row_id, code: "MONTHS_DO_NOT_FIT" }); throw new Rollback("refused", ["MONTHS_DO_NOT_FIT"]); }
      const moved = slots !== null && !sameSlots(row.ma, slots);
      const name = await this.open();
      try {
        let version = row.version;
        if (moved) version = (await this.db.query<{ version: number }>(
          `UPDATE nzi_console.job_scope_rows SET monthly_activity_json = $4::jsonb, version = version + 1, updated_at = now()
            WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 AND version = $5 RETURNING version`,
          [this.org, this.jobId, row.scope_row_id, JSON.stringify(slots), row.version])).rows[0]!.version;
        const after = await this.calculate(row.scope_row_id, version, moved
          ? { title: "Months re-read by calendar month", detail: `the previous system's month_N is calendar month N · backfill ${this.runId}` }
          : { title: "Re-priced by month", detail: `each month at its year's edition · backfill ${this.runId}` });
        const figureMoved = num(row.calc) === null || Math.abs(after - num(row.calc)!) > 1e-9;
        if (!moved && !figureMoved) { await this.back(name); continue; }
        await this.release(name);
        if (moved) this.out.monthsMoved += 1;
        if (figureMoved) this.out.repriced += 1;
      } catch (error) {
        if (!(error instanceof CommandValidationError)) throw error;
        await this.back(name);
        const code = error.issues[0]?.code ?? "REFUSED";
        this.out.rows.push({ rowId: row.scope_row_id, code });
        throw new Rollback("refused", [code]);
      }
    }
  }

  /**
   * The one row calculation, as the re-ingest's principal, carrying the row's import marks and its re-ingest provenance forward (the
   * calculation writes its own lineage and provenance whole). Returns the row's figure.
   */
  private async calculate(rowId: string, version: number, note: { title: string; detail: string }): Promise<number> {
    const prior = (await this.db.query<{ lineage: Array<{ title?: string; detail?: string }> | null; reingest: unknown }>(
      `SELECT lineage_json AS lineage, provenance_json->'reingest' AS reingest FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND scope_row_id = $2`,
      [this.org, rowId])).rows[0]!;
    const kept = (prior.lineage ?? []).filter((entry) => typeof entry.title === "string" && !CALCULATION_TITLES.has(entry.title))
      .map((entry) => ({ title: entry.title!, detail: entry.detail ?? "" }));
    await recalculateScopeRowInTransaction(this.db, { jobId: this.jobId, rowId, expectedVersion: version }, this.system, [...kept, note]);
    const figure = (await this.db.query<{ t: string | null }>(
      prior.reingest === null || prior.reingest === undefined
        ? `SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND scope_row_id = $2`
        : `UPDATE nzi_console.job_scope_rows SET provenance_json = provenance_json || jsonb_build_object('reingest', $3::jsonb)
            WHERE organisation_id = $1 AND scope_row_id = $2 RETURNING calculated_tco2e::text AS t`,
      prior.reingest === null || prior.reingest === undefined ? [this.org, rowId] : [this.org, rowId, JSON.stringify(prior.reingest)])).rows[0]!.t;
    return Number(figure ?? 0);
  }

  private async open(): Promise<string> { const name = `v7_backfill_${++this.savepoint}`; await this.db.query(`SAVEPOINT ${name}`); return name; }
  private async back(name: string): Promise<void> { await this.db.query(`ROLLBACK TO SAVEPOINT ${name}`); await this.db.query(`RELEASE SAVEPOINT ${name}`); }
  private async release(name: string): Promise<void> { await this.db.query(`RELEASE SAVEPOINT ${name}`); }
}

/** Two of the previous system's month arrays the same: twelve values, a missing one null. */
function sameMonths(a: ReadonlyArray<number | string | null> | null | undefined, b: ReadonlyArray<number | string | null> | null | undefined): boolean {
  const norm = (months: ReadonlyArray<number | string | null> | null | undefined) => Array.from({ length: 12 }, (_, at) => num(months?.[at] ?? null));
  const left = norm(a), right = norm(b);
  return left.every((value, at) => value === right[at]);
}
/** A row's stored months the same as the calendar slots. */
function sameSlots(stored: ReadonlyArray<{ month: string; quantity: number | null }> | null, slots: ReadonlyArray<{ month: string; quantity: number | null }>): boolean {
  if (!stored || stored.length !== slots.length) return false;
  return stored.every((entry, at) => entry.month === slots[at]!.month && num(entry.quantity) === num(slots[at]!.quantity));
}

// ── The list, as the script prints it and writes it (ids, codes and tCO₂e only) ──────────────────────────────────────────────────

const t = (n: number | null) => (n === null ? "" : n.toFixed(4));
const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export const V7_BACKFILL_CSV_HEADER = "job,job_id,outcome,s1_before,s1_after,s1_v7,s2_before,s2_after,s2_v7,s3_before,s3_after,s3_v7,"
  + "months_moved,repriced,repointed,selections_added,selections_removed,country_before,country_after,country_flag,codes,rows_not_moved,rows_differing";

export function v7BackfillCsv(jobs: readonly V7BackfillJob[]): string {
  const lines = [V7_BACKFILL_CSV_HEADER];
  for (const job of jobs) {
    const scope = (s: V7ImportScope) => job.scopes.find((entry) => entry.scope === s)!;
    lines.push([job.jobNumber, job.jobId, job.status, ...SCOPES.flatMap((s) => [t(scope(s).before), t(scope(s).after), t(scope(s).previous)]),
      String(job.monthsMoved), String(job.repriced), String(job.repointed), job.selectionsAdded.join(" "), job.selectionsRemoved.join(" "),
      job.countryBefore, job.countryAfter, job.countryAssumed ? "GB assumed" : "", job.codes.join(" "),
      job.rows.map((row) => `${row.rowId}:${row.code}`).join(" "),
      job.misses.map((miss) => `${miss.legacyDbId}:S${miss.scope}:${t(miss.console)}/${t(miss.previous)}:${miss.reason}`).join(" ")].map(cell).join(","));
  }
  const totals = v7BackfillTotals(jobs);
  lines.push("", "outcome,jobs", ...totals.map((row) => `${row.status},${row.jobs}`), `total,${jobs.length}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The approved list (BF-4), read from the dry run's CSV as Francis kept it: each `would-write` job's after per scope. Every other
 * line, the blank one and the totals are ignored; a job named twice is refused.
 */
export function parseV7BackfillApproved(text: string): Map<string, Record<V7ImportScope, number>> {
  const [header, ...lines] = text.split(/\r?\n/);
  if (header?.trim() !== V7_BACKFILL_CSV_HEADER) throw new Error("APPROVED_LIST: the approved list must be the backfill's own CSV, header first.");
  const out = new Map<string, Record<V7ImportScope, number>>();
  for (const line of lines) {
    const cells = line.split(",");
    if (cells[2] !== "would-write") continue;
    if (out.has(cells[0]!)) throw new Error(`APPROVED_LIST: ${cells[0]} is approved twice.`);
    const after = { "1": Number(cells[4]), "2": Number(cells[7]), "3": Number(cells[10]) };
    if (Object.values(after).some((value) => !Number.isFinite(value))) throw new Error(`APPROVED_LIST: ${cells[0]}'s after figures don't read.`);
    out.set(cells[0]!, after);
  }
  return out;
}

const ORDER: ReadonlyArray<[V7BackfillStatus, string]> = [["would-write", "would write"], ["written", "written"], ["unchanged", "unchanged"],
  ["does-not-reconcile", "does not reconcile"], ["listed-issued", "issued (listed)"], ["v7-row-changed", "V7 row changed (bring-in)"],
  ["refused", "refused"], ["figures-unread", "figures unread"], ["changed-since-approval", "changed since approval"], ["not-approved", "not approved"]];

export function v7BackfillTotals(jobs: readonly V7BackfillJob[]): Array<{ status: V7BackfillStatus; label: string; jobs: number }> {
  return ORDER.map(([status, label]) => ({ status, label, jobs: jobs.filter((job) => job.status === status).length }));
}

export function v7BackfillLines(job: V7BackfillJob): string[] {
  const head = `  ${job.jobNumber}: ${job.status.toUpperCase()}${job.codes.length ? ` — ${job.codes.join(" ")}` : ""}`
    + `${job.countryAfter !== job.countryBefore ? ` · country ${job.countryBefore} → ${job.countryAfter}` : job.countryAssumed ? " · country GB assumed" : ""}`;
  return [head,
    ...job.scopes.map((s) => `      Scope ${s.scope}: before ${t(s.before)} t → after ${t(s.after)} t${s.previous === null ? "" : ` · previous system ${t(s.previous)} t`}`),
    ...(job.monthsMoved || job.repriced || job.repointed ? [`      rows: ${job.monthsMoved} months re-read · ${job.repriced} re-priced · ${job.repointed} re-pointed`] : []),
    ...(job.selectionsAdded.length ? [`      datasets added: ${job.selectionsAdded.join(", ")}`] : []),
    ...(job.selectionsRemoved.length ? [`      datasets removed: ${job.selectionsRemoved.join(", ")}`] : []),
    ...job.rows.map((row) => `      row ${row.rowId}: ${row.code}`),
    ...job.misses.map((miss) => `      V7 row ${miss.legacyDbId} (Scope ${miss.scope}): ${t(miss.console)} here, ${t(miss.previous)} there — ${miss.reason}`),
    ...(job.drift ? [`      drift after: ${job.drift.outcome}${job.drift.unknownReason ? ` (${job.drift.unknownReason})` : ""}`] : [])];
}
