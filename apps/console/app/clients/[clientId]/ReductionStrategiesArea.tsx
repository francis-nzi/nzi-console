"use client";

import { useState } from "react";
import { GatedButton, NziIcon, type NziIconKey } from "@nzi/ui";
import {
  strategyDeadline, strategyDeadlineSignals, strategyDeadlineSummary, strategyReminderWindowDays,
  strategyLibrary, strategyPlanByLever, strategyPlanSummary, strategyScopeLabel,
  strategyStatusLabels, strategiesWithoutLever,
  type ClientStrategy, type Lever, type StrategyDeadline, type StrategyStatus,
} from "@nzi/contracts";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { CardHead, Empty } from "./OverviewArea";
import { StrategyProjection } from "./StrategyProjection";
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
 * Qualitative progress, plus an optional quantified layer: a strategy may carry a
 * consultant ESTIMATE of what it will save, rolled up into the projected trajectory below
 * the summary. The estimate is a forward view and is never the measured footprint.
 */

const iconKey = (key: string): NziIconKey => key as NziIconKey;

export function ReductionStrategiesArea({ workspace, today, access, onDrawer }: {
  workspace: ClientWorkspaceReadModel;
  /** The London calendar date, resolved on the server so it survives hydration unchanged. */
  today: string;
  access: EditAccess;
  onDrawer: (request: StrategyDrawerRequest) => void;
}) {
  const { levers, library, plan } = workspace.strategies;
  const summary = strategyPlanSummary(plan);
  const groups = strategyPlanByLever(plan, levers);
  const unallocated = strategiesWithoutLever(plan, levers);
  const entries = strategyLibrary(library, plan);

  // Requirement codes, resolved once for the whole area: "S2 M2" is what a report prints
  // and what an assessor asks about; the generated id is neither.
  const codes = new Map((workspace.srs.framework?.requirements ?? []).map((requirement) => [requirement.id, requirement.code]));
  const excluded = plan.filter((strategy) => !strategy.includeInReport).length;

  // Derived at read time from the date the client set. Nothing is stored and no date is
  // invented: an undated strategy raises nothing at all.
  const signals = strategyDeadlineSignals(plan, today);
  const deadlines = strategyDeadlineSummary(signals);

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
      <CardHead eyebrow="Job" title="Reduction strategies" />
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

        {/* What needs attention, said once at the top rather than left to be found by
            scrolling every lever group. Undated strategies are absent by design. */}
        {deadlines.total > 0 ? <div className={deadlines.overdue > 0 ? "nz-banner warn" : "nz-banner"} style={{ marginTop: 10 }}>
          <b>{deadlineHeadline(deadlines)}</b>
          <ul className="nz-deadline-list">
            {signals.slice(0, 5).map((signal) => <li key={signal.strategy.id}>
              <DeadlineFlag deadline={signal.deadline} /> {signal.strategy.title}
              {signal.strategy.owner !== "" ? <span className="hint"> · {signal.strategy.owner}</span> : null}
            </li>)}
          </ul>
          {signals.length > 5 ? <span className="hint">and {signals.length - 5} more.</span> : null}
        </div> : null}

        {/* A plan whose report shows only some of it should say so here, where it is edited,
            not only in the document. */}
        {excluded > 0 ? <p className="hint" style={{ marginTop: 10 }}>
          {excluded} {excluded === 1 ? "strategy is" : "strategies are"} held back from the client — absent
          from their portal plan and from reports issued from now on. Reports already issued are
          unaffected: each keeps the plan it was issued with.
        </p> : null}
      </div>
    </section>

    {/* The quantified view, directly under the qualitative summary: what the plan is
        estimated to deliver, against the target and the measured footprint. */}
    {summary.total > 0 ? <StrategyProjection workspace={workspace} /> : null}

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
          codes={codes} today={today} access={access} onDrawer={onDrawer} />)}

        {/* A strategy whose only lever was withdrawn still belongs to the plan the client
            agreed. Shown in its own group rather than silently dropped from a grouped view. */}
        {unallocated.length > 0 ? <LeverGroup
          lever={{ id: "__unallocated", key: "unallocated", title: "Not yet allocated to a lever", iconKey: "target", ordering: 999, active: true }}
          strategies={unallocated}
          collapsed={collapsed.has("__unallocated")} onToggle={() => toggle("__unallocated")}
          codes={codes} today={today} access={access} onDrawer={onDrawer} /> : null}
      </>}

    <p className="nz-maps">
      Progress is what the client reports against each strategy — not a modelled reduction, and not the
      same thing as the estimate above it. The strategy library is Admin-managed and allocated to levers
      there; a client&rsquo;s copy references the library wording, so an Admin correction propagates.
      Quantified impact is a consultant <b>estimate</b> per strategy, rolled up into the projection at the
      top of this screen; it is never measured, and it never appears in a client-facing surface from here.
    </p>
  </>;
}

