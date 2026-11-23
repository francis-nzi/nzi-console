import type { ReactNode } from "react";
import { emissionCategoryTaxonomy, V7_IMPORT_SCOPES } from "@nzi/contracts";
import type { V7ImportMapping, V7ImportMappingFlag, V7ImportMappingRow, V7ImportMappingSource } from "@nzi/isolated-backend";
import { STATUS_LABEL, VERDICT_LABEL } from "../admin/import/ImportReconciliation";
import { FIRST_TIME_MAPPING_LINE } from "../clients/[clientId]/importBatchView";

/**
 * The job's mapping view (BRIEF-v7-import-rowid-match-and-mapping-view, Part 2), drawn from one mapping read. Pure: no hooks, no
 * requests, so a test renders it as the panel does. Every row the previous system holds for the job, two sides:
 *   the previous system, as it stands — record, label, site, quantity and unit, its factor, its tCO2e;
 *   the console, intended — category and factor, where that comes from, and whether it is resolved or needs a person (and why).
 * `resolve(row)` is the panel's own control for a flagged row (inline, or the way to Import reconciliation).
 */
export const SOURCE_LABEL: Record<V7ImportMappingSource, string> = {
  decision: "Decision", plan: "Crosswalk plan", console: "As imported", none: "Unmatched",
};
export const FLAG_LABEL: Record<V7ImportMappingFlag, string> = {
  NEW: "New — needs a mapping", NEEDS_MAPPING: "Moved — needs a mapping", WITHDRAWN: "Withdrawn — confirm it goes off",
  DECISION_STALE: "Decision no longer stands", PAIR_TO_CARRY: "Its pair needs carrying", NEEDS_FRESH_SUMMARY: "Needs a fresh summary",
};

const t = (value: number | null) => (value === null ? "—" : (Math.round(value * 1e6) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 6 }));
const categoryName = (code: string | null) => emissionCategoryTaxonomy.find((entry) => entry.code === code)?.name ?? null;

export function flaggedCount(mapping: V7ImportMapping): number {
  return mapping.rows.filter((row) => row.flag !== null).length;
}

function Intended({ row }: { row: V7ImportMappingRow }) {
  if (row.intended.withdraw) return <span>Off at refresh</span>;
  if (!row.intended.categoryCode) return <span className="sub">—</span>;
  return <span><span className="nz-a-mono">{row.intended.categoryCode}</span> {categoryName(row.intended.categoryCode) ?? ""}
    {row.intended.factorId ? <> · <span className="nz-a-mono">{row.intended.factorId}</span></> : null}</span>;
}

export function ImportMappingView({ mapping, resolve }: { mapping: V7ImportMapping; resolve?: (row: V7ImportMappingRow) => ReactNode }) {
  const flagged = flaggedCount(mapping);
  return <div data-mapping={mapping.jobId}>
    {mapping.firstTimeMapping ? <div className="nz-banner warn" role="status" data-first-time-mapping><div><b>{FIRST_TIME_MAPPING_LINE}</b> The console holds only the previous system&rsquo;s scope totals for this job, so its rows there are new here, not changed.</div></div> : null}
    <div className="sub">{mapping.rows.length} row{mapping.rows.length === 1 ? "" : "s"} · {flagged} flagged · {VERDICT_LABEL[mapping.verdict]}</div>
    <div className="nz-table-wrap"><table className="nz-tbl" data-table="mapping-totals">
      <thead><tr><th>Scope</th><th className="num">Previous system rows</th><th className="num">Previous system Σ (tCO2e)</th><th className="num">Console rows</th><th className="num">Console Σ (tCO2e)</th></tr></thead>
      <tbody>{V7_IMPORT_SCOPES.map((scope) => { const totals = mapping.scopeTotals[scope]; return <tr key={scope} data-scope={scope}>
        <td>Scope {scope}</td><td className="num">{totals.v7Rows}</td><td className="num">{t(totals.v7Tco2e)}</td><td className="num">{totals.consoleRows}</td><td className="num">{t(totals.consoleTco2e)}</td></tr>; })}</tbody>
    </table></div>
    <div className="nz-table-wrap"><table className="nz-tbl" data-table="mapping">
      <thead><tr>
        <th>Record</th><th>Label</th><th>Site</th><th className="num">Quantity</th><th>Factor</th><th className="num">tCO2e</th>
        <th>Console mapping</th><th>Source</th><th>Status</th>
      </tr></thead>
      <tbody>{mapping.rows.map((row) => <tr key={row.legacyDbId} data-row={row.legacyDbId} data-source={row.source} data-flag={row.flag ?? "resolved"}>
        <td className="nz-a-mono">{row.legacyDbId}<div className="sub">S{row.scope}{row.previous.enabled === false ? " · off" : ""}</div></td>
        <td>{row.previous.label ?? "—"}</td>
        <td>{row.previous.siteName ?? "—"}</td>
        <td className="num">{t(row.previous.quantity)}{row.previous.unit ? ` ${row.previous.unit}` : ""}</td>
        <td>{row.previous.factorCode ? <span className="nz-a-mono">{row.previous.factorCode}</span> : "—"}
          {row.previous.factor !== null ? <div className="sub">{t(row.previous.factor)}{row.previous.factorUnit ? ` ${row.previous.factorUnit}` : ""}</div> : null}</td>
        <td className="num">{t(row.previous.tco2e)}</td>
        <td><Intended row={row} /></td>
        <td>{SOURCE_LABEL[row.source]}</td>
        <td>{row.flag
          ? <><span className="nz-a-badge" data-flag-code={row.flag}>{FLAG_LABEL[row.flag]}</span>{resolve ? <div>{resolve(row)}</div> : null}</>
          : <span className="nz-a-badge ok" title={STATUS_LABEL[row.status]}>Resolved</span>}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}
