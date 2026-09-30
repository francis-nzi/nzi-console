"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import { MILESTONE_KIND_META, todayInLondon, type MilestoneKind } from "@nzi/contracts";
import type { JobMilestonesView } from "@nzi/isolated-backend";
import { RiskBadge } from "@nzi/ui";
import { formatDate } from "../lib/formatDate";

/**
 * A job's Milestones panel (PR 3) — the same on every family's page. Data collection, first draft and final report:
 * each with its due date and Risk (the rule the lists use), its completion, where its date came from (a source chip),
 * and that date's lineage — evidence-first: no date without its basis one line away.
 *
 * Actions, where writes are on: set or clear a date (manual — never moved again), complete (today, or a past day —
 * never after today, in London), reopen (with a reason), and reschedule from a template — which is also how a job with
 * no milestones gets some. The reschedule shows what will move and what will stay, and why, before it runs.
 */
type Milestone = JobMilestonesView["milestones"][number];
const SOURCE: Record<Milestone["source"], string> = { template: "Template", manual: "Manual", import: "Imported · v7" };
const ANCHOR_FROM = { start_date: "the start date", reporting_period_start: "the reporting-period start" } as const;

function lineage(milestone: Milestone): string {
  if (milestone.source === "import") return "From v7’s job plan.";
  if (milestone.source === "manual") return milestone.dueDate ? "Set by hand — a reschedule never moves it." : "Cleared by hand.";
  if (!milestone.basis) return "Not scheduled by the job’s current template.";
  const b = milestone.basis;
  return `Anchored ${formatDate(b.anchor)} on ${ANCHOR_FROM[b.anchorFrom]} + ${b.daysOffset} days — from the template as it was at v${b.templateVersion}.`;
}

export function JobMilestonesPanel({ view, writeEnabled }: { view: JobMilestonesView; writeEnabled: boolean }) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const byKind = new Map(view.milestones.map((milestone) => [milestone.kind, milestone]));
  const hasAny = view.milestones.some((milestone) => milestone.dueDate || milestone.completedAt);

  const done = (result: BrowserCommandResult<unknown>, ok: string) => {
    setBusy(null);
    if (result.state === "success") { setNotice({ kind: "ok", text: ok }); router.refresh(); return true; }
    setNotice({ kind: "warn", text: result.state === "validation_failed" ? result.issues[0]?.message ?? result.message
      : result.state === "conflict" ? "These milestones changed since the page loaded. Refresh to see the latest." : result.message });
    return false;
  };
  const path = (kind?: MilestoneKind) => `/api/isolated/jobs/${encodeURIComponent(view.jobId)}/milestones${kind ? `/${kind}` : ""}`;

  return <section className="nz-body nz-milestones-body" aria-labelledby="milestones-title">
    <div className="nz-panel nz-milestones">
      <div className="nz-milestones-heading">
        <div>
          <span className="nz-eyebrow">Delivery milestones</span>
          <b id="milestones-title">Milestones</b>
          <div className="sub">{view.template ? <>From <b>{view.template.name}</b>{view.template.active ? "" : " (now inactive)"}{view.anchor ? <> · anchored {formatDate(view.anchor.anchor)} on {ANCHOR_FROM[view.anchor.from]}</> : null}.</> : "No milestone template on this job."} Every change is audited.</div>
        </div>
        <RiskBadge risk={view.risk} />
      </div>
      {notice ? <div className={`nz-banner ${notice.kind}`} role={notice.kind === "warn" ? "alert" : "status"}><div>{notice.text}</div></div> : null}
      {!hasAny && !rescheduling ? <p className="nz-milestones-empty"><b>Not set.</b> This job has no dated milestones, so its Risk reads Not set.{writeEnabled && view.templates.length ? " Apply a template to schedule them." : ""}</p> : null}
      <ul className="nz-milestones-list">
        {(Object.keys(MILESTONE_KIND_META) as MilestoneKind[]).map((kind) => <MilestoneRow key={kind} kind={kind} milestone={byKind.get(kind) ?? null}
          writeEnabled={writeEnabled} busy={busy} path={path(kind)}
          onRun={async (label, run, ok) => { setBusy(label); setNotice(null); return done(await run(), ok); }} />)}
      </ul>
      {writeEnabled ? rescheduling
        ? <Reschedule view={view} busy={busy !== null} onCancel={() => setRescheduling(false)}
            onRun={async (templateId) => {
              setBusy("reschedule"); setNotice(null);
              const ok = done(await postBrowserCommand(`${path()}/reschedule`, { milestoneTemplateId: templateId, expectedVersion: view.jobVersion }, crypto.randomUUID()),
                templateId ? "Milestones rescheduled from the template." : "The template was removed; template dates were cleared.");
              if (ok) setRescheduling(false);
            }} />
        : <div className="nz-milestones-actions"><button type="button" className="nz-btn" onClick={() => setRescheduling(true)}>{hasAny ? "Reschedule from template…" : "Apply a template…"}</button></div>
        : null}
    </div>
  </section>;
}

