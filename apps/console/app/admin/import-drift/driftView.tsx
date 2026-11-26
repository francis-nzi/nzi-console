"use client";

import { Fragment, useMemo, useState } from "react";
import {
  applyDrift, DEFAULT_DRIFT_QUERY, DRIFT_CHIPS, driftCsv, driftQueryString, driftTally, isApart, nextSort, OUTCOME_LABEL, totalDifference,
  type DriftChip, type DriftItem, type DriftQuery, type DriftSortKey,
} from "./driftModel";

/**
 * The Admin list of every job imported from the previous system against it (BRIEF-v7-import-j000663 Part C, made reviewable by
 * BRIEF-drift-investigation-and-review-page Part C): a two-row header with every figure in its own column under its heading, sorting on
 * every column, the smart filter and the CSV, all over what one read of the stored checks returned (`driftModel.ts`). The filter and
 * the sort live in the URL, rewritten without a navigation. A job never checked, or one the previous system could not answer for,
 * shows no figure: never a zero.
 */
const t = (value: number | null) => value === null ? "—" : value.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const signed = (value: number | null) => value === null ? "—" : `${value > 0.05 ? "+" : value < -0.05 ? "−" : ""}${t(Math.abs(value))}`;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).replace(",", "");
const REASON: Record<string, string> = {
  "not-configured": "the previous system's figures are not connected yet", unreachable: "the previous system did not answer", timeout: "the previous system took too long",
  "not-found": "the previous system does not hold this job", "cannot-compute": "the previous system could not work it out", busy: "the previous system was busy",
  contract: "the previous system's answer was not in the agreed form", refused: "the connection to the previous system is refused",
};
const TRIGGER: Record<string, string> = { admin: "Check now", publish: "Before publish", nightly: "Nightly" };
const SCOPES = ["1", "2", "3"] as const;
const FIGURES = [["here", "Here"], ["previous", "Previous system"], ["difference", "Difference"]] as const;

/** The difference, its sign in the text and its tone by sign beyond 0.1 t (never colour alone). */
function Difference({ value }: { value: number | null }) {
  const tone = !isApart(value) ? "even" : value! < 0 ? "lower" : "higher";
  return <span className={`nz-a-drift-diff ${tone}`} title={tone === "lower" ? "Lower here than in the previous system" : tone === "higher" ? "Higher here than in the previous system" : undefined}>{signed(value)}</span>;
}

function SortHeading({ label, column, query, onSort, ...rest }: { label: string; column: DriftSortKey; query: DriftQuery; onSort: (key: DriftSortKey) => void } & React.ThHTMLAttributes<HTMLTableCellElement> & { "data-col": string }) {
  const sorted = query.sort === column;
  return <th scope="col" aria-sort={sorted ? (query.dir === "asc" ? "ascending" : "descending") : "none"} {...rest}>
    <button type="button" className="nz-sort" onClick={() => onSort(column)}>{label}<span aria-hidden="true" className="nz-sort-mark">{sorted ? (query.dir === "asc" ? "▲" : "▼") : "↕"}</span></button>
  </th>;
}

/** The table: pure over its rows and query, so a test can render it. `open` is the job whose history is shown. */
export function DriftTable({ items, query, onSort, open, onToggle }: { items: readonly DriftItem[]; query: DriftQuery; onSort: (key: DriftSortKey) => void; open: string | null; onToggle: (jobId: string) => void }) {
  return <div className="nz-a-drift-wrap"><table className="nz-tbl nz-a-drift" data-drift-list>
    <thead>
      <tr>
        <SortHeading label="Job" column="job" query={query} onSort={onSort} rowSpan={2} id="dh-job" className="job" data-col="job" />
        <SortHeading label="Client" column="client" query={query} onSort={onSort} rowSpan={2} id="dh-client" className="client" data-col="client" />
        <SortHeading label="Outcome" column="outcome" query={query} onSort={onSort} rowSpan={2} id="dh-outcome" data-col="outcome" />
        {SCOPES.map((scope) => <th key={scope} scope="colgroup" colSpan={3} id={`dh-s${scope}`} className="group">Scope {scope}</th>)}
        <th scope="col" id="dh-total" className="group">Total</th>
        <SortHeading label="Checked" column="checked" query={query} onSort={onSort} rowSpan={2} id="dh-checked" data-col="checked" />
      </tr>
      <tr>
        {SCOPES.flatMap((scope) => FIGURES.map(([figure, label]) => <SortHeading key={`${scope}-${figure}`} label={label} column={`s${scope}-${figure}` as DriftSortKey} query={query} onSort={onSort}
          id={`dh-s${scope}-${figure}`} className={`num${figure === "here" ? " first" : ""}`} data-col={`s${scope}-${figure}`} />))}
        <SortHeading label="Difference" column="total" query={query} onSort={onSort} id="dh-total-difference" className="num first" data-col="total" />
      </tr>
    </thead>
    <tbody>{items.map((item) => {
      const expanded = open === item.jobId;
      return <Fragment key={item.jobId}>
        <tr data-drift-job={item.jobNumber} data-outcome={item.outcome}>
          <th scope="row" className="job" headers="dh-job" data-col="job">
            <a href={`/jobs/${encodeURIComponent(item.jobId)}`}>{item.jobNumber}</a>
            {item.spansTwoYears ? <span className="nz-a-prov" title="The reporting period spans two dataset years">Two-year</span> : null}
          </th>
          <td className="client" headers="dh-client" data-col="client" title={item.clientName}>{item.clientName}</td>
          <td headers="dh-outcome" data-col="outcome" title={item.outcome === "unknown" && item.unknownReason ? REASON[item.unknownReason] ?? item.unknownReason : undefined}>{OUTCOME_LABEL[item.outcome]}</td>
          {item.scopes.flatMap((entry) => FIGURES.map(([figure]) => <td key={`${entry.scope}-${figure}`} className={`num${figure === "here" ? " first" : ""}`}
            headers={`dh-s${entry.scope} dh-s${entry.scope}-${figure}`} data-col={`s${entry.scope}-${figure}`}>
            {figure === "here" ? t(entry.console) : figure === "previous" ? t(entry.previous) : <Difference value={entry.difference} />}
          </td>))}
          <td className="num first" headers="dh-total dh-total-difference" data-col="total"><Difference value={totalDifference(item)} /></td>
          <td headers="dh-checked" data-col="checked">{item.checkedAt
            ? <button type="button" className="nz-a-drift-when" aria-expanded={expanded} aria-controls={`drift-history-${item.jobId}`} onClick={() => onToggle(item.jobId)}>{when(item.checkedAt)}</button>
            : "—"}</td>
        </tr>
        {expanded ? <tr className="nz-a-drift-history" id={`drift-history-${item.jobId}`}><td colSpan={14}>
          <b>Last {item.history.length === 1 ? "check" : `${item.history.length} checks`} of {item.jobNumber}</b>
          <table className="nz-tbl"><thead><tr><th>Checked</th><th>By</th><th>Outcome</th>{SCOPES.map((scope) => <th key={scope} className="num">Scope {scope} difference</th>)}</tr></thead>
            <tbody>{item.history.map((entry) => <tr key={entry.checkedAt}>
              <td>{when(entry.checkedAt)}</td><td>{TRIGGER[entry.trigger] ?? entry.trigger}</td>
              <td>{OUTCOME_LABEL[entry.outcome]}{entry.outcome === "unknown" && entry.unknownReason ? `: ${REASON[entry.unknownReason] ?? entry.unknownReason}` : ""}</td>
              {entry.differences.map((value, at) => <td key={at} className="num"><Difference value={value} /></td>)}
            </tr>)}</tbody></table>
        </td></tr> : null}
      </Fragment>;
    })}</tbody>
  </table></div>;
}

