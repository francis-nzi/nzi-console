// The import workbench, Phase 3 (BRIEF-v7-import-workbench-phase3; migration 0229): ingest one job from its resolved decisions.
//
// The decisions are the crosswalk (R-B). The plan is the job's committed plan, re-planned onto v7's current records exactly as
// the rehearsal does (`replanOntoCurrentRows`: a changed row is carried at v7's current figures), and completed from the
// decisions: each row the re-plan cannot cover — new in v7, or moved in what the crosswalk keyed on — is planned from its `map`
// (category, factor). Each `carry` lets its pair group through the re-sync (RULING-v7-import-pair-carry, A: carry both,
// unlinked); each `withdraw` is the re-sync switching that row off. Then the chain that already exists — revert the standing
// re-ingest → re-sync (0225) → re-plan → re-ingest — with the re-ingest's D7 the hard floor (R-D): a decision set that does not
// reconcile to v7 per scope, row by row, is refused and nothing is written.
//
// It runs where the extract is — the operator's machine (R-A option 1); the service never sees it. The extract's rows are an
// argument beside the command, never its input, so nothing of them is stored but what the re-sync itself writes (v7's records,
// as the import always has). Before anything runs, the job must be ready to ingest *now*: the latest summary is of this extract,
// it still describes the job's rows, and the decisions resolve it.
import { createHash, randomUUID } from "node:crypto";
import {
  isCurrencyUnit, resolveV7Import, V7_IMPORT_SCOPES, V7_IMPORT_SUMMARY_FORMAT, v7ApplyPct,
  type CommandContext, type CommandInputMap, type ScopeQualityTier, type V7ImportDecision, type V7ImportIngestStage, type V7ImportIngestTotals,
  type V7ImportRehearsalRecord, type V7ReingestJobInput, type V7ReingestPlanRow,
} from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PlannedRow } from "./v7ClientImport";
import { currentDecisions, invalidApplied, invalidV7ImportMappings } from "./v7ImportDecision";
import { readV7ImportView, summariseV7JobForImport } from "./v7ImportSummary";
import { revertV7ReingestInTransaction, sameV7Unit } from "./v7Reingest";
import { v7ReingestRevertContext } from "./v7ReingestRevertRun";
import { emptyRehearsalReport, rehearseV7Resync, runV7ResyncChain, type V7ChainOptions, type V7Replan, type V7RehearsalInput, type V7RehearsalReport } from "./v7ResyncRehearsal";
import type { V7ResyncResult } from "./v7Resync";

const fail = (field: string, code: string, message: string): never => { throw new CommandValidationError([{ field, code, message }]); };
/** JSON with keys in order, so equal content fingerprints equally. */
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value ?? null);
const sha256 = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

/** The decisions an ingest runs with, fingerprinted: a decision made or cleared since changes it. */
export const v7ImportDecisionsSha256 = (decisions: readonly V7ImportDecision[]) => sha256(decisions.map((decision) => decision.decisionId).sort());

/**
 * The job's summary as the chain will see it. A job already re-ingested has its imported rows switched off by that run, so a
 * plain comparison finds every row "changed" and no row withdrawn. The chain reverts the standing run first; so does this —
 * under a savepoint, rolled back before it returns — and then summarises. Nothing is kept. Use it inside a write transaction.
 */
export async function summariseV7JobAsTheChainSees(db: Queryable, input: Parameters<typeof summariseV7JobForImport>[1]): ReturnType<typeof summariseV7JobForImport> {
  const standing = (await db.query<{ run_id: string }>(
    `SELECT run_id FROM nzi_console.v7_reingest_runs WHERE organisation_id = $1 AND job_id = $2 AND status = 'completed'`, [input.organisationId, input.jobId])).rows[0]?.run_id;
  if (!standing) return summariseV7JobForImport(db, input);
  await db.query("SAVEPOINT v7_import_summary_as_reverted");
  try {
    await revertV7ReingestInTransaction(db, { jobId: input.jobId, runId: standing },
      v7ReingestRevertContext(input.organisationId, standing, "import summary: compared as the ingest will see it (rolled back)"));
    return await summariseV7JobForImport(db, input);
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT v7_import_summary_as_reverted");
  }
}

