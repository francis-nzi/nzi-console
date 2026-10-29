// RULING-reingest-bulk-attest (on DESIGN-reingest-bulk-attest; SPEC-review-surface-readiness §4): `scope.review.attest_reingest`,
// one reviewer's attestation that a re-ingest run's rows reproduce v7 exactly, verified by D7.2 — recorded as that reviewer's
// approval on each row — with the record-of-account gaps on the run's rows resolved alongside, so the QA gate clears in one
// reviewed act. Governance is unchanged: a person (a staff principal, never the re-ingest's own principal) attests; nothing is
// edited; every row still gets its own review-history approval.
//
// One plan, read by both the preview and the write, so the preview shows exactly what the write does:
//   - the run's rows: the job's enabled live rows linked by `reingested_from_row_id` to the v7 rows the run superseded (its own
//     append-only `v7_row_superseded` audit events) — never provenance, as the fixed revert;
//   - pending rows are attested; already-approved rows are skipped (never re-approved); rejected rows are excluded (a human
//     finding, handled individually);
//   - every attested row must pass approve's gates and D7.2 at the moment of attesting — as refined by RULING-v7-book-runner R2:
//     it still carries its v7 row's input exactly (quantity, unit, apportionment; a reported total, v7's figure) — or the whole
//     act refuses: it never vouches for a row whose input has been edited away from v7's;
//   - R3: the emission is the console's calculation. Where it differs materially from v7's reported figure (the run's delta
//     report: > 5%, or a 0 → non-zero move), the reviewer must acknowledge each flag — the act refuses unless the acknowledged set
//     is exactly what is flagged now. A confirmed v7-drift row passes on its input, at the console's figure;
//   - gaps: only the two record-of-account gaps on the run's non-rejected rows, and only where the reason is literally true —
//     `unmapped` on a reported-total row; `zero_blank` where the v7 figure is 0 AND the row reproduces 0. Every other gap stays
//     with the individual Resolve. A gap that already has a resolution is never overwritten.
import { randomUUID } from "node:crypto";
import {
  isV7ReportedTotalReason, sameV7CarriedQuantity, sameV7Quantity, V7_REINGEST_ACTOR, V7_REPORTED_TOTAL_REASONS, v7ApplyPct, v7EmissionDeltaReport, withinV7Tolerance,
  type AssuranceGap, type CommandContext, type CommandInputMap, type V7EmissionDeltaReport,
} from "@nzi/contracts";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError, isV7ReingestPrincipal, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { getAssuranceScreen } from "./readModels";
import { normaliseV7Unit, sameV7Unit } from "./v7Reingest";

export const REINGEST_ATTESTATION = "Attested: carries v7's input exactly, verified by re-ingest D7.2; emission by the console's calculation";
export const UNMAPPED_REPORTED_TOTAL_REASON: string = V7_REPORTED_TOTAL_REASONS[0];
export const ZERO_RECORD_OF_ACCOUNT_REASON = "v7 recorded zero (record of account)";

export type AttestRow = { rowId: string; version: number; label: string; categoryCode: string | null; tco2e: number };
export type AttestBlocked = { rowId: string; label: string; reasons: string[] };
export type AttestGap = { gapKey: string; flag: "unmapped" | "zero_blank"; rowId: string; label: string; reason: string };
export type ReingestAttestationPlan = {
  jobId: string; runId: string | null;
  /** Pending rows of the run, each passing approve's gates and D7.2 — what the act approves. */
  attest: AttestRow[];
  /** Pending rows that may not be attested, and why. Any of these refuses the act. */
  blocked: AttestBlocked[];
  skippedApproved: number;
  excludedRejected: Array<{ rowId: string; label: string }>;
  /** The record-of-account gaps the act resolves. */
  gaps: AttestGap[];
  /** Record-of-account gaps that already carry a resolution — kept as they are. */
  skippedResolvedGaps: number;
  /** Open gaps the act does not touch — each needs its own Resolve. */
  otherOpenGaps: Array<{ gapKey: string; flag: string; label: string }>;
  /** Why this reviewer may not attest at all (the preparer), or null. */
  reviewerRefusal: string | null;
  /**
   * R3: the console's figure against v7's over the act's rows (not rejected), with each flagged row's label for the reviewer.
   * `deltas.flagged` is what the act's `acknowledgedDeltas` must equal. Null when there is no completed run.
   */
  deltas: V7EmissionDeltaReport | null;
  deltaLabels: Record<string, string>;
};