function LeverGroup({ lever, strategies, collapsed, onToggle, codes, today, access, onDrawer }: {
  lever: Lever; strategies: ClientStrategy[]; collapsed: boolean; onToggle: () => void;
  codes: ReadonlyMap<string, string>; today: string; access: EditAccess; onDrawer: (request: StrategyDrawerRequest) => void;
}) {
  const bodyId = `lever-body-${lever.id}`;
  return <section className={collapsed ? "nz-panel nz-lever collapsed" : "nz-panel nz-lever"}>
    {/* The whole header is the control, so the hit target is the row rather than a chevron. */}
    <button type="button" className="nz-lever-head" onClick={onToggle} aria-expanded={!collapsed} aria-controls={bodyId}>
      {/* The chevron is the only affordance, on the left, rotating ▸ closed / ▾ open — the same
          glyph as @nzi/ui's Collapsible (DESIGN_CONVENTIONS §3.4). Never a tick: a check means
          selected or complete, and an open group is neither. */}
      <svg className="nz-lever-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
      <span className="nz-lever-icon"><NziIcon name={iconKey(lever.iconKey)} size={17} /></span>
      <h2>{lever.title}</h2>
      {/* A collapsed group still says how much is inside it. */}
      <span className="cnt">· {strategies.length} {strategies.length === 1 ? "strategy" : "strategies"}</span>
    </button>
    <div className="nz-lever-body" id={bodyId} hidden={collapsed}>
      {strategies.map((strategy) => <StrategyRow key={strategy.id} strategy={strategy} codes={codes} today={today} access={access} onDrawer={onDrawer} />)}
    </div>
  </section>;
}

function StrategyRow({ strategy, codes, today, access, onDrawer }: {
  strategy: ClientStrategy; codes: ReadonlyMap<string, string>; today: string; access: EditAccess; onDrawer: (request: StrategyDrawerRequest) => void;
}) {
  const parts = [strategy.category, strategy.owner, targetText(strategy)].filter((part) => part !== "");
  // Codes the framework still knows. A requirement retired from the framework leaves the
  // alignment on the record but has nothing to print, so it is dropped from the row rather
  // than shown as a bare id.
  const aligned = strategy.srsRequirementIds.map((id) => codes.get(id)).filter((code): code is string => code !== undefined);
  return <div className="nz-action-row">
    <span className="nz-action-icon"><NziIcon name={iconKey(strategy.iconKey)} size={18} /></span>
    <div className="nz-action-main">
      <div className="nm">{strategy.title}</div>
      <div className="sub">
        <span className="nz-tag">{strategyScopeLabel(strategy.scope)}</span>
        {parts.length > 0 ? ` ${parts.join(" · ")}` : null}
        {strategy.strategyId === null ? <span className="nz-tag" style={{ marginLeft: 6 }}>bespoke</span> : null}
      </div>
      <div className="sub">
        {aligned.map((code) => <span className="nz-tag srs" key={code}>{code}</span>)}
        {!strategy.includeInReport
          ? <span className="nz-tag" style={{ marginLeft: 6 }}>not shown to client</span> : null}
        <DeadlineFlag deadline={strategyDeadline(strategy, today)} />
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

/**
 * The deadline in words. Days, not a bare date — "overdue by 10 days" is the fact someone
 * acts on, and the date is already on the row beside it.
 */
function DeadlineFlag({ deadline }: { deadline: StrategyDeadline }) {
  if (deadline.state === "overdue") {
    return <span className="nz-deadline late">
      <NziIcon name="alert" size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />
      Overdue by {deadline.daysOverdue} {deadline.daysOverdue === 1 ? "day" : "days"}
    </span>;
  }
  if (deadline.state === "approaching") {
    return <span className="nz-deadline soon">
      {deadline.daysRemaining === 0 ? "Due today" : `Due in ${deadline.daysRemaining} ${deadline.daysRemaining === 1 ? "day" : "days"}`}
    </span>;
  }
  return null;
}

/** Counts, so the banner says what it is before the list does. */
function deadlineHeadline({ overdue, approaching }: { overdue: number; approaching: number }): string {
  const parts: string[] = [];
  if (overdue > 0) parts.push(`${overdue} ${overdue === 1 ? "strategy is" : "strategies are"} overdue`);
  if (approaching > 0) parts.push(`${approaching} due within ${strategyReminderWindowDays} days`);
  return `${parts.join(", and ")}.`;
}

function StatusPill({ status }: { status: StrategyStatus }) {
  const tone = status === "complete" ? "ok" : status === "in_progress" ? "prog" : "plan";
  return <span className={`nz-action-pill ${tone}`}><i />{strategyStatusLabels[status]}</span>;
}

function Stat({ value, label }: { value: number; label: string }) {
  return <div className="nz-action-stat"><b className="num">{value}</b><span>{label}</span></div>;
}
