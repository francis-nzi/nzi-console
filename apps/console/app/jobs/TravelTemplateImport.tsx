"use client";
// Data entry D5 (R6, R7): the Business Travel template — download it (named by the universal convention), fill it, upload it. Every
// trip is previewed with the factor its mode (+ haul and class for a flight) resolves to, its figure in that factor's unit, its site
// and date, and what does not match is said. Then each is filed as a Scope 3.6 travel source in the roll-up group for its mode and
// factor — found, or made — and each group is rolled up once: one row per mode and factor, composing the category's total.
import { useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import type { EmissionSourceGroup, FactorOption } from "@nzi/contracts";
import { travelGroupName, travelModeLabel, travelPatternOf } from "@nzi/contracts";
import { templateFileName } from "./vehicleTemplate";
import type { VehicleTemplateJob } from "./VehicleTemplateImport";
import { greyFleetFactorFor, parseTravelTemplate, resolveTravelTemplateRow, travelSourceName, travelTemplateCsv, type ResolvedTravelRow, type TravelTemplateRow } from "./travelTemplate";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;
type Line = { row: TravelTemplateRow; resolved: ResolvedTravelRow; state: "" | "saving" | "saved" | "failed"; detail: string };
type Priced = { id: string; label: string; unit: string; datasetId: string };

export function TravelTemplateImport({ jobId, job, factors, notice }: { jobId: string; job: VehicleTemplateJob; factors: FactorOption[]; notice: Notice }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  // Scope 3 dataset factors, in the library's own words — what a mode, haul and class are resolved against.
  const options = useMemo(() => factors.filter((factor) => factor.scopes.includes("3") && factor.factorSource === "dataset" && factor.datasetId)
    .map((factor) => ({ id: factor.factorId, label: factor.label, unit: factor.activityUnit, datasetId: factor.datasetId! })), [factors]);

  function download() {
    const blob = new Blob([travelTemplateCsv()], { type: "text/csv;charset=utf-8" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = templateFileName({ jobNumber: job.jobNumber, clientName: job.clientName, jobName: job.jobName, contents: "Business Travel", from: job.reportingFrom, to: job.reportingTo });
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  async function upload(text: string) {
    const parsed = parseTravelTemplate(text);
    if (parsed.missing.length) { notice({ kind: "warn", text: `This isn't the travel template: no ${parsed.missing.join(", ")} column.` }); return; }
    const resolved: Line[] = [];
    for (const row of parsed.rows) {
      let result = resolveTravelTemplateRow(row, options, job.sites);
      // Grey fleet with a registration: the vehicle lookup names the car, as the drawer does. The plate goes no further than the request.
      if (result.needsLookup) {
        const response = await fetch(`/api/isolated/jobs/${jobId}/vehicle-lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registration: row.registration, categoryCode: "3.6", scope: "3" }) });
        const body = response.ok ? await response.json() as { factor?: { factorId?: string; label?: string } | null } : null;
        const car = body?.factor?.label ? options.find((option) => option.id === body.factor!.factorId) ?? greyFleetFactorFor(options, body.factor.label) : null;
        result = car ? resolveTravelTemplateRow(row, options, job.sites, car)
          : { ...result, needsLookup: false, issues: [...result.issues, response.ok ? "The lookup found the car but no business-travel factor for it — enter this trip in the drawer." : "The registration lookup failed — enter this trip in the drawer."] };
      }
      resolved.push({ row, resolved: result, state: "", detail: "" });
    }
    setLines(resolved);
    notice(resolved.length ? { kind: "ok", text: `${resolved.length} trip${resolved.length === 1 ? "" : "s"} read. Check each, then import.` } : { kind: "warn", text: "The file has no trip rows." });
  }

  const ready = (line: Line) => line.state !== "saved" && line.resolved.option !== null && line.resolved.quantity !== null && line.resolved.issues.length === 0;
  const readyCount = lines.filter(ready).length;

  async function importAll() {
    if (busy) return;
    setBusy(true);
    const batchId = crypto.randomUUID();
    // R7: one roll-up group per mode and factor. A group already on the factor (made by an earlier import, or carried forward from
    // last year's pattern) is reused — so a carried row fills.
    const register = await fetch(`/api/isolated/jobs/${jobId}/emission-sources`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null) as { groups?: EmissionSourceGroup[] } | null;
    const groups = new Map((register?.groups ?? []).filter((group) => group.factorId && group.datasetId).map((group) => [`${group.datasetId}|${group.factorId}`, group.id]));
    const touched = new Set<string>();
    let ok = 0;
    for (const line of lines.filter(ready)) {
      const { row, resolved } = line;
      const option = resolved.option as Priced;
      setLines((current) => current.map((entry) => entry === line ? { ...entry, state: "saving" } : entry));
      let failed: string | null = null;
      let groupId = groups.get(`${option.datasetId}|${option.id}`) ?? null;
      if (!groupId) {
        const pattern = travelPatternOf(option.label);
        const made = await postBrowserCommand<{ groupId: string }>(`/api/isolated/jobs/${jobId}/emission-source-groups`, {
          name: travelGroupName(pattern?.label ?? option.label), datasetId: option.datasetId, factorId: option.id, factorLabel: option.label, unit: option.unit,
        }, crypto.randomUUID());
        if (made.state === "success") { groupId = made.data.groupId; groups.set(`${option.datasetId}|${option.id}`, groupId); }
        else failed = made.state === "validation_failed" ? made.issues.map((issue) => issue.message).join(" ") : made.message;
      }
      if (groupId && !failed) {
        const created = await postBrowserCommand<{ sourceId: string }>(`/api/isolated/jobs/${jobId}/emission-sources`, {
          groupId, scope: "3.6", sourceType: "travel", sourceSubtype: null, siteId: resolved.siteId,
          // The leg, else the mode — never a person's name or a registration (R5).
          sourceName: travelSourceName(row, resolved), assetIdentifier: null, purchasedGoodsCategoryId: null,
          datasetId: option.datasetId, factorId: option.id, factorSource: "dataset", clientFactorId: null,
          quantity: resolved.quantity, unit: option.unit, applyPct: 100, dataSource: "Business travel template import", dataConfidence: "M", monthlyActivity: [],
          detail: { kind: "travel", travelMode: resolved.mode, airHaul: resolved.haul, cabinClass: resolved.cabinClass, nights: resolved.basis === "nights" ? resolved.quantity : null,
            tripDate: resolved.tripDate, origin: row.from || null, destination: row.to || null, carrier: null, distanceUnit: row.unit || "km", passengers: row.passengers },
          notes: null, importBatchId: batchId,
        }, crypto.randomUUID());
        if (created.state !== "success") failed = created.state === "validation_failed" ? created.issues.map((issue) => issue.message).join(" ") : created.message;
        else touched.add(groupId);
      }
      setLines((current) => current.map((entry) => entry.row === row ? { ...entry, state: failed ? "failed" : "saved", detail: failed ?? "Filed in its mode's roll-up." } : entry));
      if (!failed) ok += 1;
    }
    for (const groupId of touched) await postBrowserCommand(`/api/isolated/jobs/${jobId}/emission-source-groups/${groupId}/sync`, {}, crypto.randomUUID());
    setBusy(false);
    notice(ok ? { kind: "ok", text: `${ok} trip${ok === 1 ? "" : "s"} imported into ${touched.size} Business Travel row${touched.size === 1 ? "" : "s"} — one per mode and factor. They enter the standard calculation and review.` }
      : { kind: "warn", text: "No trips were imported. Check each row's message." });
  }

  return <div className="nz-travel-template">
    <div className="nz-sect">From the template</div>
    <p className="muted">Mode, from, to, distance, unit, nights, spend, passengers, date and site — and for a flight its haul and cabin class. Leave what a mode doesn&rsquo;t use blank. A grey-fleet registration is used for the lookup only, never kept.</p>
    <div className="nz-config-actions">
      <button type="button" className="nz-btn" onClick={download}>Download travel template</button>
      <label className="nz-btn">Upload filled template<input type="file" accept=".csv,text/csv" hidden aria-label="Travel template file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(upload); event.target.value = ""; }} /></label>
    </div>
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
            <td><span className={`nz-st ${line.state === "saved" ? "done" : line.state === "failed" || !ready(line) ? "nof" : "need"}`}>{line.state === "saving" ? "Saving…" : line.state === "saved" ? "Imported" : line.state === "failed" ? "Failed" : ready(line) ? "Ready" : "Check"}</span>
              {[...line.resolved.issues, ...(line.detail ? [line.detail] : [])].map((text) => <div key={text} className="nz-hint">{text}</div>)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="nz-config-actions" style={{ marginTop: 12 }}>
        <button type="button" className="nz-btn" disabled={busy} onClick={() => setLines([])}>Clear</button>
        <button type="button" className="nz-btn pri" disabled={busy || readyCount === 0} onClick={() => void importAll()}>{busy ? "Importing…" : `Import ${readyCount} trip${readyCount === 1 ? "" : "s"}`}</button>
      </div>
    </> : null}
  </div>;
}
