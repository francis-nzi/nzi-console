"use client";

import { useState } from "react";
import { GatedButton, NziIcon, type NziIconKey } from "@nzi/ui";
import {
  strategyLibrary, strategyPlanByLever, strategyPlanSummary, strategyScopeLabel,
  strategyStatusLabels, strategiesWithoutLever,
  type ClientStrategy, type Lever, type StrategyStatus,
} from "@nzi/contracts";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { CardHead, Empty } from "./OverviewArea";
import type { StrategyDrawerRequest } from "./strategyDrawers";

/**
 * Reduction Strategies — the client's reduction plan (`reduction_strategies_v1`).
 *
 * The PLAN half of a CRP, kept deliberately apart from the measurement half. A scope row
 * says what was emitted, with a factor and a provenance trail behind it; a strategy says
 * what the client intends to do about it. Reading them in one place would let a plan borrow
 * the authority of evidence.
 *
 * Grouped by **lever** — the theme a strategy belongs to. Levers are many-to-many, so a
 * strategy that is both energy and buildings appears under both: that is what the
 * categorisation means, and hiding it from one of its themes would make the grouping lie.
 * Control level is a separate single-value axis and rides along as a chip, because "how
 * much of this do they control" is a different question from "what kind of thing is it".
 *
 * "Reduction Strategies", never bare "Strategies": `Strategy` is already an SRS pillar.
 *
 * Qualitative today (A2-lite). No strategy here carries a modelled tCO₂e.
 */

const iconKey = (key: string): NziIconKey => key as NziIconKey;

