import { BUSINESS_TRAVEL_CODE, isCurrencyUnit, spendCarryKey, TRAVEL_MODE_GROUP_LABEL, travelModeGroupOf, type ReportingChainSource } from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { resolveCrpReportingChain } from "./readModels";
import { VEHICLE_CATEGORY_CODE, vehicleIdentityKey, vehicleRegistrationReader } from "./vehicleRegistrations";

/**
 * Data entry D3 (R5): a category's lines across the reporting grain — the QA drawer's read. **Baseline + current + up to four prior
 * years** (baseline-only in a baseline year): the years of the job's reporting chain (`resolveCrpReportingChain`, the QA trend's,
 * whose prior count is `REPORTING_PRIOR_YEARS`), each read from that year's job.
 *
 * A line is matched across years by the identity a carried-forward line keeps (R4): its GL code — the row's own, or its spend
 * source's — else its normalised description; a line with neither is matched by its label. General: any category reads the same
 * way, PG&S by GL code being the case it was built for.
 *
 * A prior year's figures are its job's enabled rows as they stand — the year's reviewed snapshot names the job, and its totals are
 * frozen, but not line by line by GL code. A year with no job behind it (a baseline with no reviewed snapshot) has no figures: null,
 * never zero.
 *
 * D5 (R7): Business Travel reads by **mode** — air, rail, road, sea, hotel — beside the prior years, not trip by trip: trips don't
 * recur. A row's mode is its trip's (a synced source's detail), else its factor's (a mode's roll-up row, a drawer entry); a spend row
 * with no mode is its own line.
 */
export type CategoryLineYearValue = { quantity: number | null; unit: string | null; tco2e: number | null };
export type CategoryLineYears = {
  categoryCode: string;
  years: Array<{ year: number; kind: "baseline" | "prior" | "current"; source: ReportingChainSource; jobId: string | null; jobNumber: string | null }>;
  lines: Array<{ key: string; label: string; glCode: string | null; values: Array<CategoryLineYearValue | null> }>;
};

type LineRow = { job_id: string; label: string; gl_code: string | null; quantity: string | null; unit: string | null; tco2e: string | null;
  /** D5 (R7): what says a travel row's mode — its trip's, else its factor's label. */
  factor_label?: string | null; travel_mode?: string | null;
  /** D4 (R6/R7): a company vehicle's identity parts — the sealed plate's digest and ciphertext, or an opted-out client's name. */
  asset_identifier?: string | null; asset_identifier_bidx?: string | null; asset_identifier_sealed?: unknown; client_id?: string };

export async function readCategoryLineYears(db: Queryable, jobId: string, categoryCode: string): Promise<CategoryLineYears | null> {
  const chain = await resolveCrpReportingChain(db, jobId);
  if (!chain) return null;
  const snapshotIds = chain.entries.map((entry) => entry.snapshotId).filter((id): id is string => id !== null);
  const jobsBySnapshot = new Map((await db.query<{ snapshot_id: string; job_id: string }>(
    `SELECT snapshot_id,job_id FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id = ANY($1::text[])`, [snapshotIds])).rows.map((row) => [row.snapshot_id, row.job_id]));
  const yearJobs = chain.entries.map((entry) => entry.kind === "current" ? jobId : entry.snapshotId ? jobsBySnapshot.get(entry.snapshotId) ?? null : null);
  const jobIds = [...new Set(yearJobs.filter((id): id is string => id !== null))];
  const numbers = new Map((await db.query<{ job_id: string; job_number: string }>(
    `SELECT job_id,job_number FROM nzi_console.jobs WHERE job_id = ANY($1::text[])`, [jobIds])).rows.map((row) => [row.job_id, row.job_number]));

  // D4 (R7): Scope 1 (the QA trend's grain — it groups Scope 1 by the scope) holds its company vehicles, and they are read as the
  // Company Vehicles category is: vehicle by vehicle (below), not as Scope 1's other lines.
  const withVehicles = categoryCode === VEHICLE_CATEGORY_CODE || categoryCode === "1";
  // A row is in the category by its code; a Scope 3 row stored before codes carried one, by its scope (`3.1`). Scope 1 is every
  // Scope 1 row, whatever its code — the vehicles apart.
  const { rows } = categoryCode === VEHICLE_CATEGORY_CODE ? { rows: [] as LineRow[] } : await db.query<LineRow>(
    `SELECT r.job_id,coalesce(nullif(btrim(r.report_label),''),r.source_label) AS label,coalesce(nullif(btrim(r.column_text),''),s.source_subtype) AS gl_code,
            r.quantity::text,r.unit,coalesce(r.override_tco2e,r.calculated_tco2e)::text AS tco2e,r.factor_label,s.detail_json->>'travelMode' AS travel_mode
       FROM nzi_console.job_scope_rows r
       LEFT JOIN nzi_console.job_emission_sources s ON (s.organisation_id,s.source_id)=(r.organisation_id,r.source_id)
      WHERE r.job_id = ANY($1::text[]) AND r.enabled AND (r.category_code=$2 OR (r.category_code IS NULL AND r.scope=$2)
            OR ($2='1' AND r.scope='1' AND r.category_code IS DISTINCT FROM $3))
        -- A vehicle fleet's roll-up row is its members' total; its members are the vehicle lines.
        AND NOT ($2='1' AND r.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM nzi_console.job_emission_sources g
              WHERE (g.organisation_id,g.group_id)=(r.organisation_id,r.group_id) AND g.source_type='vehicle'))
      ORDER BY r.job_id,lower(r.source_label),r.scope_row_id`,
    [jobIds, categoryCode, VEHICLE_CATEGORY_CODE]);

  const lines = new Map<string, { label: string; glCode: string | null; byJob: Map<string, LineRow[]> }>();
  const travel = categoryCode === BUSINESS_TRAVEL_CODE;
  for (const row of rows) {
    const mode = travel ? travelModeGroupOf({ travelMode: row.travel_mode, factorLabel: row.factor_label }) : null;
    const byMode = mode ? { key: `mode:${mode}`, label: TRAVEL_MODE_GROUP_LABEL[mode] } : travel && isCurrencyUnit(row.unit) ? { key: "mode:spend", label: "Spend (no mode)" } : null;
    const key = byMode?.key ?? spendCarryKey({ glCode: row.gl_code, description: row.label }) ?? `label:${row.label.trim().toLowerCase()}`;
    const line = lines.get(key) ?? { label: byMode?.label ?? row.label, glCode: byMode ? null : row.gl_code, byJob: new Map<string, LineRow[]>() };
    // The current year names the line where it has it; otherwise the most recent year that does. A mode names its own.
    if (row.job_id === jobId && !byMode) line.label = row.label;
    line.byJob.set(row.job_id, [...(line.byJob.get(row.job_id) ?? []), row]);
    lines.set(key, line);
  }
  if (withVehicles) for (const [key, line] of await vehicleLines(db, jobId, jobIds)) lines.set(key, { ...line, glCode: null });
  const currentAt = chain.entries.findIndex((entry) => entry.kind === "current");
  const result = [...lines].map(([key, line]) => ({ key, label: line.label, glCode: line.glCode, values: yearJobs.map((id) => id ? sumOf(line.byJob.get(id)) : null) }));
  result.sort((a, b) => (b.values[currentAt]?.tco2e ?? -1) - (a.values[currentAt]?.tco2e ?? -1) || a.label.localeCompare(b.label));
  return {
    categoryCode,
    years: chain.entries.map((entry, index) => ({ year: entry.year, kind: entry.kind, source: entry.source, jobId: yearJobs[index] ?? null, jobNumber: yearJobs[index] ? numbers.get(yearJobs[index]!) ?? null : null })),
    lines: result,
  };
}

