// The import, server-side — Phase D (BRIEF-v7-import-server-side-phase-d; DESIGN-v7-import-rethink R-4): the fast path.
//
// An eligible job refreshes end-to-end on one action: no Σ/Commit step, no reason prompt. It is NOT a new command and not a
// new mode of `import.refresh`: it orchestrates the existing preview → commit, with their inputs unchanged (the contract and
// the matrix are as Phase B left them). The same actor runs the same commit; only the human prompt goes.
//
// Eligible = all three (D-ELIG-1..3), read inside the preview's transaction:
//   1. no issued report   — `issuedReport`: a console report version past validated (sent to client review, approved,
//                           published or superseded, or carrying `published_at`), or a report composition (what an issued
//                           report froze, 0077). Console-issued only, as ruled: a report the previous system made (0135) does
//                           not count — almost every migrated job has one, and D7 already keeps the refresh in line with it.
//   2. no manual edits    — `manualEdits`: any decision for the job in the decisions store (0228, superseded ones included);
//                           any scope-row audit event by a person (staff or portal principal) on a row of the job — an edit,
//                           an override, a review; or a live row of the job the import did not write (`reingested_from_row_id`
//                           NULL: made by a person, or an import row whose link an edit stripped, the J000663 kind). The
//                           re-ingest's own override on a reported total is the import's, not a person's, and does not count.
//   3. nothing flagged    — the preview would commit (D7 reconciled), with zero exceptions.
// …and the Admin-commit gate (0231) wins: set, and the caller is not an Admin → not automatic; an Admin commits deliberately.
//
// Eligible → the commit runs with the fixed system reason below and the preview's own fingerprints, and re-reads 1 and 2 in
// ITS transaction before the chain: anything that changed between the two refuses (FAST_PATH_INELIGIBLE), nothing written.
// Every Phase B guard runs as it does for a person's commit — the fingerprints, the Admin gate, readiness, D7, the audit.
// Ineligible → the preview, unchanged, and why it was not automatic: Phase C's deliberate flow carries on from there.
//
// One job per call, so the batch queue (Phase E) can call it per job unchanged.
import type { CommandContext, V7ImportRefreshCommitted, V7ImportRefreshPreview } from "@nzi/contracts";
import { readImportPolicy } from "./organisationSettings";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import { commitV7ImportRefresh, previewV7ImportRefresh, readSpanningFigures, type V7ImportRefreshOptions, type V7ImportRefreshSource } from "./v7ImportRefresh";

export const V7_IMPORT_FAST_PATH_REASON = "Fast path: no issued report, no manual edits, nothing flagged.";

/** Why a refresh was not automatic, in the brief's order. `admin-commits`: the gate is set and the caller is not an Admin. */
export type V7ImportFastPathBlocker = "issued-report" | "manual-edits" | "flagged" | "admin-commits";
export type V7ImportFastPathSignals = { issuedReport: boolean; manualEdits: boolean };

export type V7ImportFastPathResult =
  | { fastPath: "refreshed"; preview: V7ImportRefreshPreview; committed: V7ImportRefreshCommitted; auditEventId: string; correlationId: string; replayed: boolean }
  | { fastPath: "deliberate"; preview: V7ImportRefreshPreview; because: V7ImportFastPathBlocker[]; flagged: number };

