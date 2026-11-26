"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, patchBrowserCommandWithReason, postBrowserCommand, postBrowserCommandWithReason, putBrowserCommand, putBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import { datasetLabelFromId, MILESTONE_KIND_META, todayInLondon, type MilestoneKind } from "@nzi/contracts";
import type { JobMilestonesView, JobUpdatePlan } from "@nzi/isolated-backend";
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
 *
 * "Edit schedule…" is job.update (ruled J1–J6): the start date, the reporting period and the template, previewed by the
 * plan the command applies — the milestones, the reporting year, the window and its datasets — with any refusal said
 * before anything runs. A period change asks for a reason.
 */
type Milestone = JobMilestonesView["milestones"][number];
const SOURCE: Record<Milestone["source"], string> = { template: "Template", manual: "Manual", import: "Imported" };
const ANCHOR_FROM = { start_date: "the start date", reporting_period_start: "the reporting-period start" } as const;

function lineage(milestone: Milestone): string {
  if (milestone.source === "import") return "From the imported job plan.";
  if (milestone.source === "manual") return milestone.dueDate ? "Set by hand — a reschedule never moves it." : "Cleared by hand.";
  if (!milestone.basis) return "Not scheduled by the job’s current template.";
  const b = milestone.basis;
  return `Anchored ${formatDate(b.anchor)} on ${ANCHOR_FROM[b.anchorFrom]} + ${b.daysOffset} days — from the template as it was at v${b.templateVersion}.`;
}

/**
 * Addendum B (ruled 25 Nov 2026): **all of a job's dates are edited in the Setup drawer**, imported jobs included — the start
 * date, the reporting period and each milestone's due date, each audited. This is that section. The Milestones drawer keeps
 * completion and templates (`JobMilestonesPanel`). An imported job's date edited here is the console's from then on; where V7's
 * differs the section says so, with Use V7's dates / Keep the console's.
 */
export function JobDatesSection({ view, writeEnabled }: { view: JobMilestonesView; writeEnabled: boolean }) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [offer, setOffer] = useState<{ clientId: string; from: string; to: string } | null>(null);
  const closed = view.schedule.status === "complete" || view.schedule.status === "cancelled";
  const byKind = new Map(view.milestones.map((milestone) => [milestone.kind, milestone]));
  const done = (result: BrowserCommandResult<unknown>, ok: string) => {
    setBusy(null);
    if (result.state === "success") { setNotice({ kind: "ok", text: ok }); router.refresh(); return true; }
    setNotice({ kind: "warn", text: result.state === "validation_failed" ? result.issues[0]?.message ?? result.message
      : result.state === "conflict" ? "This job changed since the page loaded. Refresh to see the latest." : result.message });
    return false;
  };
  const path = (kind: MilestoneKind) => `/api/isolated/jobs/${encodeURIComponent(view.jobId)}/milestones/${kind}`;
  return <section className="nz-panel nz-config-panel nz-job-dates" aria-labelledby="job-dates-title">
    <div className="nz-config-head"><div><span className="nz-eyebrow">Schedule</span><b id="job-dates-title">Job dates</b>
      <div className="sub">The start date, the reporting period and the milestones&rsquo; due dates. Every change is audited.{view.schedule.imported ? " Imported from the previous system: a date edited here is the console’s from then on." : ""}</div></div></div>
    {notice ? <div className={`nz-banner ${notice.kind}`} role={notice.kind === "warn" ? "alert" : "status"}><div>{notice.text}</div></div> : null}
    {view.dateDifferences.length ? <DateDifferences view={view} writeEnabled={writeEnabled && !closed} busy={busy !== null}
      onResolve={async (difference, choice, reason) => {
        setBusy("resolve"); setNotice(null);
        const url = `/api/isolated/jobs/${encodeURIComponent(view.jobId)}/dates`;
        const body = { dateKey: difference.dateKey, observationNo: difference.observationNo, choice, expectedVersion: view.jobVersion };
        done(reason ? await putBrowserCommandWithReason(url, body, crypto.randomUUID(), reason) : await putBrowserCommand(url, body, crypto.randomUUID()),
          choice === "v7" ? `${difference.label} now follows the previous system.` : `${difference.label} keeps the console’s date.`);
      }} /> : null}
    {closed ? <p className="nz-hint">This job is {view.schedule.status}; its dates are fixed.</p>
      : writeEnabled ? <ScheduleEditor view={view} busy={busy !== null} datesOnly onCancel={() => undefined}
        onRun={async (change, reason) => {
          setBusy("schedule"); setNotice(null); setOffer(null);
          const url = `/api/isolated/jobs/${encodeURIComponent(view.jobId)}/schedule`;
          const body = { ...change, expectedVersion: view.jobVersion };
          const result = reason ? await patchBrowserCommandWithReason<{ clientId: string; baselineYearJob: boolean; schedule: { reportingPeriodStart: string | null; reportingPeriodEnd: string | null } }>(url, body, crypto.randomUUID(), reason)
            : await patchBrowserCommand<{ clientId: string; baselineYearJob: boolean; schedule: { reportingPeriodStart: string | null; reportingPeriodEnd: string | null } }>(url, body, crypto.randomUUID());
          // B.4: this job is the client's baseline year — offer the same change to the client's baseline period.
          if (result.state === "success" && result.data.baselineYearJob && result.data.schedule.reportingPeriodStart && result.data.schedule.reportingPeriodEnd) {
            setOffer({ clientId: result.data.clientId, from: result.data.schedule.reportingPeriodStart, to: result.data.schedule.reportingPeriodEnd });
          }
          done(result, "The job's dates were updated.");
        }} />
      : <p className="sub">Start {formatDate(view.schedule.startDate)}{view.schedule.hasPeriod ? ` · reporting period ${formatDate(view.schedule.reportingPeriodStart)} – ${formatDate(view.schedule.reportingPeriodEnd)}` : ""}</p>}
    {offer ? <BaselinePeriodOffer offer={offer} onDone={(ok, text) => { setOffer(null); setNotice({ kind: ok ? "ok" : "warn", text }); if (ok) router.refresh(); }} /> : null}
    <div className="nz-sect">Milestone due dates</div>
    <ul className="nz-milestones-list">
      {(Object.keys(MILESTONE_KIND_META) as MilestoneKind[]).map((kind) => <MilestoneRow key={kind} kind={kind} milestone={byKind.get(kind) ?? null}
        writeEnabled={writeEnabled && !closed} busy={busy} path={path(kind)} actions="date"
        onRun={async (label, run, ok) => { setBusy(label); setNotice(null); return done(await run(), ok); }} />)}
    </ul>
  </section>;
}

