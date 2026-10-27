"use client";

import { useState } from "react";
import { postBrowserCommand, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { GatedButton } from "@nzi/ui";
import {
  srsBridgeCandidates, strategyControlLevelLabels, strategyControlLevels, strategyScopeLabel, strategyScopes,
  type SrsAssessment, type StrategyControlLevel, type StrategyScope,
} from "@nzi/contracts";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * Bridge one readiness gap (SRS S3, R1/R2) — the library first, AI second, both grounded in the gap.
 *
 * 1. **From the Actions library**: the actions whose own SRS alignment names this requirement (a read of A1's alignment).
 * 2. **Ideas from AI**: asked for on demand, checked to carry no figure and no claim, and **shown to the client** in their
 *    portal, labelled as AI. An idea is never an action by itself: "Use this idea" fills the third section, where you
 *    settle its scope and control level; "Withdraw" takes it off what the client sees.
 * 3. **Your own action**.
 *
 * Whichever is chosen joins the plan as an `srs_gap` action naming this requirement, aligned to it — and, while the
 * assessment is in progress, linked from it.
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

export function SrsBridgeForm({ workspace, assessment, requirementId, access, onClose, onSaved }: {
  workspace: ClientWorkspaceReadModel; assessment: SrsAssessment; requirementId: string; access: EditAccess;
  onClose: () => void; onSaved: (text: string) => void;
}) {
  const framework = workspace.srs.frameworks.find((version) => version.frameworkId === assessment.frameworkId) ?? workspace.srs.framework;
  const requirement = framework?.requirements.find((entry) => entry.id === requirementId) ?? null;
  const maturity = assessment.items.find((item) => item.requirementId === requirementId)?.maturity ?? null;
  const stepName = (level: number) => framework?.maturityLevels.find((entry) => entry.level === level)?.label ?? `Step ${level}`;
  const candidates = srsBridgeCandidates(requirementId, workspace.strategies.library, workspace.strategies.plan);
  const ideas = workspace.srs.suggestions.filter((idea) => idea.assessmentId === assessment.assessmentId && idea.requirementId === requirementId);

  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<StrategyScope>("governance");
  const [controlLevel, setControlLevel] = useState<StrategyControlLevel>("direct_control");
  const [fromIdea, setFromIdea] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const base = `/api/isolated/srs-assessments/${encodeURIComponent(assessment.assessmentId)}/gaps/${encodeURIComponent(requirementId)}`;
  const blocked = access.state !== "allowed";

  async function bridge(body: Record<string, unknown>, label: string) {
    setPending(label); setError(null);
    const result = await postBrowserCommand<{ clientStrategyId: string; linked: boolean }>(`${base}/bridge`, { ...body, status: agreed ? "agreed" : "proposed" }, crypto.randomUUID());
    setPending(null);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved(`${label} is on the plan, bridging ${requirement?.code ?? "the gap"}${result.data.linked ? ", and linked from this assessment" : ""}.`);
  }

  async function suggest() {
    setPending("ideas"); setError(null); setNote(null);
    const result = await postBrowserCommand<{ suggestionIds: string[]; dropped: string[]; declinedByModel: boolean }>(`${base}/suggestions`, {}, crypto.randomUUID());
    setPending(null);
    if (result.state !== "success") { setError(errorText(result)); return; }
    const kept = result.data.suggestionIds.length;
    const dropped = result.data.dropped.length;
    onSaved(result.data.declinedByModel ? "The AI declined to suggest anything for this requirement."
      : `${kept} idea${kept === 1 ? "" : "s"} shown${dropped > 0 ? ` (${dropped} dropped for quoting a figure, making a claim or repeating the library)` : ""}. The client sees them too, labelled as AI.`);
  }

  async function withdraw(suggestionId: string) {
    setPending(suggestionId); setError(null);
    const result = await putBrowserCommand(`${base}/suggestions`, { suggestionId }, crypto.randomUUID());
    setPending(null);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved("Idea withdrawn — the client no longer sees it.");
  }

  if (!requirement) return <div className="nz-db"><p className="sub">That requirement is not in this assessment&rsquo;s framework.</p></div>;

  return <>
    <div className="nz-dh">
      <div className="kick">Bridge a readiness gap · {requirement.code}</div>
      <h3>{requirement.title}</h3>
      <div className="m">{maturity === null ? "Not yet answered" : `${maturity} · ${stepName(maturity)}`} → expected {requirement.targetMaturity} · {stepName(requirement.targetMaturity)}</div>
    </div>
    <div className="nz-db">
      <section className="nz-bridge-sec">
        <h4>From the Actions library</h4>
        <p className="hint">Actions whose alignment names this requirement.</p>
        {candidates.length === 0 ? <p className="sub">No library action is aligned to {requirement.code} yet.</p>
          : candidates.map(({ strategy, onPlan }) => <div className="nz-lib-item" key={strategy.id}>
            <div className="nz-lib-main"><div className="nm">{strategy.title}</div>
              <div className="sub"><span className="nz-tag">{strategyScopeLabel(strategy.scope)}</span> {strategy.category}</div></div>
            {onPlan ? <span className="nz-tag">On the plan</span>
              : <GatedButton className="nz-btn sm" blocked={blocked || pending !== null} blockedReason={blocked ? access.reason : undefined}
                reasonClassName="hint nz-gated-reason" onClick={() => void bridge({ strategyId: strategy.id }, strategy.title)}>{pending === strategy.title ? "Adding…" : "Add as the bridge"}</GatedButton>}
          </div>)}
      </section>

      <section className="nz-bridge-sec">
        <h4>Ideas from AI <span className="nz-tag nz-ai-tag">AI</span></h4>
        <p className="hint">Examples to consider, not advice: checked to carry no figures, costs, dates or legal claims. The client sees the ideas shown here in their portal, labelled as AI. None becomes an action until someone makes it one.</p>
        {ideas.length === 0 ? <p className="sub">No ideas shown for this requirement.</p>
          : ideas.map((idea) => <div className="nz-lib-item" key={idea.id}>
            <div className="nz-lib-main"><div className="nm">{idea.title}</div><div className="sub">{idea.how}</div>
              <div className="hint">Suggested {formatDate(idea.suggestedOn)}</div></div>
            <div className="nz-bridge-idea-actions">
              <button type="button" className="nz-btn sm" disabled={pending !== null} onClick={() => { setTitle(idea.title); setFromIdea(idea.id); }}>Use this idea</button>
              <GatedButton className="nz-btn sm" blocked={blocked || pending !== null} blockedReason={blocked ? access.reason : undefined}
                reasonClassName="hint nz-gated-reason" onClick={() => void withdraw(idea.id)}>{pending === idea.id ? "Withdrawing…" : "Withdraw"}</GatedButton>
            </div>
          </div>)}
        <GatedButton className="nz-btn sm" blocked={blocked || pending !== null} blockedReason={blocked ? access.reason : undefined}
          reasonClassName="hint nz-gated-reason" onClick={() => void suggest()}>{pending === "ideas" ? "Asking…" : ideas.length > 0 ? "Ask again (replaces these)" : "Suggest ideas"}</GatedButton>
        {note ? <p className="hint">{note}</p> : null}
      </section>

      <section className="nz-bridge-sec">
        <h4>Your own action{fromIdea ? " — from an AI idea" : ""}</h4>
        <label className="nz-fl"><span>The action</span>
          <input className="nz-inp" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Name a board member accountable for climate risk" /></label>
        <div className="nz-two">
          <label className="nz-fl"><span>Scope</span>
            <select className="nz-sel" value={scope} onChange={(event) => setScope(event.target.value as StrategyScope)}>
              {strategyScopes.map((value) => <option key={value} value={value}>{strategyScopeLabel(value)}</option>)}
            </select></label>
          <label className="nz-fl"><span>How much do they control?</span>
            <select className="nz-sel" value={controlLevel} onChange={(event) => setControlLevel(event.target.value as StrategyControlLevel)}>
              {strategyControlLevels.map((value) => <option key={value} value={value}>{strategyControlLevelLabels[value]}</option>)}
            </select></label>
        </div>
        <GatedButton className="nz-btn sm" blocked={blocked || pending !== null || title.trim() === ""} blockedReason={blocked ? access.reason : title.trim() === "" ? "Say what the action is." : undefined}
          reasonClassName="hint nz-gated-reason"
          onClick={() => void bridge({ bespoke: { title, scope, controlLevel }, ...(fromIdea ? { suggestionId: fromIdea } : {}) }, title.trim())}>Add as the bridge</GatedButton>
      </section>

      <label className="nz-fl nz-check"><input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <span>The client has already agreed this</span></label>
      <small className="hint">Otherwise it joins the plan as Proposed.{assessment.status === "complete" ? " This assessment is complete, so it is not changed — the action records the gap it bridges." : ""}</small>
    </div>
    <div className="nz-df">
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      <span className="sp" />
      <button type="button" className="nz-btn" onClick={onClose}>Done</button>
    </div>
  </>;
}
