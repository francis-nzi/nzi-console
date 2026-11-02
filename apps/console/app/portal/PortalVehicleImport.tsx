"use client";
// Portal bulk import — Company Vehicles (BRIEF-portal-data-entry-parity #3). Download the template, fill it, upload it, check every
// vehicle against the factor its type · size · fuel resolves to, then confirm: the vehicles are filed together as pending rows that wait
// for review, or not at all. The reading and resolving are the CRM's own (`vehicleTemplate.ts`); the filing is `portal.scope.row.import`.
// A plate goes only to the write's sealed identifier — never shown back, never in a label or note.
import { useEffect, useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { PORTAL_IMPORT_MAX_ROWS, type FactorOption, type JobEntryBasis } from "@nzi/contracts";
import { importErrorText } from "./data/portalImportErrors";
import { portalVehicleRow, portalVehicleTemplateCsv, portalVehicleTemplateName, previewPortalVehicles, vehicleFactorOptions, type PortalVehicleLine } from "./data/portalVehicleImport";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;

export function PortalVehicleImport({ base, factors, sites, reportingMonths, canImport, adviser, notice, onImported }: {
  /** `…/jobs/<id>` on the portal API. */
  base: string; factors: FactorOption[]; sites: Array<{ id: string; name: string }>; reportingMonths: string[];
  /** The entry window is open and this is not the staff preview. The command refuses otherwise too. */
  canImport: boolean; adviser: string; notice: Notice; onImported: () => void | Promise<void>;
}) {
  const [lines, setLines] = useState<PortalVehicleLine[]>([]);
  const [optedOut, setOptedOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options = useMemo(() => vehicleFactorOptions(factors), [factors]);
  const ready = lines.filter((line) => line.ready);

  // Whether this client holds no vehicle registrations (then each vehicle is named, and the name is the identifier).
  useEffect(() => {
    let live = true;
    void fetch(`${base}/entry-basis`, { cache: "no-store" }).then((response) => (response.ok ? response.json() : null))
      .then((basis: JobEntryBasis | null) => { if (live) setOptedOut(basis?.vehicleRegistrationsOptOut === true); }).catch(() => undefined);
    return () => { live = false; };
  }, [base]);

  function download() {
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([portalVehicleTemplateCsv(reportingMonths)], { type: "text/csv;charset=utf-8" }));
    anchor.download = portalVehicleTemplateName(reportingMonths);
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  function read(text: string) {
    setError("");
    const preview = previewPortalVehicles(text, reportingMonths, options, sites, optedOut);
    if (preview.missing.length) { setLines([]); notice({ kind: "warn", text: `This isn't the vehicle template: no ${preview.missing.join(", ")} column.` }); return; }
    setLines(preview.lines);
    notice(preview.lines.length ? { kind: "ok", text: `${preview.lines.length} vehicle${preview.lines.length === 1 ? "" : "s"} read. Check each, then confirm.` } : { kind: "warn", text: "The file has no vehicle rows." });
  }

  async function confirm() {
    if (busy || !ready.length) return;
    setBusy(true); setError("");
    const result = await postBrowserCommand<{ count: number }>(`${base}/scope-rows/import`, { template: "vehicles", rows: ready.map((line) => portalVehicleRow(line, optedOut)) }, crypto.randomUUID());
    setBusy(false);
    if (result.state === "success") {
      setLines([]);
      notice({ kind: "ok", text: `${result.data.count} vehicle${result.data.count === 1 ? "" : "s"} saved to Company Vehicles. They wait for ${adviser}'s review.` });
      await onImported();
    } else setError(importErrorText(result, ready.map((line) => line.row.rowNumber)));
  }

  return <div className="nz-vehicle-template">
    <div className="nz-sect">From the template</div>
    <p className="muted">Registration (optional), vehicle name, type, size, fuel, annual mileage, unit, site, and the months. The factor comes from the type, size and fuel{optedOut ? "; this client holds no registrations, so name each vehicle" : "; a registration is kept encrypted and never shown back"}. Nothing is saved until you confirm.</p>
    <div className="nz-config-actions">
      <button type="button" className="nz-btn" onClick={download}>Download vehicle template</button>
      {canImport ? <label className="nz-btn">Upload filled template<input type="file" accept=".csv,text/csv" hidden aria-label="Vehicle template file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(read); event.target.value = ""; }} /></label> : null}
    </div>
    {canImport ? null : <p className="muted">Importing opens with your entry window.</p>}
    {lines.length ? <>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table className="nz-tbl nz-vehicle-template-tbl">
          <thead><tr><th>Row</th><th>Vehicle</th><th>Factor</th><th className="num">Mileage</th><th>Site</th><th>Status</th></tr></thead>
          <tbody>{lines.map((line) => <tr key={line.row.rowNumber}>
            <td>{line.row.rowNumber}</td>
            <td>{line.row.name || <span className="muted">no name</span>}{line.row.registration && !optedOut ? <div className="nz-hint">Registration given · held encrypted</div> : null}</td>
            <td>{line.resolved.option ? <>{line.resolved.option.label}<div className="nz-hint">per {line.resolved.option.unit}</div></> : <span className="muted">—</span>}</td>
            <td className="num">{line.resolved.quantity ?? "—"}{line.resolved.monthly.length ? <div className="nz-hint">from the months</div> : null}</td>
            <td>{line.resolved.siteId ? sites.find((site) => site.id === line.resolved.siteId)?.name : <span className="muted">none</span>}</td>
            <td><span className={`nz-st ${line.ready ? "need" : "nof"}`}>{line.ready ? "Ready" : "Check"}</span>
              {[...line.issues, ...line.resolved.issues.filter((issue) => issue.startsWith("The months add up"))].map((text) => <div key={text} className="nz-hint">{text}</div>)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {lines.length > PORTAL_IMPORT_MAX_ROWS ? <p className="nz-banner warn" role="alert">A file imports at most {PORTAL_IMPORT_MAX_ROWS} vehicles at a time — split this one.</p> : null}
      {error ? <p className="nz-banner warn" role="alert">{error}</p> : null}
      <div className="nz-config-actions" style={{ marginTop: 12 }}>
        <button type="button" className="nz-btn" disabled={busy} onClick={() => { setLines([]); setError(""); }}>Clear</button>
        <button type="button" className="nz-btn pri" disabled={busy || ready.length === 0 || ready.length > PORTAL_IMPORT_MAX_ROWS} onClick={() => void confirm()}>
          {busy ? "Saving…" : `Confirm ${ready.length} vehicle${ready.length === 1 ? "" : "s"}`}</button>
      </div>
      {lines.length > ready.length ? <p className="muted">{lines.length - ready.length} row{lines.length - ready.length === 1 ? "" : "s"} marked Check {lines.length - ready.length === 1 ? "isn't" : "aren't"} included. Fix {lines.length - ready.length === 1 ? "it" : "them"} in the file and upload again, or add {lines.length - ready.length === 1 ? "it" : "them"} from the drawer.</p> : null}
    </> : null}
  </div>;
}
