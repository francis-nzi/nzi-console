// RULING-report-denominator (NZC-120): no currency denominator crosses to the client. A currency intensity measure's
// denominator is the client's turnover — money — so the two client boundaries (a composition's chart basis, and the client's
// copy of a published report) carry the reporting year's intensity in its place. Every other measure keeps its denominator
// (floor area, employees). The staff-side snapshot keeps it too: staff need it, and it never leaves the firm.

/** What a reported intensity target looks like at either boundary — the fields this rule reads. */
type IntensityTargetShape = { metric?: unknown; reportingDenominator?: number | null };

/**
 * The currency measure, in a frozen target's shape: turnover. The target names its measure only by `metric` (from its key:
 * `turnover`, `employees` or `floor-area`), and turnover is the one currency measure a CRP reports (0143 made the standard
 * turnover `unit_kind = 'currency'`); a turnover is money whatever unit it is drawn in, so this errs on the side of not sending it.
 *
 * `metric === "turnover"` is **exact**, not a heuristic, because of two guards (RULING-report-denominator-unitkind):
 * `client.intensityMetric.set` and `organisation.intensityDefault.set` refuse a currency kind on `employees` and `floor-area`
 * (`monetaryKindIssue`), and only those three keys can be reported — so a reported currency measure is always turnover. Lift
 * either guard, or make another key reportable, and this rule must key on the measure's unit kind instead.
 */
export const isCurrencyIntensityTarget = (target: IntensityTargetShape): boolean => target.metric === "turnover";

/**
 * The reporting year's intensity exactly as the intensity pathway has always drawn it: the rows' tCO₂e summed in order, over
 * the reporting denominator — unrounded. The one division the composition's Intensity section (its reported currency measure),
 * its chart basis and the client's published-report copy share, so none of them can disagree at full precision. `null` when
 * there is no positive denominator to divide by.
 */
export function reportingIntensityOf(measurements: ReadonlyArray<{ tco2e: number }>, reportingDenominator: number | null | undefined): number | null {
  if (reportingDenominator === null || reportingDenominator === undefined || !(reportingDenominator > 0)) return null;
  return measurements.reduce((total, row) => total + row.tco2e, 0) / reportingDenominator;
}

/**
 * The one helper at both client boundaries. A currency measure's target loses `reportingDenominator` and gains
 * `reportingIntensity` (the year's intensity, from the same rows); any other measure's target is returned unchanged.
 * Idempotent: a target that no longer carries a denominator is returned as it is, its `reportingIntensity` kept.
 */
export function withoutCurrencyDenominator<T extends IntensityTargetShape>(target: T, measurements: ReadonlyArray<{ tco2e: number }>):
  T | (Omit<T, "reportingDenominator"> & { reportingIntensity: number | null }) {
  if (!isCurrencyIntensityTarget(target) || !("reportingDenominator" in target)) return target;
  const { reportingDenominator, ...figures } = target;
  return { ...figures, reportingIntensity: reportingIntensityOf(measurements, reportingDenominator) };
}
