"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import type { OversightJob, TimeMoney, TimeOversight, TimePayroll, TimePeriod, TimeUtilisation } from "@nzi/contracts";
import { hoursLabel, periodLabel } from "./timePeriods";

/**
 * Time PR B — Oversight, Payroll and Utilisation (the approved mockup), each a read over the entries for the chosen
 * period. The server decides who sees what: a refused read is said, never shown as an empty team; money appears only
 * where the read carries it (finance.view), and is otherwise absent — never a zero.
 */
type Load<T> = { state: "loading" } | { state: "refused"; message: string } | { state: "failed"; message: string } | { state: "ready"; data: T };

function useTimeRead<T>(path: string, key: string, period: TimePeriod): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    fetch(`/api/isolated/time/${path}?from=${period.from}&to=${period.to}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!live) return;
        if (response.status === 403) return setLoad({ state: "refused", message: typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "Your role can't read this." });
        if (!response.ok) return setLoad({ state: "failed", message: typeof body.error === "string" ? body.error : "It could not be read just now." });
        setLoad({ state: "ready", data: body[key] as T });
      })
      .catch(() => { if (live) setLoad({ state: "failed", message: "It could not be read just now." }); });
    return () => { live = false; };
  }, [path, key, period.from, period.to, tick]);
  return [load, useCallback(() => setTick((value) => value + 1), [])];
}

function LoadState({ load, what }: { load: Exclude<Load<unknown>, { state: "ready" }>; what: string }) {
  if (load.state === "loading") return <p className="nz-time-state">Loading {what}…</p>;
  if (load.state === "refused") return <div className="nz-banner warn" role="status"><div>{load.message}</div></div>;
  return <div className="nz-banner warn" role="alert"><div>{what[0]!.toUpperCase() + what.slice(1)} could not be read, so nothing is shown — this is not "no time". {load.message}</div></div>;
}

const moneyFormat = (currency: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 });
/** A money figure, or a dash with the reason in its title when there is none to show. */
function Money({ value, money }: { value: number | null | undefined; money: TimeMoney }) {
  if (money.mixedCurrency) return <span className="nz-time-sub" title="Rates in more than one currency are not summed into one figure">mixed currency</span>;
  if (value === null || value === undefined) return <span className="nz-time-sub">—</span>;
  return <span>{money.currency ? moneyFormat(money.currency).format(value) : moneyFormat("GBP").format(value)}</span>;
}
const unratedNote = (minutes: number) => minutes > 0 ? <div className="nz-time-sub" title="Entries logged when no rate was in force add nothing to cost">{hoursLabel(minutes)} h with no rate</div> : null;

function Metric({ label, value, foot, tone }: { label: string; value: string; foot?: string; tone?: "crit" | "warn" | "good" }) {
  return <div className="nz-metric"><div className="l">{tone ? <span className={`nz-time-dot ${tone}`} /> : null}{label}</div><div className="v">{value}</div>{foot ? <div className="nz-time-foot">{foot}</div> : null}</div>;
}

const STATUS: Record<OversightJob["budgetStatus"], [string, "crit" | "warn" | "good" | "none"]> = {
  over: ["Over budget", "crit"], approaching: ["Approaching", "warn"], "on-track": ["On track", "good"], "no-budget": ["No budget", "none"],
};

/** The budget-used meter: the share used, capped at the track, with the over-run marked. */
export function BudgetMeter({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="nz-time-sub">no budget recorded</span>;
  const tone = pct > 100 ? "crit" : pct >= 90 ? "warn" : "good";
  return <div className="nz-job-time-meter-line">
    <div className={`nz-job-time-meter ${tone}`} role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(pct, 100)}><i style={{ width: `${Math.min(pct, 100)}%` }} /></div>
    <span className={`nz-job-time-pct ${tone}`}>{pct}% used</span>
  </div>;
}

// ── Oversight ──────────────────────────────────────────────────────────────────────────────────────────────────

export function OversightTab({ period }: { period: TimePeriod }) {
  const [load] = useTimeRead<TimeOversight>("oversight", "oversight", period);
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("");
  const [status, setStatus] = useState("");
  const jobs = load.state === "ready" ? load.data.jobs : [];
  const owners = useMemo(() => [...new Set(jobs.map((job) => job.ownerName).filter((name): name is string => !!name))].sort(), [jobs]);
  const shown = jobs.filter((job) => (!owner || job.ownerName === owner) && (!status || job.budgetStatus === status || (status === "over-cost" && job.money?.overCost === true))
    && (!search.trim() || `${job.clientName} ${job.jobNumber} ${job.title} ${job.ownerName ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())));
  if (load.state !== "ready") return <LoadState load={load} what="oversight" />;
  const { totals } = load.data;
  const money = jobs.some((job) => job.money !== null);
  return <section role="tabpanel" aria-label="Oversight">
    <p className="nz-time-note-strip">Budget used compares everything logged on a job to date — as at {periodLabel(period).split(" – ")[1]} — with its budgeted hours.{money ? " Cost is logged hours × each person's rate on the day; the estimate is the job's fee." : " Cost and fee need finance.view."}{load.data.allClients ? "" : " These are your own clients' jobs."}</p>
    <section className="nz-metrics" aria-label="Oversight totals">
      <Metric label="Jobs over budget" value={String(totals.overBudget)} tone={totals.overBudget ? "crit" : "good"} foot={totals.approaching ? `${totals.approaching} approaching` : "None approaching"} />
      <Metric label="Jobs over cost" value={totals.overCost === null ? "—" : String(totals.overCost)} tone={totals.overCost ? "crit" : totals.overCost === 0 ? "good" : undefined} foot={totals.overCost === null ? "Needs finance.view" : "Cost above the fee"} />
      <Metric label="Billable hours" value={`${hoursLabel(totals.billableMinutes)} h`} foot={`of ${hoursLabel(totals.periodMinutes)} h logged in the period`} />
      <Metric label="Jobs with time" value={String(jobs.length)} foot={periodLabel(period)} />
    </section>
    <div className="nz-time-toolbar">
      <input className="nz-inp" type="search" aria-label="Search jobs" placeholder="Search jobs — client, number, title…" value={search} onChange={(event) => setSearch(event.target.value)} />
      <select className="nz-sel" aria-label="Filter by owner" value={owner} onChange={(event) => setOwner(event.target.value)}>
        <option value="">All owners</option>{owners.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <select className="nz-sel" aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="">All statuses</option><option value="over">Over budget</option><option value="approaching">Approaching</option><option value="on-track">On track</option><option value="no-budget">No budget</option>
        {money ? <option value="over-cost">Over cost</option> : null}
      </select>
    </div>
    <section className="nz-panel">
      <h2 className="nz-time-h2">Jobs <span className="nz-time-count">· {shown.length}{shown.length !== jobs.length ? ` of ${jobs.length}` : ""}</span></h2>
      {jobs.length === 0 ? <p className="nz-time-state">No time was logged on any job in {periodLabel(period)}.</p>
        : shown.length === 0 ? <p className="nz-time-state">No jobs match.</p>
        : <div className="nz-time-tablewrap"><table className="nz-tbl">
          <thead><tr><th>Job</th><th>Owner</th><th>Hours (logged / budget)</th><th className="num">This period</th>{money ? <th className="num">Cost / fee</th> : null}<th>Status</th></tr></thead>
          <tbody>{shown.map((job) => {
            const [label, tone] = STATUS[job.budgetStatus];
            return <tr key={job.jobId}>
              <td><a className="nz-time-job" href={`/jobs/${encodeURIComponent(job.jobId)}`}>{job.clientName} · {job.jobNumber}</a><div className="nz-time-sub">{job.title}</div>
                <a className="nz-btn sm nz-time-rowlog" href={`/time?job=${encodeURIComponent(job.jobId)}`}>+ Log time</a></td>
              <td>{job.ownerName ?? <span className="nz-time-sub">—</span>}</td>
              <td className="nz-time-hours-cell"><div className="nz-time-hrs"><b>{hoursLabel(job.loggedMinutes)}</b> / {job.budgetedMinutes === null ? "—" : hoursLabel(job.budgetedMinutes)} h</div><BudgetMeter pct={job.budgetUsedPct} /></td>
              <td className="num">{hoursLabel(job.periodMinutes)}</td>
              {money ? <td className="num">{job.money ? <>
                <div><Money value={job.money.cost} money={job.money} /> <span className="nz-time-sub">/ <Money value={job.money.fee} money={job.money} /></span></div>
                {job.money.margin !== null && job.money.margin !== undefined ? <div className={job.money.margin < 0 ? "nz-time-neg" : "nz-time-pos"}>{job.money.margin < 0 ? "−" : "+"}<Money value={Math.abs(job.money.margin)} money={job.money} /> margin</div> : null}
                {unratedNote(job.money.unratedMinutes)}
              </> : <span className="nz-time-sub" title="Cost needs finance.view on this job">—</span>}</td> : null}
              <td><span className={`nz-time-status ${tone}`}>{label}</span>{job.money?.overCost ? <span className="nz-time-status crit">Over cost</span> : null}</td>
            </tr>;
          })}</tbody>
        </table></div>}
    </section>
  </section>;
}

