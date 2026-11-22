import type { ReactNode } from "react";
import type { V7ImportIngestStage, V7ImportRefreshCommitted, V7ImportRefreshException, V7ImportRefreshPreview, V7ImportScope } from "@nzi/contracts";
import { STATUS_LABEL, VERDICT_LABEL } from "../admin/import/ImportReconciliation";

/**
 * The job's "Refresh from the previous system" result (BRIEF-v7-import-server-side-phase-c §3), drawn from one `import.refresh`
 * preview. Pure: no hooks, no requests, so a test renders it as the panel does.
 *
 *   nothing    — the job is clean: every row matches. Not an error, and not a refusal to explain: "Nothing to refresh".
 *   exceptions — rows still need a person. Only those rows are listed (ids, codes, states), never the rows that match.
 *   ready      — it would commit: Σ previous system against Σ live per scope, as D7 reconciled them.
 *   refused    — a step refused (D7's reconciliation, most often): the step and its codes, nothing written.
 */
export type ImportRefreshState =
  | { applies: false }
  | { applies: true; jobId: string; legacyJobNumber: string; writeEnabled: boolean; commitNeedsAdmin: boolean; isAdmin: boolean; canResolve: boolean };

export type ImportRefreshView =
  | { kind: "nothing" }
  | { kind: "exceptions"; exceptions: V7ImportRefreshException[] }
  | { kind: "ready"; totals: Array<{ scope: V7ImportScope; previous: number; live: number }> }
  | { kind: "refused"; stage: V7ImportIngestStage; issues: Array<{ code: string; message: string }> };

export const NOTHING_TO_REFRESH = "Nothing to refresh";

export function refreshViewOf(preview: V7ImportRefreshPreview): ImportRefreshView {
  if (preview.outcome === "would-commit" && preview.scopeTotals) {
    return { kind: "ready", totals: (["1", "2", "3"] as const).map((scope) => ({ scope, previous: preview.scopeTotals![scope].v7Tco2e, live: preview.scopeTotals![scope].liveTco2e })) };
  }
  // Phase B refuses a clean job at "ready" (NOT_READY_TO_INGEST, verdict clean): here, that is simply nothing to do.
  if (preview.refusal?.stage === "ready" && preview.verdict === "clean") return { kind: "nothing" };
  if (preview.refusal?.stage === "ready" && preview.exceptions.length) return { kind: "exceptions", exceptions: preview.exceptions };
  const refusal = preview.refusal ?? { stage: "reingest" as const, issues: [{ field: "jobId", code: "NOT_COMMITTED", message: "The re-ingest did not commit." }] };
  return { kind: "refused", stage: refusal.stage, issues: refusal.issues.map(({ code, message }) => ({ code, message })) };
}

const STAGE_LABEL: Record<V7ImportIngestStage, string> = {
  ready: "the readiness check", revert: "reverting the standing re-ingest", resync: "the re-sync", replan: "the re-plan", reingest: "the re-ingest's reconciliation",
};
const RESOLUTION_LABEL: Record<V7ImportRefreshException["resolution"], string> = {
  matched: "Matched", "auto-accepted": "Accepted", resolved: "Resolved", stale: "Decision no longer stands", unresolved: "Needs a decision",
};
const t = (value: number) => (Math.round(value * 1e6) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 6 });

function ScopeTotals({ totals }: { totals: Extract<ImportRefreshView, { kind: "ready" }>["totals"] }) {
  return <div className="nz-table-wrap"><table className="nz-tbl">
    <thead><tr><th>Scope</th><th>Previous system (tCO2e)</th><th>Live (tCO2e)</th></tr></thead>
    <tbody>{totals.map((row) => <tr key={row.scope} data-scope={row.scope}><td>Scope {row.scope}</td><td>{t(row.previous)}</td><td>{t(row.live)}</td></tr>)}</tbody>
  </table></div>;
}

/** Phase D (R-4): what one action did. `refreshed` — committed with the system reason; `deliberate` — Phase C's flow, and why. */
export type FastPathBlocker = "issued-report" | "manual-edits" | "flagged" | "admin-commits";
export type FastPathOutcome =
  | { fastPath: "refreshed"; preview: V7ImportRefreshPreview; committed: V7ImportRefreshCommitted; auditEventId: string }
  | { fastPath: "deliberate"; preview: V7ImportRefreshPreview; because: FastPathBlocker[]; flagged: number };

export const REFRESHED_AUTOMATICALLY = "Refreshed automatically";

