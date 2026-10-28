import { randomUUID } from "node:crypto";
import { BUSINESS_TRAVEL_CODE, COMMUTING_IDENTIFYING_DETAIL_KEYS, commuterLabel } from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { withTenantWrite } from "./postgres";

/**
 * Data entry D6 (R2a, R1, R3) — the one-off clear of the personal identifiers commuting and business travel held before D6 (ruled
 * 28 Oct: minimise, don't seal). An operator run, `npm run clear:commuting-travel-identifiers`, behind the staging gate.
 *
 * - **Commuting (3.7).** Every commuting source loses its asset identifier (the commuter's name, or an employee id) and the
 *   `employeeName` / `vehicleRegistration` its detail held, and a source still labelled by a name is relabelled "Commuter n · mode"
 *   (n its place among the job's commuting sources). Each live 3.7 row follows: its identifier cleared, its labels taken from its
 *   source (or, unsourced, "Commuter n" where the label was the identifier), the name dropped from its provenance and lineage.
 * - **Business travel (3.6).** A travel source or row written before D5 A (`travelBefore`) loses its asset identifier — the field
 *   was "Traveller / trip ref" then, so it held names and plates. A trip reference given since D5 stays.
 * - **Figures never move.** Quantities, factors and tCO2e are not touched, so no reporting figure changes; nor is a row's version
 *   or review, since nothing it was reviewed on has changed.
 * - **Migrated history is left.** A migrated row refuses every change but `enabled` (0133); those still holding an identifier are
 *   counted, for a ruling, never altered here.
 * - **Counts only, audited by reference.** The result and the one audit event carry counts — never a name, a plate or a label.
 *   Re-running clears nothing (the queue is "an identifier present"); a dry run is the whole run, rolled back.
 */

/** D5 A (#533) merged 28 Oct 2026, 13:33 UTC: before it, the travel identifier field was "Traveller / trip ref". */
export const D5_TRAVEL_CUTOFF = "2026-10-28T13:33:13Z";

export type MinimisationCounts = {
  commutingSources: number; commutingRows: number; relabelled: number;
  travelSources: number; travelRows: number;
  migratedLeft: number; remaining: number;
};

const COMMUTER_LABEL = /^Commuter \d+( · .*)?$/;
const KEYS = [...COMMUTING_IDENTIFYING_DETAIL_KEYS];
const same = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " "));
const isCommuting = "(x.category_code='3.7' OR (x.category_code IS NULL AND x.scope='3.7'))";
const isTravel = `(x.category_code='${BUSINESS_TRAVEL_CODE}' OR (x.category_code IS NULL AND x.scope='${BUSINESS_TRAVEL_CODE}'))`;

type Lineage = Array<{ title?: unknown; detail?: unknown }>;
/** A lineage entry that named the old label ("<label> · <source id>") names the new one; nothing else in it changes. */
function relabelLineage(lineage: unknown, from: readonly string[], to: string): Lineage | null {
  if (!Array.isArray(lineage)) return null;
  let changed = false;
  const next = (lineage as Lineage).map((entry) => {
    if (!entry || typeof entry.detail !== "string") return entry;
    const hit = from.find((old) => old && (entry.detail === old || (entry.detail as string).startsWith(`${old} · `)));
    const detail = hit ? `${to}${(entry.detail as string).slice(hit.length)}` : entry.detail;
    if (detail === entry.detail) return entry;
    changed = true;
    return { ...entry, detail };
  });
  return changed ? next : null;
}

