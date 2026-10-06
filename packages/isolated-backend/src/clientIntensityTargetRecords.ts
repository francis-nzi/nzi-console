// Phase 1b (0158) — reading a client's intensity targets. Kept apart from the commands so the read models can use it
// without importing the command runner.
import type { ClientIntensityTarget } from "@nzi/contracts";
import type { Queryable } from "./postgres";

export type IntensityTargetRow = {
  version: number; baseline_year: number; baseline_intensity: string; interim_year: number | null; interim_reduction_pct: string | null;
  target_year: number | null; target_reduction_pct: string | null; active: boolean;
};

export const intensityTargetFromRow = (row: IntensityTargetRow) => ({
  baselineYear: row.baseline_year, baselineIntensity: Number(row.baseline_intensity), interimYear: row.interim_year,
  interimReductionPct: row.interim_reduction_pct === null ? null : Number(row.interim_reduction_pct), targetYear: row.target_year,
  targetReductionPct: row.target_reduction_pct === null ? null : Number(row.target_reduction_pct), active: row.active,
});

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
  return rows.map((row) => ({
    metricKey: row.metric_key, metricLabel: row.label, unitWording: row.unit_wording, version: row.version, ...(({ active: _active, ...rest }) => rest)(intensityTargetFromRow(row)),
    setBy: row.set_by, setAt: row.set_at instanceof Date ? row.set_at.toISOString() : String(row.set_at),
  }));
}