const fail = (field: string, code: string, message: string): never => { throw new CommandValidationError([{ field, code, message }]); };

/** The preparer may not attest its own rows (reviewer ≠ preparer). */
function reviewerRefusal(context: Pick<CommandContext, "actorId" | "principal">): string | null {
  if (context.principal !== "staff" || isV7ReingestPrincipal(context) || context.actorId === V7_REINGEST_ACTOR)
    return "The re-ingest prepared these rows; only an independent staff reviewer may attest them.";
  return null;
}

/** A run row as the gap rule needs it: in the act's scope (enabled, linked to the run, not rejected). */
export type AttestScopeRow = { rowId: string; label: string; reportedTotal: boolean; v7Tco2e: number | null; tco2e: number | null };

/**
 * RULING-reingest-bulk-attest 3, a hard boundary: the attestation resolves a gap only where its reason is literally true —
 * `unmapped` on a reported-total row, and `zero_blank` where the v7 row's figure is 0 AND the live row reproduces 0 (so an
 * accidentally blank row is never swept up). Anything else — a gap on a row outside the act, a category or site gap, YoY, out of
 * boundary, a missing factor on any other row — is null: it stays with the individual Resolve.
 */
export function recordOfAccountGap(gap: AssuranceGap, row: AttestScopeRow | undefined): AttestGap | null {
  // The gap's own key names the row (`unmapped:<rowId>`, `zero_blank:<rowId>`), so a gap on any other row never matches.
  if (!row) return null;
  if (gap.flag === "unmapped" && gap.key === `unmapped:${row.rowId}` && row.reportedTotal)
    return { gapKey: gap.key, flag: "unmapped", rowId: row.rowId, label: row.label, reason: UNMAPPED_REPORTED_TOTAL_REASON };
  if (gap.flag === "zero_blank" && gap.key === `zero_blank:${row.rowId}` && row.v7Tco2e === 0 && row.tco2e === 0)
    return { gapKey: gap.key, flag: "zero_blank", rowId: row.rowId, label: row.label, reason: ZERO_RECORD_OF_ACCOUNT_REASON };
  return null;
}

type RunRow = {
  scope_row_id: string; version: number; review_status: string; source_label: string; category_code: string | null;
  quality_tier: string | null; calculated: string | null; override: string | null; override_reason: string | null;
  factor_id: string | null; client_factor_id: string | null; factor_source: string | null; reported: string | null;
  captured_by: string | null; calculated_by: string | null;
  scope: string; site_id: string | null; reingested_from_row_id: string;
  /** The live row's input, and v7's (RULING-v7-book-runner R2). */
  quantity: string | null; unit: string | null; apply_pct: string | null; has_months: boolean; v7_qty: string | null; v7_uom: string | null; v7_apply_pct: string | null;
};