function download(csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `against-the-previous-system-${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date())}.csv` });
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

/** The page's list: the filters, the tally, the CSV and the table, with the query mirrored into the URL. */
export function DriftBoard({ items, initialQuery = DEFAULT_DRIFT_QUERY }: { items: readonly DriftItem[]; initialQuery?: DriftQuery }) {
  const [query, setQuery] = useState<DriftQuery>(initialQuery);
  const [open, setOpen] = useState<string | null>(null);
  const shown = useMemo(() => applyDrift(items, query), [items, query]);
  const update = (patch: Partial<DriftQuery>) => setQuery((current) => {
    const next = { ...current, ...patch };
    window.history.replaceState(null, "", `${window.location.pathname}${driftQueryString(next)}`);
    return next;
  });
  const toggleChip = (chip: DriftChip) => update({ chips: query.chips.includes(chip) ? query.chips.filter((entry) => entry !== chip) : [...query.chips, chip] });
  const filtered = driftQueryString({ ...query, sort: DEFAULT_DRIFT_QUERY.sort, dir: DEFAULT_DRIFT_QUERY.dir }) !== "";

  return <>
    <div className="nz-datalist-toolbar nz-a-drift-filters" role="search" aria-label="Filter imported jobs">
      <label className="nz-a-drift-text"><span className="nz-fl">Search</span>
        <input className="nz-inp" type="search" value={query.text} placeholder="Job, client, outcome — any words, e.g. “gama behind”" onChange={(event) => update({ text: event.target.value })} /></label>
      <label><span className="nz-fl">Difference at least (t)</span>
        <input className="nz-inp nz-a-drift-min" type="number" min={0} step={0.1} inputMode="decimal" value={query.atLeast ?? ""}
          onChange={(event) => update({ atLeast: event.target.value === "" || !Number.isFinite(Number(event.target.value)) ? null : Math.max(0, Number(event.target.value)) })} /></label>
      <label><span className="nz-fl">In</span>
        <select className="nz-sel" value={query.atLeastScope} onChange={(event) => update({ atLeastScope: event.target.value as DriftQuery["atLeastScope"] })}>
          <option value="any">Any scope</option>{SCOPES.map((scope) => <option key={scope} value={scope}>Scope {scope}</option>)}
        </select></label>
      <div className="nz-a-drift-actions">
        {filtered ? <button type="button" className="nz-btn" onClick={() => update({ text: "", chips: [], atLeast: null, atLeastScope: "any" })}>Clear filters</button> : null}
        <button type="button" className="nz-btn" data-drift-csv disabled={shown.length === 0} onClick={() => download(driftCsv(shown))}>Export CSV</button>
      </div>
    </div>
    <div className="nz-a-seg nz-a-drift-chips" role="group" aria-label="Quick filters">
      {DRIFT_CHIPS.map((chip) => <button key={chip.id} type="button" data-chip={chip.id} aria-pressed={query.chips.includes(chip.id)} className={query.chips.includes(chip.id) ? "on" : undefined} onClick={() => toggleChip(chip.id)}>{chip.label}</button>)}
    </div>
    <p className="nz-datalist-count" data-drift-tally role="status">{driftTally(items, shown)}</p>
    {shown.length === 0
      ? <div className="nz-list-empty"><b>{items.length === 0 ? "No job imported from the previous system yet" : "No job matches these filters"}</b>{items.length === 0 ? null : <span>Clear a filter to widen the list.</span>}</div>
      : <DriftTable items={shown} query={query} onSort={(key) => update(nextSort(query, key))} open={open} onToggle={(jobId) => setOpen((current) => current === jobId ? null : jobId)} />}
  </>;
}