/** The command's choice value for "follow the previous system" (the copy never names it — check:terminology). */
const FOLLOW_PREVIOUS = "v7" as const;
/** B.2 — "Dates differ from the previous system: console …, previous system …", each with Use its dates / Keep the console's. */
function DateDifferences({ view, writeEnabled, busy, onResolve }: { view: JobMilestonesView; writeEnabled: boolean; busy: boolean;
  onResolve: (difference: JobMilestonesView["dateDifferences"][number], choice: "v7" | "console", reason: string | null) => void }) {
  const [reason, setReason] = useState("");
  const shown = (value: { from: string | null; to: string | null }) => value.to ? `${formatDate(value.from)} – ${formatDate(value.to)}` : formatDate(value.from);
  return <div className="nz-banner warn" role="status"><div>
    <b>{view.dateDifferences.some((d) => d.owner === "v7") ? "Dates changed in the previous system" : "Dates differ from the previous system"}</b>
    <ul>{view.dateDifferences.map((difference) => <li key={difference.dateKey}>
      {difference.label}: console <b>{shown(difference.console)}</b>, previous system <b>{shown(difference.v7)}</b>
      {difference.owner === "v7" ? <span className="muted"> · the sync could not apply the previous system&rsquo;s date here</span> : null}
      {writeEnabled ? <> <button type="button" className="nz-btn" disabled={busy || (difference.dateKey === "reporting_period" && !reason.trim())}
          onClick={() => onResolve(difference, FOLLOW_PREVIOUS, difference.dateKey === "reporting_period" ? reason.trim() : null)}>Use the previous system&rsquo;s dates</button>
        {" "}<button type="button" className="nz-btn" disabled={busy} onClick={() => onResolve(difference, "console", null)}>Keep the console&rsquo;s</button></> : null}
    </li>)}</ul>
    {writeEnabled && view.dateDifferences.some((d) => d.dateKey === "reporting_period")
      ? <label className="nz-fl">Reason, to use the previous system&rsquo;s reporting period<input className="nz-inp" value={reason} onChange={(event) => setReason(event.target.value)} /></label> : null}
  </div></div>;
}

