import { V7_IMPORT_SCOPES, type V7ImportResolvedVerdict, type V7ImportRowStatus } from "@nzi/contracts";
import type { V7ImportWorkbenchSession, V7ImportWorkbenchView } from "@nzi/isolated-backend";
import { ImportPairCarry } from "./ImportPairCarry";
import { ImportResolution } from "./ImportResolution";

/**
 * The import view (import workbench, Phases 1–2). The list of jobs with a summary, and one job's three-way table — the
 * console's copy · the previous system's record now · the status — with Σ per scope on each side, each row's resolution
 * control inline (Phase 2), and the verdict its decisions give. Built from the existing admin card, the shared table and the
 * badge. A linked pair that moved is carried as a group (ruled: A, carry both, unlinked), each member then resolved under its own
 * status. Decisions are kept against the job; nothing here changes a job's rows or ingests.
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
export const VERDICT_LABEL: Record<V7ImportResolvedVerdict, string> = {
  clean: "Clean", "ready-to-ingest": "Ready to ingest", "needs-confirmation": "Needs confirmation", "needs-mapping": "Needs mapping", "blocked-on-pairs": "Blocked on pairs",
};
export const VERDICT_LINE: Record<V7ImportResolvedVerdict, string> = {
  clean: "Clean — every row matches the previous system's record; there is nothing to ingest.",
  "ready-to-ingest": "Ready to ingest — every row that differs is resolved, and every mapping is valid. Ingest is the next phase.",
  "needs-confirmation": "Needs confirmation — withdrawn rows wait for a person to confirm they go off.",
  "needs-mapping": "Needs mapping — rows the mapping does not cover need a category and factor.",
  "blocked-on-pairs": "Blocked on pairs — a linked pair moved; a person decides how it carries before anything else.",
};
const ready = (verdict: V7ImportResolvedVerdict) => verdict === "clean" || verdict === "ready-to-ingest";

const t = (value: number | null) => (value === null ? "—" : (Math.round(value * 1e6) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 6 }));
const onOff = (value: boolean | null) => (value === null ? "" : value ? "" : " (off)");
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export function ImportSessionsList({ sessions, selected }: { sessions: V7ImportWorkbenchSession[]; selected: string | null }) {
  return <section className="nz-a-card" aria-labelledby="import-jobs">
    <div className="nz-a-panel-title"><h2 id="import-jobs">Jobs with an import summary</h2><span className="nz-a-hint">{sessions.length} job{sessions.length === 1 ? "" : "s"}</span></div>
    {sessions.length === 0 ? <p className="nz-a-hint" style={{ padding: "14px 18px" }}>No summaries yet. One is made on the operator&rsquo;s machine from a one-job extract and uploaded; only the summary reaches the console.</p> : (
      <div className="nz-table-wrap"><table className="nz-tbl">
        <thead><tr><th>Job</th><th>Verdict</th><th className="num">Resolved</th><th className="num">Matched</th><th className="num">Changed</th><th className="num">Needs mapping</th><th className="num">New</th><th className="num">Withdrawn</th><th className="num">Pairs</th><th>Uploaded</th></tr></thead>
        <tbody>{sessions.map((session) => <tr key={session.sessionId} data-job={session.jobId} aria-current={session.jobId === selected ? "true" : undefined}>
          <td><a href={`/admin/import?job=${encodeURIComponent(session.jobId)}`}><b>{session.jobNumber}</b></a></td>
          <td><span className={`nz-a-badge${ready(session.resolvedVerdict) ? " ok" : ""}`} data-verdict={session.resolvedVerdict}>{VERDICT_LABEL[session.resolvedVerdict]}</span></td>
          <td className="num">{session.resolved} / {session.toResolve}</td>
          <td className="num">{session.counts.matched}</td><td className="num">{session.counts.changed}</td><td className="num">{session.counts.needsMapping}</td>
          <td className="num">{session.counts.new}</td><td className="num">{session.counts.withdrawn}</td><td className="num">{session.counts.linkedPairChanged}</td>
          <td className="nz-a-mono">{when(session.uploadedAt)}</td>
        </tr>)}</tbody>
      </table></div>)}
  </section>;
}

export function ImportJobView({ view }: { view: V7ImportWorkbenchView }) {
  const { session, rows } = view;
  const resolutionOf = new Map(view.resolutions.map((entry) => [entry.legacyDbId, entry]));
  const pairs = view.groups.filter((group) => group.moved);
  const stalePairs = view.resolutions.some((entry) => entry.carry === "needs-fresh-summary");
  return <section className="nz-a-card" aria-labelledby="import-job" data-session={session.sessionId}>
    <div className="nz-a-panel-title"><h2 id="import-job">{session.jobNumber} — import reconciliation</h2>
      <span className="nz-a-hint">summary of {when(session.generatedAt)} · extract <span className="nz-a-mono">{session.extractSha256.slice(0, 12)}</span>{view.earlierSessions ? ` · ${view.earlierSessions} earlier` : ""}</span></div>
    <div style={{ padding: "14px 18px 0" }}>
      <div className={`nz-a-hint-strip${ready(view.resolvedVerdict) ? "" : " warn"}`} role="status" data-verdict={view.resolvedVerdict}><span>i</span><div><b>{VERDICT_LINE[view.resolvedVerdict]}</b> Decisions are kept against the job and carry over to a fresh summary; nothing here changes the job&rsquo;s rows.</div></div>
      <div className="nz-a-subhead">Σ per scope (tCO2e)</div>
    </div>
    <div className="nz-table-wrap"><table className="nz-tbl" data-table="scope-totals">
      <thead><tr><th>Scope</th><th className="num">Console rows</th><th className="num">Console Σ</th><th className="num">Previous system rows</th><th className="num">Previous system Σ</th><th className="num">Difference</th></tr></thead>
      <tbody>{V7_IMPORT_SCOPES.map((scope) => { const totals = session.scopeTotals[scope]; return <tr key={scope} data-scope={scope}>
        <td>Scope {scope}</td><td className="num">{totals.consoleRows}</td><td className="num">{t(totals.consoleTco2e)}</td><td className="num">{totals.v7Rows}</td><td className="num">{t(totals.v7Tco2e)}</td>
        <td className="num">{t(totals.v7Tco2e - totals.consoleTco2e)}</td></tr>; })}</tbody>
    </table></div>
    {pairs.length ? <>
      <div style={{ padding: "0 18px" }}><div className="nz-a-subhead">Linked pairs — each group carries as one</div></div>
      <div className="nz-table-wrap"><table className="nz-tbl" data-table="pairs">
        <thead><tr><th>Pair group</th><th>Members</th><th>T&amp;D quantity</th><th>Carry</th></tr></thead>
        <tbody>{pairs.map((group) => { const first = resolutionOf.get(group.members[0]!); return <tr key={group.pairGroup} data-pair-group={group.pairGroup} data-carry={group.carried ? "carried" : "awaiting"}>
          <td className="nz-a-mono">{group.pairGroup}</td>
          <td className="nz-a-mono">{group.members.join(", ")}</td>
          <td>{group.quantityConsistent ? <span className="nz-a-hint">equals its parents</span>
            : <span className="nz-a-badge" data-quantity="inconsistent" title="In the previous system's records, the T&amp;D quantity is not the apportioned sum of its parents.">Differs from its parents</span>}</td>
          <td><ImportPairCarry jobId={session.jobId} firstMember={group.members[0]!} carried={group.carried} carryDecisionId={first?.carryDecision?.decisionId ?? null} /></td>
        </tr>; })}</tbody>
      </table></div>
    </> : null}
    {stalePairs ? <div style={{ padding: "0 18px" }}><div className="nz-a-hint-strip warn" role="status"><span>i</span><div>This summary predates pair groups, so its linked pairs cannot be carried. Make and upload a fresh summary of the job.</div></div></div> : null}
    <div style={{ padding: "0 18px" }}><div className="nz-a-subhead">Rows — console · previous system · status · resolution</div></div>
    <div className="nz-table-wrap"><table className="nz-tbl" data-table="rows">
      <thead><tr><th>Record</th><th>Console row</th><th className="num">Console tCO2e</th><th>Code</th><th className="num">Previous system tCO2e</th><th>Status</th><th>What moved</th><th>Resolution</th></tr></thead>
      <tbody>{rows.map((row) => { const entry = resolutionOf.get(row.legacyDbId); return <tr key={row.legacyDbId} data-status={row.status} data-resolution={entry?.resolution}>
        <td className="nz-a-mono">{row.legacyDbId}</td>
        <td className="nz-a-mono">{row.consoleRowId ?? "—"}{row.consoleScope ? ` · S${row.consoleScope}` : ""}</td>
        <td className="num">{t(row.consoleFigure)}{onOff(row.consoleEnabled)}</td>
        <td className="nz-a-mono">{row.code ?? "—"}{row.v7Figure === null ? "" : ` · S${row.scope}`}</td>
        <td className="num">{t(row.v7Figure)}{onOff(row.v7Enabled)}</td>
        <td><span className={`nz-a-badge${row.status === "matched" ? " ok" : row.status === "withdrawn" ? " off" : ""}`} title={STATUS_HINT[row.status]}>{STATUS_LABEL[row.status]}</span>
          {row.pairRef ? <div className="nz-a-hint">paired with <span className="nz-a-mono">{row.pairRef}</span></div> : null}
          {entry?.carry === "carried" ? <div className="nz-a-hint" data-carry="carried">pair carried</div> : entry?.carry === "awaiting" ? <div className="nz-a-hint" data-carry="awaiting">pair to carry</div> : null}</td>
        <td className="nz-a-hint">{row.changedFields.length ? row.changedFields.join(", ") : ""}</td>
        <td>{entry ? <ImportResolution jobId={session.jobId} legacyDbId={row.legacyDbId} status={entry.ownStatus} scope={row.scope}
          resolution={entry.resolution} decision={entry.decision} invalid={entry.invalid} /> : null}</td>
      </tr>; })}</tbody>
    </table></div>
  </section>;
}