/** One job's ingest, as the operator's script holds it: the extract's rows for the job, and the job's committed plan. */
export type V7ImportIngestRun = {
  organisationId: string; jobId: string; legacyJobNumber: string; reason: string;
  extractSha256: string; rows: readonly PlannedRow[];
  /** The committed crosswalk plan (`data/v7-crosswalk-v1/plan-<job>.json`), or an empty one when the job has none. */
  basePlan: Omit<V7ReingestJobInput, "runId">;
};

type Ready = { sessionId: string; decisionsSha256: string; decisions: V7ImportDecision[]; carriedPairGroups: string[] };

/**
 * Ready to ingest, now: the job's latest summary is of this extract and of the current format, it still describes the job's rows
 * (the emitter, re-run here read-only, finds what it found), and the job's current decisions resolve every row of it.
 */
async function readiness(db: Queryable, run: V7ImportIngestRun): Promise<Ready> {
  const view = await readV7ImportView(db, run.jobId);
  if (!view) fail("jobId", "NO_SUMMARY", "This job has no import summary; make and upload one, and resolve it, first.");
  const session = view!.session;
  if (session.extractSha256 !== run.extractSha256) fail("extractSha256", "EXTRACT_NOT_SUMMARISED", "The job's latest summary is of another extract; summarise this one and resolve it first.");
  if (session.format !== V7_IMPORT_SUMMARY_FORMAT) fail("sessionId", "SUMMARY_TOO_OLD", "The job's latest summary predates pair groups; make and upload a fresh one.");
  const fresh = await summariseV7JobAsTheChainSees(db, { organisationId: run.organisationId, jobId: run.jobId, legacyJobNumber: run.legacyJobNumber,
    extractSha256: run.extractSha256, rows: run.rows, generatedAt: session.generatedAt });
  if (stable(fresh.rows) !== stable(view!.rows))
    fail("sessionId", "SUMMARY_STALE", "The job's rows have moved since its latest summary; make and upload a fresh one, and check its decisions.");
  const decisions = (await currentDecisions(db, run.jobId)).get(run.jobId) ?? [];
  const resolved = resolveV7Import(fresh.rows, decisions, await invalidApplied(db, run.organisationId, decisions));
  if (resolved.verdict !== "ready-to-ingest")
    fail("jobId", "NOT_READY_TO_INGEST", `The job is ${resolved.verdict}, not ready to ingest: every row that differs needs its decision, and every decision must stand.`);
  return { sessionId: session.sessionId, decisionsSha256: v7ImportDecisionsSha256(decisions), decisions,
    carriedPairGroups: resolved.groups.filter((group) => group.moved && group.carried).map((group) => group.pairGroup) };
}

/** A new row's data quality tier: spend in a currency is spend-based, a commuting survey is a survey, the rest measured. */
const tierFor = (unit: string | null, dataSource: unknown): ScopeQualityTier =>
  unit && isCurrencyUnit(unit) ? "spend-based" : typeof dataSource === "string" && /commuting/i.test(dataSource) ? "survey" : "measured";

type PlanCounts = { committed: number; decided: number };

/**
 * The plan, completed from the decisions: the committed plan re-planned onto the current rows, and each row the re-plan cannot
 * cover planned from its `map` — v7's current record (its label, quantity, unit, apportionment, figure) under the decision's
 * category and factor. A row with no `map`, or a `map` the re-plan would ignore, refuses: nothing is guessed.
 */
