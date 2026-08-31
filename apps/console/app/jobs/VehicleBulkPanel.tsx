"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import type { EmissionSourceGroup, FactorOption } from "@nzi/contracts";
import { crpScopeOptions } from "@nzi/contracts";
import { matchFuel, parseVehicleLedger, vehicleTemplateCsv, VEHICLE_FUELS } from "./vehicleBulk";

// S1.2 — Company Vehicles bulk-paste grid (NZC-036 / NZC-037, flag `vehicle`).
// Same shape as CommutingBulkPanel: paste → confirm fuel + factor per vehicle →
// import as `job_emission_sources` sharing one `import_batch_id` for an audited
// soft-undo. A roll-up group rolls up to one canonical row (NZC-043).
type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;
type Row = {
  key: string; registration: string; make: string; model: string; fuel: string;
  activity: number | null; activityUnit: string; scope: string; factorId: string;
  state: "" | "saving" | "saved" | "failed"; detail: string;
};
const SAMPLE = "Registration\tMake\tModel\tFuel\tActivity / year\tUnit\nAB12CDE\tFord\tTransit\tDiesel\t3200\tlitres\nFG34HIJ\tNissan\tLeaf\tBattery electric\t9800\tkWh";
const vehicleScopes = crpScopeOptions.filter((option) => option.value === "1" || option.value === "3.6");
const blankRow = (line?: Partial<Row>): Row => ({ key: crypto.randomUUID(), registration: line?.registration ?? "", make: line?.make ?? "", model: line?.model ?? "", fuel: line?.fuel ?? "", activity: line?.activity ?? null, activityUnit: line?.activityUnit ?? "litres", scope: "1", factorId: "", state: "", detail: "" });

