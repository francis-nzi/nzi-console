// The v7 re-ingest commit phase (DESIGN-v7-reingest-commit-phase, ruled in REVIEW-v7-reingest-commit-phase; ADDENDUM on
// accepted units). One job, one transaction: v7's vintages added to the job's selection (ruling 3), v7's copied factor values
// carried as client factors (ruling 4), every enabled v7 row re-written as a live row through the ordinary create and
// calculate (D4), totals-only rows as labelled reported totals (D5), the v7 rows switched off (D6), and the post-conditions
// checked before anything can commit (D7). RULING-v7-book-runner (R2/R3) refines D7: the hard gate is v7's **input** — each
// row's quantity, unit and apportionment carried exactly — and the emission is the console's calculation, compared with v7's
// reported figure in a delta report (material differences flagged for the attesting reviewer) rather than refused. A dry run is
// the same call inside a transaction the caller rolls back. Tenancy is the caller's `withTenantWrite` (SET LOCAL ROLE
// nzi_console_app: forced RLS throughout).
import { createHash, randomUUID } from "node:crypto";
import {
  sameV7Quantity, V7_REINGEST_ACTOR, V7_REPORTED_TOTAL_LABEL, V7_REPORTED_TOTAL_REASONS, v7ApplyPct, v7EmissionDeltaReport, v7ReingestPostconditionMisses,
  withinV7Tolerance, type CommandContext, type CommandInputMap, type V7EmissionDeltaReport, type V7ReingestPlanRow,
} from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { checkUnit } from "./unitCompatibility";
import { UNITS as V7_UNITS } from "./v7ReferenceImport";
import {
  CommandValidationError, createScopeRowInTransaction, recalculateScopeRowInTransaction, reportingMonthsFor, requireCrpJob,
  runPostgresCommandInTransaction, type StoredOutcome,
} from "./postgresCommands";
import { siteIncludedSql } from "./siteInclusionGuard";
import { deactivateScopeRowInTransaction } from "./scopeRowState";

/** The import identity a carried factor is created under, so a later run (after a revert) reuses it rather than adding another. */
export const V7_REINGEST_SOURCE_SYSTEM = "nzi-pro-v7-reingest";

export type V7ReingestResult = {
  runId: string; jobId: string; crosswalkVersion: string;
  /** tCO2e only (NZC-120: no money in the run's audit or its record). */
  v7TotalTco2e: number; nativeTotalTco2e: number; scopeTotals: Record<string, { v7: number; native: number }>;
  /** Per site, by site id ("unallocated" where v7 named none): rows, v7 and native tCO2e (RULING-v7-reingest-full-record). */
  siteTotals: Record<string, { rows: number; v7: number; native: number }>;
  /** How many rows carried each v7 field. */
  carried: { site: number; dataConfidence: number; columnText: number; months: number };
  rowsByDisposition: Record<string, number>; datasetsAdded: string[]; clientFactorsCreated: number; v7RowsSwitchedOff: number;
  /**
   * RULING-v7-book-runner R3: the console's calculated figure against v7's reported one, per row, scope, site and job — a comparison,
   * not a gate. Its `flagged` list is what the attesting reviewer must acknowledge. tCO2e and row ids only.
   */
  deltas: V7EmissionDeltaReport;
};
export type V7ReingestRevertResult = { runId: string; jobId: string; liveRowsSwitchedOff: number; v7RowsSwitchedOn: number };

/**
 * A stored v7 row, with the data-row fields the re-ingest carries (RULING-v7-reingest-full-record A): read from the row itself —
 * the record of account, immutable under 0133 — never from the plan, which stays a pure crosswalk decision.
 */
type MigratedRow = {
  scope_row_id: string; scope: string; enabled: boolean; reported: string | null; immutable_hash: string;
  site_id: string | null; data_confidence: string | null; column_text: string | null; months: Array<number | null> | null; data_source: string | null;
  /** v7's input (RULING-v7-book-runner R2): what the live row must carry exactly. */
  qty: string | null; uom: string | null; apply_pct: string | null;
};

/** v7's uom in the console registry's spelling (the ruled map; a three-letter currency upper-cased; anything else as written). */
export function normaliseV7Unit(uom: string | null): string | null {
  const key = (uom ?? "").trim().toLowerCase();
  if (!key) return null;
  return V7_UNITS[key] ?? (/^[a-z]{3}$/.test(key) ? key.toUpperCase() : uom!.trim());
}

/** The same unit — one spelling, or two the unit registry reads as the same (the factor's own spelling, as the plan uses). */
export const sameV7Unit = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase() || checkUnit(a, b).kind === "same" || checkUnit(b, a).kind === "same";

