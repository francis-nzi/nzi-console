"use client";

import type { ReactNode } from "react";
import { ReductionPathway, CRP_RESOLVER_VERSION, RENDERER_VERSION, TOKENS_VERSION } from "@nzi/charts";
import type { ClientTargetsReadModel, TargetActual } from "@nzi/isolated-backend";

/**
 * NZC-072 — the reduction pathway, drawn from the target model: actual is one point per
 * assured reporting year, the target line is the benchmark and each committed milestone
 * (`benchmark × (1 − pct)`). Nothing here is a fixed point, and the gap shown underneath
 * is the same measurement the gap engine makes.
 */
function CardHead({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return <div className="nz-card-h"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><span className="sp" />{right}</div>;
}

export function ClientPathway({ client, targets, actuals }: { client: { id: string; name: string }; targets: ClientTargetsReadModel; actuals: TargetActual[] }) {
  const benchmark = targets.benchmark;
  const ready = targets.model !== null && benchmark !== null && targets.trajectory.length > 1;
  const latest = targets.latestGap;
  const FY = (year: number) => `FY${String(year).slice(-2)}`;

  return <section className="nz-panel">
    <CardHead eyebrow="Commitment" title="Reduction pathway" right={benchmark ? <span className="sub">vs {FY(benchmark.year)} benchmark</span> : undefined} />
    {!ready
      ? <div className="nz-card-b"><p className="sub" style={{ margin: "8px 0" }}>{targets.benchmarkInForce
        ? "No targets set, so there is no pathway to draw. Set a near-term or net-zero commitment on Baseline & targets."
        : "No baseline in force, so there is nothing to measure a reduction against yet."}</p></div>
      : <>
        <ReductionPathway showChrome={false} data={{
          spec: { id: `client-pathway-${client.id}`, type: "reduction_pathway", title: `${client.name} reduction pathway`, subtitle: `vs ${FY(benchmark!.year)} benchmark`, family: "crp", specVersion: 1 },
          unit: "tCO₂e",
          state: actuals.length ? "success" : "empty",
          stateMessage: actuals.length ? undefined : "No assured reporting year yet — the target line stands alone until one is issued.",
          actual: actuals.map((actual) => ({ year: actual.year, value: actual.tco2e })),
          target: targets.trajectory.map((point) => ({ year: point.year, value: point.tco2e })),
          milestones: targets.trajectory.map((point) => ({
            year: point.year, value: point.tco2e,
            label: point.kind === "benchmark" ? `Benchmark ${FY(point.year)}` : point.kind === "near-term" ? `Near-term −${point.pct}%` : `Net zero −${point.pct}%`,
            kind: point.kind === "benchmark" ? "baseline" : point.kind === "near-term" ? "interim" : "netzero",
          })),
          provenance: {
            jobId: actuals[actuals.length - 1]?.jobNumber ?? "", dataHash: "", factorSets: [],
            generatedAt: targets.setAt ?? "", reviewedSnapshotId: actuals[actuals.length - 1]?.snapshotId ?? "",
            resolverVersion: CRP_RESOLVER_VERSION, tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION,
          },
        }} />
        <div className="nz-card-b">
          {latest && latest.targetTco2e !== null
            ? <div className="nz-cw-kv"><span className="k">{FY(latest.year)} against the line</span><span className={`v ${latest.status === "behind" ? "up" : "ok"}`}>
              {latest.status === "on-track" ? "On track" : latest.status === "behind" ? `${Math.abs(latest.gapPct ?? 0).toFixed(1)}% above target` : `${Math.abs(latest.gapPct ?? 0).toFixed(1)}% below target`}
            </span></div>
            : <p className="sub" style={{ margin: "8px 0" }}>No assured year falls on or after the benchmark year yet, so there is nothing to measure against the line.</p>}
          {targets.benchmarkStale ? <p className="nz-maps">These targets are held against the benchmark they were set with; the baseline in force has moved since.</p> : null}
        </div>
      </>}
    <p className="nz-maps">Actual is the assured total from each year&apos;s reviewed snapshot. The target line is the benchmark and each committed milestone — the same model the gap engine measures against, so the chart and the gap cannot disagree.</p>
  </section>;
}
