// Cause 8 (FINDING-drift-large-differences; ruled by Francis 25 and 27 Nov): the rows the previous system derives.
//
// V7 computes some rows at report time — its consolidated commuting and travel rows — and counts them in its scope totals. They
// carry negative ids on endpoint 2 (the row figures) and are stored in none of its tables, so the view set, and with it the chain,
// never sees them, and an imported job reads behind by exactly their figure. Bring-in now carries them, after the chain and in its
// transaction, from the endpoint-2 read it already makes:
//
//   * each is a live row of its own import identity — `V7_DERIVED_SOURCE_SYSTEM`, legacy id `<V7 job id>:<V7 row id>`, the link
//     to its V7 row — at the previous system's own figure (an override with the closed reason), marked in its lineage;
//   * it counts in the scope totals as any enabled row does, so the job reads level with V7;
//   * a re-run never makes a second row for one (the identity key, 0132/0225, allows one): a row V7 still derives at the same
//     scope and figure is left as it is; a moved one is brought up to V7's in place (version, lineage);
//   * one V7 no longer derives (absent, or switched off there) is switched off here — kept, never deleted.
//
// Nothing here runs without the previous system's own figures read: then the job's derived rows stay exactly as they are.
// Ids, scopes and tCO2e only; no label of the previous system's crosses.
import { randomUUID } from "node:crypto";
import {
  crpScopeCategoryPath, isV7DerivedRow, V7_DERIVED_LINEAGE_TITLE, V7_DERIVED_OVERRIDE_REASON, V7_DERIVED_SOURCE_SYSTEM, v7FiguresRowKey, v7FiguresScope,
  type V7DerivedRowsCarried, type V7FiguresRowFigures, type V7ImportScope,
} from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";

const r6 = (value: number) => Math.round(value * 1e6) / 1e6;
export const v7DerivedLegacyId = (v7JobId: string, rowId: string) => `${v7JobId}:${rowId}`;
const derivedLabel = (rowId: string) => `Derived in the previous system (row ${rowId})`;

export type V7DerivedCarry = {
  carried: V7DerivedRowsCarried;
  /** Σ per scope of the job's derived rows switched on once the carry is done (V7's own figures). */
  scopeTotals: Record<V7ImportScope, number>;
  /** One governed event for the job (ids only), so a person's bring-in audits what it did to them. */
  event: { action: string; entityType: string; entityId: string; before: Record<string, unknown>; after: Record<string, unknown> } | null;
};

type Held = { scope_row_id: string; legacy_db_id: string; scope: string; tco2e: string | null; enabled: boolean };

/**
 * Bring the job's derived rows level with the previous system's own figures, in the caller's transaction. Refused, nothing kept,
 * when V7 names a derived row in no scope the console has.
 */
