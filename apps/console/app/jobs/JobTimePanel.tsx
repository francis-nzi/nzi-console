"use client";

import { useEffect, useState } from "react";
import type { JobTimeSummary } from "@nzi/contracts";
import { hoursLabel } from "../time/timePeriods";

/** "+ Log time" on a job header — the per-job entry point, which pre-fills this job on the Time screen. */
export function LogTimeButton({ jobId }: { jobId: string }) {
  return <a className="nz-btn" href={`/time?job=${encodeURIComponent(jobId)}`}>+ Log time</a>;
}

type Load = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; summary: JobTimeSummary };

/**
 * Job → Time (TIME PR A): hours by person, billable or not, and how much of the budgeted hours is used. Everyone's
 * time with time.view on the job; only the reader's own without it, and it says so. Hours only — the labour cost,
 * fee and margin are finance's and arrive with PR B. A failed read says so; it is never shown as "no time".
 */
export function JobTimePanel({ jobId }: { jobId: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
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
  }, [jobId]);

  return <section className="nz-body nz-milestones-body"><div className="nz-panel nz-job-time">
    <div className="nz-milestones-heading">
      <div><h2>Time</h2><span className="sub">{load.state === "ready" && !load.summary.othersVisible ? "Your own time on this job — other people's needs time.view." : "Hours logged on this job, by person."}</span></div>
      <LogTimeButton jobId={jobId} />
    </div>
    {load.state === "loading" ? <p className="nz-milestones-empty">Loading time…</p>
      : load.state === "failed" ? <div className="nz-banner warn" role="alert"><div>{load.message} Nothing is shown rather than a total that might be wrong.</div></div>
      : <JobTimeBody summary={load.summary} />}
  </div></section>;
}

function JobTimeBody({ summary }: { summary: JobTimeSummary }) {
  const { totals, budgetedMinutes, people } = summary;
  const used = budgetedMinutes && budgetedMinutes > 0 ? Math.round((totals.minutes / budgetedMinutes) * 100) : null;
  const tone = used === null ? "" : used > 100 ? " crit" : used >= 90 ? " warn" : " good";
  return <>
    <div className="nz-job-time-budget">
      <div><b>{hoursLabel(totals.minutes)} h</b> logged{budgetedMinutes !== null ? <> of <b>{hoursLabel(budgetedMinutes)} h</b> budgeted</> : <> · <span className="nz-time-sub">no budget recorded</span></>}</div>
      {used !== null ? <div className="nz-job-time-meter-line">
        <div className={`nz-job-time-meter${tone}`} role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(used, 100)}><i style={{ width: `${Math.min(used, 100)}%` }} /></div>
        <span className={`nz-job-time-pct${tone}`}>{used}% of budget used</span>
      </div> : null}
      <div className="nz-time-sub">{hoursLabel(totals.billableMinutes)} h billable · {hoursLabel(totals.minutes - totals.billableMinutes)} h non-billable</div>
    </div>
    {people.length === 0 ? <p className="nz-milestones-empty">No time logged on this job yet.</p>
      : <table className="nz-tbl"><thead><tr><th>Person</th><th className="num">Billable h</th><th className="num">Non-billable h</th><th className="num">Total h</th><th className="num">Entries</th></tr></thead>
        <tbody>{people.map((person) => <tr key={person.userId}><td>{person.name}</td><td className="num">{hoursLabel(person.billableMinutes)}</td>
          <td className="num">{hoursLabel(person.minutes - person.billableMinutes)}</td><td className="num"><b>{hoursLabel(person.minutes)}</b></td><td className="num">{person.entries}</td></tr>)}</tbody></table>}
  </>;
}