// ── Payroll ────────────────────────────────────────────────────────────────────────────────────────────────────

export function PayrollTab({ period }: { period: TimePeriod }) {
  const [load] = useTimeRead<TimePayroll>("payroll", "payroll", period);
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  if (load.state !== "ready") return <LoadState load={load} what="payroll" />;
  const { people, moneyVisible } = load.data;
  const shown = people.filter((person) => !search.trim() || person.name.toLowerCase().includes(search.trim().toLowerCase()));
  const most = Math.max(1, ...people.map((person) => person.totalMinutes));
  const total = (pick: (person: (typeof people)[number]) => number) => shown.reduce((sum, person) => sum + pick(person), 0);
  const currencies = new Set(shown.flatMap((person) => person.money?.currency ? [person.money.currency] : []));
  const mixed = shown.some((person) => person.money?.mixedCurrency) || currencies.size > 1;
  const totalMoney: TimeMoney = { currency: [...currencies][0] ?? "GBP", mixedCurrency: mixed, cost: total((person) => person.money?.cost ?? 0), charge: null, unratedMinutes: total((person) => person.money?.unratedMinutes ?? 0) };
  async function copy() {
    const rows = [["Person", "Billable h", "Non-billable h", "Total h", ...(moneyVisible ? ["Cost"] : [])],
      ...shown.map((person) => [person.name, hoursLabel(person.billableMinutes), hoursLabel(person.nonBillableMinutes), hoursLabel(person.totalMinutes),
        ...(moneyVisible ? [person.money?.mixedCurrency ? "mixed currency" : String(person.money?.cost ?? "")] : [])])];
    try { await navigator.clipboard.writeText(rows.map((row) => row.join("\t")).join("\n")); setCopied("Copied — paste into a spreadsheet."); }
    catch { setCopied("Copying isn't available here; select the table instead."); }
  }
  return <section role="tabpanel" aria-label="Payroll">
    <div className="nz-time-rowtools">
      <p className="nz-time-note-strip">Hours worked per person in {periodLabel(period)}, for paying staff. Change the period above.{moneyVisible ? " Cost is each entry's hours × the person's cost rate on the day." : " Cost needs finance.view."}</p>
      <button type="button" className="nz-btn" onClick={() => void copy()}>Copy table</button>
    </div>
    {copied ? <div className="nz-banner ok" role="status"><div>{copied}</div></div> : null}
    <div className="nz-time-toolbar"><input className="nz-inp" type="search" aria-label="Search staff" placeholder="Search staff…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
    <section className="nz-panel">
      <h2 className="nz-time-h2">Staff hours <span className="nz-time-count">· {shown.length} {shown.length === 1 ? "person" : "people"}</span></h2>
      {shown.length === 0 ? <p className="nz-time-state">No staff match.</p> : <div className="nz-time-tablewrap"><table className="nz-tbl">
        <thead><tr><th>Person</th><th>Billable / total</th><th className="num">Billable h</th><th className="num">Non-billable h</th><th className="num">Total h</th>{moneyVisible ? <th className="num">Cost</th> : null}</tr></thead>
        <tbody>{shown.map((person) => <tr key={person.userId}>
          <td>{person.name}</td>
          <td className="nz-time-hours-cell"><div className="nz-time-bar" title={`${hoursLabel(person.billableMinutes)} of ${hoursLabel(person.totalMinutes)} h billable`}>
            <i style={{ width: `${(person.billableMinutes / most) * 100}%` }} /><i className="b2" style={{ width: `${(person.nonBillableMinutes / most) * 100}%` }} /></div></td>
          <td className="num">{hoursLabel(person.billableMinutes)}</td><td className="num">{hoursLabel(person.nonBillableMinutes)}</td><td className="num"><b>{hoursLabel(person.totalMinutes)}</b></td>
          {moneyVisible ? <td className="num">{person.money ? <><Money value={person.money.cost} money={person.money} />{unratedNote(person.money.unratedMinutes)}</> : null}</td> : null}
        </tr>)}</tbody>
        <tfoot><tr><td>Total</td><td /><td className="num">{hoursLabel(total((person) => person.billableMinutes))}</td><td className="num">{hoursLabel(total((person) => person.nonBillableMinutes))}</td>
          <td className="num">{hoursLabel(total((person) => person.totalMinutes))}</td>{moneyVisible ? <td className="num"><Money value={totalMoney.cost} money={totalMoney} />{unratedNote(totalMoney.unratedMinutes)}</td> : null}</tr></tfoot>
      </table></div>}
      <div className="nz-time-legend"><span><i className="nz-time-sw" /> Billable</span><span><i className="nz-time-sw b2" /> Non-billable</span></div>
    </section>
  </section>;
}