export async function carryV7DerivedRows(db: Queryable, input: { organisationId: string; jobId: string; reason: string; figures: V7FiguresRowFigures }): Promise<V7DerivedCarry> {
  const { organisationId: org, jobId } = input;
  const v7JobId = String(input.figures.job_id);
  const wanted = new Map<string, { rowId: string; scope: V7ImportScope; tco2e: number }>();
  const unscoped: string[] = [];
  for (const row of input.figures.rows) {
    if (!isV7DerivedRow(row) || !row.enabled) continue;
    const scope = v7FiguresScope(row.scope);
    if (!scope) { unscoped.push(v7FiguresRowKey(row)); continue; }
    wanted.set(v7DerivedLegacyId(v7JobId, v7FiguresRowKey(row)), { rowId: v7FiguresRowKey(row), scope, tco2e: row.tco2e });
  }
  if (unscoped.length) throw new CommandValidationError(unscoped.slice(0, 20).map((rowId) => ({ field: `rows.${rowId}`, code: "DERIVED_ROW_SCOPE",
    message: `The previous system derives row ${rowId} in no scope the console knows, so it can't be carried. Nothing was written.` })));

  const held = (await db.query<Held>(
    `SELECT scope_row_id, legacy_db_id, scope, override_tco2e::text AS tco2e, enabled FROM nzi_console.job_scope_rows
      WHERE organisation_id = $1 AND job_id = $2 AND origin = 'live' AND source_system = $3 ORDER BY scope_row_id FOR UPDATE`,
    [org, jobId, V7_DERIVED_SOURCE_SYSTEM])).rows;
  const byLegacy = new Map(held.map((row) => [row.legacy_db_id, row]));
  const carried: V7DerivedRowsCarried = { added: 0, updated: 0, unchanged: 0, switchedOff: 0 };
  const ids = { added: [] as string[], updated: [] as string[], switchedOff: [] as string[] };
  const mark = (title: string, detail: string) => JSON.stringify([{ title, detail }]);

  for (const [legacyId, want] of wanted) {
    const detail = `carried at the previous system's own figure, ${r6(want.tco2e)} t (its row ${want.rowId} on job ${v7JobId}) · ${input.reason}`;
    const provenance = JSON.stringify({ v7Derived: { v7JobId, v7RowId: want.rowId, v7Tco2e: want.tco2e, scope: want.scope } });
    const was = byLegacy.get(legacyId);
    if (!was) {
      const scopeRowId = randomUUID();
      const path = crpScopeCategoryPath(want.scope);
      await db.query(
        `INSERT INTO nzi_console.job_scope_rows (organisation_id, scope_row_id, job_id, scope, source_label, report_label, level_1, level_2, quantity, unit,
           override_tco2e, override_reason, quality_tier, provenance_json, lineage_json, source_system, legacy_db_id)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, NULL, NULL, $8, $9, 'estimated', $10::jsonb, $11::jsonb, $12, $13)`,
        // Endpoint 2 names the scope alone: a Scope 3 row is filed under no category, so its path's second level says what it is.
        [org, scopeRowId, jobId, want.scope, derivedLabel(want.rowId), path[0] ?? `Scope ${want.scope}`, path[1] ?? V7_DERIVED_LINEAGE_TITLE, want.tco2e, V7_DERIVED_OVERRIDE_REASON,
          provenance, mark(V7_DERIVED_LINEAGE_TITLE, detail), V7_DERIVED_SOURCE_SYSTEM, legacyId]);
      carried.added += 1; ids.added.push(scopeRowId);
      continue;
    }
    if (was.enabled && was.scope === want.scope && was.tco2e !== null && r6(Number(was.tco2e)) === r6(want.tco2e)) { carried.unchanged += 1; continue; }
    // Moved in V7 (its figure or scope), or switched off here earlier and derived again: brought up to V7's own, in place.
    await db.query(
      `UPDATE nzi_console.job_scope_rows SET scope = $3, override_tco2e = $4, enabled = true, review_status = 'pending', version = version + 1, updated_at = now(),
              provenance_json = coalesce(provenance_json, '{}'::jsonb) || $5::jsonb, lineage_json = lineage_json || $6::jsonb
        WHERE organisation_id = $1 AND scope_row_id = $2`,
      [org, was.scope_row_id, want.scope, want.tco2e, provenance, mark(V7_DERIVED_LINEAGE_TITLE, `brought up to date: ${detail}`)]);
    carried.updated += 1; ids.updated.push(was.scope_row_id);
  }
  for (const row of held) {
    if (wanted.has(row.legacy_db_id) || !row.enabled) continue;
    await db.query(
      `UPDATE nzi_console.job_scope_rows SET enabled = false, version = version + 1, updated_at = now(), lineage_json = lineage_json || $3::jsonb
        WHERE organisation_id = $1 AND scope_row_id = $2`,
      [org, row.scope_row_id, mark("Switched off", `the previous system no longer derives its row ${row.legacy_db_id.split(":").slice(1).join(":")} · ${input.reason}`)]);
    carried.switchedOff += 1; ids.switchedOff.push(row.scope_row_id);
  }

  const scopeTotals: Record<V7ImportScope, number> = { "1": 0, "2": 0, "3": 0 };
  for (const want of wanted.values()) scopeTotals[want.scope] += want.tco2e;
  const changed = ids.added.length + ids.updated.length + ids.switchedOff.length > 0;
  return { carried, scopeTotals,
    event: changed ? { action: "v7_derived_rows.carried", entityType: "job", entityId: jobId, before: { derivedRows: held.filter((row) => row.enabled).length },
      after: { v7JobId, added: ids.added, updated: ids.updated, switchedOff: ids.switchedOff, unchanged: carried.unchanged } } : null };
}
