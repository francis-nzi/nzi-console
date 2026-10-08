import type { ClientIntensityTarget } from "@nzi/contracts";

/** An intensity, as the job's Intensity drawer shows it: whole numbers from 100, two places below. */
export const intensityFigure = (value: number) => value >= 100 ? Math.round(value).toLocaleString("en-GB") : value.toLocaleString("en-GB", { maximumFractionDigits: 2 });

/** "2022 baseline 1.2 → −30% by 2027 → −60% by 2035": a client target's milestones, as stated (Phase 3c). */
export function targetText(target: Pick<ClientIntensityTarget, "baselineYear" | "baselineIntensity" | "interimYear" | "interimReductionPct" | "targetYear" | "targetReductionPct">): string {
  const parts = [`${target.baselineYear} baseline ${intensityFigure(target.baselineIntensity)}`];
  if (target.interimYear !== null && target.interimReductionPct !== null) parts.push(`−${target.interimReductionPct}% by ${target.interimYear}`);
  if (target.targetYear !== null && target.targetReductionPct !== null) parts.push(target.targetReductionPct >= 100 ? `net zero by ${target.targetYear}` : `−${target.targetReductionPct}% by ${target.targetYear}`);
  return parts.join(" → ");
}
