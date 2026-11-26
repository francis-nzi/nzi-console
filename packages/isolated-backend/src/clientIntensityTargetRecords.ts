// Phase 1b (0158) — reading a client's intensity targets. Kept apart from the commands so the read models can use it
// without importing the command runner.
import { isSamePeriod, type ClientIntensityTarget } from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { dateOnly } from "./dates";

export type IntensityTargetRow = {
  version: number; baseline_year: number;
  /** 0238: null = the baseline intensity is pending. */
  baseline_intensity: string | null; interim_year: number | null; interim_reduction_pct: string | null;
  target_year: number | null; target_reduction_pct: string | null; active: boolean;
};

export const intensityTargetFromRow = (row: IntensityTargetRow) => ({
  baselineYear: row.baseline_year, baselineIntensity: row.baseline_intensity === null ? null : Number(row.baseline_intensity), interimYear: row.interim_year,
  interimReductionPct: row.interim_reduction_pct === null ? null : Number(row.interim_reduction_pct), targetYear: row.target_year,
  targetReductionPct: row.target_reduction_pct === null ? null : Number(row.target_reduction_pct), active: row.active,
});

/** A SQL `date` as its calendar day — never through an instant (NZC-096). */
const day = (value: Date | string | null | undefined) => value == null ? null : dateOnly(value);

/**
 * 0238 — a pending baseline intensity, worked out once it can be: the client baseline's total × the metric's divider ÷ the
 * value recorded for the metric on the job whose period is the baseline period (`intensity = emissions × divider ÷ value`).
 * Null (still pending) without the figures, without that value, or with a value of 0 — never a guessed denominator.
 */
async function derivedBaselineIntensities(db: Queryable, clientId: string, metricKeys: readonly string[]): Promise<Map<string, number>> {
  const derived = new Map<string, number>();
  if (metricKeys.length === 0) return derived;
  const client = (await db.query<{ start: Date | string | null; end: Date | string | null; total: string | null }>(
    `SELECT baseline_period_start AS start, baseline_period_end AS "end",
            coalesce(baseline_total_tco2e, CASE WHEN coalesce(baseline_scope1_tco2e, baseline_scope2_tco2e, baseline_scope3_tco2e) IS NULL THEN NULL
              ELSE coalesce(baseline_scope1_tco2e,0) + coalesce(baseline_scope2_tco2e,0) + coalesce(baseline_scope3_tco2e,0) END)::text AS total
       FROM nzi_console.clients WHERE organisation_id = current_setting('app.organisation_id', true) AND client_id = $1`, [clientId])).rows[0];
  const start = client ? day(client.start) : null, end = client ? day(client.end) : null;
  if (!client || client.total === null || !start || !end) return derived;
  const { rows } = await db.query<{ metric_key: string; value: string | null; divider: number; period_from: Date | string | null; period_to: Date | string | null }>(
    `SELECT v.metric_key, v.value::text AS value, m.divider,
            coalesce(j.reporting_period_start, c.reporting_from) AS period_from, coalesce(j.reporting_period_end, c.reporting_to) AS period_to
       FROM nzi_console.job_intensity_values v
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (v.organisation_id, v.job_id)
       LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
       JOIN LATERAL (SELECT divider FROM nzi_console.client_intensity_metrics cm WHERE cm.client_id = j.client_id AND cm.metric_key = v.metric_key ORDER BY cm.version DESC LIMIT 1) m ON true
      WHERE j.client_id = $1 AND v.period_key = 'year' AND v.metric_key = ANY($2::text[]) AND j.status <> 'cancelled'`, [clientId, [...metricKeys]]);
  for (const row of rows) {
    const from = day(row.period_from), to = day(row.period_to);
    if (!from || !to || !isSamePeriod(from, to, start, end) || row.value === null || Number(row.value) <= 0) continue;
    if (!derived.has(row.metric_key)) derived.set(row.metric_key, (Number(client.total) * (row.divider || 1)) / Number(row.value));
  }
  return derived;
}

/**
 * The client's intensity targets in force: the latest version per metric, when active, on a metric that is itself
 * active — with the metric's current label and unit. A withdrawn target, or one on a deactivated metric, is not shown.
 */
export async function listClientIntensityTargets(db: Queryable, clientId: string): Promise<ClientIntensityTarget[]> {
  const { rows } = await db.query<IntensityTargetRow & { metric_key: string; label: string; unit_wording: string; set_by: string; set_at: Date | string }>(
    `WITH t AS (SELECT DISTINCT ON (metric_key) * FROM nzi_console.client_intensity_targets WHERE client_id = $1 ORDER BY metric_key, version DESC),
          m AS (SELECT DISTINCT ON (metric_key) metric_key, label, unit_wording, active, ordering FROM nzi_console.client_intensity_metrics WHERE client_id = $1 ORDER BY metric_key, version DESC)
     SELECT t.metric_key, t.version, t.baseline_year, t.baseline_intensity::text, t.interim_year, t.interim_reduction_pct::text, t.target_year,
            t.target_reduction_pct::text, t.active, t.set_by, t.set_at, m.label, m.unit_wording
       FROM t JOIN m USING (metric_key) WHERE t.active AND m.active ORDER BY m.ordering, m.label`, [clientId]);
  const derived = await derivedBaselineIntensities(db, clientId, rows.filter((row) => row.baseline_intensity === null).map((row) => row.metric_key));
  return rows.map((row) => {
    const { active: _active, ...target } = intensityTargetFromRow(row);
    const worked = target.baselineIntensity === null ? derived.get(row.metric_key) ?? null : null;
    return {
      metricKey: row.metric_key, metricLabel: row.label, unitWording: row.unit_wording, version: row.version, ...target,
      baselineIntensity: target.baselineIntensity ?? worked,
      baselineIntensitySource: target.baselineIntensity !== null ? "stated" as const : worked !== null ? "derived" as const : "pending" as const,
      setBy: row.set_by, setAt: row.set_at instanceof Date ? row.set_at.toISOString() : String(row.set_at),
    };
  });
}
