// The v7 re-sync rehearsal: the whole J-number routine — revert the standing re-ingest, re-sync to v7's current records, re-plan
// from the current rows, re-ingest — run in ONE transaction that is always rolled back. It exists so the reconciliation (the
// re-sync's counts, Σ live against Σ v7 per scope) can be seen before anything is written: each step on its own can only dry-run
// against what is committed, so the later steps never see the earlier ones.
//
// It never writes. There is no commit path: the transaction ends in a rollback on every route — success, refusal or error — and
// nothing here takes a flag that could change that. It adds no command, no migration and no access rule: each step is the
// existing, merged one (`v7.reingest.revert`, the re-sync, `v7.reingest.job`), called exactly as its own runner calls it.
//
// The re-plan is the only new logic, and it is deliberately narrow. The job's committed crosswalk plan is carried onto the
// current rows: a plan row whose v7 row the re-sync superseded moves to the replacement and takes v7's current figures (reported
// tCO2e, quantity, apportionment), keeping the crosswalk's category, factor and rule — but only when v7 left everything the
// crosswalk keyed on unchanged (scope, unit, factor ids, dataset, factor value). A row v7 changed in any of those, and a row new in
// v7, is not guessed at: it is listed as needing the crosswalk, and the re-ingest's own gate (PLAN_INCOMPLETE) then says so.
import { commandGrantForRole, V7_REINGEST_ACTOR, v7ApplyPct, type V7ReingestJobInput, type V7ReingestPlanRow } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import type { PlannedRow } from "./v7ClientImport";
import { reingestV7JobInTransaction, revertV7ReingestInTransaction, type V7ReingestResult } from "./v7Reingest";
import { v7ReingestRevertContext } from "./v7ReingestRevertRun";
import { resyncV7JobInTransaction, v7ResyncContext, type V7ResyncResult } from "./v7Resync";

export type V7RehearsalStage = "revert" | "resync" | "replan" | "reingest";
export type V7RehearsalInput = {
  organisationId: string; jobId: string; reason: string;
  /** The re-sync's input: v7's current records of this job, from a one-job extract, and that extract's sha256. */
  resyncRunId: string; extractSha256: string; rows: readonly PlannedRow[];
  /** The job's committed crosswalk plan (`data/v7-crosswalk-v1/plan-<job>.json`), re-planned onto the current rows. */
  plan: Omit<V7ReingestJobInput, "runId">; reingestRunId: string;
};
/** Ids and tCO2e only — never a label beyond the plan's own, and never money. */
export type V7RehearsalReport = {
  jobId: string;
  /** Always true: the transaction was rolled back, whatever happened inside it. */
  rolledBack: true;
  revert: { runId: string; liveRowsSwitchedOff: number; v7RowsSwitchedOn: number } | null;
  resync: { unchanged: number; superseded: V7ResyncResult["superseded"]; added: string[]; withdrawn: string[] } | null;
  replan: V7Replan | null;
  /** Σ v7 per top-level scope over the job's current, enabled v7 rows after the re-sync — what a re-ingest must reconcile to. */
  v7ScopeTotals: Record<string, { rows: number; v7: number }> | null;
  reingest: Pick<V7ReingestResult, "v7TotalTco2e" | "nativeTotalTco2e" | "scopeTotals" | "rowsByDisposition" | "v7RowsSwitchedOff"> | null;
  /** The first step that refused, with its own issues; the steps after it did not run. */
  refusal: { stage: V7RehearsalStage; issues: Array<{ field: string; code: string; message: string }> } | null;
};
export type V7Replan = {
  rows: V7ReingestPlanRow[];
  /** Plan rows moved onto their replacement, at v7's current figures. */
  carried: Array<{ from: string; to: string }>;
  unchanged: number;
  /** Plan rows whose v7 row is gone or switched off in v7 now. */
  dropped: string[];
  /** Current, enabled v7 rows the crosswalk plan does not cover — each needs the crosswalk, not a guess. */
  needsCrosswalk: Array<{ rowId: string; why: string }>;
};

