"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { patchBrowserCommand, postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { minutesFromHours, TIME_ENTRY_MAX_MINUTES, TIME_HOURS_STEP, type LoggableJob, type TimeActivityOption, type TimeEntryReadModel } from "@nzi/contracts";
import { SmartSearch, type SmartSearchOption } from "@nzi/ui";
import { hoursLabel, monthOf, periodFor, periodLabel, shortDay, weekOf, type Period, type PeriodKey } from "./timePeriods";
import { OversightTab, PayrollTab, UtilisationTab } from "./TimeReports";

/**
 * The Time screen (TIME PR A, to the approved mockup): the period filter and "+ Log time" up top; tabs for Log time,
 * Oversight, Payroll and Utilisation. Log time is the Add entry form (date, job, hours, activity, billable, note) over My time —
 * one's own entries, newest first, with inline edit and void, and the week / month totals and billable ratio.
 * Oversight, Payroll and Utilisation (PR B) are reads over the same entries for the chosen period (TimeReports).
 *
 * Hours only, never rates: a person logging time sees hours, and money stays finance-gated (T-Q3).
 */
type Tab = "log" | "oversight" | "payroll" | "utilisation";
export type Load<T> = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; data: T };
type Draft = { workDate: string; jobId: string; hours: string; activityValueId: string; billable: boolean; billableTouched: boolean; note: string };

const PERIODS: Array<[PeriodKey, string]> = [["week", "This week"], ["month", "This month"], ["last-month", "Last month"], ["quarter", "This quarter"], ["custom", "Custom"]];

export async function readJson<T>(url: string, pick: (body: Record<string, unknown>) => T): Promise<Load<T>> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return { state: "failed", message: response.status === 403 ? "Your role can't read this." : "It could not be read just now." };
    return { state: "ready", data: pick(await response.json() as Record<string, unknown>) };
  } catch { return { state: "failed", message: "It could not be read just now." }; }
}

const jobOption = (job: LoggableJob): SmartSearchOption => ({ id: job.jobId, label: `${job.clientName} · ${job.jobNumber}`, hint: job.title });
const sumMinutes = (entries: TimeEntryReadModel[], within?: Period) =>
  entries.filter((entry) => !within || (entry.workDate >= within.from && entry.workDate <= within.to)).reduce((total, entry) => total + entry.minutes, 0);

function issueText(result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) {
  if (result.state === "validation_failed") return result.issues.map((issue) => issue.message).join(" ");
  if (result.state === "conflict") return "This entry changed since you opened it — the list has been refreshed.";
  return result.message;
}

