import { isReportGap, type ReportComposition } from "@nzi/contracts";

/**
 * composed@5's own figure helpers, shared — moved here verbatim from `ReportComposedV5.tsx` so the `composed@6` narrative's tokens
 * (B2-4, `composedNarrative.ts`) resolve each figure exactly as composed@5's template prints it. One source, so the two cannot
 * drift: "Reset" returns the wording and the numbers the report shows. Moving them changes no markup (the golden pins hold).
 */

// The mockup's formatters, exactly: one decimal with thousands separators; a share to one decimal, ".0" dropped.
export const f1 = (value: number) => value.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const pc = (value: number, total: number) => (total ? Math.round((value / total) * 1000) / 10 : 0);
export const dd = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** The reporting year as the mockup names it: "2025–2026" for a split year, "2025" for a calendar one. */
export function reportingYearLabel(composition: ReportComposition): string {
  const period = composition.reportingPeriod;
  if (!period) return String(composition.reportingYear);
  const [from, to] = [period.from.slice(0, 4), period.to.slice(0, 4)];
  return from === to ? from : `${from}–${to}`;
}

/** The year a target or baseline is named by, in the report's own convention (a split reporting year reads "2022–2023"). */
export function yearLabel(composition: ReportComposition, year: number): string {
  const period = composition.reportingPeriod;
  return period && period.from.slice(0, 4) !== period.to.slice(0, 4) ? `${year}–${year + 1}` : String(year);
}

/** The frozen targets' interim (near-term) and net-zero points, and the baseline they are measured from. */
export function targetPoints(composition: ReportComposition) {
  if (isReportGap(composition.targets)) return null;
  const { trajectory, benchmark } = composition.targets;
  return { interim: trajectory.find((point) => point.kind === "near-term") ?? null, netZero: trajectory.find((point) => point.kind === "net-zero") ?? null, benchmark };
}

export const siteCount = (composition: ReportComposition) =>
  isReportGap(composition.emissions) ? 0 : (composition.emissions.sites ?? []).filter((site) => site.siteId !== null).length;

/** The employees the report states: the frozen wording of the client's employees measure ("240 employees"), when it has one. */
export function employeesOf(composition: ReportComposition): string | null {
  if (isReportGap(composition.intensity)) return null;
  const text = composition.intensity.metrics.find((metric) => metric.key === "employees")?.denominatorText ?? null;
  return text ? text.split(" ")[0]! : null;
}