/** B.4 — the job is the client's baseline year: move the client's baseline period with it (client.update; a re-baseline when it has figures). */
function BaselinePeriodOffer({ offer, onDone }: { offer: { clientId: string; from: string; to: string }; onDone: (ok: boolean, text: string) => void }) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  return <div className="nz-banner info" role="status"><div>
    <b>This job is the client&rsquo;s baseline year.</b> Move the client&rsquo;s baseline period to {formatDate(offer.from)} – {formatDate(offer.to)} too?
    <label className="nz-fl">Reason (a re-baseline when the baseline has figures)<input className="nz-inp" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    <div><button type="button" className="nz-btn pri" disabled={pending} onClick={async () => {
      setPending(true);
      const result = await putBrowserCommandWithReason(`/api/isolated/clients/${encodeURIComponent(offer.clientId)}/baseline/period`, { periodStart: offer.from, periodEnd: offer.to }, crypto.randomUUID(), reason.trim());
      setPending(false);
      onDone(result.state === "success", result.state === "success" ? "The client's baseline period moved with this job."
        : result.state === "validation_failed" ? result.issues[0]?.message ?? result.message : result.message);
    }}>Move the baseline period</button> <button type="button" className="nz-btn" onClick={() => onDone(true, "The client's baseline period was left as it is.")}>Leave it</button></div>
  </div></div>;
}

export function JobMilestonesPanel({ view, writeEnabled }: { view: JobMilestonesView; writeEnabled: boolean }) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const closed = view.schedule.status === "complete" || view.schedule.status === "cancelled";
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
          writeEnabled={writeEnabled} busy={busy} path={path(kind)} actions="completion"
          onRun={async (label, run, ok) => { setBusy(label); setNotice(null); return done(await run(), ok); }} />)}
      </ul>
      {/* Addendum B.1: the dates — start, period and each due date — are edited in the Setup drawer (JobDatesSection). */}
      {writeEnabled ? rescheduling
        ? <Reschedule view={view} busy={busy !== null} onCancel={() => setRescheduling(false)}
            onRun={async (templateId) => {
              setBusy("reschedule"); setNotice(null);
              const ok = done(await postBrowserCommand(`${path()}/reschedule`, { milestoneTemplateId: templateId, expectedVersion: view.jobVersion }, crypto.randomUUID()),
                templateId ? "Milestones rescheduled from the template." : "The template was removed; template dates were cleared.");
              if (ok) setRescheduling(false);
            }} />
        : <div className="nz-milestones-actions">
            {closed ? <small className="nz-hint">This job is {view.schedule.status}; its schedule is fixed.</small>
              : <><button type="button" className="nz-btn" onClick={() => setRescheduling(true)}>{hasAny ? "Reschedule from template…" : "Apply a template…"}</button> <small className="nz-hint">Dates are edited in Setup.</small></>}
          </div>
        : null}
    </div>
  </section>;
}