/** D-ELIG-1 and D-ELIG-2, read from the job as it stands in the caller's transaction. Ids and booleans; no figure leaves. */
export async function readV7ImportFastPathSignals(db: Queryable, organisationId: string, jobId: string): Promise<V7ImportFastPathSignals> {
  const row = (await db.query<{ issued_report: boolean; manual_edits: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM nzi_console.report_versions v WHERE v.organisation_id = $1 AND v.job_id = $2
                AND (v.status NOT IN ('draft', 'validated') OR v.published_at IS NOT NULL))
       OR EXISTS (SELECT 1 FROM nzi_console.report_compositions c WHERE c.organisation_id = $1 AND c.job_id = $2)
         AS issued_report,
       EXISTS (SELECT 1 FROM nzi_console.v7_import_decisions d WHERE d.organisation_id = $1 AND d.job_id = $2)
       OR EXISTS (SELECT 1 FROM nzi_console.audit_events a JOIN nzi_console.job_scope_rows r
                    ON r.organisation_id = a.organisation_id AND r.scope_row_id = a.entity_id
                  WHERE a.organisation_id = $1 AND r.job_id = $2 AND a.entity_type = 'scope_row' AND a.principal_type IN ('staff', 'portal'))
       OR EXISTS (SELECT 1 FROM nzi_console.job_scope_rows r WHERE r.organisation_id = $1 AND r.job_id = $2
                   AND r.origin = 'live' AND r.reingested_from_row_id IS NULL)
         AS manual_edits`,
    [organisationId, jobId])).rows[0];
  return { issuedReport: row?.issued_report !== false, manualEdits: row?.manual_edits !== false };
}

/** The verdict from what the preview transaction read. Pure: the panel's one line and the batch queue both read `because`. */
export function v7ImportFastPathBlockers(preview: V7ImportRefreshPreview, signals: V7ImportFastPathSignals, adminGateBlocks: boolean): V7ImportFastPathBlocker[] {
  const because: V7ImportFastPathBlocker[] = [];
  if (signals.issuedReport) because.push("issued-report");
  if (signals.manualEdits) because.push("manual-edits");
  if (preview.outcome !== "would-commit" || preview.exceptions.length > 0 || preview.scopeTotals === null) because.push("flagged");
  if (adminGateBlocks) because.push("admin-commits");
  return because;
}

const blocksAutoCommit = async (db: Queryable, context: CommandContext) =>
  (await readImportPolicy(db, context.organisationId)).refreshCommitRequiresAdmin && context.grant?.role !== "admin";

/**
 * The fast path's first half alone: the preview, with D-ELIG-1 and 2 and the Admin gate read in its transaction, and why it would not
 * be automatic (empty: it would commit). Rolled back like any preview. The spanning batch's dry run is this, for each job.
 */
export async function previewV7ImportFastPath(pool: PoolLike, source: V7ImportRefreshSource, jobId: string, context: CommandContext,
  given: V7ImportRefreshOptions = {}): Promise<{ preview: V7ImportRefreshPreview; because: V7ImportFastPathBlocker[]; options: V7ImportRefreshOptions }> {
  // Never a bring-in on a snapshotted job (BRIEF-v7-import-j000663 §B): that is a person's act, in the deliberate flow. Without it the
  // chain refuses a snapshotted job (SNAPSHOT_EXISTS), so its preview is flagged and it falls back.
  // A spanning job's own figures (endpoint 2) are read once, for the preview and its commit alike: one call per bring-in.
  const spanningFigures = given.spanningFigures ?? await readSpanningFigures(pool, context.organisationId, jobId, given.rowFigures);
  const options: V7ImportRefreshOptions = { ...given, allowSnapshotted: false, spanningFigures };
  let signals = null as V7ImportFastPathSignals | null;
  let adminGateBlocks = true;
  const preview = await previewV7ImportRefresh(pool, source, { jobId, mode: "preview" }, context, { ...options,
    within: async (db, at) => {
      await options.within?.(db, at);
      signals = await readV7ImportFastPathSignals(db, context.organisationId, jobId);
      adminGateBlocks = await blocksAutoCommit(db, context);
    } });
  // The preview always reads the job before it answers; a preview that did not (refused before reading) is never automatic.
  const read: V7ImportFastPathSignals = signals ?? { issuedReport: true, manualEdits: true };
  return { preview, because: v7ImportFastPathBlockers(preview, read, adminGateBlocks), options };
}

/**
 * One job, one action: the preview, and — when D-ELIG-1..3 hold and the Admin gate does not stand in the way — the commit, with
 * the fixed system reason and the preview's fingerprints. Otherwise the preview and why, for the deliberate flow.
 */
export async function refreshV7ImportFastPath(pool: PoolLike, source: V7ImportRefreshSource, jobId: string, context: CommandContext,
  given: V7ImportRefreshOptions = {}): Promise<V7ImportFastPathResult> {
  const { preview, because, options } = await previewV7ImportFastPath(pool, source, jobId, context, given);
  if (because.length) return { fastPath: "deliberate", preview, because, flagged: preview.exceptions.length };
  const outcome = await commitV7ImportRefresh(pool, source,
    { jobId, mode: "commit", summarySha256: preview.summarySha256, decisionsSha256: preview.decisionsSha256 },
    { ...context, reason: V7_IMPORT_FAST_PATH_REASON }, { ...options,
      // D-ELIG-1 and 2 again, in the commit's own transaction: what the preview saw must still hold when the chain runs.
      within: async (db, at) => {
        await options.within?.(db, at);
        const now = await readV7ImportFastPathSignals(db, context.organisationId, jobId);
        if (now.issuedReport || now.manualEdits) throw new CommandValidationError([{ field: "jobId", code: "FAST_PATH_INELIGIBLE",
          message: "The job changed since its preview (a report was issued, or it was edited); refresh again." }]);
      } });
  return { fastPath: "refreshed", preview, committed: outcome.data, auditEventId: outcome.auditEventId, correlationId: outcome.correlationId, replayed: outcome.replayed };
}