const sumOf = (members: LineRow[] | undefined): CategoryLineYearValue | null => {
  if (!members?.length) return null;
  const units = new Set(members.map((member) => member.unit));
  const quantities = members.map((member) => member.quantity === null ? null : Number(member.quantity));
  const tonnes = members.map((member) => member.tco2e === null ? null : Number(member.tco2e));
  return {
    // Summed only in one unit: lines in different units are not one figure.
    quantity: units.size === 1 && quantities.every((value) => value !== null) ? quantities.reduce((sum, value) => sum! + value!, 0)! : null,
    unit: units.size === 1 ? [...units][0]! : null,
    tco2e: tonnes.some((value) => value !== null) ? tonnes.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null,
  };
};

/**
 * D4 (R6/R7): each company vehicle across the years — an omission or a swing in its mileage stands out. Matched across the years by
 * its identity (`vehicleIdentityKey`: the plate's digest, else an opted-out client's name) and named by its registration, opened for
 * staff from its seal, else its name, else its label. Rows that stand alone, and the members of a roll-up group — whose row is the
 * fleet's total, so not a vehicle.
 */
async function vehicleLines(db: Queryable, jobId: string, jobIds: string[]): Promise<Map<string, { label: string; byJob: Map<string, LineRow[]> }>> {
  const { rows } = await db.query<LineRow & { organisation_id: string }>(
    `SELECT r.organisation_id,r.job_id,j.client_id,coalesce(nullif(btrim(r.report_label),''),r.source_label) AS label,NULL::text AS gl_code,r.quantity::text,r.unit,
            coalesce(r.override_tco2e,r.calculated_tco2e)::text AS tco2e,r.asset_identifier,r.asset_identifier_bidx,r.asset_identifier_sealed
       FROM nzi_console.job_scope_rows r JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(r.organisation_id,r.job_id)
      WHERE r.job_id = ANY($1::text[]) AND r.enabled AND r.category_code=$2 AND r.group_id IS NULL
     UNION ALL
     SELECT s.organisation_id,s.job_id,j.client_id,s.source_name,NULL,s.quantity::text,s.unit,s.calculated_tco2e::text,s.asset_identifier,s.asset_identifier_bidx,s.asset_identifier_sealed
       FROM nzi_console.job_emission_sources s JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(s.organisation_id,s.job_id)
      WHERE s.job_id = ANY($1::text[]) AND s.source_type='vehicle' AND s.group_id IS NOT NULL AND s.enabled AND s.voided_at IS NULL
      ORDER BY 2,4`,
    [jobIds, VEHICLE_CATEGORY_CODE]);
  const open = rows[0] ? vehicleRegistrationReader(db, rows[0].organisation_id) : null;
  const lines = new Map<string, { label: string; byJob: Map<string, LineRow[]>; named: boolean }>();
  for (const row of rows) {
    const key = vehicleIdentityKey({ asset_identifier_bidx: row.asset_identifier_bidx, asset_identifier: row.asset_identifier, source_label: row.label });
    const plate = open && row.asset_identifier_sealed && row.client_id ? await open(row.client_id, row.asset_identifier_sealed) : null;
    const name = plate ?? (row.asset_identifier?.trim() || null);
    const line = lines.get(key) ?? { label: name ?? row.label, byJob: new Map<string, LineRow[]>(), named: name !== null };
    if (name && (!line.named || row.job_id === jobId)) { line.label = name; line.named = true; }
    line.byJob.set(row.job_id, [...(line.byJob.get(row.job_id) ?? []), row]);
    lines.set(key, line);
  }
  return lines;
}
