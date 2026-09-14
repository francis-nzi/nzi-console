"use client";

import { useState } from "react";
import { GatedButton, NziIcon, type NziIconKey } from "@nzi/ui";
import {
  actionLibrary, actionPlanGroups, actionPlanSummary, actionScopeLabel, actionStatusLabels,
  type ActionStatus, type ClientAction,
} from "@nzi/contracts";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { CardHead, Empty } from "./OverviewArea";
import type { ActionDrawerRequest } from "./actionDrawers";

/**
 * The Actions area — the client's decarbonisation plan (`client_workspace_v12`).
 *
 * This is the PLAN half of a CRP, and it is kept deliberately distinct from the
 * measurement half. A scope row says what was emitted, with a factor and a provenance
 * trail behind it. An action says what the client intends to do about it. Reading them in
 * one place would let a plan borrow the authority of evidence.
 *
 * Grouped by level of control rather than by scope, because that is the axis a client
 * can act on: what they control, what they buy, and what they can only influence.
 *
 * Qualitative today (A2-lite). No action here carries a modelled tCO₂e, and the area says
 * so rather than leaving a reader to assume the percentages mean carbon.
 */

const iconKey = (key: string): NziIconKey => key as NziIconKey;

export function ActionsArea({ workspace, access, onDrawer }: {
  workspace: ClientWorkspaceReadModel;
  access: EditAccess;
  onDrawer: (request: ActionDrawerRequest) => void;
}) {
  const { catalogue, plan } = workspace.actions;
  const summary = actionPlanSummary(plan);
  const groups = actionPlanGroups(plan);
  const library = actionLibrary(catalogue, plan);

  return <>
    <section className="nz-panel">
      <CardHead eyebrow="Engagement" title="Decarbonisation actions" />
      <div className="nz-card-b">
        <div className="nz-actions-head">
          <p className="sub" style={{ margin: 0, flex: 1 }}>
            The client&rsquo;s reduction plan — levers assigned from the NZI catalogue, grouped by how much of
            the outcome they control.
          </p>
          <GatedButton className="nz-btn pri" blocked={access.state !== "allowed"}
            blockedReason={access.state === "allowed" ? undefined : access.reason}
            reasonClassName="hint nz-gated-reason"
            onClick={() => onDrawer({ kind: "action-library", library })}>
            <NziIcon name="plus" size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />Add from library
          </GatedButton>
        </div>

        {summary.total === 0
          ? null
          : <div className="nz-action-summary">
            <Stat value={summary.total} label={summary.total === 1 ? "Action" : "Actions"} />
            <Stat value={summary.inProgress} label="In progress" />
            <Stat value={summary.complete} label="Complete" />
            <Stat value={summary.planned} label="Planned" />
          </div>}
      </div>
    </section>

    {summary.total === 0
      ? <section className="nz-panel">
        <Empty text="This client has no reduction plan yet. Add levers from the NZI catalogue — or a bespoke action for something specific to them — and they will appear here grouped by how much of the outcome the client controls." />
      </section>
      : groups.map((group) => <section className="nz-panel" key={group.controlLevel}>
        <div className="nz-card-h">
          <span className="eyebrow">Level of control</span><h2>{group.label}</h2>
          <span className="sp" /><span className="hint">{group.scopeHint}</span>
        </div>
        <div className="nz-card-b">
          {group.actions.map((action) => <ActionRow key={action.id} action={action} access={access} onDrawer={onDrawer} />)}
        </div>
      </section>)}

    <p className="nz-maps">
      Qualitative tracker (A2-lite): progress is what the client reports, not a modelled reduction. The lever
      catalogue is Admin-managed and assigned here. Quantified impact — each lever&rsquo;s modelled tCO₂e and its
      contribution to the pathway — is Stage 2, and nothing on this screen estimates it.
    </p>
  </>;
}

function ActionRow({ action, access, onDrawer }: {
  action: ClientAction; access: EditAccess; onDrawer: (request: ActionDrawerRequest) => void;
}) {
  const parts = [action.category, action.owner, targetText(action)].filter((part) => part !== "");
  return <div className="nz-action-row">
    <span className="nz-action-icon"><NziIcon name={iconKey(action.iconKey)} size={18} /></span>
    <div className="nz-action-main">
      <div className="nm">{action.title}</div>
      <div className="sub">
        <span className="nz-tag">{actionScopeLabel(action.scope)}</span>
        {parts.length > 0 ? ` ${parts.join(" · ")}` : null}
        {action.leverId === null ? <span className="nz-tag" style={{ marginLeft: 6 }}>bespoke</span> : null}
      </div>
    </div>
    <div className="nz-action-state">
      <StatusPill status={action.status} />
      <div className="nz-action-progress" role="progressbar" aria-label={`${action.title} progress`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={action.progressPct}>
        <span style={{ width: `${action.progressPct}%` }} />
      </div>
    </div>
    <GatedButton className="nz-editlink" blocked={access.state !== "allowed"}
      blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
      onClick={() => onDrawer({ kind: "action-edit", action })}>Edit</GatedButton>
  </div>;
}

/**
 * What the date means depends on the status, so it is worded rather than dumped: a target
 * on a finished action is not a target, it is when it happened.
 */
function targetText(action: ClientAction): string {
  if (action.targetDate === null) return "";
  return action.status === "complete" ? `complete ${formatDate(action.targetDate)}` : `due ${formatDate(action.targetDate)}`;
}

function StatusPill({ status }: { status: ActionStatus }) {
  const tone = status === "complete" ? "ok" : status === "in_progress" ? "prog" : "plan";
  return <span className={`nz-action-pill ${tone}`}><i />{actionStatusLabels[status]}</span>;
}

function Stat({ value, label }: { value: number; label: string }) {
  return <div className="nz-action-stat"><b className="num">{value}</b><span>{label}</span></div>;
}