export function TimeBoard({ today, initialJobId, writeEnabled }: { today: string; initialJobId: string | null; writeEnabled: boolean }) {
  const [tab, setTab] = useState<Tab>("log");
  const [periodKey, setPeriodKey] = useState<PeriodKey>("month");
  const [custom, setCustom] = useState<Period>(monthOf(today));
  const period = periodFor(periodKey, today, custom);
  const week = weekOf(today), month = monthOf(today);
  // One read covers the chosen period and the running week and month, so the totals never disagree with the list.
  const span = { from: [period.from, week.from, month.from].sort()[0]!, to: [period.to, week.to, month.to].sort().at(-1)! };

  const [jobs, setJobs] = useState<Load<LoggableJob[]>>({ state: "loading" });
  const [activities, setActivities] = useState<Load<TimeActivityOption[]>>({ state: "loading" });
  const [entries, setEntries] = useState<Load<TimeEntryReadModel[]>>({ state: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    void readJson("/api/isolated/time/jobs", (body) => body.jobs as LoggableJob[]).then(setJobs);
    void readJson("/api/isolated/time/activities", (body) => body.activities as TimeActivityOption[]).then(setActivities);
  }, []);
  const reload = useCallback(() => {
    void readJson(`/api/isolated/time/entries?from=${span.from}&to=${span.to}`, (body) => body.entries as TimeEntryReadModel[]).then(setEntries);
  }, [span.from, span.to]);
  useEffect(() => { reload(); }, [reload]);

  const inPeriod = useMemo(() => entries.state === "ready" ? entries.data.filter((entry) => entry.workDate >= period.from && entry.workDate <= period.to) : [], [entries, period.from, period.to]);
  const periodMinutes = sumMinutes(inPeriod), billableMinutes = sumMinutes(inPeriod.filter((entry) => entry.billable));

  const openLog = () => { setTab("log"); requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>("input")?.focus()); };

  return <div className="nz-body nz-time">
    <div className="nz-time-head">
      <div>
        <div className="nz-eyebrow">Time</div>
        <h1>Time</h1>
        <div className="sub">Your hours against jobs. Each entry is yours alone, and every change is audited.</div>
      </div>
      <div className="nz-time-periods">
        <div className="nz-seg" role="group" aria-label="Period">
          {PERIODS.map(([key, label]) => <button key={key} type="button" className={periodKey === key ? "on" : undefined} aria-pressed={periodKey === key} onClick={() => setPeriodKey(key)}>{label}</button>)}
        </div>
        {periodKey === "custom"
          ? <span className="nz-time-custom">
            <input className="nz-inp sm" type="date" aria-label="From" value={custom.from} max={custom.to} onChange={(event) => event.target.value && setCustom({ ...custom, from: event.target.value })} />
            <span aria-hidden="true">–</span>
            <input className="nz-inp sm" type="date" aria-label="To" value={custom.to} min={custom.from} onChange={(event) => event.target.value && setCustom({ ...custom, to: event.target.value })} />
          </span>
          : <span className="nz-time-range">{periodLabel(period)}</span>}
      </div>
      <button type="button" className="nz-btn pri" onClick={openLog}>+ Log time</button>
    </div>

    <div className="nz-tabs" role="tablist" aria-label="Time">
      {([["log", "Log time"], ["oversight", "Oversight"], ["payroll", "Payroll"], ["utilisation", "Utilisation"]] as Array<[Tab, string]>).map(([key, label]) =>
        <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "on" : undefined} onClick={() => setTab(key)}>{label}</button>)}
    </div>

    {tab === "oversight" ? <OversightTab period={period} /> : null}
    {tab === "payroll" ? <PayrollTab period={period} /> : null}
    {tab === "utilisation" ? <UtilisationTab period={period} writeEnabled={writeEnabled} /> : null}

    {tab === "log" ? <>
      {notice ? <div className="nz-banner ok" role="status"><div>{notice}</div></div> : null}
      <section className="nz-metrics" aria-label="Your totals">
        <Metric label="This week" value={entries.state === "ready" ? `${hoursLabel(sumMinutes(entries.data, week))} h` : "—"} />
        <Metric label="This month" value={entries.state === "ready" ? `${hoursLabel(sumMinutes(entries.data, month))} h` : "—"} />
        <Metric label="In this period" value={entries.state === "ready" ? `${hoursLabel(periodMinutes)} h` : "—"} />
        <Metric label="Billable ratio" value={entries.state !== "ready" ? "—" : periodMinutes === 0 ? "No time yet" : `${Math.round((billableMinutes / periodMinutes) * 100)}%`}
          foot={entries.state === "ready" && periodMinutes > 0 ? `${hoursLabel(billableMinutes)} of ${hoursLabel(periodMinutes)} h billable` : undefined} />
      </section>

      <AddEntry formRef={formRef} today={today} initialJobId={initialJobId} jobs={jobs} activities={activities} writeEnabled={writeEnabled}
        onSaved={(message) => { setNotice(message); reload(); }} />

      <section className="nz-panel nz-time-entries">
        <h2>My time <span className="nz-time-count">{entries.state === "ready" ? `· ${inPeriod.length} in ${periodLabel(period)}` : null}</span></h2>
        {entries.state === "loading" ? <p className="nz-time-state">Loading your entries…</p>
          : entries.state === "failed" ? <div className="nz-banner warn" role="alert"><div>Your entries could not be read, so none are shown — this is not "no time logged". {entries.message}</div></div>
          : inPeriod.length === 0 ? <p className="nz-time-state">No time logged in {periodLabel(period)}.</p>
          : <EntryTable entries={inPeriod} jobs={jobs.state === "ready" ? jobs.data : []} activities={activities.state === "ready" ? activities.data : []}
            today={today} writeEnabled={writeEnabled} onChanged={(message) => { setNotice(message); reload(); }} />}
      </section>
    </> : null}
  </div>;
}