async function clearCommuting(db: Queryable, organisationId: string, counts: MinimisationCounts): Promise<void> {
  const sources = (await db.query<{ source_id: string; job_id: string; source_name: string; asset_identifier: string | null; detail_json: Record<string, unknown> | null; ordinal: number }>(
    `SELECT source_id,job_id,source_name,asset_identifier,detail_json,
            row_number() OVER (PARTITION BY job_id ORDER BY created_at,source_id)::int AS ordinal
       FROM nzi_console.job_emission_sources WHERE organisation_id=$1 AND source_type='commuting'`, [organisationId])).rows;
  const labels = new Map<string, { from: string[]; to: string }>();
  for (const source of sources) {
    const detail = source.detail_json ?? {};
    const held = Boolean(source.asset_identifier?.trim()) || KEYS.some((key) => key in detail);
    const relabel = !COMMUTER_LABEL.test(source.source_name.trim());
    const to = relabel ? commuterLabel(source.ordinal, typeof detail.commuteMode === "string" ? detail.commuteMode : null) : source.source_name;
    labels.set(source.source_id, { from: [source.source_name, source.asset_identifier ?? "", String(detail.employeeName ?? "")].filter(Boolean), to });
    if (!held && !relabel) continue;
    await db.query(
      `UPDATE nzi_console.job_emission_sources SET asset_identifier=NULL,detail_json=detail_json-$3::text[],source_name=$4
        WHERE organisation_id=$1 AND source_id=$2`, [organisationId, source.source_id, KEYS, to]);
    if (held) counts.commutingSources += 1;
    if (relabel) counts.relabelled += 1;
  }

  const rows = (await db.query<{ scope_row_id: string; job_id: string; source_id: string | null; source_label: string; report_label: string | null; asset_identifier: string | null; provenance_json: Record<string, unknown> | null; lineage_json: unknown; ordinal: number }>(
    `SELECT x.scope_row_id,x.job_id,x.source_id,x.source_label,x.report_label,x.asset_identifier,x.provenance_json,x.lineage_json,
            row_number() OVER (PARTITION BY x.job_id ORDER BY x.created_at,x.scope_row_id)::int AS ordinal
       FROM nzi_console.job_scope_rows x WHERE x.organisation_id=$1 AND x.origin='live' AND (${isCommuting} OR x.source_id IN
         (SELECT s.source_id FROM nzi_console.job_emission_sources s WHERE s.organisation_id=$1 AND s.source_type='commuting'))`, [organisationId])).rows;
  for (const row of rows) {
    const detail = (row.provenance_json?.detail ?? null) as Record<string, unknown> | null;
    const heldDetail = Boolean(detail && KEYS.some((key) => key in detail));
    const fromSource = row.source_id ? labels.get(row.source_id) : undefined;
    // Unsourced (the drawer, a year rolled forward): a label that was the commuter's identifier names them; any other label is the
    // activity text the drawer asked for, and stays.
    const namedBy = [row.asset_identifier ?? "", String(detail?.employeeName ?? "")].filter(Boolean);
    const to = fromSource ? fromSource.to
      : namedBy.some((name) => same(name, row.source_label)) ? commuterLabel(row.ordinal, typeof detail?.commuteMode === "string" ? detail.commuteMode : null)
      : row.source_label;
    const from = fromSource ? [...fromSource.from, row.source_label] : [row.source_label, ...namedBy];
    const reportTo = row.report_label && from.some((name) => same(name, row.report_label)) ? to : row.report_label;
    const lineage = to === row.source_label && !fromSource ? null : relabelLineage(row.lineage_json, [...new Set(from)].sort((a, b) => b.length - a.length), to);
    const held = Boolean(row.asset_identifier?.trim()) || heldDetail;
    if (!held && to === row.source_label && reportTo === row.report_label && !lineage) continue;
    await db.query(
      `UPDATE nzi_console.job_scope_rows SET asset_identifier=NULL,source_label=$3,report_label=$4,
              provenance_json=CASE WHEN jsonb_typeof(provenance_json->'detail')='object' THEN jsonb_set(provenance_json,'{detail}',(provenance_json->'detail')-$5::text[]) ELSE provenance_json END,
              lineage_json=coalesce($6::jsonb,lineage_json)
        WHERE organisation_id=$1 AND scope_row_id=$2`,
      [organisationId, row.scope_row_id, to, reportTo, KEYS, lineage ? JSON.stringify(lineage) : null]);
    counts.commutingRows += 1;
  }
}

async function clearTravel(db: Queryable, organisationId: string, travelBefore: string, counts: MinimisationCounts): Promise<void> {
  counts.travelSources = (await db.query(
    `UPDATE nzi_console.job_emission_sources SET asset_identifier=NULL
      WHERE organisation_id=$1 AND source_type='travel' AND created_at<$2::timestamptz AND nullif(btrim(asset_identifier),'') IS NOT NULL RETURNING 1`,
    [organisationId, travelBefore])).rows.length;
  counts.travelRows = (await db.query(
    `UPDATE nzi_console.job_scope_rows x SET asset_identifier=NULL
      WHERE x.organisation_id=$1 AND x.origin='live' AND x.created_at<$2::timestamptz AND nullif(btrim(x.asset_identifier),'') IS NOT NULL
        AND (${isTravel} OR x.source_id IN (SELECT s.source_id FROM nzi_console.job_emission_sources s WHERE s.organisation_id=$1 AND s.source_type='travel'))
      RETURNING 1`,
    [organisationId, travelBefore])).rows.length;
}