/** What the crosswalk keyed a row on: if v7 changed any of it, the row's category and factor are no longer known. */
const CROSSWALK_KEYS = ["uom", "dataset", "factor_db_id", "original_id", "ghg_unit", "factor"] as const;
type Current = { scope_row_id: string; scope: string; enabled: boolean; record: Record<string, unknown> };

async function currentRows(db: Queryable, organisationId: string, jobId: string): Promise<Current[]> {
  return (await db.query<Current>(
    `SELECT scope_row_id, scope, enabled, migrated_record AS record FROM nzi_console.job_scope_rows
      WHERE organisation_id = $1 AND job_id = $2 AND origin = 'migrated' AND superseded_by_row_id IS NULL ORDER BY scope_row_id`,
    [organisationId, jobId])).rows;
}

const numberOrNull = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The committed plan, carried onto the job's current v7 rows (see the header). Reads only. */
export async function replanOntoCurrentRows(db: Queryable, organisationId: string, jobId: string,
  plan: Omit<V7ReingestJobInput, "runId">, superseded: V7ResyncResult["superseded"]): Promise<V7Replan> {
  const current = await currentRows(db, organisationId, jobId);
  const byId = new Map(current.map((row) => [row.scope_row_id, row]));
  const replacedBy = new Map(superseded.map((pair) => [pair.rowId, pair.replacedBy]));
  const old = new Map((await db.query<Current>(
    `SELECT scope_row_id, scope, enabled, migrated_record AS record FROM nzi_console.job_scope_rows
      WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = ANY($3::text[])`,
    [organisationId, jobId, [...replacedBy.keys()]])).rows.map((row) => [row.scope_row_id, row]));

  const rows: V7ReingestPlanRow[] = [];
  const carried: V7Replan["carried"] = [];
  const dropped: string[] = [];
  const needsCrosswalk: V7Replan["needsCrosswalk"] = [];
  let unchanged = 0;
  for (const row of plan.rows) {
    const to = replacedBy.get(row.v7RowId);
    if (to === undefined) {
      const now = byId.get(row.v7RowId);
      if (!now || !now.enabled) { dropped.push(row.v7RowId); continue; }
      rows.push(row); unchanged += 1; continue;
    }
    const was = old.get(row.v7RowId)!, now = byId.get(to)!;
    if (!now.enabled) { dropped.push(row.v7RowId); continue; }
    const moved = [...(was.scope === now.scope ? [] : ["scope"]), ...CROSSWALK_KEYS.filter((key) => !same(was.record[key], now.record[key]))];
    if (moved.length) { needsCrosswalk.push({ rowId: to, why: `v7 changed its ${moved.join(", ")} (was ${row.v7RowId})` }); continue; }
    rows.push({ ...row, v7RowId: to, v7Tco2e: Number(now.record.reported_tco2e),
      quantity: row.disposition === "REPORTED-TOTAL" ? null : numberOrNull(now.record.qty),
      applyPct: v7ApplyPct(numberOrNull(now.record.apply_pct)) });
    carried.push({ from: row.v7RowId, to });
  }
  const planned = new Set(rows.map((row) => row.v7RowId));
  const flagged = new Set(needsCrosswalk.map((row) => row.rowId));
  for (const row of current) {
    if (row.enabled && !planned.has(row.scope_row_id) && !flagged.has(row.scope_row_id))
      needsCrosswalk.push({ rowId: row.scope_row_id, why: "new in v7: crosswalk v1 has no row for it" });
  }
  return { rows, carried, unchanged, dropped, needsCrosswalk };
}

async function v7ScopeTotals(db: Queryable, organisationId: string, jobId: string): Promise<Record<string, { rows: number; v7: number }>> {
  const totals: Record<string, { rows: number; v7: number }> = {};
  for (const row of await currentRows(db, organisationId, jobId)) {
    if (!row.enabled) continue;
    const scope = row.scope.split(".")[0]!;
    const entry = (totals[scope] ??= { rows: 0, v7: 0 });
    entry.rows += 1;
    entry.v7 += Number(row.record.reported_tco2e ?? 0);
  }
  for (const entry of Object.values(totals)) entry.v7 = Math.round(entry.v7 * 1e6) / 1e6;
  return totals;
}