function Metric({ label, value, foot }: { label: string; value: string; foot?: string }) {
  return <div className="nz-metric"><div className="l">{label}</div><div className="v">{value}</div>{foot ? <div className="nz-time-foot">{foot}</div> : null}</div>;
}

/**
 * The Add entry form. On the Time screen the job is chosen; in a job's Time drawer (Phase 2 job shell) it is that job,
 * fixed (`fixedJob`) — the same form, the same `time.entry.log` command and its validation, with no redirect out.
 */
export function AddEntry({ formRef, today, initialJobId, jobs, activities, writeEnabled, onSaved, fixedJob }: {
  formRef: React.RefObject<HTMLFormElement | null>; today: string; initialJobId: string | null; jobs: Load<LoggableJob[]>; activities: Load<TimeActivityOption[]>;
  writeEnabled: boolean; onSaved: (message: string) => void; fixedJob?: { jobId: string; label: string };
}) {
  const blank = (jobId: string): Draft => ({ workDate: today, jobId, hours: "", activityValueId: "", billable: true, billableTouched: false, note: "" });
  const [draft, setDraft] = useState<Draft>(blank(fixedJob?.jobId ?? initialJobId ?? ""));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const key = useRef(crypto.randomUUID());
  const options = jobs.state === "ready" ? jobs.data.map(jobOption) : [];
  const chosenJob = jobs.state === "ready" ? jobs.data.find((job) => job.jobId === draft.jobId) : undefined;
  const jobLabel = fixedJob ? fixedJob.label : chosenJob ? `${chosenJob.clientName} · ${chosenJob.jobNumber}` : "the job";
  const preset = !fixedJob && initialJobId && jobs.state === "ready" && !jobs.data.some((job) => job.jobId === initialJobId);

  const chooseActivity = (activityValueId: string) => {
    const activity = activities.state === "ready" ? activities.data.find((item) => item.valueId === activityValueId) : undefined;
    // The activity's default applies until the person sets billable themselves.
    setDraft({ ...draft, activityValueId, billable: draft.billableTouched || !activity ? draft.billable : activity.billableDefault });
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !writeEnabled) return;
    setProblem(null);
    const hours = Number(draft.hours);
    const minutes = minutesFromHours(hours);
    if (!draft.jobId) return setProblem("Choose a job.");
    if (!draft.hours.trim() || !Number.isFinite(hours) || minutes <= 0 || minutes > TIME_ENTRY_MAX_MINUTES) return setProblem("Enter the hours worked: more than none, and no more than 24 in one entry.");
    if (!draft.activityValueId) return setProblem("Choose an activity.");
    setSaving(true);
    try {
      const result = await postBrowserCommand("/api/isolated/time/entries", {
        jobId: draft.jobId, workDate: draft.workDate, minutes, activityValueId: draft.activityValueId, billable: draft.billable, note: draft.note.trim() || null,
      }, key.current);
      if (result.state !== "success") return setProblem(issueText(result));
      key.current = crypto.randomUUID();
      onSaved(`Logged ${hoursLabel(minutes)} h on ${jobLabel} for ${shortDay(draft.workDate)}.`);
      setDraft({ ...blank(draft.jobId), workDate: draft.workDate });
    } finally { setSaving(false); }
  }

  return <section className="nz-panel nz-time-add">
    <h2>Add entry</h2>
    {!writeEnabled ? <div className="nz-banner warn" role="status"><div>Writes are switched off in this environment, so time can't be logged here.</div></div> : null}
    {!fixedJob && jobs.state === "failed" ? <div className="nz-banner warn" role="alert"><div>The jobs you can log against could not be read. {jobs.message}</div></div> : null}
    {activities.state === "failed" ? <div className="nz-banner warn" role="alert"><div>The activities could not be read. {activities.message}</div></div> : null}
    {preset ? <div className="nz-banner warn" role="status"><div>That job isn't one you can log time against, so choose another.</div></div> : null}
    <form ref={formRef} className="nz-time-form" onSubmit={save}>
      <label className="nz-time-field"><span>Date</span>
        <input className="nz-inp" type="date" value={draft.workDate} max={today} required onChange={(event) => setDraft({ ...draft, workDate: event.target.value })} /></label>
      {fixedJob ? <div className="nz-time-field wide"><span>Job</span><b className="nz-time-fixed-job">{fixedJob.label}</b></div>
        : <div className="nz-time-field wide">
        <label htmlFor="time-job">Job</label>
        <SmartSearch id="time-job" label="Job" options={options} value={draft.jobId} required
          emptyHint={jobs.state === "ready" ? "No jobs you can log time against." : undefined}
          placeholder={jobs.state === "loading" ? "Loading jobs…" : options.length ? "Type a client, number or title…" : "No jobs you can log against"}
          onChange={(jobId) => setDraft({ ...draft, jobId })} />
      </div>}
      <label className="nz-time-field"><span>Hours</span>
        <input className="nz-inp" type="number" inputMode="decimal" min={TIME_HOURS_STEP} max={24} step={TIME_HOURS_STEP} value={draft.hours} placeholder="1.5" required
          onChange={(event) => setDraft({ ...draft, hours: event.target.value })} /></label>
      <label className="nz-time-field"><span>Activity</span>
        <select className="nz-sel" value={draft.activityValueId} required onChange={(event) => chooseActivity(event.target.value)}>
          <option value="">{activities.state === "loading" ? "Loading…" : "Choose…"}</option>
          {activities.state === "ready" ? activities.data.map((activity) => <option key={activity.valueId} value={activity.valueId}>{activity.label}</option>) : null}
        </select></label>
      <label className="nz-time-toggle"><input type="checkbox" checked={draft.billable} onChange={(event) => setDraft({ ...draft, billable: event.target.checked, billableTouched: true })} /> Billable</label>
      <label className="nz-time-field wide"><span>Note</span>
        <input className="nz-inp" type="text" maxLength={2000} value={draft.note} placeholder="Optional" onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
      <button type="submit" className="nz-btn pri" disabled={saving || !writeEnabled}>{saving ? "Saving…" : "Save entry"}</button>
    </form>
    {problem ? <div className="nz-banner warn nz-time-problem" role="alert"><div>{problem}</div></div> : null}
  </section>;
}

function EntryTable({ entries, jobs, activities, today, writeEnabled, onChanged }: {
  entries: TimeEntryReadModel[]; today: string; jobs: LoggableJob[]; activities: TimeActivityOption[]; writeEnabled: boolean; onChanged: (message: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());

  async function voidEntry(entry: TimeEntryReadModel) {
    setProblem(null);
    const result = await postBrowserCommand(`/api/isolated/time/entries/${encodeURIComponent(entry.entryId)}/void`, { expectedVersion: entry.version }, key(`void:${entry.entryId}:${entry.version}`));
    setVoiding(null);
    if (result.state !== "success") { setProblem(issueText(result)); if (result.state === "conflict") onChanged("The list has been refreshed."); return; }
    onChanged(`Voided ${hoursLabel(entry.minutes)} h on ${entry.clientName} · ${entry.jobNumber} (${shortDay(entry.workDate)}).`);
  }

  return <>
    {problem ? <div className="nz-banner warn" role="alert"><div>{problem}</div></div> : null}
    <div className="nz-time-tablewrap"><table className="nz-tbl">
      <thead><tr><th>Date</th><th>Job</th><th className="num">Hours</th><th>Activity</th><th>Billable</th><th>Note</th><th aria-label="Actions" /></tr></thead>
      <tbody>{entries.map((entry) => editing === entry.entryId
        ? <EditRow key={entry.entryId} entry={entry} jobs={jobs} activities={activities} today={today} idempotencyKey={key(`edit:${entry.entryId}:${entry.version}`)}
          onCancel={() => setEditing(null)} onSaved={(message) => { setEditing(null); onChanged(message); }} />
        : <tr key={entry.entryId}>
          <td>{shortDay(entry.workDate)}</td>
          <td><div className="nz-time-job">{entry.clientName} · {entry.jobNumber}</div><div className="nz-time-sub">{entry.jobTitle}</div></td>
          <td className="num">{hoursLabel(entry.minutes)}</td>
          <td>{entry.activityLabel}</td>
          <td><span className={`nz-time-chip ${entry.billable ? "y" : "n"}`}>{entry.billable ? "Billable" : "Non-billable"}</span></td>
          <td className="nz-time-note">{entry.note ?? <span className="nz-time-sub">—</span>}</td>
          <td className="nz-time-actions">{entry.billed ? <span className="nz-time-sub" title="Billed time is locked until finance unbills it">Billed · locked</span>
            : !writeEnabled ? null
            : voiding === entry.entryId ? <><button type="button" className="nz-btn sm danger" onClick={() => void voidEntry(entry)}>Void entry</button><button type="button" className="nz-btn sm" onClick={() => setVoiding(null)}>Keep</button></>
            : <><button type="button" className="nz-btn sm" onClick={() => { setVoiding(null); setEditing(entry.entryId); }}>Edit</button><button type="button" className="nz-btn sm" onClick={() => { setEditing(null); setVoiding(entry.entryId); }}>Void…</button></>}</td>
        </tr>)}</tbody>
    </table></div>
  </>;
}

function EditRow({ entry, jobs, activities, today, idempotencyKey, onCancel, onSaved }: {
  entry: TimeEntryReadModel; today: string; jobs: LoggableJob[]; activities: TimeActivityOption[]; idempotencyKey: string; onCancel: () => void; onSaved: (message: string) => void;
}) {
  const [draft, setDraft] = useState({ workDate: entry.workDate, jobId: entry.jobId, hours: hoursLabel(entry.minutes), activityValueId: entry.activityValueId, billable: entry.billable, note: entry.note ?? "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The entry's own job and activity stay choosable even if they have since left the lists.
  const jobChoices = jobs.some((job) => job.jobId === entry.jobId) ? jobs : [{ jobId: entry.jobId, jobNumber: entry.jobNumber, title: entry.jobTitle, clientName: entry.clientName, family: "" }, ...jobs];
  const activityChoices = activities.some((item) => item.valueId === entry.activityValueId) ? activities : [{ valueId: entry.activityValueId, label: entry.activityLabel, billableDefault: entry.billable }, ...activities];

  async function save() {
    if (saving) return;
    const minutes = minutesFromHours(Number(draft.hours));
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > TIME_ENTRY_MAX_MINUTES) return setProblem("Hours: more than none, and no more than 24.");
    setSaving(true); setProblem(null);
    try {
      const result = await patchBrowserCommand(`/api/isolated/time/entries/${encodeURIComponent(entry.entryId)}`, {
        expectedVersion: entry.version, jobId: draft.jobId, workDate: draft.workDate, minutes, activityValueId: draft.activityValueId, billable: draft.billable, note: draft.note.trim() || null,
      }, idempotencyKey);
      if (result.state !== "success") return setProblem(issueText(result));
      onSaved(`Saved ${hoursLabel(minutes)} h for ${shortDay(draft.workDate)}.`);
    } finally { setSaving(false); }
  }

  return <tr className="nz-time-editing">
    <td><input className="nz-inp sm" type="date" aria-label="Date" value={draft.workDate} max={today} onChange={(event) => setDraft({ ...draft, workDate: event.target.value })} /></td>
    <td><select className="nz-sel sm" aria-label="Job" value={draft.jobId} onChange={(event) => setDraft({ ...draft, jobId: event.target.value })}>
      {jobChoices.map((job) => <option key={job.jobId} value={job.jobId}>{job.clientName} · {job.jobNumber}</option>)}</select></td>
    <td className="num"><input className="nz-inp sm nz-time-hours" type="number" aria-label="Hours" min={TIME_HOURS_STEP} max={24} step={TIME_HOURS_STEP} value={draft.hours} onChange={(event) => setDraft({ ...draft, hours: event.target.value })} /></td>
    <td><select className="nz-sel sm" aria-label="Activity" value={draft.activityValueId} onChange={(event) => setDraft({ ...draft, activityValueId: event.target.value })}>
      {activityChoices.map((activity) => <option key={activity.valueId} value={activity.valueId}>{activity.label}</option>)}</select></td>
    <td><label className="nz-time-toggle"><input type="checkbox" checked={draft.billable} onChange={(event) => setDraft({ ...draft, billable: event.target.checked })} /> Billable</label></td>
    <td><input className="nz-inp sm" type="text" aria-label="Note" maxLength={2000} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
      {problem ? <div className="nz-time-inline-problem" role="alert">{problem}</div> : null}</td>
    <td className="nz-time-actions"><button type="button" className="nz-btn sm pri" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button><button type="button" className="nz-btn sm" onClick={onCancel}>Cancel</button></td>
  </tr>;
}
