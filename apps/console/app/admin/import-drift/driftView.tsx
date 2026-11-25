import type { V7DriftListItem } from "@nzi/isolated-backend";

/**
 * The Admin list of every job imported from the previous system against it (BRIEF-v7-import-j000663 Part C): the console's scope totals,
 * the previous system's, and the difference, at each job's latest check, sorted by the difference. Pure: what one read returns.
 * A job never checked, or one the previous system could not answer for, shows no figure: never a zero.
 */
const t = (value: number | null) => value === null ? "—" : value.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const signed = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${t(value)}`;
const OUTCOME: Record<V7DriftListItem["outcome"], string> = { level: "Level", behind: "Behind", unknown: "Can't check", unchecked: "Not checked" };
const REASON: Record<string, string> = {
  "not-configured": "the previous system's figures are not connected yet", unreachable: "the previous system did not answer", timeout: "the previous system took too long",
  "not-found": "the previous system does not hold this job", "cannot-compute": "the previous system could not work it out", busy: "the previous system was busy",
  contract: "the previous system's answer was not in the agreed form", refused: "the connection to the previous system is refused",
};

export function DriftList({ items }: { items: readonly V7DriftListItem[] }) {
  const behind = items.filter((item) => item.outcome === "behind").length;
  return <>
    <p className="nz-a-hint" data-drift-tally>{items.length} imported job{items.length === 1 ? "" : "s"} · {behind} behind · {items.filter((item) => item.outcome === "level").length} level · {items.filter((item) => item.outcome === "unknown").length} can&rsquo;t check · {items.filter((item) => item.outcome === "unchecked").length} not checked</p>
    <div className="nz-table-wrap"><table className="nz-tbl" data-drift-list>
      <thead><tr><th>Job</th><th>Client</th><th>Outcome</th>{(["1", "2", "3"] as const).map((scope) => <th key={scope} className="num">Scope {scope}: here · previous system · difference</th>)}<th>Checked</th></tr></thead>
      <tbody>{items.map((item) => <tr key={item.jobId} data-drift-job={item.jobNumber} data-outcome={item.outcome}>
        <td><a href={`/jobs/${encodeURIComponent(item.jobId)}`}>{item.jobNumber}</a>{item.spansTwoYears ? <div className="nz-a-hint">two dataset years</div> : null}</td>
        <td>{item.clientName}</td>
        <td>{OUTCOME[item.outcome]}{item.outcome === "unknown" && item.unknownReason ? <div className="nz-a-hint">{REASON[item.unknownReason] ?? item.unknownReason}</div> : null}</td>
        {item.scopes.map((entry) => <td key={entry.scope} className="num" data-scope={entry.scope}>{t(entry.console)} · {t(entry.previous)} · <b>{signed(entry.difference)}</b></td>)}
        <td>{item.checkedAt ? new Date(item.checkedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }) : "—"}</td>
      </tr>)}</tbody>
    </table></div>
  </>;
}