class RehearsalRollback extends Error {}

/**
 * The rehearsal. One transaction, rolled back on every route: the report is read inside it, before the rollback. A step that
 * refuses (a CommandValidationError) is recorded and the steps after it do not run; any other error rolls back and is thrown.
 */
export async function rehearseV7Resync(pool: PoolLike, input: V7RehearsalInput): Promise<V7RehearsalReport> {
  const org = input.organisationId;
  const report: V7RehearsalReport = { jobId: input.jobId, rolledBack: true, revert: null, resync: null, replan: null, v7ScopeTotals: null, reingest: null, refusal: null };
  const step = async <T>(stage: V7RehearsalStage, work: () => Promise<T>): Promise<T | null> => {
    try { return await work(); } catch (error) {
      if (!(error instanceof CommandValidationError)) throw error;
      report.refusal = { stage, issues: error.issues.map((issue) => ({ field: String(issue.field), code: issue.code, message: issue.message })) };
      return null;
    }
  };
  try {
    await withTenantWrite(pool, org, async (db) => {
      // 1. The standing re-ingest, reverted as its own runner reverts it. None standing: nothing to revert.
      const standing = (await db.query<{ run_id: string }>(
        `SELECT run_id FROM nzi_console.v7_reingest_runs WHERE organisation_id = $1 AND job_id = $2 AND status = 'completed'`, [org, input.jobId])).rows[0]?.run_id;
      if (standing) {
        const outcome = await step("revert", () => revertV7ReingestInTransaction(db, { jobId: input.jobId, runId: standing }, v7ReingestRevertContext(org, standing, input.reason)));
        if (!outcome) throw new RehearsalRollback();
        report.revert = { runId: standing, liveRowsSwitchedOff: outcome.data.liveRowsSwitchedOff, v7RowsSwitchedOn: outcome.data.v7RowsSwitchedOn };
      }
      // 2. The re-sync, as its runner calls it.
      const resync = await step("resync", () => resyncV7JobInTransaction(db,
        { jobId: input.jobId, runId: input.resyncRunId, extractSha256: input.extractSha256, rows: input.rows }, v7ResyncContext(org, input.reason)));
      if (!resync) throw new RehearsalRollback();
      report.resync = { unchanged: resync.unchanged, superseded: resync.superseded, added: resync.added, withdrawn: resync.withdrawn };
      report.v7ScopeTotals = await v7ScopeTotals(db, org, input.jobId);
      // 3. The re-plan onto the current rows (reads only).
      const replan = await replanOntoCurrentRows(db, org, input.jobId, input.plan, resync.superseded);
      report.replan = replan;
      // 4. The re-ingest, as its runner calls it — its own D7 gates decide; a row needing the crosswalk is its PLAN_INCOMPLETE.
      const plan: V7ReingestJobInput = { ...input.plan, runId: input.reingestRunId, rows: replan.rows };
      const context = { organisationId: org, actorId: V7_REINGEST_ACTOR, principal: "system" as const, idempotencyKey: input.reingestRunId,
        correlationId: input.reingestRunId, reason: `${input.reason} — rehearsal, rolled back`, grant: commandGrantForRole("admin", org, V7_REINGEST_ACTOR) };
      const outcome = await step("reingest", () => reingestV7JobInTransaction(db, plan, context));
      if (outcome) {
        const { v7TotalTco2e, nativeTotalTco2e, scopeTotals, rowsByDisposition, v7RowsSwitchedOff } = outcome.data;
        report.reingest = { v7TotalTco2e, nativeTotalTco2e, scopeTotals, rowsByDisposition, v7RowsSwitchedOff };
      }
      throw new RehearsalRollback();
    });
  } catch (error) {
    if (!(error instanceof RehearsalRollback)) throw error;
  }
  return report;
}