export async function planReingestAttestation(db: Queryable, context: Pick<CommandContext, "organisationId" | "actorId" | "principal">, jobId: string, lock = false): Promise<ReingestAttestationPlan> {
  const org = context.organisationId;
  const empty: ReingestAttestationPlan = { jobId, runId: null, attest: [], blocked: [], skippedApproved: 0, excludedRejected: [], gaps: [], skippedResolvedGaps: 0, otherOpenGaps: [], reviewerRefusal: reviewerRefusal(context), deltas: null, deltaLabels: {} };
  const run = (await db.query<{ run_id: string }>(
    `SELECT run_id FROM nzi_console.v7_reingest_runs WHERE organisation_id = $1 AND job_id = $2 AND status = 'completed'`, [org, jobId])).rows[0];
  if (!run) return empty;
  const v7RowIds = (await db.query<{ entity_id: string }>(
    `SELECT DISTINCT a.entity_id FROM nzi_console.audit_events a
       JOIN nzi_console.job_scope_rows v ON v.organisation_id = a.organisation_id AND v.scope_row_id = a.entity_id AND v.job_id = $2 AND v.origin = 'migrated'
      WHERE a.organisation_id = $1 AND a.action = 'v7_row_superseded' AND a.entity_type = 'scope_row' AND a.actor_id = $4 AND a.after_json->>'runId' = $3`,
    [org, jobId, run.run_id, V7_REINGEST_ACTOR])).rows.map((row) => row.entity_id);
  const rows = (await db.query<RunRow>(
    `SELECT r.scope_row_id, r.version, r.review_status, r.source_label, r.category_code, r.quality_tier,
            r.calculated_tco2e::text AS calculated, r.override_tco2e::text AS override, r.override_reason,
            r.factor_id, r.client_factor_id, r.factor_source, v.migrated_record->>'reported_tco2e' AS reported,
            r.provenance_json->>'capturedBy' AS captured_by, r.provenance_json->>'calculatedBy' AS calculated_by,
            r.scope, r.site_id, r.reingested_from_row_id, r.quantity::text AS quantity, r.unit, r.apply_pct::text AS apply_pct,
            (jsonb_typeof(r.monthly_activity_json) = 'array' AND jsonb_array_length(r.monthly_activity_json) > 0) AS has_months,
            v.migrated_record->>'qty' AS v7_qty, v.migrated_record->>'uom' AS v7_uom, v.migrated_record->>'apply_pct' AS v7_apply_pct
       FROM nzi_console.job_scope_rows r
       JOIN nzi_console.job_scope_rows v ON v.organisation_id = r.organisation_id AND v.scope_row_id = r.reingested_from_row_id AND v.origin = 'migrated'
      WHERE r.organisation_id = $1 AND r.job_id = $2 AND r.origin = 'live' AND r.enabled AND r.reingested_from_row_id = ANY($3::text[])
      ORDER BY r.scope_row_id${lock ? " FOR UPDATE OF r" : ""}`, [org, jobId, v7RowIds])).rows;

  const plan: ReingestAttestationPlan = { ...empty, runId: run.run_id };
  const tco2e = (row: RunRow) => (row.override ?? row.calculated) === null ? null : Number(row.override ?? row.calculated);
  // The D5 shape, which only the re-ingest may write: no factor, v7's figure as an override, a reason from the closed set.
  const isReportedTotal = (row: RunRow) => !row.factor_id && !row.client_factor_id && row.override !== null && isV7ReportedTotalReason(row.override_reason);
  /** D7.2 as refined (R2): why the row no longer carries v7's input (a reported total: v7's figure), or null. */
  const inputMiss = (row: RunRow): string | null => {
    if (isReportedTotal(row)) return row.reported !== null && tco2e(row) !== null && withinV7Tolerance(tco2e(row)!, Number(row.reported)) ? null
      : `its reported total ${tco2e(row) ?? "none"} t is not v7's ${row.reported ?? "missing"} t (D7.2)`;
    const v7Quantity = row.v7_qty === null || row.v7_qty === "" ? null : Number(row.v7_qty), v7Unit = normaliseV7Unit(row.v7_uom);
    const v7Pct = v7ApplyPct(row.v7_apply_pct === null || row.v7_apply_pct === "" ? null : Number(row.v7_apply_pct));
    if (row.quantity === null || v7Quantity === null || !sameV7CarriedQuantity(Number(row.quantity), v7Quantity, row.has_months)) return `its quantity ${row.quantity ?? "none"} is no longer v7's ${v7Quantity ?? "none"} (D7.2)`;
    if (row.unit === null || v7Unit === null || !sameV7Unit(row.unit, v7Unit)) return `its unit ${row.unit ?? "none"} is no longer v7's ${v7Unit ?? "none"} (D7.2)`;
    if (!sameV7Quantity(row.apply_pct === null ? 100 : Number(row.apply_pct), v7Pct)) return `its apportionment is no longer v7's ${v7Pct}% (D7.2)`;
    return null;
  };
  const inScope = new Map<string, RunRow>();
  for (const row of rows) {
    if (row.review_status === "rejected") { plan.excludedRejected.push({ rowId: row.scope_row_id, label: row.source_label }); continue; }
    inScope.set(row.scope_row_id, row);
    if (row.review_status === "approved") { plan.skippedApproved += 1; continue; }
    // Approve's gates, then D7.2 at the moment of attesting.
    const reasons: string[] = [];
    if (tco2e(row) === null) reasons.push("no calculated or override figure");
    if (!row.quality_tier) reasons.push("no quality tier");
    if ([row.captured_by, row.calculated_by].includes(context.actorId)) reasons.push("the reviewer captured or calculated this row");
    const miss = tco2e(row) === null ? null : inputMiss(row);
    if (miss) reasons.push(miss);
    if (reasons.length) plan.blocked.push({ rowId: row.scope_row_id, label: row.source_label, reasons });
    else plan.attest.push({ rowId: row.scope_row_id, version: row.version, label: row.source_label, categoryCode: row.category_code, tco2e: tco2e(row)! });
  }
  // R3: the comparison over the act's rows, read now — what the reviewer acknowledges is what is flagged at the moment of attesting.
  const compared = [...inScope.values()].filter((row) => tco2e(row) !== null && row.reported !== null);
  plan.deltas = v7EmissionDeltaReport(compared.map((row) => ({ v7RowId: row.reingested_from_row_id, liveRowId: row.scope_row_id, scope: row.scope,
    siteId: row.site_id, v7Tco2e: Number(row.reported), calcTco2e: tco2e(row)! })));
  plan.deltaLabels = Object.fromEntries(compared.filter((row) => plan.deltas!.flagged.includes(row.reingested_from_row_id)).map((row) => [row.reingested_from_row_id, row.source_label]));

  // The gaps, from the assurance engine itself — the same keys and the same resolutions the sign-off gate reads.
  const screen = await getAssuranceScreen(db, jobId);
  const gaps: AssuranceGap[] = screen?.gaps.gaps ?? [];
  const asScopeRow = (row: RunRow): AttestScopeRow => ({
    rowId: row.scope_row_id, label: row.source_label, tco2e: tco2e(row), v7Tco2e: row.reported === null ? null : Number(row.reported),
    // The D5 shape, which only the re-ingest may write: no factor, v7's figure as an override, a reason from the closed set.
    reportedTotal: !row.factor_id && !row.client_factor_id && row.override !== null && isV7ReportedTotalReason(row.override_reason),
  });
  for (const gap of gaps) {
    const row = gap.scopeRowId ? inScope.get(gap.scopeRowId) : undefined;
    const ours = recordOfAccountGap(gap, row ? asScopeRow(row) : undefined);
    if (ours && gap.resolved) plan.skippedResolvedGaps += 1;
    else if (ours) plan.gaps.push(ours);
    else if (!gap.resolved) plan.otherOpenGaps.push({ gapKey: gap.key, flag: gap.flag, label: gap.label });
  }
  return plan;
}

