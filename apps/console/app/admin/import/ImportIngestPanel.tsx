import { V7_IMPORT_SCOPES, type V7ImportIngestTotals, type V7ImportResolvedVerdict } from "@nzi/contracts";
import type { V7ImportIngestState } from "@nzi/isolated-backend";

/**
 * The ingest (import workbench, Phase 3): read-only. The job's latest rehearsal — the whole chain run on the operator's machine
 * and rolled back — with its reconciliation (Σ per scope, the previous system's against the console's) or the step and codes
 * that refused it; and the ingest itself once it is committed, with its re-ingest run and how many of its rows a reviewer has
 * attested. The ingest is run by the operator's script, where the extract is (R-A option 1): there is no ingest button.
 */
const t = (value: number) => (Math.round(value * 1e6) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 6 });
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
const STAGE: Record<string, string> = { ready: "the readiness check", revert: "reverting the standing re-ingest", resync: "the re-sync", replan: "the plan", reingest: "the re-ingest (D7)" };

function Totals({ totals, name }: { totals: V7ImportIngestTotals; name: string }) {
  return <div className="nz-table-wrap"><table className="nz-tbl" data-table={name}>
    <thead><tr><th>Scope</th><th className="num">Previous system Σ</th><th className="num">Console Σ</th><th className="num">Difference</th></tr></thead>
    <tbody>{V7_IMPORT_SCOPES.map((scope) => <tr key={scope} data-scope={scope}><td>Scope {scope}</td><td className="num">{t(totals[scope].v7Tco2e)}</td>
      <td className="num">{t(totals[scope].liveTco2e)}</td><td className="num">{t(totals[scope].liveTco2e - totals[scope].v7Tco2e)}</td></tr>)}</tbody>
  </table></div>;
}

export function ImportIngestPanel({ state, verdict }: { state: V7ImportIngestState; verdict: V7ImportResolvedVerdict }) {
  const { rehearsal, ingest } = state;
  return <section className="nz-a-card" aria-labelledby="import-ingest" data-panel="ingest">
    <div className="nz-a-panel-title"><h2 id="import-ingest">Ingest</h2><span className="nz-a-hint">run on the operator&rsquo;s machine, where the extract is</span></div>
    <div style={{ padding: "14px 18px 0" }}>
      {ingest ? <div className={`nz-a-hint-strip${ingest.runStatus === "completed" ? "" : " warn"}`} role="status" data-ingest={ingest.runStatus ?? "unknown"}><span>i</span><div>
        <b>{ingest.runStatus === "completed" ? "Ingested" : "Ingested, since reverted"}</b> {when(ingest.createdAt)} · re-ingest run <span className="nz-a-mono">{ingest.reingestRunId}</span>
        {ingest.plan ? ` · ${ingest.plan.committed} row(s) from the committed plan, ${ingest.plan.decided} from the decisions` : ""}
        {ingest.runStatus === "completed" ? ` · attested ${ingest.rowsApproved} of ${ingest.rowsApproved + ingest.rowsPending} row(s)${ingest.rowsPending ? " — a reviewer attests the rest in the job's review" : ""}` : ""}
      </div></div> : null}
      {!ingest && verdict === "ready-to-ingest" && !(rehearsal?.current && rehearsal.outcome === "would-commit")
        ? <div className="nz-a-hint-strip" role="status" data-ingest="ready"><span>i</span><div>Ready to ingest. The operator rehearses and ingests this job with the import-ingest script; nothing is written until the rehearsal reconciles.</div></div> : null}
      {!ingest && verdict !== "ready-to-ingest" && verdict !== "clean" && !rehearsal
        ? <p className="nz-a-hint">Not ready to ingest yet: resolve every row that differs first.</p> : null}
    </div>
    {ingest?.scopeTotals ? <><div style={{ padding: "0 18px" }}><div className="nz-a-subhead">Ingested — Σ per scope (tCO2e), as D7 reconciled it</div></div><Totals totals={ingest.scopeTotals} name="ingest-totals" /></> : null}
    {rehearsal ? <>
      <div style={{ padding: "0 18px" }}>
        <div className="nz-a-subhead">Latest rehearsal — {when(rehearsal.createdAt)}, rolled back</div>
        <div className={`nz-a-hint-strip${rehearsal.outcome === "would-commit" && rehearsal.current ? "" : " warn"}`} role="status" data-rehearsal={rehearsal.outcome}><span>i</span><div>
          <b>{rehearsal.outcome === "would-commit" ? "Would commit — D7 met" : `Refused at ${STAGE[rehearsal.refusedStage ?? ""] ?? rehearsal.refusedStage}`}</b>
          {rehearsal.refusalCodes.length ? <> · <span className="nz-a-mono">{rehearsal.refusalCodes.join(", ")}</span></> : null}
          {rehearsal.resync ? ` · re-sync: ${rehearsal.resync.superseded} superseded, ${rehearsal.resync.added} added, ${rehearsal.resync.withdrawn} withdrawn, ${rehearsal.resync.unchanged} unchanged` : ""}
          {rehearsal.plan ? ` · plan: ${rehearsal.plan.committed} committed + ${rehearsal.plan.decided} decided` : ""}
          {rehearsal.current ? "" : <div data-rehearsal-current="false">The summary or the decisions have changed since; rehearse again before ingesting.</div>}
        </div></div>
      </div>
      {rehearsal.scopeTotals ? <Totals totals={rehearsal.scopeTotals} name="rehearsal-totals" /> : null}
    </> : null}
  </section>;
}
