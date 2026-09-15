"use client";

import { useMemo } from "react";
import { ProjectedPathway } from "@nzi/charts";
import {
  projectedTrajectory, projectionGap, projectionOverClaims, projectionVsActual, splitProjectionInputs,
} from "@nzi/contracts";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { CardHead } from "./OverviewArea";

/**
 * The plan, quantified — and labelled as an estimate everywhere it appears.
 *
 * Three trajectories: what was **measured**, what the plan **projects**, and what the target
 * **needs**. The value is the distance between them, so the gap is stated as a sentence and
 * not left for the reader to measure off a chart.
 *
 * Derived entirely from what the workspace already loaded — the plan, the target model and
 * the assured actuals. It resolves nothing of its own, and it reads no snapshot: the
 * projected line is built from consultant estimates and must never be mistaken for the
 * assured footprint.
 */
export function StrategyProjection({ workspace }: { workspace: ClientWorkspaceReadModel }) {
  const { plan } = workspace.strategies;
  const { targets, actuals } = workspace;
  const benchmark = targets.benchmarkInForce;

  const model = useMemo(() => {
    const { contributions, excluded } = splitProjectionInputs(plan);
    const projected = projectedTrajectory(contributions, benchmark, targets.trajectory);
    return {
      contributions, excluded, projected,
      overClaims: projectionOverClaims(contributions, benchmark),
      gap: projectionGap(projected, targets.trajectory),
      vsActual: projectionVsActual(projected, actuals.map((entry) => ({ year: entry.year, tco2e: entry.tco2e }))),
      totalPerYear: contributions.reduce((sum, entry) => sum + entry.tco2ePerYear, 0),
    };
  }, [plan, benchmark, targets.trajectory, actuals]);

  // Without a target pathway there is nothing to project against, and a bare projected line
  // would imply a commitment the client has not made.
  if (benchmark === null || targets.trajectory.length === 0) {
    return <section className="nz-panel">
      <CardHead eyebrow="Projection" title="What the plan is expected to deliver" />
      <div className="nz-card-b">
        <p className="sub" style={{ margin: "8px 0" }}>
          A projection needs a baseline and a target to be read against. Set this client&rsquo;s targets and
          baseline first, and the plan&rsquo;s expected reductions will be shown against them here.
        </p>
      </div>
    </section>;
  }

  if (model.contributions.length === 0) {
    return <section className="nz-panel">
      <CardHead eyebrow="Projection" title="What the plan is expected to deliver" />
      <div className="nz-card-b">
        <p className="sub" style={{ margin: "8px 0" }}>
          No strategy on this plan carries a reduction estimate with a target date yet, so there is nothing
          to project. Add an estimate and a date to a strategy to build the projected trajectory.
        </p>
        <Flags excluded={model.excluded} />
      </div>
    </section>;
  }

  return <section className="nz-panel">
    <CardHead eyebrow="Projection" title="What the plan is expected to deliver"
      right={<span className="nz-st est">Estimate</span>} />
    <div className="nz-card-b">
      {/* Said before the chart, not after it: everything below is a forward estimate. */}
      <p className="nz-maps">
        These are <b>consultant estimates</b>, not measurements. The projected line is built from the
        reductions entered against each strategy and is not assured. It is shown against the measured
        footprint so the two can be compared — never combined.
      </p>

      {/* NZC-068 — a held benchmark means the target it is measured against no longer applies. */}
      {targets.benchmarkStale ? <div className="nz-banner warn" role="status">
        This client&rsquo;s baseline has been restated since these targets were set, so the targets are held
        rather than recalculated. The projection is drawn on the baseline in force, so read the gap below
        as indicative until the targets are restated.
      </div> : null}

      {model.overClaims.map((claim) => <div className="nz-banner warn" role="alert" key={claim.scope}>
        {claim.message}
      </div>)}

      <div className="nz-proj-chart">
        <ProjectedPathway showChrome={false} data={{
          spec: { id: `proj-${workspace.client.id}`, type: "projected_pathway", title: "Projected against target", family: "crp", specVersion: 1 },
          unit: "tCO₂e", state: "success",
          provenance: {
            jobId: workspace.client.id, dataHash: "", factorSets: [], generatedAt: targets.setAt ?? "",
            reviewedSnapshotId: "", resolverVersion: 1, tokensVersion: 1, rendererVersion: 1,
          },
          actual: actuals.map((entry) => ({ year: entry.year, value: entry.tco2e })),
          projected: model.projected.map((point) => ({ year: point.year, value: point.tco2e })),
          target: targets.trajectory.map((point) => ({ year: point.year, value: point.tco2e })),
        }} />
      </div>

      <div className="nz-proj-facts">
        <div><span className="l">Estimated annual reduction</span>
          <span className="v num">{round(model.totalPerYear)}<small> tCO₂e/yr</small></span>
          <span className="sub">from {model.contributions.length} dated {model.contributions.length === 1 ? "strategy" : "strategies"}</span></div>
        {model.gap ? <div><span className="l">Plan against target, {model.gap.year}</span>
          <span className="v num">{model.gap.state === "meets" ? "Meets" : `${round(model.gap.shortfallTco2e)} short`}</span>
          <span className="sub">plan {round(model.gap.projectedTco2e)} · target {round(model.gap.targetTco2e)} tCO₂e</span></div> : null}
        {model.vsActual ? <div><span className="l">Measured against plan, {model.vsActual.year}</span>
          <span className="v num">{model.vsActual.state === "tracking" ? "Tracking" : `${round(model.vsActual.differenceTco2e)} above`}</span>
          <span className="sub">{model.vsActual.state === "tracking"
            ? "the measured footprint is at or below what the plan projected"
            : "the projected reduction has not shown up in the measured footprint"}</span></div> : null}
      </div>

      <Flags excluded={model.excluded} />
    </div>
  </section>;
}

/**
 * Strategies that contribute nothing, and why.
 *
 * Each is a different fact and none of them is "this saves nothing" — which is what a zero
 * on the chart would have said.
 */
function Flags({ excluded }: { excluded: ReturnType<typeof splitProjectionInputs>["excluded"] }) {
  if (excluded.length === 0) return null;
  return <div className="nz-proj-flags">
    <span className="l">Not in the projection</span>
    <ul>{excluded.map((entry) => <li key={entry.strategyId}>
      <b>{entry.title}</b> — {entry.detail}
    </li>)}</ul>
  </div>;
}

const round = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 0 });