function MilestoneRow({ kind, milestone, writeEnabled, busy, path, onRun }: {
  kind: MilestoneKind; milestone: Milestone | null; writeEnabled: boolean; busy: string | null; path: string;
  onRun: (label: string, run: () => Promise<BrowserCommandResult<unknown>>, ok: string) => Promise<boolean>;
}) {
  const today = todayInLondon();
  const [mode, setMode] = useState<"idle" | "date" | "complete" | "reopen">("idle");
  const [date, setDate] = useState(milestone?.dueDate ?? "");
  const [completedOn, setCompletedOn] = useState(today);
  const [reason, setReason] = useState("");
  const name = milestone?.basis?.itemLabel ?? MILESTONE_KIND_META[kind].defaultLabel;
  const completed = !!milestone?.completedAt;
  const label = `${MILESTONE_KIND_META[kind].defaultLabel}`;
  const versioned = milestone ? { expectedVersion: milestone.version } : {};

  return <li className={`nz-milestone${completed ? " completed" : ""}`}>
    <span className="nz-milestone-mark" aria-hidden="true">{MILESTONE_KIND_META[kind].mark}</span>
    <div className="nz-milestone-main">
      <div className="nz-milestone-line">
        <b>{name}</b>
        {milestone ? <span className={`nz-src ${milestone.source}`}>{SOURCE[milestone.source]}</span> : null}
        {/* A completed milestone counts as neither Overdue nor Due (PR 2's rule) — it says Completed, not Healthy. */}
        {completed ? <span className="nz-st done">Completed</span> : milestone?.risk ? <RiskBadge risk={milestone.risk} /> : null}
      </div>
      <div className="sub">
        {milestone?.dueDate ? <>Due <b>{formatDate(milestone.dueDate)}</b></> : "No due date"}
        {completed ? <> · completed {formatDate(milestone!.completedOn)}{milestone!.completedByLabel ? ` by ${milestone!.completedByLabel}` : ""}</> : null}
      </div>
      {milestone ? <div className="nz-milestone-lineage">{lineage(milestone)}</div> : null}
      {mode === "date" ? <form className="nz-milestone-form" onSubmit={async (event) => { event.preventDefault();
        if (await onRun(`${kind}-date`, () => patchBrowserCommand(path, { dueDate: date || null, ...versioned }, crypto.randomUUID()), date ? `${label} is due ${formatDate(date)}.` : `${label}'s date was cleared.`)) setMode("idle"); }}>
        <label className="nz-fl">Due date<input className="nz-inp" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <small className="nz-hint">Set by hand, it is never moved by a reschedule. Leave empty to clear it.</small>
        <div><button type="submit" className="nz-btn pri" disabled={busy !== null}>Save date</button> <button type="button" className="nz-btn" onClick={() => setMode("idle")}>Cancel</button></div>
      </form> : null}
      {mode === "complete" ? <form className="nz-milestone-form" onSubmit={async (event) => { event.preventDefault();
        const body = { ...(completedOn && completedOn !== today ? { completedAt: completedOn } : {}), ...versioned };
        if (await onRun(`${kind}-complete`, () => postBrowserCommand(`${path}/complete`, body, crypto.randomUUID()), `${label} completed ${formatDate(completedOn || today)}.`)) setMode("idle"); }}>
        <label className="nz-fl">Completed on<input className="nz-inp" type="date" value={completedOn} max={today} required onChange={(event) => setCompletedOn(event.target.value)} /></label>
        <small className="nz-hint">Today, or an earlier day — never a later one.</small>
        <div><button type="submit" className="nz-btn pri" disabled={busy !== null || completedOn > today}>Mark complete</button> <button type="button" className="nz-btn" onClick={() => setMode("idle")}>Cancel</button></div>
      </form> : null}
      {mode === "reopen" ? <form className="nz-milestone-form" onSubmit={async (event) => { event.preventDefault();
        if (await onRun(`${kind}-reopen`, () => postBrowserCommandWithReason(`${path}/reopen`, { expectedVersion: milestone!.version }, crypto.randomUUID(), reason), `${label} was reopened.`)) { setMode("idle"); setReason(""); } }}>
        <label className="nz-fl">Reason for reopening<textarea className="nz-inp" rows={2} value={reason} required onChange={(event) => setReason(event.target.value)} /></label>
        <small className="nz-hint">Required — it is recorded in the audit log.</small>
        <div><button type="submit" className="nz-btn pri" disabled={busy !== null || !reason.trim()}>Reopen</button> <button type="button" className="nz-btn" onClick={() => setMode("idle")}>Cancel</button></div>
      </form> : null}
    </div>
    {writeEnabled && mode === "idle" ? <div className="nz-milestone-actions">
      {completed
        ? <button type="button" className="nz-btn" onClick={() => setMode("reopen")} aria-label={`Reopen ${label}`}>Reopen…</button>
        : <>
          <button type="button" className="nz-btn" onClick={() => { setDate(milestone?.dueDate ?? ""); setMode("date"); }} aria-label={`Set the ${label} date`}>Set date</button>
          <button type="button" className="nz-btn pri" onClick={() => { setCompletedOn(today); setMode("complete"); }} aria-label={`Complete ${label}`}>Complete</button>
        </>}
    </div> : null}
  </li>;
}

