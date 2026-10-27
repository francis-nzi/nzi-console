import { spendCarryKey, type ReportingChainSource } from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { resolveCrpReportingChain } from "./readModels";

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
 */
export type CategoryLineYearValue = { quantity: number | null; unit: string | null; tco2e: number | null };
export type CategoryLineYears = {
  categoryCode: string;
  years: Array<{ year: number; kind: "baseline" | "prior" | "current"; source: ReportingChainSource; jobId: string | null; jobNumber: string | null }>;
  lines: Array<{ key: string; label: string; glCode: string | null; values: Array<CategoryLineYearValue | null> }>;
};

type LineRow = { job_id: string; label: string; gl_code: string | null; quantity: string | null; unit: string | null; tco2e: string | null };

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

  // A row is in the category by its code; a Scope 3 row stored before codes carried one, by its scope (`3.1`).
  const { rows } = await db.query<LineRow>(
    `SELECT r.job_id,coalesce(nullif(btrim(r.report_label),''),r.source_label) AS label,coalesce(nullif(btrim(r.column_text),''),s.source_subtype) AS gl_code,
            r.quantity::text,r.unit,coalesce(r.override_tco2e,r.calculated_tco2e)::text AS tco2e
       FROM nzi_console.job_scope_rows r
       LEFT JOIN nzi_console.job_emission_sources s ON (s.organisation_id,s.source_id)=(r.organisation_id,r.source_id)
      WHERE r.job_id = ANY($1::text[]) AND r.enabled AND (r.category_code=$2 OR (r.category_code IS NULL AND r.scope=$2))
      ORDER BY r.job_id,lower(r.source_label),r.scope_row_id`,
    [jobIds, categoryCode]);

  const lines = new Map<string, { label: string; glCode: string | null; byJob: Map<string, LineRow[]> }>();
  for (const row of rows) {
    const key = spendCarryKey({ glCode: row.gl_code, description: row.label }) ?? `label:${row.label.trim().toLowerCase()}`;
    const line = lines.get(key) ?? { label: row.label, glCode: row.gl_code, byJob: new Map<string, LineRow[]>() };
    // The current year names the line where it has it; otherwise the most recent year that does.
    if (row.job_id === jobId) line.label = row.label;
    line.byJob.set(row.job_id, [...(line.byJob.get(row.job_id) ?? []), row]);
    lines.set(key, line);
  }
  const valueOf = (members: LineRow[] | undefined): CategoryLineYearValue | null => {
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
  const currentAt = chain.entries.findIndex((entry) => entry.kind === "current");
  const result = [...lines].map(([key, line]) => ({ key, label: line.label, glCode: line.glCode, values: yearJobs.map((id) => id ? valueOf(line.byJob.get(id)) : null) }));
  result.sort((a, b) => (b.values[currentAt]?.tco2e ?? -1) - (a.values[currentAt]?.tco2e ?? -1) || a.label.localeCompare(b.label));
  return {
    categoryCode,
    years: chain.entries.map((entry, index) => ({ year: entry.year, kind: entry.kind, source: entry.source, jobId: yearJobs[index] ?? null, jobNumber: yearJobs[index] ? numbers.get(yearJobs[index]!) ?? null : null })),
    lines: result,
  };
}
