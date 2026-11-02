"use client";
// Portal bulk import — Business Travel (BRIEF-portal-data-entry-parity #3). Download the template, fill it, upload it, check every
// trip against the factor it resolves to, then confirm: the trips are filed together as pending rows that wait for review, or not at
// all. The reading and resolving are the CRM's own (`travelTemplate.ts`); the filing is the portal's `portal.scope.row.import`.
import { useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { PORTAL_IMPORT_MAX_ROWS, travelModeLabel, type FactorOption } from "@nzi/contracts";
import { travelTemplateCsv } from "../jobs/travelTemplate";
import { importErrorText } from "./data/portalImportErrors";
import { portalTravelRow, portalTravelTemplateName, previewPortalTravel, travelFactorOptions, type PortalTravelLine } from "./data/portalTravelImport";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;

export function PortalTravelImport({ base, factors, sites, reportingMonths, canImport, adviser, notice, onImported }: {
  /** `…/jobs/<id>` on the portal API. */
  base: string; factors: FactorOption[]; sites: Array<{ id: string; name: string }>; reportingMonths: string[];
  /** The entry window is open and this is not the staff preview. The command refuses otherwise too. */
  canImport: boolean; adviser: string; notice: Notice; onImported: () => void | Promise<void>;
}) {
  const [lines, setLines] = useState<PortalTravelLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options = useMemo(() => travelFactorOptions(factors), [factors]);
  const ready = lines.filter((line) => line.ready);

  function download() {
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([travelTemplateCsv()], { type: "text/csv;charset=utf-8" }));
    anchor.download = portalTravelTemplateName(reportingMonths);
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  function read(text: string) {
    setError("");
    const preview = previewPortalTravel(text, options, sites);
    if (preview.missing.length) { setLines([]); notice({ kind: "warn", text: `This isn't the travel template: no ${preview.missing.join(", ")} column.` }); return; }
    setLines(preview.lines);
    notice(preview.lines.length ? { kind: "ok", text: `${preview.lines.length} trip${preview.lines.length === 1 ? "" : "s"} read. Check each, then confirm.` } : { kind: "warn", text: "The file has no trip rows." });
  }

  async function confirm() {
    if (busy || !ready.length) return;
    setBusy(true); setError("");
    const result = await postBrowserCommand<{ count: number }>(`${base}/scope-rows/import`, { template: "travel", rows: ready.map(portalTravelRow) }, crypto.randomUUID());
    setBusy(false);
    if (result.state === "success") {
      setLines([]);
      notice({ kind: "ok", text: `${result.data.count} trip${result.data.count === 1 ? "" : "s"} saved to Business Travel. They wait for ${adviser}'s review.` });
      await onImported();
    } else setError(importErrorText(result, ready.map((line) => line.row.rowNumber)));
  }

  return <div className="nz-travel-template">
    <div className="nz-sect">From the template</div>
    <p className="muted">Mode, from, to, distance, unit, nights, spend, passengers, date and site — and for a flight its haul and cabin class. Leave what a mode doesn&rsquo;t use blank. Nothing is saved until you confirm.</p>
    <div className="nz-config-actions">
      <button type="button" className="nz-btn" onClick={download}>Download travel template</button>
      {canImport ? <label className="nz-btn">Upload filled template<input type="file" accept=".csv,text/csv" hidden aria-label="Travel template file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(read); event.target.value = ""; }} /></label> : null}
    </div>
    {canImport ? null : <p className="muted">Importing opens with your entry window.</p>}
    {lines.length ? <>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table className="nz-tbl nz-travel-template-tbl">
          <thead><tr><th>Row</th><th>Trip</th><th>Factor</th><th className="num">Quantity</th><th>Status</th></tr></thead>
          <tbody>{lines.map((line) => <tr key={line.row.rowNumber}>
            <td>{line.row.rowNumber}</td>
            <td><b>{travelModeLabel({ travelMode: line.resolved.mode, airHaul: line.resolved.haul, cabinClass: line.resolved.cabinClass }) || line.row.mode || "—"}</b>
              {line.row.from || line.row.to ? <div className="nz-hint">{[line.row.from, line.row.to].filter(Boolean).join(" → ")}</div> : null}</td>
            <td>{line.resolved.option ? <>{line.resolved.option.label}<div className="nz-hint">per {line.resolved.option.unit}</div></> : <span className="muted">—</span>}</td>
            <td className="num">{line.resolved.quantity ?? "—"}{line.resolved.notes.map((text) => <div key={text} className="nz-hint">{text}</div>)}</td>
            <td><span className={`nz-st ${line.ready ? "need" : "nof"}`}>{line.ready ? "Ready" : "Check"}</span>
              {line.issues.map((text) => <div key={text} className="nz-hint">{text}</div>)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {lines.length > PORTAL_IMPORT_MAX_ROWS ? <p className="nz-banner warn" role="alert">A file imports at most {PORTAL_IMPORT_MAX_ROWS} trips at a time — split this one.</p> : null}
      {error ? <p className="nz-banner warn" role="alert">{error}</p> : null}
      <div className="nz-config-actions" style={{ marginTop: 12 }}>
        <button type="button" className="nz-btn" disabled={busy} onClick={() => { setLines([]); setError(""); }}>Clear</button>
        <button type="button" className="nz-btn pri" disabled={busy || ready.length === 0 || ready.length > PORTAL_IMPORT_MAX_ROWS} onClick={() => void confirm()}>
          {busy ? "Saving…" : `Confirm ${ready.length} trip${ready.length === 1 ? "" : "s"}`}</button>
      </div>
      {lines.length > ready.length ? <p className="muted">{lines.length - ready.length} row{lines.length - ready.length === 1 ? "" : "s"} marked Check {lines.length - ready.length === 1 ? "isn't" : "aren't"} included. Fix {lines.length - ready.length === 1 ? "it" : "them"} in the file and upload again, or add {lines.length - ready.length === 1 ? "it" : "them"} from the drawer.</p> : null}
    </> : null}
  </div>;
}