const STEP_LABEL = { generate: "Scheduled", move: "Moves", keep: "Stays", clear: "Cleared", unchanged: "No change" } as const;

function Reschedule({ view, busy, onCancel, onRun }: { view: JobMilestonesView; busy: boolean; onCancel: () => void; onRun: (templateId: string | null) => void }) {
  const [choice, setChoice] = useState<string>(view.template?.active ? view.template.templateId : view.templates.find((template) => template.isDefault)?.templateId ?? view.templates[0]?.templateId ?? "");
  const preview = choice ? view.templates.find((template) => template.templateId === choice)?.preview ?? [] : view.previewWithout;
  return <div className="nz-milestones-reschedule">
    <label className="nz-fl">Template
      <select className="nz-sel" value={choice} onChange={(event) => setChoice(event.target.value)}>
        {view.templates.map((template) => <option key={template.templateId} value={template.templateId}>{template.name}{template.isDefault ? " (default)" : ""}</option>)}
        <option value="">No template</option>
      </select>
    </label>
    <table className="nz-milestones-preview"><caption>What this will do</caption>
      <thead><tr><th scope="col">Milestone</th><th scope="col">Now</th><th scope="col">After</th><th scope="col">Why</th></tr></thead>
      <tbody>{preview.map((step) => <tr key={step.kind} className={step.action}>
        <th scope="row">{MILESTONE_KIND_META[step.kind].defaultLabel}</th>
        <td>{formatDate(step.from)}</td>
        <td>{STEP_LABEL[step.action]}{step.to && step.action !== "keep" ? ` · ${formatDate(step.to)}` : ""}</td>
        <td className="sub">{step.because}</td>
      </tr>)}</tbody>
    </table>
    <div><button type="button" className="nz-btn pri" disabled={busy} onClick={() => onRun(choice || null)}>{choice ? "Reschedule" : "Remove the template"}</button> <button type="button" className="nz-btn" onClick={onCancel}>Cancel</button></div>
  </div>;
}
