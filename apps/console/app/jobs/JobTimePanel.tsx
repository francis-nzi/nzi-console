"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import type { JobTimeSummary, TimeActivityOption, TimeMoney } from "@nzi/contracts";
import { hoursLabel } from "../time/timePeriods";
import { AddEntry, readJson, type Load as TimeLoad } from "../time/TimeBoard";
import { JOB_TIME_CHANGED } from "./jobTimeEvents";

/** "+ Log time" on a job header — the per-job entry point, which pre-fills this job on the Time screen. */
export function LogTimeButton({ jobId }: { jobId: string }) {
  return <a className="nz-btn" href={`/time?job=${encodeURIComponent(jobId)}`}>+ Log time</a>;
}

type Load = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; summary: JobTimeSummary };

/**
 * Job → Time: hours by person, billable or not, and how much of the budgeted hours is used. Everyone's time with
 * time.view on the job; only the reader's own without it, and it says so. With finance.view (PR B) it adds the job's
 * labour cost, charge-out value, fee and margin. The budget (job.manage) and the fee (finance.manage) are edited here,
 * each offered only to someone the read says may change it. A failed read says so; it is never shown as "no time".
 */
export function JobTimePanel({ jobId, writeEnabled = false, logInPlace }: {
  jobId: string; writeEnabled?: boolean;
  /**
   * Phase 2 job shell (the Time drawer): log time here, on this job, rather than leaving for the Time screen — the Time
   * screen's own Add entry form and `time.entry.log`, the job fixed. `today` is the London day, resolved on the server.
   */
  logInPlace?: { jobLabel: string; today: string };
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  const [activities, setActivities] = useState<TimeLoad<TimeActivityOption[]>>({ state: "loading" });
  const [logged, setLogged] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inPlace = logInPlace !== undefined;
  useEffect(() => {
    if (!inPlace) return;
    void readJson("/api/isolated/time/activities", (body) => body.activities as TimeActivityOption[]).then(setActivities);
  }, [inPlace]);
  useEffect(() => {
    let live = true;
    fetch(`/api/isolated/jobs/${encodeURIComponent(jobId)}/time`, { cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (!response.ok) return setLoad({ state: "failed", message: response.status === 403 ? "Your role can't read time on this job." : "Time on this job could not be read just now." });
        setLoad({ state: "ready", summary: (await response.json() as { summary: JobTimeSummary }).summary });
      })
      .catch(() => { if (live) setLoad({ state: "failed", message: "Time on this job could not be read just now." }); });
    return () => { live = false; };
  }, [jobId, tick]);

  return <section className="nz-body nz-milestones-body"><div className="nz-panel nz-job-time">
    <div className="nz-milestones-heading">
      <div><h2>Time</h2><span className="sub">{load.state === "ready" && !load.summary.othersVisible ? "Your own time on this job — other people's needs time.view." : "Hours logged on this job, by person."}</span></div>
      {logInPlace ? <a className="nz-btn" href={`/time?job=${encodeURIComponent(jobId)}`}>Open the Time screen</a> : <LogTimeButton jobId={jobId} />}
    </div>
    {logInPlace ? <>
      {logged ? <div className="nz-banner ok" role="status"><div>{logged}</div></div> : null}
      <AddEntry formRef={formRef} today={logInPlace.today} initialJobId={jobId} jobs={{ state: "ready", data: [] }} activities={activities}
        writeEnabled={writeEnabled} fixedJob={{ jobId, label: logInPlace.jobLabel }} onSaved={(message) => { setLogged(message); reload(); window.dispatchEvent(new Event(JOB_TIME_CHANGED)); }} />
    </> : null}
    {load.state === "loading" ? <p className="nz-milestones-empty">Loading time…</p>
      : load.state === "failed" ? <div className="nz-banner warn" role="alert"><div>{load.message} Nothing is shown rather than a total that might be wrong.</div></div>
      : <JobTimeBody summary={load.summary} writeEnabled={writeEnabled} onSaved={reload} />}
  </div></section>;
}

const money = (value: number, currency: string | null) => new Intl.NumberFormat("en-GB", { style: "currency", currency: currency ?? "GBP" }).format(value);

function JobTimeBody({ summary, writeEnabled, onSaved }: { summary: JobTimeSummary; writeEnabled: boolean; onSaved: () => void }) {
  const { totals, budgetedMinutes, people } = summary;
  const used = budgetedMinutes && budgetedMinutes > 0 ? Math.round((totals.minutes / budgetedMinutes) * 100) : null;
  const [editing, setEditing] = useState<"budget" | "fee" | null>(null);
  return <>
    <div className="nz-job-time-budget">
      <div><b>{hoursLabel(totals.minutes)} h</b> logged{budgetedMinutes !== null ? <> of <b>{hoursLabel(budgetedMinutes)} h</b> budgeted</> : <> · <span className="nz-time-sub">no budget recorded</span></>}
        {summary.editable.budget && writeEnabled && editing !== "budget" ? <button type="button" className="nz-btn sm nz-time-inline" onClick={() => setEditing("budget")}>Edit budget</button> : null}</div>
      {editing === "budget" ? <QuantityEditor label="Budgeted hours" initial={budgetedMinutes === null ? "" : hoursLabel(budgetedMinutes)} step={0.25}
        path={`/api/isolated/jobs/${encodeURIComponent(summary.jobId)}/budget`} field="budgetedHours" expectedVersion={summary.jobVersion}
        onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onSaved(); }} /> : null}
      {used !== null ? <div className="nz-job-time-meter-line">
        <div className={`nz-job-time-meter ${used > 100 ? "crit" : used >= 90 ? "warn" : "good"}`} role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(used, 100)}><i style={{ width: `${Math.min(used, 100)}%` }} /></div>
        <span className={`nz-job-time-pct ${used > 100 ? "crit" : used >= 90 ? "warn" : "good"}`}>{used}% of budget used</span>
      </div> : null}
      <div className="nz-time-sub">{hoursLabel(totals.billableMinutes)} h billable · {hoursLabel(totals.minutes - totals.billableMinutes)} h non-billable</div>
    </div>
    {summary.money ? <JobMoney money={summary.money} canEditFee={summary.editable.fee && writeEnabled} editingFee={editing === "fee"} onEditFee={() => setEditing("fee")}
      feeEditor={<QuantityEditor label="Fee (ex VAT)" initial={summary.money.fee === null || summary.money.fee === undefined ? "" : String(summary.money.fee)} step={0.01}
        path={`/api/isolated/jobs/${encodeURIComponent(summary.jobId)}/fee`} field="feeAmount" expectedVersion={summary.jobVersion}
        onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onSaved(); }} />} />
      : summary.editable.fee && writeEnabled ? <p className="nz-time-sub">The fee is shown with everyone's time on the job.</p> : null}
    {people.length === 0 ? <p className="nz-milestones-empty">No time logged on this job yet.</p>
      : <table className="nz-tbl"><thead><tr><th>Person</th><th className="num">Billable h</th><th className="num">Non-billable h</th><th className="num">Total h</th><th className="num">Entries</th></tr></thead>
        <tbody>{people.map((person) => <tr key={person.userId}><td>{person.name}</td><td className="num">{hoursLabel(person.billableMinutes)}</td>
          <td className="num">{hoursLabel(person.minutes - person.billableMinutes)}</td><td className="num"><b>{hoursLabel(person.minutes)}</b></td><td className="num">{person.entries}</td></tr>)}</tbody></table>}
  </>;
}

