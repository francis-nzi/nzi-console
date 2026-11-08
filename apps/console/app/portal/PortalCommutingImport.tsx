"use client";
// Portal bulk import — Employee Commuting (BRIEF-portal-data-entry-parity #3). Download the template, fill it, upload it, choose each
// line's factor (pre-filled with the category's declared one), then confirm: the commuters are filed together as pending rows that wait
// for review, or not at all. The file is read in the browser with the CRM's own reader; the employee column is never sent.
import { useEffect, useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { PORTAL_IMPORT_MAX_ROWS, type FactorOption } from "@nzi/contracts";
import { declaredOptionFor, entryFactorRefsFor, optionsForCategory, type DeclaredFactorPreviewResult, type EntryFactorRef } from "../jobs/emissionEntryModel";
import { commutingLineReady, portalCommutingRow, portalCommutingTemplateCsv, portalCommutingTemplateName, previewPortalCommuting, type PortalCommutingLine } from "./data/portalCommutingImport";
import { importErrorText } from "./data/portalImportErrors";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;

export function PortalCommutingImport({ base, factors, sites, existingCommuters, reportingMonths, canImport, adviser, notice, onImported }: {
  /** `…/jobs/<id>` on the portal API. */
  base: string; factors: FactorOption[]; sites: Array<{ id: string; name: string }>; existingCommuters: number; reportingMonths: string[];
  /** The entry window is open and this is not the staff preview. The command refuses otherwise too. */
  canImport: boolean; adviser: string; notice: Notice; onImported: () => void | Promise<void>;
}) {
  const [lines, setLines] = useState<PortalCommutingLine[]>([]);
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<DeclaredFactorPreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Commuters belong to a site (uplift is per site): a one-site client's is the only choice, otherwise the file is for the site picked.
  const [siteId, setSiteId] = useState(sites.length === 1 ? sites[0]!.id : "");
  const siteMissing = sites.length > 0 && siteId === "";
  const [error, setError] = useState("");

  // The category's declared factor and exclusions, from the same resolution the write uses — a convenience the write never needs.
  useEffect(() => {
    let live = true;
    void fetch(`${base}/declared-factor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ categoryCode: "3.7", scope: "3.7" }) })
      .then((response) => (response.ok ? response.json() : null)).then((result) => { if (live) setPreview(result); }).catch(() => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [base]);

  const options = useMemo(() => optionsForCategory(entryFactorRefsFor(factors).filter((option) => option.scope === "3"), preview), [factors, preview]);
  const declaredId = declaredOptionFor(preview, options)?.optionId ?? "";
  const factorFor = (line: PortalCommutingLine): EntryFactorRef | null => options.find((option) => option.id === (chosen[line.rowNumber] ?? declaredId)) ?? null;
  const ready = lines.filter((line) => commutingLineReady(line, factorFor(line)));

  function download() {
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([portalCommutingTemplateCsv()], { type: "text/csv;charset=utf-8" }));
    anchor.download = portalCommutingTemplateName(reportingMonths);
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  function read(text: string) {
    setError(""); setChosen({});
    const result = previewPortalCommuting(text);
    if (!result.looksLikeTemplate) { setLines([]); notice({ kind: "warn", text: "This isn't the commuting template: it needs a commute mode and a distance column." }); return; }
    setLines(result.lines);
    notice(result.lines.length ? { kind: "ok", text: `${result.lines.length} commuter${result.lines.length === 1 ? "" : "s"} read. Check each, then confirm.` } : { kind: "warn", text: "The file has no commuting rows." });
  }

  async function confirm() {
    if (busy || !ready.length || siteMissing) return;
    setBusy(true); setError("");
    const rows = ready.map((line, index) => portalCommutingRow(line, existingCommuters + index + 1, factorFor(line)!, factors, siteId || null));
    const result = await postBrowserCommand<{ count: number }>(`${base}/scope-rows/import`, { template: "commuting", rows }, crypto.randomUUID());
    setBusy(false);
    if (result.state === "success") {
      setLines([]); setChosen({});
      notice({ kind: "ok", text: `${result.data.count} commuter${result.data.count === 1 ? "" : "s"} saved to Employee Commuting. They wait for ${adviser}'s review.` });
      await onImported();
    } else setError(importErrorText(result, ready.map((line) => line.rowNumber)));
  }

  return <div className="nz-commuting-template">
    <div className="nz-sect">From the template</div>
    <p className="muted">One row per commuter: commute mode, distance per year and unit, and working-from-home days and hours. The employee column only lines the file up — names are never saved; each commuter is filed by number and mode. Nothing is saved until you confirm.</p>
    {sites.length > 1 ? <label className="nz-fl" data-commuting-site>Site this file is for
      <select className="nz-sel" value={siteId} onChange={(event) => setSiteId(event.target.value)}>
        <option value="">Choose a site</option>
        {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
      </select></label> : null}
    <div className="nz-config-actions">
      <button type="button" className="nz-btn" onClick={download}>Download commuting template</button>
      {canImport ? <label className="nz-btn">Upload filled template<input type="file" accept=".csv,text/csv" hidden aria-label="Commuting template file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(read); event.target.value = ""; }} /></label> : null}
    </div>
    {canImport ? null : <p className="muted">Importing opens with your entry window.</p>}
    {lines.length ? <>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table className="nz-tbl">
          <thead><tr><th>Row</th><th>Mode</th><th className="num">Distance / year</th><th>Factor</th><th>Status</th></tr></thead>
          <tbody>{lines.map((line) => {
            const factor = factorFor(line);
            const okay = commutingLineReady(line, factor);
            return <tr key={line.rowNumber}>
              <td>{line.rowNumber}</td>
              <td><b>{line.mode || "—"}</b></td>
              <td className="num">{line.distance ?? "—"} {line.distanceUnit === "mi" ? "miles" : "km"}</td>
              <td><select className="nz-sel" aria-label={`Factor for row ${line.rowNumber}`} value={factor?.id ?? ""} onChange={(event) => setChosen((current) => ({ ...current, [line.rowNumber]: event.target.value }))}>
                <option value="">Select a factor</option>
                {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select></td>
              <td><span className={`nz-st ${okay ? "need" : "nof"}`}>{okay ? "Ready" : "Check"}</span>
                {line.issues.map((text) => <div key={text} className="nz-hint">{text}</div>)}
                {line.issues.length === 0 && !factor ? <div className="nz-hint">Choose a factor.</div> : null}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {options.length === 0 ? <p className="nz-banner warn" role="alert">No commuting factors are available on this job yet.</p> : null}
      {lines.length > PORTAL_IMPORT_MAX_ROWS ? <p className="nz-banner warn" role="alert">A file imports at most {PORTAL_IMPORT_MAX_ROWS} commuters at a time — split this one.</p> : null}
      {error ? <p className="nz-banner warn" role="alert">{error}</p> : null}
      <div className="nz-config-actions" style={{ marginTop: 12 }}>
        <button type="button" className="nz-btn" disabled={busy} onClick={() => { setLines([]); setChosen({}); setError(""); }}>Clear</button>
        <button type="button" className="nz-btn pri" disabled={busy || siteMissing || ready.length === 0 || ready.length > PORTAL_IMPORT_MAX_ROWS} onClick={() => void confirm()}>
          {busy ? "Saving…" : `Confirm ${ready.length} commuter${ready.length === 1 ? "" : "s"}`}</button>
      </div>
      {lines.length > ready.length ? <p className="muted">{lines.length - ready.length} row{lines.length - ready.length === 1 ? "" : "s"} marked Check {lines.length - ready.length === 1 ? "isn't" : "aren't"} included until fixed in the file or given a factor.</p> : null}
    </> : null}
  </div>;
}