async function completeFromDecisions(db: Queryable, run: V7ImportIngestRun, ready: Ready, replan: V7Replan, superseded: V7ResyncResult["superseded"], counts: PlanCounts):
  Promise<Omit<V7ReingestJobInput, "runId">> {
  const org = run.organisationId;
  const maps = new Map(ready.decisions.filter((decision) => decision.kind === "map").map((decision) => [decision.legacyDbId, decision]));
  const current = new Map((await db.query<{ scope_row_id: string; legacy_db_id: string; scope: string; source_label: string; enabled: boolean; record: Record<string, unknown> }>(
    `SELECT scope_row_id, legacy_db_id, scope, source_label, enabled, migrated_record AS record FROM nzi_console.job_scope_rows
      WHERE organisation_id = $1 AND job_id = $2 AND origin = 'migrated' AND superseded_by_row_id IS NULL`, [org, run.jobId])).rows.map((row) => [row.scope_row_id, row]));
  const needed = new Set(replan.needsCrosswalk.map((row) => row.rowId));
  const issues: Array<{ field: string; code: string; message: string }> = [];
  for (const rowId of needed) if (!maps.has(current.get(rowId)?.legacy_db_id ?? "")) issues.push({ field: "decisions", code: "DECISION_MISSING", message: `${rowId} has no mapping, and the committed plan does not cover it.` });
  // A mapping the re-plan would not use (its row carried by the committed plan) refuses rather than be silently ignored.
  for (const row of current.values()) if (row.enabled && maps.has(row.legacy_db_id) && !needed.has(row.scope_row_id))
    issues.push({ field: "decisions", code: "DECISION_UNUSED", message: `${row.scope_row_id} has a mapping, but the committed plan already places it.` });
  if (issues.length) throw new CommandValidationError(issues.slice(0, 20));

  const used = [...needed].map((rowId) => ({ row: current.get(rowId)!, decision: maps.get(current.get(rowId)!.legacy_db_id)! }));
  const invalid = await invalidV7ImportMappings(db, org, used.map(({ row, decision }) =>
    ({ key: row.scope_row_id, scope: decision.forScope, categoryCode: decision.categoryCode!, datasetId: decision.datasetId!, factorId: decision.factorId! })));
  if (invalid.size) throw new CommandValidationError([...invalid].slice(0, 20).map(([rowId, issue]) => ({ ...issue, message: `${rowId}: ${issue.message}` })));
  const units = new Map((await db.query<{ dataset_id: string; factor_id: string; activity_unit: string }>(
    `SELECT dataset_id, factor_id, activity_unit FROM nzi_console.emission_factors WHERE organisation_id = $1 AND (dataset_id, factor_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
    [org, used.map(({ decision }) => decision.datasetId!), used.map(({ decision }) => decision.factorId!)])).rows.map((row) => [`${row.dataset_id}|${row.factor_id}`, row.activity_unit]));
  const replacedFrom = new Map(superseded.map((pair) => [pair.replacedBy, pair.rowId]));
  const prior = new Map(run.basePlan.rows.map((row) => [row.v7RowId, row]));

  const decided: V7ReingestPlanRow[] = used.map(({ row, decision }) => {
    const record = row.record;
    const quantity = record.qty === null || record.qty === undefined || record.qty === "" ? null : Number(record.qty);
    const uom = typeof record.uom === "string" ? record.uom : null;
    const factorUnit = units.get(`${decision.datasetId}|${decision.factorId}`) ?? null;
    const before = prior.get(replacedFrom.get(row.scope_row_id) ?? "");
    const categoryCode = decision.categoryCode!;
    const base = { v7RowId: row.scope_row_id, categoryCode, scope: categoryCode.startsWith("3.") ? categoryCode : categoryCode.split(".")[0]!,
      sourceLabel: row.source_label, v7Tco2e: Number(record.reported_tco2e ?? 0), applyPct: v7ApplyPct(record.apply_pct === null || record.apply_pct === undefined ? null : Number(record.apply_pct)),
      // The decision that placed it, so the live row's lineage names it.
      rule: `workbench:${decision.decisionId}` };
    // v7 recorded a figure and no activity: carried as a reported total, under the decision's category (D5).
    if (quantity === null) return { ...base, disposition: "REPORTED-TOTAL" as const, quantity: null, unit: null, qualityTier: before?.qualityTier ?? "estimated" };
    // The factor's own spelling where v7's unit is the same unit, so calculation reads them as one; else v7's, for D7 to judge.
    const unit = factorUnit && uom && sameV7Unit(factorUnit, uom) ? factorUnit : uom ?? factorUnit ?? "";
    return { ...base, disposition: "RE-INGEST" as const, quantity, unit, datasetId: decision.datasetId!, factorId: decision.factorId!,
      qualityTier: before?.qualityTier ?? tierFor(unit, record.data_source) };
  });
  counts.committed = replan.rows.length; counts.decided = decided.length;
  const rows = [...replan.rows, ...decided];
  return { jobId: run.jobId, crosswalkVersion: `${run.basePlan.crosswalkVersion}+workbench`, crosswalkSha256: sha256(rows),
    vintageDatasetIds: [...new Set([...run.basePlan.vintageDatasetIds, ...used.map(({ decision }) => decision.datasetId!)])], rows };
}

/** The chain's options for this run: its carried pairs, and the plan completed from its decisions. */
const chainOptions = (run: V7ImportIngestRun, ready: Ready, counts: PlanCounts): V7ChainOptions => ({
  carriedPairGroups: ready.carriedPairGroups,
  completePlan: (db, replan, superseded) => completeFromDecisions(db, run, ready, replan, superseded, counts),
});
const chainInput = (run: V7ImportIngestRun): V7RehearsalInput => ({ organisationId: run.organisationId, jobId: run.jobId, reason: run.reason,
  resyncRunId: `v7-resync-${randomUUID()}`, extractSha256: run.extractSha256, rows: run.rows, plan: run.basePlan, reingestRunId: `v7-reingest-${randomUUID()}` });

const totalsOf = (report: V7RehearsalReport): V7ImportIngestTotals | null => report.reingest
  ? Object.fromEntries(V7_IMPORT_SCOPES.map((scope) => [scope, { v7Tco2e: report.reingest!.scopeTotals[scope]?.v7 ?? 0, liveTco2e: report.reingest!.scopeTotals[scope]?.native ?? 0 }])) as V7ImportIngestTotals
  : null;
const countsOf = (report: V7RehearsalReport, plan: PlanCounts | null) => ({
  resync: report.resync ? { unchanged: report.resync.unchanged, superseded: report.resync.superseded.length, added: report.resync.added.length, withdrawn: report.resync.withdrawn.length } : null,
  plan: report.replan && plan && (plan.committed || plan.decided) ? { ...plan } : report.replan ? { committed: report.replan.rows.length, decided: 0 } : null,
});

/**
 * The rehearsal of the ingest: the readiness check, then the whole chain, in one transaction that is always rolled back
 * (`rehearseV7Resync`). Returns the report and the closed record the console keeps of it.
 */
export async function rehearseV7ImportIngest(pool: PoolLike, run: V7ImportIngestRun): Promise<{ report: V7RehearsalReport; record: V7ImportRehearsalRecord | null }> {
  let ready: Ready | null = null;
  const counts: PlanCounts = { committed: 0, decided: 0 };
  let planSha256: string | null = null;
  const report = await rehearseV7Resync(pool, chainInput(run), {
    before: async (db, rehearsal) => {
      try { ready = await readiness(db, run); } catch (error) {
        if (!(error instanceof CommandValidationError)) throw error;
        rehearsal.refusal = { stage: "ready", issues: error.issues.map((issue) => ({ field: String(issue.field), code: issue.code, message: issue.message })) };
        return null;
      }
      const chain = chainOptions(run, ready!, counts);
      return { ...chain, completePlan: async (db2, replan, superseded) => { const plan = await chain.completePlan!(db2, replan, superseded); planSha256 = plan.crosswalkSha256; return plan; } };
    },
  });
  // A rehearsal refused before it knew the summary has nothing to be recorded against.
  if (!ready) return { report, record: null };
  const r = ready as Ready;
  const refused = report.refusal !== null || report.reingest === null;
  return { report, record: {
    sessionId: r.sessionId, extractSha256: run.extractSha256, decisionsSha256: r.decisionsSha256, planSha256,
    outcome: refused ? "refused" : "would-commit", refusedStage: refused ? (report.refusal?.stage ?? "reingest") as V7ImportIngestStage : null,
    refusalCodes: refused ? [...new Set(report.refusal?.issues.map((issue) => issue.code) ?? ["NOT_COMMITTED"])] : [],
    counts: countsOf(report, counts), scopeTotals: refused ? null : totalsOf(report) } };
}

const insertIngest = (db: Queryable, context: CommandContext, jobId: string, kind: "rehearsal" | "ingest", record: V7ImportRehearsalRecord | (Omit<V7ImportRehearsalRecord, "outcome"> & { outcome: "committed" }),
  runs: { resync: string; reingest: string } | null) => {
  const ingestId = `v7-ingest-${randomUUID()}`;
  const t = record.scopeTotals;
  return db.query(
    `INSERT INTO nzi_console.v7_import_ingests (organisation_id, ingest_id, job_id, kind, session_id, extract_sha256, decisions_sha256, plan_sha256, outcome, refused_stage,
       refusal_codes, rows_unchanged, rows_superseded, rows_added, rows_withdrawn, plan_rows_committed, plan_rows_decided,
       v7_scope1_tco2e, v7_scope2_tco2e, v7_scope3_tco2e, live_scope1_tco2e, live_scope2_tco2e, live_scope3_tco2e, resync_run_id, reingest_run_id, created_by, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [context.organisationId, ingestId, jobId, kind, record.sessionId, record.extractSha256, record.decisionsSha256, record.planSha256, record.outcome, record.refusedStage,
      record.refusalCodes, record.counts.resync?.unchanged ?? null, record.counts.resync?.superseded ?? null, record.counts.resync?.added ?? null, record.counts.resync?.withdrawn ?? null,
      record.counts.plan?.committed ?? null, record.counts.plan?.decided ?? null,
      t?.["1"].v7Tco2e ?? null, t?.["2"].v7Tco2e ?? null, t?.["3"].v7Tco2e ?? null, t?.["1"].liveTco2e ?? null, t?.["2"].liveTco2e ?? null, t?.["3"].liveTco2e ?? null,
      runs?.resync ?? null, runs?.reingest ?? null, context.actorId, context.correlationId]).then(() => ingestId);
};

export type V7ImportRehearsalRecorded = { ingestId: string; jobId: string; outcome: V7ImportRehearsalRecord["outcome"]; refusedStage: V7ImportIngestStage | null; refusalCodes: string[] };

/** import.rehearsal.record — keep one rehearsal: ids, counts, codes, Σ per scope. The audit holds the outcome and codes, no figures. */
export function recordV7ImportRehearsal(pool: PoolLike, input: CommandInputMap["import.rehearsal.record"], context: CommandContext): Promise<StoredOutcome<V7ImportRehearsalRecorded>> {
  return runPostgresCommand(pool, "import.rehearsal.record", input, context, async (db) => {
    const session = (await db.query<{ job_id: string }>(`SELECT job_id FROM nzi_console.v7_import_sessions WHERE organisation_id = $1 AND session_id = $2`,
      [context.organisationId, input.rehearsal.sessionId])).rows[0];
    if (!session || session.job_id !== input.jobId) fail("rehearsal.sessionId", "SESSION_OF_ANOTHER_JOB", "That summary is not this job's.");
    const ingestId = await insertIngest(db, context, input.jobId, "rehearsal", input.rehearsal, null);
    return { data: { ingestId, jobId: input.jobId, outcome: input.rehearsal.outcome, refusedStage: input.rehearsal.refusedStage, refusalCodes: input.rehearsal.refusalCodes },
      entityType: "job", entityId: input.jobId, topic: "import.rehearsal.recorded" };
  });
}

export type V7ImportIngestResult = {
  ingestId: string; jobId: string; resyncRunId: string; reingestRunId: string;
  resync: { unchanged: number; superseded: number; added: number; withdrawn: number }; plan: { committed: number; decided: number };
};

/**
 * import.ingest — the committed chain, in the command's own transaction: ready now (the summary and the decisions the operator
 * rehearsed, unchanged), then revert → re-sync → re-plan → re-ingest, each the existing governed step under its own principal.
 * Any refusal — D7's included — refuses the whole command, and nothing is written. The audit holds run ids and counts, no figures.
 */
export function ingestV7ImportJob(pool: PoolLike, input: CommandInputMap["import.ingest"], run: V7ImportIngestRun, context: CommandContext): Promise<StoredOutcome<V7ImportIngestResult>> {
  return runPostgresCommand(pool, "import.ingest", input, context, async (db) => {
    if (run.jobId !== input.jobId || run.extractSha256 !== input.extractSha256 || run.organisationId !== context.organisationId)
      fail("jobId", "RUN_MISMATCH", "The extract's rows are of another job or extract than the command names.");
    const ready = await readiness(db, { ...run, reason: context.reason ?? run.reason });
    if (ready.sessionId !== input.sessionId) fail("sessionId", "SUMMARY_MOVED", "A newer summary was uploaded since the rehearsal; rehearse again.");
    if (ready.decisionsSha256 !== input.decisionsSha256) fail("decisionsSha256", "DECISIONS_MOVED", "The job's decisions changed since the rehearsal; rehearse again.");
    const counts: PlanCounts = { committed: 0, decided: 0 };
    const chain = chainInput({ ...run, reason: context.reason!.trim() });
    const report = emptyRehearsalReport(run.jobId);
    let planSha256: string | null = null;
    const options = chainOptions(run, ready, counts);
    const committed = await runV7ResyncChain(db, chain, report, { ...options, reingestReasonSuffix: " — import workbench ingest",
      completePlan: async (db2, replan, superseded) => { const plan = await options.completePlan!(db2, replan, superseded); planSha256 = plan.crosswalkSha256; return plan; } });
    if (!committed || report.refusal) throw new CommandValidationError(report.refusal?.issues ?? [{ field: "jobId", code: "NOT_COMMITTED", message: "The re-ingest did not commit." }]);
    const record = { sessionId: ready.sessionId, extractSha256: run.extractSha256, decisionsSha256: ready.decisionsSha256, planSha256, outcome: "committed" as const,
      refusedStage: null, refusalCodes: [], counts: countsOf(report, counts), scopeTotals: totalsOf(report) };
    const ingestId = await insertIngest(db, context, run.jobId, "ingest", record, { resync: chain.resyncRunId, reingest: chain.reingestRunId });
    return { data: { ingestId, jobId: run.jobId, resyncRunId: chain.resyncRunId, reingestRunId: chain.reingestRunId,
      resync: record.counts.resync!, plan: record.counts.plan ?? { committed: 0, decided: 0 } },
      entityType: "job", entityId: run.jobId, topic: "import.ingested" };
  });
}

// ── The read behind the view ──────────────────────────────────────────────────────────────────────────────────────

export type V7ImportIngestEntry = {
  ingestId: string; kind: "rehearsal" | "ingest"; sessionId: string; decisionsSha256: string; outcome: "would-commit" | "refused" | "committed";
  refusedStage: V7ImportIngestStage | null; refusalCodes: string[];
  resync: { unchanged: number; superseded: number; added: number; withdrawn: number } | null; plan: { committed: number; decided: number } | null;
  scopeTotals: V7ImportIngestTotals | null; resyncRunId: string | null; reingestRunId: string | null; createdAt: string; createdBy: string;
};
export type V7ImportIngestState = {
  /** The latest rehearsal, and whether it ran with the job's current decisions and latest summary. */
  rehearsal: (V7ImportIngestEntry & { current: boolean }) | null;
  /** The latest ingest, with its re-ingest run's state now and its live rows' review. */
  ingest: (V7ImportIngestEntry & { runStatus: "completed" | "reverted" | null; rowsApproved: number; rowsPending: number }) | null;
};

type IngestRow = {
  ingest_id: string; kind: "rehearsal" | "ingest"; session_id: string; decisions_sha256: string; outcome: V7ImportIngestEntry["outcome"]; refused_stage: V7ImportIngestStage | null;
  refusal_codes: string[]; rows_unchanged: number | null; rows_superseded: number | null; rows_added: number | null; rows_withdrawn: number | null;
  plan_rows_committed: number | null; plan_rows_decided: number | null; resync_run_id: string | null; reingest_run_id: string | null; created_at: Date; created_by: string;
} & Record<`${"v7" | "live"}_scope${1 | 2 | 3}_tco2e`, string | null>;
const entryOf = (row: IngestRow): V7ImportIngestEntry => ({
  ingestId: row.ingest_id, kind: row.kind, sessionId: row.session_id, decisionsSha256: row.decisions_sha256, outcome: row.outcome, refusedStage: row.refused_stage,
  refusalCodes: row.refusal_codes,
  resync: row.rows_unchanged === null ? null : { unchanged: row.rows_unchanged, superseded: row.rows_superseded!, added: row.rows_added!, withdrawn: row.rows_withdrawn! },
  plan: row.plan_rows_committed === null ? null : { committed: row.plan_rows_committed, decided: row.plan_rows_decided! },
  scopeTotals: row.v7_scope1_tco2e === null ? null : Object.fromEntries(V7_IMPORT_SCOPES.map((scope) =>
    [scope, { v7Tco2e: Number(row[`v7_scope${scope}_tco2e`]), liveTco2e: Number(row[`live_scope${scope}_tco2e`]) }])) as V7ImportIngestTotals,
  resyncRunId: row.resync_run_id, reingestRunId: row.reingest_run_id, createdAt: row.created_at.toISOString(), createdBy: row.created_by,
});

/** One job's latest rehearsal and latest ingest. */
export async function readV7ImportIngestState(db: Queryable, jobId: string, current: { sessionId: string; decisionsSha256: string } | null): Promise<V7ImportIngestState> {
  const latest = async (kind: "rehearsal" | "ingest") => (await db.query<IngestRow>(
    `SELECT * FROM nzi_console.v7_import_ingests WHERE job_id = $1 AND kind = $2 ORDER BY created_at DESC, ingest_id LIMIT 1`, [jobId, kind])).rows[0];
  const rehearsal = await latest("rehearsal"), ingest = await latest("ingest");
  let ingested: V7ImportIngestState["ingest"] = null;
  if (ingest) {
    const run = (await db.query<{ status: "completed" | "reverted" }>(`SELECT status FROM nzi_console.v7_reingest_runs WHERE run_id = $1`, [ingest.reingest_run_id])).rows[0];
    const review = (await db.query<{ approved: number; pending: number }>(
      `SELECT count(*) FILTER (WHERE r.review_status = 'approved')::int AS approved, count(*) FILTER (WHERE r.review_status <> 'approved')::int AS pending
         FROM nzi_console.job_scope_rows r JOIN nzi_console.job_scope_rows v ON (v.organisation_id, v.scope_row_id) = (r.organisation_id, r.reingested_from_row_id)
        WHERE r.job_id = $1 AND r.origin = 'live' AND r.enabled`, [jobId])).rows[0]!;
    ingested = { ...entryOf(ingest), runStatus: run?.status ?? null, rowsApproved: review.approved, rowsPending: review.pending };
  }
  return {
    rehearsal: rehearsal ? { ...entryOf(rehearsal), current: current !== null && rehearsal.session_id === current.sessionId && rehearsal.decisions_sha256 === current.decisionsSha256 } : null,
    ingest: ingested,
  };
}
