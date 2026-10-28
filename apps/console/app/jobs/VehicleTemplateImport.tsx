"use client";
// Data entry D4 (R5): the Company Vehicles template — download it (named by the universal convention), fill it, upload it. Every
// vehicle is previewed with the factor its type · size · fuel resolves to (or the DVLA lookup, for a row with only a
// registration), its unit, site and months, and what does not match is said; then each is filed as a Scope 1 register source —
// the plate going only to the sealed identifier (D4 A) — synced to its row, or added to a roll-up group on its own factor (one row
// per distinct factor, together composing the category's total).
import { useEffect, useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import type { EmissionSourceGroup, FactorOption, JobEntryBasis } from "@nzi/contracts";
import { parseVehicleFactorLabel } from "@nzi/contracts";
import {
  parseVehicleTemplate, resolveVehicleTemplateRow, templateFileName, vehicleRowBlocking, vehicleTemplateCsv, type ResolvedVehicleRow, type VehicleTemplateRow,
} from "./vehicleTemplate";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;
export type VehicleTemplateJob = { jobNumber: string; clientName: string; jobName: string; reportingFrom: string | null; reportingTo: string | null; reportingMonths: string[]; sites: Array<{ id: string; name: string }> };
type Line = { row: VehicleTemplateRow; resolved: ResolvedVehicleRow; state: "" | "saving" | "saved" | "failed"; detail: string };

export function VehicleTemplateImport({ jobId, job, factors, groups, notice }: { jobId: string; job: VehicleTemplateJob; factors: FactorOption[]; groups: EmissionSourceGroup[]; notice: Notice }) {
  const [optedOut, setOptedOut] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch(`/api/isolated/jobs/${jobId}/entry-basis`, { cache: "no-store" }).then((response) => (response.ok ? response.json() : null))
      .then((basis: JobEntryBasis | null) => setOptedOut(basis?.vehicleRegistrationsOptOut === true)).catch(() => undefined);
  }, [jobId]);
  // Scope 1 vehicle factors in the library's own words — what type · size · fuel is resolved against.
  const options = useMemo(() => factors.filter((factor) => factor.scopes.includes("1") && factor.factorSource === "dataset")
    .map((factor) => ({ id: factor.factorId, label: factor.label, unit: factor.activityUnit, datasetId: factor.datasetId })), [factors]);

  function download() {
    const blob = new Blob([vehicleTemplateCsv(job.reportingMonths)], { type: "text/csv;charset=utf-8" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = templateFileName({ jobNumber: job.jobNumber, clientName: job.clientName, jobName: job.jobName, contents: "Company Vehicles", from: job.reportingFrom, to: job.reportingTo });
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  async function upload(text: string) {
    const parsed = parseVehicleTemplate(text, job.reportingMonths);
    if (parsed.missing.length) { notice({ kind: "warn", text: `This isn't the vehicle template: no ${parsed.missing.join(", ")} column.` }); return; }
    const resolved: Line[] = [];
    for (const row of parsed.rows) {
      let result = resolveVehicleTemplateRow(row, options, job.sites, optedOut);
      // A registration and nothing else: the DVLA lookup resolves it, as the drawer does. The plate goes no further than the request.
      if (result.needsLookup) {
        const response = await fetch(`/api/isolated/jobs/${jobId}/vehicle-lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registration: row.registration, categoryCode: "1.company-vehicles", scope: "1" }) });
        const body = response.ok ? await response.json() as { factor?: { factorId?: string } | null } : null;
        const found = body?.factor?.factorId ? options.find((option) => option.id === body.factor!.factorId) ?? null : null;
        const read = found ? parseVehicleFactorLabel(found.label) : null;
        result = read ? resolveVehicleTemplateRow({ ...row, type: read.type, size: read.size ?? "", fuel: read.fuel ?? "" }, options, job.sites, optedOut)
          : { ...result, issues: [...result.issues, response.ok ? "The lookup found the vehicle but no factor for it — give its type, size and fuel." : "The registration lookup failed — give the type, size and fuel."] };
      }
      resolved.push({ row, resolved: result, state: "", detail: "" });
    }
    setLines(resolved);
    notice(resolved.length ? { kind: "ok", text: `${resolved.length} vehicle${resolved.length === 1 ? "" : "s"} read. Check each, then import.` } : { kind: "warn", text: "The file has no vehicle rows." });
  }

  // A roll-up group is priced with its one factor, so only a vehicle on that factor joins it (the write refuses any other): one row
  // per distinct factor, composing the category's total.
  const group = groups.find((entry) => entry.id === groupId) ?? null;
  const offGroup = (line: Line) => Boolean(group?.factorId && line.resolved.option
    && (line.resolved.option.id !== group.factorId || (line.resolved.option as { datasetId?: string }).datasetId !== group.datasetId));
  const groupIssue = (line: Line) => offGroup(line) ? [`Not ${group!.name}'s factor (${group!.factorLabel ?? "the group's"}) — a group is one factor: import it ungrouped, or into a group on its own factor.`] : [];
  const ready = (line: Line) => line.state !== "saved" && line.resolved.option !== null && vehicleRowBlocking(line.resolved).length === 0 && !offGroup(line);
  const readyCount = lines.filter(ready).length;

  async function importAll() {
    if (busy) return;
    setBusy(true);
    const batchId = crypto.randomUUID();
    let ok = 0;
    for (const line of lines.filter(ready)) {
      const { row, resolved } = line;
      const option = resolved.option as { id: string; label: string; unit: string; datasetId: string };
      const read = parseVehicleFactorLabel(option.label);
      setLines((current) => current.map((entry) => entry === line ? { ...entry, state: "saving" } : entry));
      const created = await postBrowserCommand<{ sourceId: string }>(`/api/isolated/jobs/${jobId}/emission-sources`, {
        groupId: groupId || null, scope: "1", sourceType: "vehicle", sourceSubtype: null, siteId: resolved.siteId,
        // The vehicle's name, never its plate (R2); the plate goes only to the sealed identifier — or, opted out, the name does.
        sourceName: row.name || ["Company vehicle", read?.size, read?.fuel].filter(Boolean).join(" · "),
        assetIdentifier: optedOut ? row.name || null : row.registration || null, purchasedGoodsCategoryId: null,
        datasetId: option.datasetId, factorId: option.id, factorSource: "dataset", clientFactorId: null,
        quantity: resolved.quantity, unit: option.unit, applyPct: 100, dataSource: "Company vehicles template import", dataConfidence: "M",
        monthlyActivity: resolved.monthly.filter((slot) => slot.quantity !== null), detail: { kind: "vehicle", vehicleRegistration: null, make: null, model: null, fuel: read?.fuel ?? null },
        notes: null, importBatchId: batchId,
      }, crypto.randomUUID());
      const failed = created.state !== "success" ? (created.state === "validation_failed" ? created.issues.map((issue) => issue.message).join(" ") : created.message) : null;
      if (!failed && !groupId && created.state === "success") await postBrowserCommand(`/api/isolated/jobs/${jobId}/emission-sources/${created.data.sourceId}/sync`, {}, crypto.randomUUID());
      setLines((current) => current.map((entry) => entry.row === row ? { ...entry, state: failed ? "failed" : "saved", detail: failed ?? (groupId ? "Added to the roll-up group." : "Synced to a Scope 1 row, pending review.") } : entry));
      if (!failed) ok += 1;
    }
    if (ok && groupId) await postBrowserCommand(`/api/isolated/jobs/${jobId}/emission-source-groups/${groupId}/sync`, {}, crypto.randomUUID());
    setBusy(false);
    notice(ok ? { kind: "ok", text: `${ok} vehicle${ok === 1 ? "" : "s"} imported${group ? ` and rolled up into ${group.name}'s row` : ""}. They enter the standard calculation and review.` } : { kind: "warn", text: "No vehicles were imported. Check each row's message." });
  }

  return <div className="nz-vehicle-template">
    <div className="nz-sect">From the template</div>
    <p className="muted">Registration (optional), vehicle name, type, size, fuel, annual mileage, unit, site, and the months. The factor comes from the type, size and fuel{optedOut ? "; this client holds no registrations, so name each vehicle" : "; a registration is held encrypted, never in a note"}.</p>
    <div className="nz-config-actions">
      <button type="button" className="nz-btn" onClick={download}>Download vehicle template</button>
      <label className="nz-btn">Upload filled template<input type="file" accept=".csv,text/csv" hidden aria-label="Vehicle template file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(upload); event.target.value = ""; }} /></label>
    </div>
    {lines.length ? <>
      <label className="nz-fl" style={{ maxWidth: 360, marginTop: 10 }}>Roll-up group <span className="muted">(optional — one row for the vehicles on its factor)</span>
        <select className="nz-sel" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">Ungrouped — one row each</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
      </label>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table className="nz-tbl nz-vehicle-template-tbl">
          <thead><tr><th>Row</th><th>Vehicle</th><th>Factor</th><th className="num">Mileage</th><th>Site</th><th>Status</th></tr></thead>
          <tbody>{lines.map((line) => <tr key={line.row.rowNumber}>
            <td>{line.row.rowNumber}</td>
            <td>{line.row.name || <span className="muted">no name</span>}{line.row.registration && !optedOut ? <div className="nz-hint">Registration given · held encrypted</div> : null}</td>
            <td>{line.resolved.option ? <>{line.resolved.option.label}<div className="nz-hint">per {line.resolved.option.unit}</div></> : <span className="muted">—</span>}</td>
            <td className="num">{line.resolved.quantity ?? "—"}{line.resolved.monthly.length ? <div className="nz-hint">from the months</div> : null}</td>
            <td>{line.resolved.siteId ? job.sites.find((site) => site.id === line.resolved.siteId)?.name : <span className="muted">none</span>}</td>
            <td><span className={`nz-st ${line.state === "saved" ? "done" : line.state === "failed" || vehicleRowBlocking(line.resolved).length || !line.resolved.option || offGroup(line) ? "nof" : "need"}`}>{line.state === "saving" ? "Saving…" : line.state === "saved" ? "Imported" : line.state === "failed" ? "Failed" : ready(line) ? "Ready" : "Check"}</span>
              {[...line.resolved.issues, ...(line.state === "saved" ? [] : groupIssue(line)), ...(line.detail ? [line.detail] : [])].map((text) => <div key={text} className="nz-hint">{text}</div>)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="nz-config-actions" style={{ marginTop: 12 }}>
        <button type="button" className="nz-btn" disabled={busy} onClick={() => setLines([])}>Clear</button>
        <button type="button" className="nz-btn pri" disabled={busy || readyCount === 0} onClick={() => void importAll()}>{busy ? "Importing…" : `Import ${readyCount} vehicle${readyCount === 1 ? "" : "s"}`}</button>
      </div>
    </> : null}
  </div>;
}
