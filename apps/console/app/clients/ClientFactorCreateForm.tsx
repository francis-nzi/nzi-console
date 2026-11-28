"use client";
import { useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { crpScopeOptions } from "@nzi/contracts";

/**
 * The "+ Add client factor" form, lifted out of the job workspace's ClientFactorPanel unchanged so the client page, the Clients
 * page's Organisation factors tab and an LCA job make a factor the same way (GAPS G3/G6). `endpoint` decides the owner: a job's
 * route (where `reusable` chooses the job or its client), a client's, or the organisation's.
 */
export function ClientFactorCreateForm({ endpoint, reusableChoice, onCreated, notice, defaultScope = "3.1", label = "+ Add client factor" }: {
  endpoint: string;
  /** Only on a job: reusable across the client, or pinned to this job. */
  reusableChoice: boolean;
  onCreated: (created: { clientFactorId: string; label: string }) => void;
  notice: (n: { kind: "ok" | "warn"; text: string }) => void;
  defaultScope?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState({ scope: defaultScope, reportLabel: "", description: "", unit: "unit", kgco2ePerUnit: 0, geography: "GB", vintageYear: new Date().getUTCFullYear(), source: "", reusable: true, evidenceFileName: "", evidenceHash: "" });
  async function add() {
    setPending(true);
    const result = await postBrowserCommand<{ clientFactorId: string; label: string }>(endpoint, {
      ...value, evidenceFileName: value.evidenceFileName || null, evidenceStorageProvider: value.evidenceFileName ? "sharepoint" : null,
      evidenceUrl: null, evidenceExternalItemId: null, evidenceHash: value.evidenceHash || null,
    }, crypto.randomUUID());
    setPending(false);
    if (result.state === "success") { notice({ kind: "ok", text: `Client factor ${result.data.label} created.` }); setOpen(false); onCreated(result.data); }
    else notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
  }
  if (!open) return <button className="nz-btn" onClick={() => setOpen(true)}>{label}</button>;
  return <div className="nz-config-grid">
    <label className="nz-fl">Label<input className="nz-inp" value={value.reportLabel} onChange={(e) => setValue({ ...value, reportLabel: e.target.value })} /></label>
    <label className="nz-fl">Scope<select className="nz-sel" value={value.scope} onChange={(e) => setValue({ ...value, scope: e.target.value })}>{crpScopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <label className="nz-fl">Activity unit<input className="nz-inp" value={value.unit} onChange={(e) => setValue({ ...value, unit: e.target.value })} /></label>
    <label className="nz-fl">kgCO2e per unit<input className="nz-inp" type="number" min="0" step="any" value={value.kgco2ePerUnit} onChange={(e) => setValue({ ...value, kgco2ePerUnit: Number(e.target.value) })} /></label>
    <label className="nz-fl">Geography<input className="nz-inp" value={value.geography} onChange={(e) => setValue({ ...value, geography: e.target.value })} /></label>
    <label className="nz-fl">Vintage year<input className="nz-inp" type="number" value={value.vintageYear} onChange={(e) => setValue({ ...value, vintageYear: Number(e.target.value) })} /></label>
    <label className="nz-fl">Source<input className="nz-inp" value={value.source} onChange={(e) => setValue({ ...value, source: e.target.value })} /></label>
    <label className="nz-fl">Evidence filename<input className="nz-inp" value={value.evidenceFileName} placeholder="Optional EPD" onChange={(e) => setValue({ ...value, evidenceFileName: e.target.value })} /></label>
    <label className="nz-fl">Evidence hash<input className="nz-inp" value={value.evidenceHash} placeholder="SHA-256; required with file" onChange={(e) => setValue({ ...value, evidenceHash: e.target.value })} /></label>
    {reusableChoice ? <label><input type="checkbox" checked={value.reusable} onChange={(e) => setValue({ ...value, reusable: e.target.checked })} /> Reusable across this client</label> : null}
    <div className="nz-config-actions">
      <button className="nz-btn" onClick={() => setOpen(false)}>Cancel</button>
      <button className="nz-btn pri" disabled={pending || !value.reportLabel.trim() || !value.source.trim()} onClick={add}>{pending ? "Creating..." : "Create factor"}</button>
    </div>
  </div>;
}