/** finance.view only: the job's labour cost and charge-out value from the snapshotted rates, against its fee. */
function JobMoney({ money: figures, canEditFee, editingFee, onEditFee, feeEditor }: {
  money: TimeMoney; canEditFee: boolean; editingFee: boolean; onEditFee: () => void; feeEditor: React.ReactNode;
}) {
  if (figures.mixedCurrency) return <div className="nz-banner warn" role="status"><div>Time on this job was rated in more than one currency, so no single cost or margin is shown.</div></div>;
  const cell = (value: number | null | undefined) => value === null || value === undefined ? <span className="nz-time-sub">—</span> : money(value, figures.currency);
  return <div className="nz-job-time-money" aria-label="Cost and fee">
    <div><span className="nz-time-sub">Labour cost</span><b>{cell(figures.cost)}</b></div>
    <div><span className="nz-time-sub">Charge-out value</span><b>{cell(figures.charge)}</b></div>
    <div><span className="nz-time-sub">Fee (ex VAT)</span><b>{figures.fee === null || figures.fee === undefined ? <span className="nz-time-sub">no fee recorded</span> : cell(figures.fee)}</b>
      {canEditFee && !editingFee ? <button type="button" className="nz-btn sm nz-time-inline" onClick={onEditFee}>Edit fee</button> : null}</div>
    <div><span className="nz-time-sub">Margin</span><b className={figures.margin !== null && figures.margin !== undefined && figures.margin < 0 ? "nz-time-neg" : undefined}>{cell(figures.margin)}</b></div>
    {editingFee ? <div className="nz-job-time-money-edit">{feeEditor}</div> : null}
    {figures.unratedMinutes > 0 ? <p className="nz-time-sub">{hoursLabel(figures.unratedMinutes)} h were logged with no rate in force, so they add nothing to the cost.</p> : null}
  </div>;
}

/** One figure — hours or money — set through its command; blank clears it (no budget / no fee recorded). */
function QuantityEditor({ label, initial, step, path, field, expectedVersion, onCancel, onSaved }: {
  label: string; initial: string; step: number; path: string; field: "budgetedHours" | "feeAmount"; expectedVersion: number; onCancel: () => void; onSaved: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const key = useRef(crypto.randomUUID());
  async function save() {
    const figure = value.trim() === "" ? null : Number(value);
    if (figure !== null && (!Number.isFinite(figure) || figure < 0)) return setProblem("0 or more — or blank, to clear it.");
    setSaving(true); setProblem(null);
    try {
      const result = await postBrowserCommand(path, { expectedVersion, [field]: figure }, key.current);
      if (result.state !== "success") return setProblem(result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.state === "conflict" ? "The job changed since it was read — close this and try again." : result.message);
      onSaved();
    } finally { setSaving(false); }
  }
  return <span className="nz-time-capacity-edit">
    <label className="nz-time-sub" htmlFor={`edit-${field}`}>{label}</label>
    <input id={`edit-${field}`} className="nz-inp sm nz-time-hours" type="number" min={0} step={step} value={value} placeholder="none" onChange={(event) => setValue(event.target.value)} />
    <button type="button" className="nz-btn sm pri" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
    <button type="button" className="nz-btn sm" onClick={onCancel}>Cancel</button>
    {problem ? <span className="nz-time-inline-problem" role="alert">{problem}</span> : null}
  </span>;
}