export function VehicleBulkPanel({ jobId, factors, notice }: { jobId: string; factors: FactorOption[]; notice: Notice }) {
  const [groups, setGroups] = useState<EmissionSourceGroup[]>([]);
  const [groupId, setGroupId] = useState("");
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastBatch, setLastBatch] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);

  const loadGroups = useCallback(async () => {
    try {
      const response = await fetch(`/api/isolated/jobs/${jobId}/emission-sources`, { cache: "no-store" });
      const body = await response.json();
      if (response.ok && Array.isArray(body.groups)) setGroups(body.groups);
    } catch { /* the register panel surfaces its own errors */ }
  }, [jobId]);
  useEffect(() => { void loadGroups(); }, [loadGroups]);

  const update = (key: string, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const remove = (key: string) => setRows((current) => current.filter((row) => row.key !== key));
  const factorsFor = (scope: string) => factors.filter((factor) => factor.scopes.includes(scope.split(".")[0]!) || factor.scopes.includes(scope));

  function parse() {
    const parsed = parseVehicleLedger(raw).map((line) => blankRow({ ...line, fuel: matchFuel(line.fuel) ?? line.fuel }));
    setRows((current) => [...current, ...parsed]);
    setRaw("");
    notice(parsed.length ? { kind: "ok", text: `${parsed.length} vehicle row${parsed.length === 1 ? "" : "s"} added. Confirm the fuel and factor for each, then import.` } : { kind: "warn", text: "No vehicle rows were recognised. Expected registration, make, model, fuel, activity value, unit." });
  }

  function downloadTemplate() {
    const blob = new Blob([vehicleTemplateCsv()], { type: "text/csv;charset=utf-8" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "company-vehicles-template.csv";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const ready = (row: Row) => row.state !== "saved" && row.registration.trim() !== "" && row.activity !== null && row.activity >= 0 && Boolean(row.factorId);
  const readyCount = useMemo(() => rows.filter(ready).length, [rows]);

  async function importRows() {
    if (busy) return;
    const toSave = rows.filter(ready);
    if (toSave.length === 0) { notice({ kind: "warn", text: "Add at least one vehicle with a registration, an activity value and a factor." }); return; }
    setBusy(true);
    const batchId = crypto.randomUUID();
    let ok = 0;
    for (const row of toSave) {
      update(row.key, { state: "saving", detail: "" });
      const factor = factorsFor(row.scope).find((item) => item.factorId === row.factorId);
      const created = await postBrowserCommand<{ sourceId: string }>(`/api/isolated/jobs/${jobId}/emission-sources`, {
        groupId: groupId || null, scope: row.scope, sourceType: "vehicle", sourceSubtype: null, siteId: null,
        sourceName: [row.make, row.model].filter(Boolean).join(" ").trim() || row.registration,
        assetIdentifier: row.registration, purchasedGoodsCategoryId: null,
        datasetId: factor?.factorSource === "dataset" ? factor.datasetId : null,
        factorId: factor?.factorSource === "dataset" ? factor.factorId : null,
        factorSource: factor?.factorSource ?? "dataset", clientFactorId: factor?.clientFactorId ?? null,
        quantity: row.activity, unit: row.activityUnit, applyPct: 100,
        dataSource: "Company vehicles bulk import", dataConfidence: "M", monthlyActivity: [],
        detail: { kind: "vehicle", vehicleRegistration: row.registration, make: row.make.trim() || null, model: row.model.trim() || null, fuel: row.fuel || null },
        notes: null, importBatchId: batchId,
      }, crypto.randomUUID());
      if (created.state !== "success") { update(row.key, { state: "failed", detail: created.state === "validation_failed" ? created.issues.map((issue) => issue.message).join(" ") : created.message }); continue; }
      if (!groupId) await postBrowserCommand<{ rowId: string }>(`/api/isolated/jobs/${jobId}/emission-sources/${created.data.sourceId}/sync`, {}, crypto.randomUUID());
      update(row.key, { state: "saved", detail: groupId ? "Added to the roll-up group." : `Synced to a Scope ${row.scope} row, pending review.` });
      ok += 1;
    }
    if (ok && groupId) {
      const rolled = await postBrowserCommand<{ enabledMemberCount: number }>(`/api/isolated/jobs/${jobId}/emission-source-groups/${groupId}/sync`, {}, crypto.randomUUID());
      if (rolled.state !== "success") notice({ kind: "warn", text: rolled.state === "validation_failed" ? rolled.issues.map((issue) => issue.message).join(" ") : rolled.message });
    }
    setBusy(false);
    setLastBatch(ok ? batchId : null);
    notice(ok ? { kind: "ok", text: `${ok} vehicle${ok === 1 ? "" : "s"} imported${groupId ? " and rolled up" : ""}. They enter the same calculation and independent-review workflow.` } : { kind: "warn", text: "No vehicles were imported. Check the per-row messages." });
  }

  async function undo() {
    if (!lastBatch || undoing) return;
    setUndoing(true);
    const result = await postBrowserCommand<{ voided: number; skipped: number }>(`/api/isolated/jobs/${jobId}/emission-source-batch/void`, { batchId: lastBatch }, crypto.randomUUID());
    setUndoing(false);
    if (result.state === "success") {
      notice({ kind: "ok", text: `Import undone — ${result.data.voided} source${result.data.voided === 1 ? "" : "s"} archived${result.data.skipped ? `, ${result.data.skipped} kept (already synced or reviewed)` : ""}.` });
      setLastBatch(null); setRows([]);
    } else notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
  }

  return (
    <section className="nz-panel nz-config-panel" id="vehicle-bulk">
      <div className="nz-config-head">
        <div>
          <span className="nz-eyebrow">Data entry · company vehicles (bulk)</span>
          <b>Company vehicles — paste a list</b>
          <div className="sub">Paste your fleet list, confirm a fuel and an emission factor per vehicle, then import. Each row becomes a Scope 1 (or Scope 3.6) source through the standard review workflow; group them to roll up into one canonical carbon-emissions row.</div>
        </div>
        <span className={`nz-st ${rows.length ? "done" : "need"}`}>{rows.length} rows</span>
      </div>

      {rows.length === 0 ? (
        <div className="nz-config-grid">
          <label className="nz-fl" style={{ gridColumn: "1/-1" }}>
            Vehicle rows
            <textarea className="nz-notes" rows={6} value={raw} placeholder={SAMPLE} onChange={(event) => setRaw(event.target.value)} />
          </label>
          <div className="nz-config-actions">
            <button type="button" className="nz-btn" onClick={downloadTemplate}>Download .csv template</button>
            <button type="button" className="nz-btn" onClick={() => setRaw(SAMPLE)}>Use sample</button>
            <button type="button" className="nz-btn pri" disabled={!raw.trim()} onClick={parse}>Parse rows</button>
          </div>
        </div>
      ) : (
        <>
          <label className="nz-fl" style={{ maxWidth: 360 }}>
            Roll-up group <span className="muted">(optional)</span>
            <select className="nz-sel" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">Ungrouped — one row each</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          </label>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table className="nz-tbl">
              <thead><tr><th>Registration</th><th>Make / model</th><th>Fuel</th><th className="num">Activity / year</th><th>Unit</th><th>Scope</th><th>Factor</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td><input className="nz-inp" aria-label={`Registration for ${row.registration || "row"}`} value={row.registration} onChange={(event) => update(row.key, { registration: event.target.value.toUpperCase() })} /></td>
                    <td>
                      <input className="nz-inp" aria-label={`Make for ${row.registration || "row"}`} placeholder="Make" value={row.make} onChange={(event) => update(row.key, { make: event.target.value })} />
                      <input className="nz-inp" aria-label={`Model for ${row.registration || "row"}`} placeholder="Model" value={row.model} onChange={(event) => update(row.key, { model: event.target.value })} />
                    </td>
                    <td>
                      <select className="nz-sel" aria-label={`Fuel for ${row.registration || "row"}`} value={VEHICLE_FUELS.includes(row.fuel) ? row.fuel : ""} onChange={(event) => update(row.key, { fuel: event.target.value })}>
                        <option value="">Select a fuel</option>
                        {VEHICLE_FUELS.map((fuel) => <option key={fuel} value={fuel}>{fuel}</option>)}
                      </select>
                    </td>
                    <td className="num"><input className="nz-inp" type="number" min="0" step="any" aria-label={`Activity for ${row.registration || "row"}`} value={row.activity ?? ""} onChange={(event) => update(row.key, { activity: event.target.value === "" ? null : Number(event.target.value) })} /></td>
                    <td>
                      <select className="nz-sel" aria-label={`Unit for ${row.registration || "row"}`} value={row.activityUnit} onChange={(event) => update(row.key, { activityUnit: event.target.value })}>
                        {["litres", "km", "mi", "kWh", "kg"].map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                      </select>
                    </td>
                    <td>
                      <select className="nz-sel" aria-label={`Scope for ${row.registration || "row"}`} value={row.scope} onChange={(event) => update(row.key, { scope: event.target.value, factorId: "" })}>
                        {vehicleScopes.map((option) => <option key={option.value} value={option.value}>{option.value === "1" ? "Scope 1 (owned)" : "Scope 3.6 (grey fleet)"}</option>)}
                      </select>
                    </td>
                    <td>
                      <select className="nz-sel" aria-label={`Factor for ${row.registration || "row"}`} value={row.factorId} onChange={(event) => update(row.key, { factorId: event.target.value })}>
                        <option value="">Select a factor</option>
                        {factorsFor(row.scope).map((factor) => <option key={`${factor.factorSource}:${factor.factorId}`} value={factor.factorId}>{factor.label} · {factor.activityUnit}</option>)}
                      </select>
                    </td>
                    <td><span className={`nz-st ${row.state === "saved" ? "done" : row.state === "failed" ? "nof" : "need"}`}>{row.state === "saving" ? "Saving…" : row.state === "saved" ? "Imported" : row.state === "failed" ? "Failed" : ready(row) ? "Ready" : "Incomplete"}</span>{row.detail ? <div className="muted">{row.detail}</div> : null}</td>
                    <td>{row.state === "saved" ? null : <button type="button" className="nz-btn" onClick={() => remove(row.key)}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="nz-config-actions" style={{ marginTop: 12 }}>
            <button type="button" className="nz-btn" disabled={busy} onClick={() => { setRows([]); setRaw(""); }}>Clear</button>
            {lastBatch ? <button type="button" className="nz-btn" disabled={undoing} onClick={() => void undo()}>{undoing ? "Undoing…" : "Undo last import"}</button> : null}
            <button type="button" className="nz-btn pri" disabled={busy || readyCount === 0} onClick={() => void importRows()}>{busy ? "Importing…" : `Import ${readyCount} vehicle${readyCount === 1 ? "" : "s"}`}</button>
          </div>
        </>
      )}
    </section>
  );
}
