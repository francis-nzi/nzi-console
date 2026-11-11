import { V7_IMPORT_SCOPES, type V7ImportRowStatus, type V7ImportVerdict } from "@nzi/contracts";
import type { V7ImportSessionSummary, V7ImportView } from "@nzi/isolated-backend";

/**
 * The import view (import workbench, Phase 1): read-only. The list of jobs with a summary, and one job's three-way table — the
 * console's copy · the previous system's record now · the status — with Σ per scope on each side and a one-line verdict.
 * Built from the existing admin card, the shared table and the badge; nothing here writes.
 */

export const STATUS_LABEL: Record<V7ImportRowStatus, string> = {
  matched: "Matched", changed: "Changed", "needs-mapping": "Needs mapping", new: "New", withdrawn: "Withdrawn", "linked-pair-changed": "Linked pair changed",
};
const STATUS_HINT: Record<V7ImportRowStatus, string> = {
  matched: "The console's copy equals the record.",
  changed: "The figures moved; the mapping still holds, so the re-sync carries it.",
  "needs-mapping": "What the mapping keyed on moved; a person maps it.",
  new: "Not in the console yet; a person maps it.",
  withdrawn: "Gone from the previous system; a person confirms it goes off.",
  "linked-pair-changed": "Part of a linked pair that moved; a person decides how the pair carries.",
};
export const VERDICT_LINE: Record<V7ImportVerdict, string> = {
  clean: "Clean — every difference is carried by the re-sync, nothing needs a person.",
  "needs-mapping": "Needs mapping — rows the mapping does not cover need a category and factor.",
  "blocked-on-pairs": "Blocked on pairs — a linked pair moved; a person decides how it carries before anything else.",
};

const t = (value: number | null) => (value === null ? "—" : (Math.round(value * 1e6) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 6 }));
const onOff = (value: boolean | null) => (value === null ? "" : value ? "" : " (off)");
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export function ImportSessionsList({ sessions, selected }: { sessions: V7ImportSessionSummary[]; selected: string | null }) {
  return <section className="nz-a-card" aria-labelledby="import-jobs">
    <div className="nz-a-panel-title"><h2 id="import-jobs">Jobs with an import summary</h2><span className="nz-a-hint">{sessions.length} job{sessions.length === 1 ? "" : "s"}</span></div>
    {sessions.length === 0 ? <p className="nz-a-hint" style={{ padding: "14px 18px" }}>No summaries yet. One is made on the operator&rsquo;s machine from a one-job extract and uploaded; only the summary reaches the console.</p> : (
      <div className="nz-table-wrap"><table className="nz-tbl">
        <thead><tr><th>Job</th><th>Verdict</th><th className="num">Matched</th><th className="num">Changed</th><th className="num">Needs mapping</th><th className="num">New</th><th className="num">Withdrawn</th><th className="num">Pairs</th><th>Uploaded</th></tr></thead>
        <tbody>{sessions.map((session) => <tr key={session.sessionId} data-job={session.jobId} aria-current={session.jobId === selected ? "true" : undefined}>
          <td><a href={`/admin/import?job=${encodeURIComponent(session.jobId)}`}><b>{session.jobNumber}</b></a></td>
          <td><span className={`nz-a-badge${session.verdict === "clean" ? " ok" : ""}`} data-verdict={session.verdict}>{session.verdict === "clean" ? "Clean" : session.verdict === "needs-mapping" ? "Needs mapping" : "Blocked on pairs"}</span></td>
          <td className="num">{session.counts.matched}</td><td className="num">{session.counts.changed}</td><td className="num">{session.counts.needsMapping}</td>
          <td className="num">{session.counts.new}</td><td className="num">{session.counts.withdrawn}</td><td className="num">{session.counts.linkedPairChanged}</td>
          <td className="nz-a-mono">{when(session.uploadedAt)}</td>
        </tr>)}</tbody>
      </table></div>)}
  </section>;
}

export function ImportJobView({ view }: { view: V7ImportView }) {
  const { session, rows } = view;
  return <section className="nz-a-card" aria-labelledby="import-job" data-session={session.sessionId}>
    <div className="nz-a-panel-title"><h2 id="import-job">{session.jobNumber} — import reconciliation</h2>
      <span className="nz-a-hint">summary of {when(session.generatedAt)} · extract <span className="nz-a-mono">{session.extractSha256.slice(0, 12)}</span>{view.earlierSessions ? ` · ${view.earlierSessions} earlier` : ""}</span></div>
    <div style={{ padding: "14px 18px 0" }}>
      <div className={`nz-a-hint-strip${session.verdict === "clean" ? "" : " warn"}`} role="status" data-verdict={session.verdict}><span>i</span><div><b>{VERDICT_LINE[session.verdict]}</b> View-only: nothing here changes the job.</div></div>
      <div className="nz-a-subhead">Σ per scope (tCO2e)</div>
    </div>
    <div className="nz-table-wrap"><table className="nz-tbl" data-table="scope-totals">
      <thead><tr><th>Scope</th><th className="num">Console rows</th><th className="num">Console Σ</th><th className="num">Previous system rows</th><th className="num">Previous system Σ</th><th className="num">Difference</th></tr></thead>
      <tbody>{V7_IMPORT_SCOPES.map((scope) => { const totals = session.scopeTotals[scope]; return <tr key={scope} data-scope={scope}>
        <td>Scope {scope}</td><td className="num">{totals.consoleRows}</td><td className="num">{t(totals.consoleTco2e)}</td><td className="num">{totals.v7Rows}</td><td className="num">{t(totals.v7Tco2e)}</td>
        <td className="num">{t(totals.v7Tco2e - totals.consoleTco2e)}</td></tr>; })}</tbody>
    </table></div>
    <div style={{ padding: "0 18px" }}><div className="nz-a-subhead">Rows — console · previous system · status</div></div>
    <div className="nz-table-wrap"><table className="nz-tbl" data-table="rows">
      <thead><tr><th>Record</th><th>Console row</th><th className="num">Console tCO2e</th><th>Code</th><th className="num">Previous system tCO2e</th><th>Status</th><th>What moved</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.legacyDbId} data-status={row.status}>
        <td className="nz-a-mono">{row.legacyDbId}</td>
        <td className="nz-a-mono">{row.consoleRowId ?? "—"}{row.consoleScope ? ` · S${row.consoleScope}` : ""}</td>
        <td className="num">{t(row.consoleFigure)}{onOff(row.consoleEnabled)}</td>
        <td className="nz-a-mono">{row.code ?? "—"}{row.v7Figure === null ? "" : ` · S${row.scope}`}</td>
        <td className="num">{t(row.v7Figure)}{onOff(row.v7Enabled)}</td>
        <td><span className={`nz-a-badge${row.status === "matched" ? " ok" : row.status === "withdrawn" ? " off" : ""}`} title={STATUS_HINT[row.status]}>{STATUS_LABEL[row.status]}</span>
          {row.pairRef ? <div className="nz-a-hint">paired with <span className="nz-a-mono">{row.pairRef}</span></div> : null}</td>
        <td className="nz-a-hint">{row.changedFields.length ? row.changedFields.join(", ") : ""}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