/** The preview: the plan, read-only — what Attest would do, with every row's version for the confirm to send back. */
export function previewReingestAttestation(pool: PoolLike, jobId: string, context: CommandContext): Promise<ReingestAttestationPlan> {
  return withTenantRead(pool, context.organisationId, (db) => planReingestAttestation(db, context, jobId));
}

export type ReingestAttestationResult = {
  jobId: string; runId: string; approved: number; gapsResolved: number; skippedApproved: number; skippedResolvedGaps: number;
  excludedRejected: number; rowIds: string[]; gapKeys: string[];
  /** R3: the flagged emission deltas the reviewer acknowledged ("job", v7 row ids) — the audit's record that each was investigated. */
  acknowledgedDeltas: string[];
};

/** `scope.review.attest_reingest`: the act, all or nothing, exactly as previewed. One audit event (the command's own). */
export function attestReingestRows(pool: PoolLike, input: CommandInputMap["scope.review.attest_reingest"], context: CommandContext): Promise<StoredOutcome<ReingestAttestationResult>> {
  return runPostgresCommand(pool, "scope.review.attest_reingest", input, context, async (db) => {
    const refusal = reviewerRefusal(context);
    if (refusal) fail("actorId", "REVIEWER_IS_PREPARER", refusal);
    const job = (await db.query<{ job_family: string }>(`SELECT job_family FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`, [context.organisationId, input.jobId])).rows[0];
    if (!job) fail("jobId", "NOT_FOUND", "Job was not found.");
    if (job!.job_family !== "crp") fail("jobId", "WRONG_FAMILY", "Only a carbon-reporting job is attested.");
    const plan = await planReingestAttestation(db, context, input.jobId, true);
    if (!plan.runId) fail("runId", "NO_COMPLETED_RUN", "This job has no completed re-ingest to attest.");
    if (plan.runId !== input.runId) fail("runId", "CHANGED_SINCE_PREVIEW", "The job's re-ingest run changed since the preview — preview it again.");
    if (plan.blocked.length)
      fail("rows", "ATTEST_BLOCKED", `${plan.blocked.length} row(s) cannot be attested, so nothing is: ${plan.blocked.slice(0, 5).map((row) => `${row.label} (${row.reasons.join("; ")})`).join(" · ")}.`);
    // R3: every flagged emission delta investigated and acknowledged — exactly the set flagged now, no more and no fewer.
    const flagged = [...(plan.deltas?.flagged ?? [])].sort().join("|");
    const acknowledged = [...(input.acknowledgedDeltas ?? [])].sort().join("|");
    if (flagged !== acknowledged)
      fail("acknowledgedDeltas", "DELTAS_NOT_ACKNOWLEDGED", plan.deltas?.flagged.length
        ? `${plan.deltas.flagged.length} emission delta(s) against v7 are flagged (${plan.deltas.flagged.slice(0, 5).join(", ")}${plan.deltas.flagged.length > 5 ? "…" : ""}); investigate and acknowledge each before attesting.`
        : "No emission delta is flagged now — preview it again.");
    // Preview == write: the rows at the versions shown, and the gap keys shown — or something moved.
    const planned = plan.attest.map((row) => `${row.rowId}@${row.version}`).sort().join("|");
    const sent = input.rows.map((row) => `${row.rowId}@${row.expectedReviewVersion}`).sort().join("|");
    if (planned !== sent || plan.gaps.map((gap) => gap.gapKey).sort().join("|") !== [...input.gapKeys].sort().join("|"))
      fail("rows", "CHANGED_SINCE_PREVIEW", "The rows or gaps changed since the preview — preview it again.");
    if (plan.attest.length === 0 && plan.gaps.length === 0) fail("rows", "NOTHING_TO_ATTEST", "Nothing is left to attest on this job.");

    const acknowledgedNote = plan.deltas?.flagged.length ? `; ${plan.deltas.flagged.length} emission delta(s) against v7 investigated` : "";
    const note = `${REINGEST_ATTESTATION} (run ${plan.runId}${acknowledgedNote}) — ${context.reason!.trim()}`;
    for (const row of plan.attest) {
      // Each row its own approval, exactly as scope.review.approve records one: the history entry, then the review columns.
      await db.query(
        `INSERT INTO nzi_console.scope_row_review_history (organisation_id, review_event_id, job_id, scope_row_id, row_version, decision, reviewer_id, reviewer_note)
         VALUES ($1, $2, $3, $4, $5, 'approved', $6, $7)`, [context.organisationId, randomUUID(), input.jobId, row.rowId, row.version, context.actorId, note]);
      const updated = await db.query(
        `UPDATE nzi_console.job_scope_rows SET review_status = 'approved', reviewed_row_version = $4, reviewed_by = $5, reviewed_at = now(), reviewer_note = $6,
                version = version + 1, updated_at = now()
          WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 AND version = $4 AND review_status = 'pending' RETURNING scope_row_id`,
        [context.organisationId, input.jobId, row.rowId, row.version, context.actorId, note]);
      if (!updated.rows[0]) fail("rows", "CHANGED_SINCE_PREVIEW", "A row changed while it was being attested — preview it again.");
    }
    for (const gap of plan.gaps) {
      // Never overwrites: a gap someone resolved in the meantime refuses the act rather than replacing their reason.
      const inserted = await db.query(
        `INSERT INTO nzi_console.gap_resolutions (organisation_id, resolution_id, job_id, gap_key, flag_type, scope_row_id, reason, resolved_by, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1) ON CONFLICT DO NOTHING RETURNING resolution_id`,
        [context.organisationId, randomUUID(), input.jobId, gap.gapKey, gap.flag, gap.rowId, gap.reason, context.actorId]);
      if (!inserted.rows[0]) fail("gapKeys", "CHANGED_SINCE_PREVIEW", "A gap was resolved since the preview — preview it again.");
    }
    const data: ReingestAttestationResult = {
      jobId: input.jobId, runId: plan.runId!, approved: plan.attest.length, gapsResolved: plan.gaps.length, skippedApproved: plan.skippedApproved,
      skippedResolvedGaps: plan.skippedResolvedGaps, excludedRejected: plan.excludedRejected.length,
      rowIds: plan.attest.map((row) => row.rowId), gapKeys: plan.gaps.map((gap) => gap.gapKey), acknowledgedDeltas: [...(plan.deltas?.flagged ?? [])],
    };
    return { data, entityType: "job", entityId: input.jobId, topic: "scope.review.reingest_attested" };
  });
}