/** v7's stored input, as numbers. */
const v7Input = (row: MigratedRow) => ({
  quantity: row.qty === null || row.qty === "" ? null : Number(row.qty), unit: normaliseV7Unit(row.uom),
  applyPct: v7ApplyPct(row.apply_pct === null || row.apply_pct === "" ? null : Number(row.apply_pct)),
});

/** What the live row must carry from its v7 row — site, confidence, column text, months on the job's reporting months. */
type Carried = { siteId: string | null; dataConfidence: string | null; columnText: string | null; slots: Array<{ month: string; quantity: number | null }> | null };

/**
 * RULING-v7-reingest-full-record C: v7's `month_i` is the i-th month of the job's reporting period (v7's own
 * `dataset_selector._month_sequence`), so slot i goes to reporting month i. A non-empty slot (a figure other than 0) that falls
 * outside the period refuses the run; a blank or zero one there carries nothing. Months must be figure-inert: their sum is the
 * row's quantity, or the run refuses — and per-row D7.2 then proves the figure.
 */
export function v7MonthSlots(months: Array<number | null> | null, reportingMonths: string[]): { slots: Array<{ month: string; quantity: number | null }> | null; outside: number[] } {
  if (!months || !months.some((value) => value !== null)) return { slots: null, outside: [] };
  const outside = months.map((value, index) => (index >= reportingMonths.length && value !== null && value !== 0 ? index + 1 : 0)).filter(Boolean);
  return { slots: reportingMonths.map((month, index) => ({ month, quantity: index < months.length ? months[index] ?? null : null })), outside };
}

const fail = (code: string, message: string, field = "rows"): never => { throw new CommandValidationError([{ field, code, message }]); };
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The job's migrated rows, with a fingerprint of everything 0133 keeps immutable (asserted unchanged after the run). */
async function migratedRows(db: Queryable, organisationId: string, jobId: string): Promise<MigratedRow[]> {
  return (await db.query<MigratedRow>(
    `SELECT scope_row_id, scope, enabled, migrated_record->>'reported_tco2e' AS reported,
            md5((to_jsonb(r) - ARRAY['enabled', 'version', 'updated_at'])::text) AS immutable_hash,
            site_id, data_confidence, column_text, migrated_record->'months' AS months, migrated_record->>'data_source' AS data_source,
            migrated_record->>'qty' AS qty, migrated_record->>'uom' AS uom, migrated_record->>'apply_pct' AS apply_pct
       FROM nzi_console.job_scope_rows r
      WHERE organisation_id = $1 AND job_id = $2 AND origin = 'migrated' ORDER BY scope_row_id FOR UPDATE`,
    [organisationId, jobId])).rows;
}

function rowContext(context: CommandContext, runId: string, v7RowId: string, step: string): CommandContext {
  return { ...context, idempotencyKey: `${runId}:${v7RowId}:${step}` };
}