function MilestoneRow({ kind, milestone, writeEnabled, busy, path, onRun, actions }: {
  kind: MilestoneKind; milestone: Milestone | null; writeEnabled: boolean; busy: string | null; path: string;
  /** Addendum B.1: Setup sets the due date; the Milestones drawer completes and reopens. */
  actions: "date" | "completion";
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
      {actions === "date"
        ? completed ? null : <button type="button" className="nz-btn" onClick={() => { setDate(milestone?.dueDate ?? ""); setMode("date"); }} aria-label={`Set the ${label} date`}>Set date</button>
        : completed
          ? <button type="button" className="nz-btn" onClick={() => setMode("reopen")} aria-label={`Reopen ${label}`}>Reopen…</button>
          : <button type="button" className="nz-btn pri" onClick={() => { setCompletedOn(today); setMode("complete"); }} aria-label={`Complete ${label}`}>Complete</button>}
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
    <PreviewTable preview={preview} caption="What this will do" />
    <div><button type="button" className="nz-btn pri" disabled={busy} onClick={() => onRun(choice || null)}>{choice ? "Reschedule" : "Remove the template"}</button> <button type="button" className="nz-btn" onClick={onCancel}>Cancel</button></div>
  </div>;
}

function PreviewTable({ preview, caption }: { preview: NonNullable<JobUpdatePlan["reschedule"]>; caption: string }) {
  return <table className="nz-milestones-preview"><caption>{caption}</caption>
    <thead><tr><th scope="col">Milestone</th><th scope="col">Now</th><th scope="col">After</th><th scope="col">Why</th></tr></thead>
    <tbody>{preview.map((step) => <tr key={step.kind} className={step.action}>
      <th scope="row">{MILESTONE_KIND_META[step.kind].defaultLabel}</th>
      <td>{formatDate(step.from)}</td>
      <td>{STEP_LABEL[step.action]}{step.to && step.action !== "keep" ? ` · ${formatDate(step.to)}` : ""}</td>
      <td className="sub">{step.because}</td>
    </tr>)}</tbody>
  </table>;
}

type ScheduleChange = { startDate?: string; dueDate?: string; reportingPeriodStart?: string | null; reportingPeriodEnd?: string | null; milestoneTemplateId?: string | null };
// A dataset by its edition ("DESNZ GB 2026"), never the file it was imported as (DATASET-CURRENCY §2).
const datasetList = (items: Array<{ datasetId: string }>) => items.length ? items.map((item) => datasetLabelFromId(item.datasetId)).join(", ") : "none";

/** job.update's form: edit, preview (the command's own plan, from the server), then apply. */
type ScopeTotals = { scope1: number; scope2: number; scope3: number; total: number };
type PreviewOutcome = { totals: { before: ScopeTotals; after: ScopeTotals }; repriced: { rows: number } } | null;
const tco2e = (value: number) => `${value.toLocaleString("en-GB", { maximumFractionDigits: 2 })} tCO₂e`;

function ScheduleEditor({ view, busy, onCancel, onRun, datesOnly = false }: { view: JobMilestonesView; busy: boolean; onCancel: () => void; onRun: (change: ScheduleChange, reason: string | null) => void;
  /** Setup's dates (Addendum B.1): no template control — that stays in Milestones — and always open. */
  datesOnly?: boolean }) {
  const s = view.schedule;
  const [startDate, setStartDate] = useState(s.startDate ?? "");
  const [dueDate, setDueDate] = useState(s.dueDate ?? "");
  const [periodStart, setPeriodStart] = useState(s.reportingPeriodStart ?? "");
  const [periodEnd, setPeriodEnd] = useState(s.reportingPeriodEnd ?? "");
  const [templateId, setTemplateId] = useState(view.template?.templateId ?? "");
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState<JobUpdatePlan | null>(null);
  const [outcome, setOutcome] = useState<PreviewOutcome>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const change: ScheduleChange = {};
  if (startDate && startDate !== s.startDate) change.startDate = startDate;
  if (datesOnly && dueDate && dueDate !== s.dueDate) change.dueDate = dueDate;
  if (s.hasPeriod && (periodStart || null) !== s.reportingPeriodStart) change.reportingPeriodStart = periodStart || null;
  if (s.hasPeriod && (periodEnd || null) !== s.reportingPeriodEnd) change.reportingPeriodEnd = periodEnd || null;
  if (!datesOnly && (templateId || null) !== (view.template?.templateId ?? null)) change.milestoneTemplateId = templateId || null;
  // Any edit makes the preview stale: it must be worked out again before Apply.
  const edit = (set: (value: string) => void) => (value: string) => { set(value); setPlan(null); setOutcome(null); setPreviewError(null); };

  const preview = async () => {
    setLoading(true); setPreviewError(null);
    const query = new URLSearchParams(Object.entries(change).map(([key, value]) => [key, value ?? ""]));
    try {
      const response = await fetch(`/api/isolated/jobs/${encodeURIComponent(view.jobId)}/schedule?${query}`);
      const body = await response.json() as { plan?: JobUpdatePlan | null; outcome?: PreviewOutcome };
      if (!response.ok || !body.plan) setPreviewError("The preview could not be worked out just now. Nothing has changed.");
      else { setPlan(body.plan); setOutcome(body.outcome ?? null); }
    } catch { setPreviewError("The preview could not be worked out just now. Nothing has changed."); }
    setLoading(false);
  };
  const templates = view.template && !view.templates.some((template) => template.templateId === view.template!.templateId)
    ? [{ templateId: view.template.templateId, name: `${view.template.name} (inactive)`, isDefault: false }, ...view.templates] : view.templates;
  const blocked = !plan || plan.issues.length > 0 || (plan.reasonRequired && !reason.trim());

  return <div className="nz-milestones-reschedule">
    <label className="nz-fl">Start date<input className="nz-inp" type="date" value={startDate} required onChange={(event) => edit(setStartDate)(event.target.value)} /></label>
    {datesOnly ? <label className="nz-fl">Due date<input className="nz-inp" type="date" value={dueDate} required onChange={(event) => edit(setDueDate)(event.target.value)} /></label> : null}
    {s.hasPeriod ? <>
      <label className="nz-fl">Reporting period start<input className="nz-inp" type="date" value={periodStart} onChange={(event) => edit(setPeriodStart)(event.target.value)} /></label>
      <label className="nz-fl">Reporting period end<input className="nz-inp" type="date" value={periodEnd} onChange={(event) => edit(setPeriodEnd)(event.target.value)} /></label>
      <small className="nz-hint">The reporting year is the year the period ends in. Moving a period with data needs a reason: its datasets are re-chosen and its rows re-priced, previewed first.</small>
    </> : null}
    {datesOnly ? null : <label className="nz-fl">Milestone template
      <select className="nz-sel" value={templateId} onChange={(event) => edit(setTemplateId)(event.target.value)}>
        {templates.map((template) => <option key={template.templateId} value={template.templateId}>{template.name}{template.isDefault ? " (default)" : ""}</option>)}
        <option value="">No template</option>
      </select>
    </label>}
    {previewError ? <div className="nz-banner warn" role="alert"><div>{previewError}</div></div> : null}
    {plan ? <>
      {plan.issues.length ? <div className="nz-banner warn" role="alert"><div><b>This cannot be applied:</b><ul>{plan.issues.map((issue) => <li key={issue.code + issue.field}>{issue.message}</li>)}</ul></div></div> : null}
      {plan.changed.period ? <div className="nz-schedule-effects"><p>Reporting year: <b>{plan.before.reportingYear ?? "not set"}</b> → <b>{plan.after.reportingYear ?? "not set"}</b>.</p></div> : null}
      {plan.datasets?.window ? <div className="nz-schedule-effects">
        <p>Emissions window: {plan.datasets.window.before ? `${formatDate(plan.datasets.window.before.from)} – ${formatDate(plan.datasets.window.before.to)}` : "none"} → <b>{formatDate(plan.datasets.window.after.from)} – {formatDate(plan.datasets.window.after.to)}</b>.</p>
        <p>Automatic datasets: {datasetList(plan.datasets.automaticRemoved)} → <b>{datasetList(plan.datasets.automaticAdded)}</b>.</p>
        {plan.datasets.manual.map((manual) => <p key={manual.datasetId}>Chosen by hand, kept: <b>{datasetLabelFromId(manual.datasetId)}</b>{manual.warningsAfter.length ? ` — ${manual.warningsAfter.join(" ")}` : " — covers the new period."}</p>)}
      </div> : null}
      {outcome && plan.periodHasData ? <table className="nz-milestones-preview"><caption>Totals before and after ({outcome.repriced.rows} row{outcome.repriced.rows === 1 ? "" : "s"} re-priced)</caption>
        <thead><tr><th scope="col">Scope</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
        <tbody>{(["scope1", "scope2", "scope3", "total"] as const).map((key) => <tr key={key}><th scope="row">{key === "total" ? "Total" : `Scope ${key.slice(-1)}`}</th>
          <td>{tco2e(outcome.totals.before[key])}</td><td>{tco2e(outcome.totals.after[key])}</td></tr>)}</tbody>
      </table> : null}
      {plan.reschedule ? <PreviewTable preview={plan.reschedule} caption="What this will do to the milestones" /> : <div className="nz-schedule-effects"><p>The milestones do not move.</p></div>}
      {plan.reasonRequired && !plan.issues.length ? <label className="nz-fl">Reason for changing the reporting period<textarea className="nz-inp" rows={2} value={reason} required onChange={(event) => setReason(event.target.value)} /></label> : null}
    </> : null}
    <div>
      {plan ? <button type="button" className="nz-btn pri" disabled={busy || blocked} onClick={() => onRun(change, plan.reasonRequired ? reason.trim() : null)}>Apply</button>
        : <button type="button" className="nz-btn pri" disabled={loading || Object.keys(change).length === 0} onClick={preview}>{loading ? "Working it out…" : "Preview"}</button>}
      {datesOnly ? (plan ? <>{" "}<button type="button" className="nz-btn" onClick={() => { setPlan(null); setOutcome(null); }}>Back</button></> : null)
        : <>{" "}<button type="button" className="nz-btn" onClick={onCancel}>Cancel</button></>}
    </div>
  </div>;
}