/** What is still held after a run: live data that must be 0 (the post-condition), and migrated history that is left by design. */
async function stillHeld(db: Queryable, organisationId: string, travelBefore: string): Promise<{ remaining: number; migratedLeft: number }> {
  const { rows } = await db.query<{ remaining: string; migrated: string }>(
    `SELECT ((SELECT count(*) FROM nzi_console.job_emission_sources x WHERE x.organisation_id=$1 AND x.source_type='commuting'
               AND (nullif(btrim(x.asset_identifier),'') IS NOT NULL OR x.detail_json ?| $3::text[] OR x.source_name !~ '^Commuter [0-9]+( · .*)?$'))
           + (SELECT count(*) FROM nzi_console.job_scope_rows x WHERE x.organisation_id=$1 AND x.origin='live' AND ${isCommuting}
               AND (nullif(btrim(x.asset_identifier),'') IS NOT NULL OR coalesce(x.provenance_json->'detail' ?| $3::text[],false)))
           + (SELECT count(*) FROM nzi_console.job_emission_sources x WHERE x.organisation_id=$1 AND x.source_type='travel' AND x.created_at<$2::timestamptz
               AND nullif(btrim(x.asset_identifier),'') IS NOT NULL)
           + (SELECT count(*) FROM nzi_console.job_scope_rows x WHERE x.organisation_id=$1 AND x.origin='live' AND x.created_at<$2::timestamptz AND ${isTravel}
               AND nullif(btrim(x.asset_identifier),'') IS NOT NULL))::text AS remaining,
            (SELECT count(*) FROM nzi_console.job_scope_rows x WHERE x.organisation_id=$1 AND x.origin='migrated' AND (${isCommuting} OR ${isTravel})
               AND nullif(btrim(x.asset_identifier),'') IS NOT NULL)::text AS migrated`,
    [organisationId, travelBefore, KEYS]);
  return { remaining: Number(rows[0]!.remaining), migratedLeft: Number(rows[0]!.migrated) };
}

class DryRun extends Error { constructor(readonly counts: MinimisationCounts) { super("dry run"); } }

export async function clearCommutingTravelIdentifiers(pool: PoolLike, organisationId: string,
  options: { commit: boolean; travelBefore?: string; actorId?: string }): Promise<MinimisationCounts> {
  const travelBefore = options.travelBefore ?? D5_TRAVEL_CUTOFF;
  if (Number.isNaN(Date.parse(travelBefore))) throw new Error("travelBefore must be a timestamp.");
  const run = async (db: Queryable) => {
    const counts: MinimisationCounts = { commutingSources: 0, commutingRows: 0, relabelled: 0, travelSources: 0, travelRows: 0, migratedLeft: 0, remaining: 0 };
    await clearCommuting(db, organisationId, counts);
    await clearTravel(db, organisationId, travelBefore, counts);
    Object.assign(counts, await stillHeld(db, organisationId, travelBefore));
    const changed = counts.commutingSources + counts.commutingRows + counts.relabelled + counts.travelSources + counts.travelRows;
    if (options.commit && changed > 0) await db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,reason,after_json)
       VALUES ($1,$2,$3,'system','data_entry.identifiers_minimised','organisation',$1,$4,$5,$6::jsonb)`,
      [organisationId, randomUUID(), options.actorId ?? "system:d6-minimise", randomUUID(),
        "D6 (R1, R2a, R3): commuting and pre-D5 travel identifiers cleared — minimised, not sealed",
        JSON.stringify({ ...counts, travelBefore })]);
    if (!options.commit) throw new DryRun(counts);
    return counts;
  };
  try {
    return await withTenantWrite(pool, organisationId, run);
  } catch (error) {
    if (error instanceof DryRun) return error.counts;
    throw error;
  }
}