/** `v7.reingest.job`, inside the caller's transaction (the dry run is this, rolled back). */
export function reingestV7JobInTransaction(db: Queryable, input: CommandInputMap["v7.reingest.job"], context: CommandContext): Promise<StoredOutcome<V7ReingestResult>> {
  return runPostgresCommandInTransaction(db, "v7.reingest.job", input, context, async (db) => {
    await requireCrpJob(db, context.organisationId, input.jobId);
    const job = (await db.query<{ source_system: string | null; client_id: string }>(
      `SELECT source_system, client_id FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`,
      [context.organisationId, input.jobId])).rows[0]!;
    if (job.source_system !== "nzi-pro-v7") fail("NOT_A_V7_JOB", "Only a job imported from NZ Insights Pro v7 is re-ingested.", "jobId");
    if ((await db.query(`SELECT 1 FROM nzi_console.v7_reingest_runs WHERE organisation_id = $1 AND job_id = $2 AND status = 'completed'`,
      [context.organisationId, input.jobId])).rows.length) fail("ALREADY_REINGESTED", "This job already has a completed re-ingest; revert it first to run again.", "jobId");

    // The plan must be exactly the job's enabled v7 rows, each in its own scope, each carrying its own v7 figure.
    const before = await migratedRows(db, context.organisationId, input.jobId);
    const enabledV7 = before.filter((row) => row.enabled);
    if (enabledV7.length === 0) fail("NOTHING_TO_REINGEST", "This job has no enabled v7 rows.", "jobId");
    const v7ById = new Map(enabledV7.map((row) => [row.scope_row_id, row]));
    const planned = new Set(input.rows.map((row) => row.v7RowId));
    for (const row of input.rows) {
      const v7 = v7ById.get(row.v7RowId);
      if (!v7) fail("PLAN_UNKNOWN_ROW", `v7 row ${row.v7RowId} is not an enabled v7 row of this job.`);
      // The scope is never moved (ruling 1): the top-level scope is v7's. v7 often stored a Scope 3 row as plain "3"; the live
      // row's scope is its Scope 3 category ("3.6"), as every native Scope 3 row's is — a refinement, not a move.
      if (v7!.scope.split(".")[0] !== row.scope.split(".")[0] || (v7!.scope.includes(".") && v7!.scope !== row.scope))
        fail("PLAN_SCOPE_MOVED", `v7 row ${row.v7RowId} is scope ${v7!.scope}; the plan says ${row.scope}. The scope is never moved.`);
      // The plan's v7 figure is the comparison basis of the delta report (and a reported total's own figure): it must be v7's.
      if (v7!.reported === null || !withinV7Tolerance(row.v7Tco2e, Number(v7!.reported)))
        fail("PLAN_FIGURE_MISMATCH", `v7 row ${row.v7RowId} reported ${v7!.reported ?? "nothing"} t; the plan says ${row.v7Tco2e} t.`);
    }
    // RULING-v7-book-runner R2 — the hard gate: every input-bearing plan row carries its v7 row's input exactly (quantity, unit,
    // apportionment), or nothing is written. A reported total has no input; it carries v7's figure, checked above.
    const quantityRefusals: Array<{ field: string; code: string; message: string }> = [];
    for (const row of input.rows) {
      if (row.disposition === "REPORTED-TOTAL") continue;
      const held = v7Input(v7ById.get(row.v7RowId)!);
      const why = held.quantity === null ? "v7 holds no quantity for it"
        : row.quantity === null || !sameV7Quantity(row.quantity, held.quantity) ? `the plan carries ${row.quantity ?? "none"}, v7 holds ${held.quantity}`
        : held.unit === null || !row.unit || !sameV7Unit(row.unit, held.unit) ? `the plan's unit ${row.unit ?? "none"} is not v7's ${held.unit ?? "none"}`
        : !sameV7Quantity(row.applyPct ?? 100, held.applyPct) ? `the plan apportions ${row.applyPct ?? 100}%, v7 ${held.applyPct}%`
        : null;
      if (why) quantityRefusals.push({ field: "rows", code: "PLAN_QUANTITY_MISMATCH", message: `v7 row ${row.v7RowId}: ${why} — its quantity cannot be carried faithfully.` });
    }
    if (quantityRefusals.length) throw new CommandValidationError(quantityRefusals.slice(0, 20));
    const unplanned = enabledV7.filter((row) => !planned.has(row.scope_row_id));
    if (unplanned.length) fail("PLAN_INCOMPLETE", `${unplanned.length} enabled v7 row(s) have no plan row (${unplanned.slice(0, 5).map((row) => row.scope_row_id).join(", ")}…); a partial re-ingest would double count or drop them.`);

    // RULING-v7-reingest-full-record: the fields each live row carries, from its own v7 row — and refused, named, before anything
    // is written, where they cannot be carried faithfully. Never a silent Unallocated; never a dropped or moved month.
    const carried = new Map<string, Carried>();
    const refusals: Array<{ field: string; code: string; message: string }> = [];
    const siteIds = [...new Set(enabledV7.map((row) => row.site_id).filter((id): id is string => id !== null))];
    // B: a v7 site must be the job's client's, not archived, and included in the job — or SITE_NOT_USABLE, naming it.
    const sites = new Map((await db.query<{ site_id: string; name: string; client_id: string; archived: boolean; included: boolean }>(
      `SELECT s.site_id, s.name, s.client_id, s.archived, ${siteIncludedSql("$2", "s.site_id")} AS included
         FROM nzi_console.client_sites s WHERE s.organisation_id = $1 AND s.site_id = ANY($3::text[])`,
      [context.organisationId, input.jobId, siteIds])).rows.map((site) => [site.site_id, site]));
    const anyMonths = input.rows.some((plan) => plan.disposition !== "REPORTED-TOTAL" && v7ById.get(plan.v7RowId)!.months?.some((value) => value !== null));
    const reportingMonths = anyMonths ? await reportingMonthsFor(db, context.organisationId, input.jobId) : [];
    for (const plan of input.rows) {
      const v7 = v7ById.get(plan.v7RowId)!;
      if (v7.site_id !== null) {
        const site = sites.get(v7.site_id);
        const why = !site ? "no such site" : site.client_id !== job.client_id ? "another client's site" : site.archived ? "archived" : !site.included ? "excluded from this job" : null;
        if (why) refusals.push({ field: "rows", code: "SITE_NOT_USABLE", message: `v7 row ${plan.v7RowId} is at site ${site?.name ?? v7.site_id} (${v7.site_id}), which is ${why}; the re-ingest will not leave it Unallocated.` });
      }
      // D5: a reported total carries v7's figure and no activity, so no months either (its shape is ruled).
      const months = plan.disposition === "REPORTED-TOTAL" ? { slots: null, outside: [] } : v7MonthSlots(v7.months, reportingMonths);
      if (months.outside.length)
        refusals.push({ field: "rows", code: "MONTHS_DO_NOT_FIT", message: `v7 row ${plan.v7RowId} has activity in month ${months.outside.join(", ")} of 12, outside this job's ${reportingMonths.length}-month reporting period.` });
      else if (months.slots) {
        const sum = months.slots.reduce((total, slot) => total + (slot.quantity ?? 0), 0);
        if (plan.quantity === null || Math.abs(sum - plan.quantity) > 1e-9 * Math.max(1, Math.abs(plan.quantity)))
          refusals.push({ field: "rows", code: "MONTHS_DO_NOT_FIT", message: `v7 row ${plan.v7RowId}'s months sum to ${sum}, not its quantity ${plan.quantity ?? "none"}; carrying them would move its figure.` });
      }
      const columnText = v7.column_text?.trim() || null;
      carried.set(plan.v7RowId, { siteId: v7.site_id, dataConfidence: v7.data_confidence, columnText, slots: months.slots });
    }
    if (refusals.length) throw new CommandValidationError(refusals);

    // Ruling 3: v7's vintages join the job's selection — added, never removed.
    const datasetsAdded: string[] = [];
    for (const datasetId of [...new Set(input.vintageDatasetIds)]) {
      const inserted = await db.query(
        `INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, warnings_json, selected_by)
         VALUES ($1, $2, $3, 'manual', $4, '[]'::jsonb, $5) ON CONFLICT (organisation_id, job_id, dataset_id) DO NOTHING RETURNING dataset_id`,
        [context.organisationId, input.jobId, datasetId, `v7 re-ingest (${input.runId}): bind to v7's dataset vintage (ruling 3)`, context.actorId]);
      if (inserted.rows[0]) datasetsAdded.push(datasetId);
    }

    // The categories whose declared-factor resolution is switched on: there, each re-ingested row records that it was not applied.
    const declaredCategories = new Set((await db.query<{ category_code: string }>(
      `SELECT category_code FROM nzi_console.input_spec_categories WHERE declarative_resolution_enabled`)).rows.map((row) => row.category_code));
    const counts: Record<string, number> = {};
    let clientFactorsCreated = 0;
    for (const plan of input.rows) {
      counts[plan.disposition] = (counts[plan.disposition] ?? 0) + 1;
      const reportedTotal = plan.disposition === "REPORTED-TOTAL";
      let clientFactorId: string | null = null;
      if (plan.disposition === "CARRY-V7-FACTOR") ({ clientFactorId, created: clientFactorsCreated } = await carriedFactor(db, context, input.jobId, job.client_id, plan, clientFactorsCreated));
      const created = await createScopeRowInTransaction(db, {
        jobId: input.jobId, scope: plan.scope, categoryCode: plan.categoryCode, sourceLabel: plan.sourceLabel,
        quantity: plan.quantity, unit: plan.unit,
        datasetId: plan.disposition === "RE-INGEST" ? plan.datasetId ?? null : null,
        factorId: plan.disposition === "RE-INGEST" ? plan.factorId ?? null : clientFactorId,
        factorVersion: null, factorLabel: reportedTotal ? V7_REPORTED_TOTAL_LABEL : null,
        factorSource: plan.disposition === "CARRY-V7-FACTOR" ? "client" : "dataset",
        clientFactorId, isCustomEntry: plan.disposition === "CARRY-V7-FACTOR",
        applyPct: plan.applyPct ?? 100, qualityTier: plan.qualityTier,
        overrideTco2e: reportedTotal ? plan.v7Tco2e : null,
        overrideReason: reportedTotal ? V7_REPORTED_TOTAL_REASONS[0] : null,
        // The full record (RULING-v7-reingest-full-record), from the v7 row — through the create's own site guards as well.
        siteId: carried.get(plan.v7RowId)!.siteId, dataConfidence: carried.get(plan.v7RowId)!.dataConfidence as "H" | "M" | "L" | null,
        columnText: carried.get(plan.v7RowId)!.columnText, monthlyActivity: carried.get(plan.v7RowId)!.slots ?? [],
      }, rowContext(context, input.runId, plan.v7RowId, "create"),
      { reingestedFrom: plan.v7RowId, reportedTotal, historicalUnit: !reportedTotal, declaredResolutionExempt: true });
      const rowId = created.data.rowId;
      const mark = { title: reportedTotal ? "v7 reported total carried" : "Re-ingested from NZ Insights Pro v7",
        detail: reportedTotal
          ? `${input.crosswalkVersion} · rule ${plan.rule} · ${plan.disposition} · carries v7's ${round6(plan.v7Tco2e)} t (v7 row ${plan.v7RowId}, run ${input.runId})`
          // R2/R3: the row carries v7's input; its figure is the console's calculation, and v7's is kept only as the comparison.
          : `${input.crosswalkVersion} · rule ${plan.rule} · ${plan.disposition} · carries v7's input; v7 reported ${round6(plan.v7Tco2e)} t (v7 row ${plan.v7RowId}, run ${input.runId})` };
      // RULING-v7-reingest-declared-factor (a): where the category declares a factor, say that it was not applied, and why.
      const marks = declaredCategories.has(plan.categoryCode)
        ? [mark, { title: "Declared resolution not applied", detail: "declared resolution not applied: v7's own factor (ruling 3)" }]
        : [mark];
      // RULING-v7-reingest-full-record D: v7's data source, kept as a lineage line — descriptive text, no money.
      const dataSource = v7ById.get(plan.v7RowId)!.data_source;
      if (dataSource) marks.push({ title: "v7 data source", detail: dataSource });
      if (!reportedTotal) {
        const calc = { jobId: input.jobId, rowId, expectedVersion: created.data.version };
        await runPostgresCommandInTransaction(db, "scope.row.calculate", calc, rowContext(context, input.runId, plan.v7RowId, "calculate"),
          (db) => recalculateScopeRowInTransaction(db, calc, rowContext(context, input.runId, plan.v7RowId, "calculate"), marks));
      } else {
        await db.query(`UPDATE nzi_console.job_scope_rows SET lineage_json = lineage_json || $3::jsonb WHERE organisation_id = $1 AND scope_row_id = $2`,
          [context.organisationId, rowId, JSON.stringify(marks)]);
      }
      // The re-ingest's provenance, merged in after calculation (which writes its own): the crosswalk, the v7 row and figure.
      await db.query(`UPDATE nzi_console.job_scope_rows SET provenance_json = coalesce(provenance_json, '{}'::jsonb) || jsonb_build_object('reingest', $3::jsonb)
                       WHERE organisation_id = $1 AND scope_row_id = $2`,
        [context.organisationId, rowId, JSON.stringify({ runId: input.runId, crosswalk: input.crosswalkVersion, crosswalkSha256: input.crosswalkSha256,
          v7RowId: plan.v7RowId, v7Label: plan.sourceLabel, v7Tco2e: plan.v7Tco2e, rule: plan.rule, disposition: plan.disposition })]);
    }

    // D6: the v7 rows switch off — the only change 0133 allows them — each with its own audit event.
    const governedEvents = [];
    for (const v7 of enabledV7) {
      await db.query(`UPDATE nzi_console.job_scope_rows SET enabled = false, version = version + 1, updated_at = now()
                       WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 AND origin = 'migrated'`,
        [context.organisationId, input.jobId, v7.scope_row_id]);
      governedEvents.push({ action: "v7_row_superseded", entityType: "scope_row", entityId: v7.scope_row_id,
        before: { enabled: true }, after: { enabled: false, runId: input.runId } });
    }

    // D7: the post-conditions, read back from what is now in the table.
    const live = (await db.query<{ scope_row_id: string; reingested_from_row_id: string; scope: string; tco2e: string | null; enabled: boolean;
      site_id: string | null; data_confidence: string | null; column_text: string | null; monthly: Array<{ month: string; quantity: number | null }> | null;
      quantity: string | null; unit: string | null; apply_pct: string | null }>(
      `SELECT scope_row_id, reingested_from_row_id, scope, coalesce(override_tco2e, calculated_tco2e)::text AS tco2e, enabled,
              site_id, data_confidence, column_text, monthly_activity_json AS monthly, quantity::text AS quantity, unit, apply_pct::text AS apply_pct
         FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND origin = 'live' AND reingested_from_row_id IS NOT NULL AND enabled`,
      [context.organisationId, input.jobId])).rows;
    const planByV7 = new Map(input.rows.map((plan) => [plan.v7RowId, plan]));
    const after = await migratedRows(db, context.organisationId, input.jobId);
    // Each side's carried fields: what the v7 row says the live row must hold, and what it holds.
    const expected = (v7: MigratedRow) => {
      const fields = carried.get(v7.scope_row_id);
      return { siteId: v7.site_id, dataConfidence: v7.data_confidence, columnText: fields?.columnText ?? (v7.column_text?.trim() || null),
        months: fields?.slots ? fields.slots.map((slot) => slot.quantity) : null };
    };
    const misses = v7ReingestPostconditionMisses({
      v7Rows: enabledV7.map((row) => {
        const reportedTotal = planByV7.get(row.scope_row_id)?.disposition === "REPORTED-TOTAL";
        const held = v7Input(row);
        return { rowId: row.scope_row_id, scope: row.scope, v7Tco2e: Number(row.reported), reportedTotal,
          quantity: reportedTotal ? null : held.quantity, unit: reportedTotal ? null : held.unit, applyPct: held.applyPct, ...expected(row) };
      }),
      liveRows: live.map((row) => ({ rowId: row.scope_row_id, reingestedFrom: row.reingested_from_row_id, scope: row.scope, tco2e: row.tco2e === null ? null : Number(row.tco2e), enabled: row.enabled,
        quantity: row.quantity === null ? null : Number(row.quantity), unit: row.unit, applyPct: row.apply_pct === null ? 100 : Number(row.apply_pct),
        siteId: row.site_id, dataConfidence: row.data_confidence, columnText: row.column_text,
        months: Array.isArray(row.monthly) && row.monthly.length ? row.monthly.map((slot) => (slot.quantity === null || slot.quantity === undefined ? null : Number(slot.quantity))) : null })),
      enabledMigratedAfter: after.filter((row) => row.enabled).length,
    }, sameV7Unit);
    const beforeHash = new Map(before.map((row) => [row.scope_row_id, row.immutable_hash]));
    for (const row of after) if (beforeHash.get(row.scope_row_id) !== row.immutable_hash) misses.push(`v7 row ${row.scope_row_id}: a kept field changed`);
    if (after.length !== before.length) misses.push("the job's v7 rows changed in number");
    if (misses.length) fail("POSTCONDITION_FAILED", `The re-ingest does not reconcile, so nothing is written: ${misses.join("; ")}.`);

    const topScope = (scope: string) => scope.split(".")[0]!;
    const scopeTotals: Record<string, { v7: number; native: number }> = {};
    for (const row of enabledV7) (scopeTotals[topScope(row.scope)] ??= { v7: 0, native: 0 }).v7 += Number(row.reported);
    for (const row of live) (scopeTotals[topScope(row.scope)] ??= { v7: 0, native: 0 }).native += Number(row.tco2e);
    for (const key of Object.keys(scopeTotals)) scopeTotals[key] = { v7: round6(scopeTotals[key]!.v7), native: round6(scopeTotals[key]!.native) };
    // Per site (Unallocated its own bucket) — ids and tCO2e only, for the run's output and audit (no names, no money).
    const siteTotals: Record<string, { rows: number; v7: number; native: number }> = {};
    const siteKey = (siteId: string | null) => siteId ?? "unallocated";
    for (const row of enabledV7) { const total = (siteTotals[siteKey(row.site_id)] ??= { rows: 0, v7: 0, native: 0 }); total.rows += 1; total.v7 += Number(row.reported); }
    for (const row of live) (siteTotals[siteKey(row.site_id)] ??= { rows: 0, v7: 0, native: 0 }).native += Number(row.tco2e);
    for (const key of Object.keys(siteTotals)) siteTotals[key] = { rows: siteTotals[key]!.rows, v7: round6(siteTotals[key]!.v7), native: round6(siteTotals[key]!.native) };
    const carriedCounts = {
      site: [...carried.values()].filter((fields) => fields.siteId !== null).length,
      dataConfidence: [...carried.values()].filter((fields) => fields.dataConfidence !== null).length,
      columnText: [...carried.values()].filter((fields) => fields.columnText !== null).length,
      months: [...carried.values()].filter((fields) => fields.slots !== null).length,
    };
    const v7TotalTco2e = round6(enabledV7.reduce((a, row) => a + Number(row.reported), 0));
    const nativeTotalTco2e = round6(live.reduce((a, row) => a + Number(row.tco2e), 0));
    await db.query(
      `INSERT INTO nzi_console.v7_reingest_runs (organisation_id, run_id, job_id, crosswalk_version, crosswalk_sha256, v7_total_tco2e, native_total_tco2e,
         scope_totals_json, rows_by_disposition_json, created_by, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
      [context.organisationId, input.runId, input.jobId, input.crosswalkVersion, input.crosswalkSha256, v7TotalTco2e, nativeTotalTco2e,
        JSON.stringify(scopeTotals), JSON.stringify(counts), context.actorId, context.correlationId]);
    // R3: the comparison — the console's figure against v7's, every row, with what is material flagged for the reviewer.
    const reported = new Map(enabledV7.map((row) => [row.scope_row_id, Number(row.reported)]));
    const deltas = v7EmissionDeltaReport(live.map((row) => ({ v7RowId: row.reingested_from_row_id, liveRowId: row.scope_row_id, scope: row.scope,
      siteId: row.site_id, v7Tco2e: reported.get(row.reingested_from_row_id) ?? 0, calcTco2e: Number(row.tco2e) })));
    const data: V7ReingestResult = { runId: input.runId, jobId: input.jobId, crosswalkVersion: input.crosswalkVersion, v7TotalTco2e, nativeTotalTco2e,
      scopeTotals, siteTotals, carried: carriedCounts, rowsByDisposition: counts, datasetsAdded, clientFactorsCreated, v7RowsSwitchedOff: enabledV7.length, deltas };
    return { data, entityType: "job", entityId: input.jobId, topic: "v7.reingest.completed", before: { enabledV7Rows: enabledV7.length }, governedEvents };
  });
}

/** Ruling 4: v7's copied factor value as a job-pinned client factor, keyed by the v7 row so a re-run reuses it. */
async function carriedFactor(db: Queryable, context: CommandContext, jobId: string, clientId: string, plan: V7ReingestPlanRow, createdSoFar: number): Promise<{ clientFactorId: string; created: number }> {
  const f = plan.carriedFactor!;
  const found = (await db.query<{ client_factor_id: string }>(
    `SELECT client_factor_id FROM nzi_console.client_factors WHERE organisation_id = $1 AND source_system = $2 AND legacy_db_id = $3`,
    [context.organisationId, V7_REINGEST_SOURCE_SYSTEM, plan.v7RowId])).rows[0];
  if (found) return { clientFactorId: found.client_factor_id, created: createdSoFar };
  const clientFactorId = randomUUID();
  await db.query(
    `INSERT INTO nzi_console.client_factors (organisation_id, client_factor_id, client_id, job_id, scope, category_path_json, report_label, description, unit, ghg_unit,
       kgco2e_per_unit, geography, vintage_year, source, created_by, source_system, legacy_db_id)
     VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,$6,$7,$8,'kgCO2e',$9,'GB',$10,$11,$12,$13,$14)`,
    [context.organisationId, clientFactorId, clientId, jobId, plan.scope, f.label,
      "v7's own factor value, carried to reproduce the issued figure (ruling 4)", f.unit, f.kgco2ePerUnit, f.vintageYear,
      "NZ Insights Pro v7 (copied factor value; record of account)", context.actorId, V7_REINGEST_SOURCE_SYSTEM, plan.v7RowId]);
  return { clientFactorId, created: createdSoFar + 1 };
}

/** `v7.reingest.revert`, inside the caller's transaction: before any snapshot of the job, nothing deleted either way. */
export function revertV7ReingestInTransaction(db: Queryable, input: CommandInputMap["v7.reingest.revert"], context: CommandContext): Promise<StoredOutcome<V7ReingestRevertResult>> {
  return runPostgresCommandInTransaction(db, "v7.reingest.revert", input, context, async (db) => {
    await requireCrpJob(db, context.organisationId, input.jobId);
    const run = (await db.query<{ status: string; created_at: Date; rows_by_disposition_json: Record<string, number> }>(
      `SELECT status, created_at, rows_by_disposition_json FROM nzi_console.v7_reingest_runs WHERE organisation_id = $1 AND job_id = $2 AND run_id = $3 FOR UPDATE`,
      [context.organisationId, input.jobId, input.runId])).rows[0];
    if (!run) fail("NOT_FOUND", "No such re-ingest run for this job.", "runId");
    if (run!.status !== "completed") fail("NOT_COMPLETED", "Only a completed re-ingest is reverted.", "runId");
    if ((await db.query(`SELECT 1 FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND job_id = $2 AND created_at >= $3`,
      [context.organisationId, input.jobId, run!.created_at])).rows.length) fail("SNAPSHOT_EXISTS", "The job has been snapshotted since the re-ingest; it is no longer reverted here.", "runId");
    // RULING-v7-reingest-row-protection 2: the run's rows are found by what nothing but the run writes — never by provenance,
    // which an edit could rewrite (the J000663 finding: two edited rows had lost their run id, and the revert would have
    // reversed 78 of 80 and still marked the run reverted). The run's v7 rows are its own `v7_row_superseded` audit events
    // (append-only), checked against the count the run recorded; its live rows, the job's enabled rows linked to them by
    // `reingested_from_row_id` (one per v7 row, 0166's unique index).
    const v7RowIds = (await db.query<{ entity_id: string }>(
      `SELECT DISTINCT a.entity_id FROM nzi_console.audit_events a
         JOIN nzi_console.job_scope_rows v ON v.organisation_id = a.organisation_id AND v.scope_row_id = a.entity_id AND v.job_id = $2 AND v.origin = 'migrated'
        WHERE a.organisation_id = $1 AND a.action = 'v7_row_superseded' AND a.entity_type = 'scope_row' AND a.actor_id = $4 AND a.after_json->>'runId' = $3
        ORDER BY a.entity_id`,
      [context.organisationId, input.jobId, input.runId, V7_REINGEST_ACTOR])).rows.map((row) => row.entity_id);
    const recorded = Object.values(run!.rows_by_disposition_json).reduce((sum, n) => sum + Number(n), 0);
    if (v7RowIds.length !== recorded)
      fail("REVERT_INCOMPLETE", `The run recorded ${recorded} row(s) but ${v7RowIds.length} v7 row(s) are on its record; nothing is reverted.`, "runId");
    const live = (await db.query<{ scope_row_id: string; version: number }>(
      `SELECT scope_row_id, version FROM nzi_console.job_scope_rows
        WHERE organisation_id = $1 AND job_id = $2 AND origin = 'live' AND enabled AND reingested_from_row_id = ANY($3::text[])
        ORDER BY scope_row_id FOR UPDATE`,
      [context.organisationId, input.jobId, v7RowIds])).rows;
    for (const row of live) {
      const ref = { jobId: input.jobId, rowId: row.scope_row_id, expectedVersion: row.version };
      await deactivateScopeRowInTransaction(db, ref, { ...rowContext(context, input.runId, row.scope_row_id, "revert"), reason: context.reason });
    }
    const governedEvents = [];
    for (const v7RowId of v7RowIds) {
      const restored = await db.query(`UPDATE nzi_console.job_scope_rows SET enabled = true, version = version + 1, updated_at = now()
                       WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 AND origin = 'migrated' AND NOT enabled RETURNING scope_row_id`,
        [context.organisationId, input.jobId, v7RowId]);
      if (restored.rows.length) governedEvents.push({ action: "v7_row_restored", entityType: "scope_row", entityId: v7RowId, before: { enabled: false }, after: { enabled: true, runId: input.runId } });
    }
    // All or nothing, read back from the table inside the transaction (as the re-ingest's D7): every live row linked to the
    // run's v7 rows is off, and every one of those v7 rows is on — or the whole revert rolls back and the run stays completed.
    const after = (await db.query<{ live_on: string; v7_on: string }>(
      `SELECT count(*) FILTER (WHERE origin = 'live' AND enabled AND reingested_from_row_id = ANY($3::text[]))::text AS live_on,
              count(*) FILTER (WHERE origin = 'migrated' AND enabled AND scope_row_id = ANY($3::text[]))::text AS v7_on
         FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2`,
      [context.organisationId, input.jobId, v7RowIds])).rows[0]!;
    if (Number(after.live_on) !== 0 || Number(after.v7_on) !== v7RowIds.length)
      fail("REVERT_INCOMPLETE", `The revert would leave ${after.live_on} re-ingested row(s) on and ${v7RowIds.length - Number(after.v7_on)} of the run's ${v7RowIds.length} v7 row(s) off; nothing is reverted.`, "runId");
    await db.query(`UPDATE nzi_console.v7_reingest_runs SET status = 'reverted', reverted_by = $4, reverted_at = now(), revert_reason = $5
                     WHERE organisation_id = $1 AND job_id = $2 AND run_id = $3`,
      [context.organisationId, input.jobId, input.runId, context.actorId, context.reason!.trim()]);
    const data: V7ReingestRevertResult = { runId: input.runId, jobId: input.jobId, liveRowsSwitchedOff: live.length, v7RowsSwitchedOn: governedEvents.length };
    return { data, entityType: "job", entityId: input.jobId, topic: "v7.reingest.reverted", governedEvents };
  });
}

/** The crosswalk file's sha256, as the run records it. */
export const crosswalkSha256 = (text: string) => createHash("sha256").update(text).digest("hex");