// ── Utilisation ────────────────────────────────────────────────────────────────────────────────────────────────

export function UtilisationTab({ period, writeEnabled }: { period: TimePeriod; writeEnabled: boolean }) {
  const [load, reload] = useTimeRead<TimeUtilisation>("utilisation", "utilisation", period);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (load.state !== "ready") return <LoadState load={load} what="utilisation" />;
  const { people, weekdays, capacityEditable } = load.data;
  return <section role="tabpanel" aria-label="Utilisation">
    <p className="nz-time-note-strip">Utilisation is logged hours against capacity: each person's weekly hours over the {weekdays} weekdays in {periodLabel(period)}. Bank holidays and leave are not taken off.</p>
    {notice ? <div className="nz-banner ok" role="status"><div>{notice}</div></div> : null}
    <section className="nz-panel">
      <h2 className="nz-time-h2">Team utilisation <span className="nz-time-count">· {people.length} {people.length === 1 ? "person" : "people"}</span></h2>
      <div className="nz-time-tablewrap"><table className="nz-tbl">
        <thead><tr><th>Person</th><th className="num">Capacity (h / week)</th><th className="num">Capacity in period</th><th className="num">Logged h</th><th className="num">Billable h</th><th>Utilisation</th></tr></thead>
        <tbody>{people.map((person) => <tr key={person.userId}>
          <td>{person.name}</td>
          <td className="num">{editing === person.userId
            ? <CapacityEditor person={person} onCancel={() => setEditing(null)} onSaved={(hours) => { setEditing(null); setNotice(`${person.name}'s capacity is now ${hours} h a week.`); reload(); }} />
            : <>{person.weeklyCapacityHours}{capacityEditable && writeEnabled ? <button type="button" className="nz-btn sm nz-time-inline" onClick={() => setEditing(person.userId)}>Edit</button> : null}</>}</td>
          <td className="num">{hoursLabel(person.capacityMinutes)}</td>
          <td className="num"><b>{hoursLabel(person.loggedMinutes)}</b></td>
          <td className="num">{hoursLabel(person.billableMinutes)}</td>
          <td className="nz-time-hours-cell">{person.utilisationPct === null ? <span className="nz-time-sub">no capacity in the period</span>
            : <div className="nz-job-time-meter-line"><div className="nz-job-time-meter good" role="meter" aria-label="Utilisation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(person.utilisationPct, 100)}><i style={{ width: `${Math.min(person.utilisationPct, 100)}%` }} /></div><span className="nz-job-time-pct">{person.utilisationPct}%</span></div>}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
  </section>;
}

function CapacityEditor({ person, onCancel, onSaved }: { person: TimeUtilisation["people"][number]; onCancel: () => void; onSaved: (hours: number) => void }) {
  const [value, setValue] = useState(String(person.weeklyCapacityHours));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const key = useRef(crypto.randomUUID());
  async function save() {
    const hours = Number(value);
    if (!value.trim() || !Number.isFinite(hours) || hours <= 0 || hours > 168) return setProblem("More than 0 and at most 168 hours.");
    setSaving(true); setProblem(null);
    try {
      const result = await postBrowserCommand(`/api/isolated/staff/${encodeURIComponent(person.userId)}/capacity`, { expectedVersion: person.version, weeklyCapacityHours: hours }, key.current);
      if (result.state !== "success") return setProblem(result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.state === "conflict" ? "This changed since it was read — reload the tab." : result.message);
      onSaved(hours);
    } finally { setSaving(false); }
  }
  return <span className="nz-time-capacity-edit">
    <input className="nz-inp sm nz-time-hours" type="number" aria-label={`Weekly capacity for ${person.name}`} min={0.25} max={168} step={0.25} value={value} onChange={(event) => setValue(event.target.value)} />
    <button type="button" className="nz-btn sm pri" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
    <button type="button" className="nz-btn sm" onClick={onCancel}>Cancel</button>
    {problem ? <span className="nz-time-inline-problem" role="alert">{problem}</span> : null}
  </span>;
}