/** The one line saying why a refresh was not automatic; null when there is nothing to say (a clean job: nothing to refresh). */
export function notAutomaticLine(outcome: Extract<FastPathOutcome, { fastPath: "deliberate" }>): string | null {
  if (refreshViewOf(outcome.preview).kind === "nothing") return null;
  const parts = blockerParts(outcome.because, outcome.flagged);
  return parts.length ? `Not automatic: ${parts.join(" · ")}.` : null;
}

/** Each blocker in words — the job's one line and the batch's review queue (Phase E) say it the same way. */
export function blockerParts(because: readonly FastPathBlocker[], flagged: number): string[] {
  return because.map((blocker) => blocker === "issued-report" ? "issued report"
    : blocker === "manual-edits" ? "manual edits"
      : blocker === "admin-commits" ? "an Admin commits on this organisation"
        : flagged > 0 ? `${flagged} flagged` : "it would not reconcile");
}

/** An eligible job, refreshed in one action: Σ previous system against Σ live per scope, and the audit id. */
export function FastPathRefreshedView({ outcome }: { outcome: Extract<FastPathOutcome, { fastPath: "refreshed" }> }) {
  const view = refreshViewOf(outcome.preview);
  return <div data-refresh="refreshed">
    <div className="nz-banner ok" role="status"><div><b>{REFRESHED_AUTOMATICALLY}.</b> No issued report, no manual edits, nothing flagged: the job&rsquo;s rows now match the previous system; the new rows wait for a reviewer&rsquo;s attest.</div></div>
    {view.kind === "ready" ? <ScopeTotals totals={view.totals} /> : null}
    <div className="sub">Audit {outcome.auditEventId}</div>
  </div>;
}

/** What one preview shows. `resolve` (for a resolver) and `commit` (on a ready preview) are the panel's own controls. */
export function ImportRefreshPreviewView({ preview, resolve, commit }: { preview: V7ImportRefreshPreview; resolve?: ReactNode; commit?: ReactNode }) {
  const view = refreshViewOf(preview);
  if (view.kind === "nothing") {
    return <div className="nz-list-empty" data-refresh="nothing" role="status"><b>{NOTHING_TO_REFRESH}</b><span>Every row matches the previous system&rsquo;s record now.</span></div>;
  }
  if (view.kind === "exceptions") {
    return <div data-refresh="exceptions">
      <div className="nz-banner warn" role="status"><div>{view.exceptions.length === 1 ? "1 row needs" : `${view.exceptions.length} rows need`} a decision before this job can be refreshed ({VERDICT_LABEL[preview.verdict].toLowerCase()}). Only those rows are listed.</div></div>
      <div className="nz-table-wrap"><table className="nz-tbl">
        <thead><tr><th>Record</th><th>Scope</th><th>Code</th><th>What changed</th><th>State</th></tr></thead>
        <tbody>{view.exceptions.map((row) => <tr key={row.legacyDbId} data-exception={row.legacyDbId}>
          <td>{row.legacyDbId}</td><td>{row.scope}</td><td>{row.code ?? "—"}</td>
          <td>{STATUS_LABEL[row.status]}{row.status === "linked-pair-changed" ? ` (${STATUS_LABEL[row.ownStatus].toLowerCase()} on its own)` : ""}</td>
          <td>{row.carry === "awaiting" ? "Its pair needs carrying" : row.carry === "needs-fresh-summary" ? "Needs a fresh summary" : RESOLUTION_LABEL[row.resolution]}</td>
        </tr>)}</tbody>
      </table></div>
      {resolve}
    </div>;
  }
  if (view.kind === "refused") {
    return <div className="nz-banner warn" role="alert" data-refresh="refused"><div>
      <b>Would not refresh: refused at {STAGE_LABEL[view.stage]}.</b> Nothing was written.
      <ul>{view.issues.map((issue, at) => <li key={`${issue.code}-${at}`}><span>{issue.code}</span> — {issue.message}</li>)}</ul>
    </div></div>;
  }
  return <div data-refresh="ready">
    <div className="nz-banner ok" role="status"><div>Ready: the live rows reconcile to the previous system in every scope. Nothing has been written yet.</div></div>
    <ScopeTotals totals={view.totals} />
    {preview.chain.resync ? <div className="sub">Re-sync: {preview.chain.resync.unchanged} unchanged · {preview.chain.resync.superseded} superseded · {preview.chain.resync.added} added · {preview.chain.resync.withdrawn} withdrawn{preview.chain.plan ? ` · plan: ${preview.chain.plan.committed} from the committed plan, ${preview.chain.plan.decided} from decisions` : ""}</div> : null}
    {commit}
  </div>;
}