export function ReductionStrategiesArea({ workspace, access, onDrawer }: {
  workspace: ClientWorkspaceReadModel;
  access: EditAccess;
  onDrawer: (request: StrategyDrawerRequest) => void;
}) {
  const { levers, library, plan } = workspace.strategies;
  const summary = strategyPlanSummary(plan);
  const groups = strategyPlanByLever(plan, levers);
  const unallocated = strategiesWithoutLever(plan, levers);
  const entries = strategyLibrary(library, plan);

  // Collapsed groups, by lever id. Per-viewer convenience only (DESIGN_CONVENTIONS §3.2) —
  // never load-bearing, so a collapsed group is still fully rendered in the report and in
  // the DOM for search; only its own body is hidden.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groupKeys = [...groups.map((group) => group.lever.id), ...(unallocated.length ? ["__unallocated"] : [])];
  const toggle = (key: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return <>
    <section className="nz-panel">
      <CardHead eyebrow="Engagement" title="Reduction strategies" />
      <div className="nz-card-b">
        <div className="nz-actions-head">
          <p className="sub" style={{ margin: 0, flex: 1 }}>
            The client&rsquo;s reduction plan — strategies taken from the NZI library and grouped by the lever
            they sit under.
          </p>
          <GatedButton className="nz-btn pri" blocked={access.state !== "allowed"}
            blockedReason={access.state === "allowed" ? undefined : access.reason}
            reasonClassName="hint nz-gated-reason"
            onClick={() => onDrawer({ kind: "strategy-library", library: entries })}>
            <NziIcon name="plus" size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />Add from library
          </GatedButton>
        </div>

        {summary.total === 0 ? null : <div className="nz-action-summary">
          <Stat value={summary.total} label={summary.total === 1 ? "Strategy" : "Strategies"} />
          <Stat value={summary.inProgress} label="In progress" />
          <Stat value={summary.complete} label="Complete" />
          <Stat value={summary.planned} label="Planned" />
        </div>}
      </div>
    </section>

    {summary.total === 0
      ? <section className="nz-panel">
        <Empty text="This client has no reduction plan yet. Add strategies from the NZI library — or a bespoke one for something specific to them — and they will appear here grouped by lever." />
      </section>
      : <>
        <div className="nz-toolbar nz-strategy-toolbar">
          <span className="hint">{groupKeys.length} lever group{groupKeys.length === 1 ? "" : "s"}</span>
          <span className="sp" />
          <button type="button" className="nz-btn sm" onClick={() => setCollapsed(new Set())}>Open all</button>
          <button type="button" className="nz-btn sm" onClick={() => setCollapsed(new Set(groupKeys))}>Collapse all</button>
        </div>

        {groups.map((group) => <LeverGroup key={group.lever.id}
          lever={group.lever} strategies={group.strategies}
          collapsed={collapsed.has(group.lever.id)} onToggle={() => toggle(group.lever.id)}
          access={access} onDrawer={onDrawer} />)}

        {/* A strategy whose only lever was withdrawn still belongs to the plan the client
            agreed. Shown in its own group rather than silently dropped from a grouped view. */}
        {unallocated.length > 0 ? <LeverGroup
          lever={{ id: "__unallocated", key: "unallocated", title: "Not yet allocated to a lever", iconKey: "target", ordering: 999, active: true }}
          strategies={unallocated}
          collapsed={collapsed.has("__unallocated")} onToggle={() => toggle("__unallocated")}
          access={access} onDrawer={onDrawer} /> : null}
      </>}

    <p className="nz-maps">
      Qualitative tracker (A2-lite): progress is what the client reports, not a modelled reduction. The
      strategy library is Admin-managed and allocated to levers there; a client&rsquo;s copy references the
      library wording, so an Admin correction propagates. Quantified impact per strategy is Stage 2, and
      nothing on this screen estimates it.
    </p>
  </>;
}

function LeverGroup({ lever, strategies, collapsed, onToggle, access, onDrawer }: {
  lever: Lever; strategies: ClientStrategy[]; collapsed: boolean; onToggle: () => void;
  access: EditAccess; onDrawer: (request: StrategyDrawerRequest) => void;
}) {
  const bodyId = `lever-body-${lever.id}`;
  return <section className={collapsed ? "nz-panel nz-lever collapsed" : "nz-panel nz-lever"}>
    {/* The whole header is the control, so the hit target is the row rather than a chevron. */}
    <button type="button" className="nz-lever-head" onClick={onToggle} aria-expanded={!collapsed} aria-controls={bodyId}>
      <span className="nz-lever-icon"><NziIcon name={iconKey(lever.iconKey)} size={17} /></span>
      <h2>{lever.title}</h2>
      {/* A collapsed group still says how much is inside it. */}
      <span className="cnt">· {strategies.length} {strategies.length === 1 ? "strategy" : "strategies"}</span>
      <span className="sp" />
      <span className="nz-lever-chev" aria-hidden="true"><NziIcon name="check" size={14} /></span>
    </button>
    <div className="nz-lever-body" id={bodyId} hidden={collapsed}>
      {strategies.map((strategy) => <StrategyRow key={strategy.id} strategy={strategy} access={access} onDrawer={onDrawer} />)}
    </div>
  </section>;
}

function StrategyRow({ strategy, access, onDrawer }: {
  strategy: ClientStrategy; access: EditAccess; onDrawer: (request: StrategyDrawerRequest) => void;
}) {
  const parts = [strategy.category, strategy.owner, targetText(strategy)].filter((part) => part !== "");
  return <div className="nz-action-row">
    <span className="nz-action-icon"><NziIcon name={iconKey(strategy.iconKey)} size={18} /></span>
    <div className="nz-action-main">
      <div className="nm">{strategy.title}</div>
      <div className="sub">
        <span className="nz-tag">{strategyScopeLabel(strategy.scope)}</span>
        {parts.length > 0 ? ` ${parts.join(" · ")}` : null}
        {strategy.strategyId === null ? <span className="nz-tag" style={{ marginLeft: 6 }}>bespoke</span> : null}
      </div>
    </div>
    <div className="nz-action-state">
      <StatusPill status={strategy.status} />
      <div className="nz-action-progress" role="progressbar" aria-label={`${strategy.title} progress`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={strategy.progressPct}>
        <span style={{ width: `${strategy.progressPct}%` }} />
      </div>
    </div>
    <GatedButton className="nz-editlink" blocked={access.state !== "allowed"}
      blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
      onClick={() => onDrawer({ kind: "strategy-edit", strategy })}>Edit</GatedButton>
  </div>;
}

/**
 * What the date means depends on the status, so it is worded rather than dumped: a target on
 * a finished strategy is not a target, it is when it happened.
 */
function targetText(strategy: ClientStrategy): string {
  if (strategy.targetDate === null) return "";
  return strategy.status === "complete" ? `complete ${formatDate(strategy.targetDate)}` : `due ${formatDate(strategy.targetDate)}`;
}

function StatusPill({ status }: { status: StrategyStatus }) {
  const tone = status === "complete" ? "ok" : status === "in_progress" ? "prog" : "plan";
  return <span className={`nz-action-pill ${tone}`}><i />{strategyStatusLabels[status]}</span>;
}

function Stat({ value, label }: { value: number; label: string }) {
  return <div className="nz-action-stat"><b className="num">{value}</b><span>{label}</span></div>;
}
