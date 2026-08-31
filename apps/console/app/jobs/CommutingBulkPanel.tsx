"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import type { EmissionSourceGroup, FactorOption } from "@nzi/contracts";
import { COMMUTE_MODES, commutingTemplateCsv, matchCommuteMode, parseCommutingLedger } from "./commutingBulk";

// S1.1 — Employee Commuting bulk-paste grid (NZC-036, flag `commuting`). Paste
// commuting rows → confirm mode + factor per line → import as `job_emission_sources`
// (Scope 3.7) sharing one `import_batch_id` for an audited soft-undo. If a roll-up
// group is chosen, the group is rolled up to one canonical row (NZC-043);
// otherwise each line syncs to its own row through the unchanged review spine.
type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;
type Row = {
  key: string; employee: string; mode: string; distance: number | null; distanceUnit: "km" | "mi";
  wfhDaysPerYear: number | null; wfhHoursPerDay: number | null; factorId: string;
  state: "" | "saving" | "saved" | "failed"; detail: string;
};
const SAMPLE = "Employee\tMode\tDistance / year\tUnit\tWFH days\tWFH hours\nA. Example\tCar — petrol\t7500\tkm\t52\t7.5\nB. Example\tRail\t3200\tkm\t104\t7.5";
const blankRow = (line?: Partial<Row>): Row => ({ key: crypto.randomUUID(), employee: line?.employee ?? "", mode: line?.mode ?? COMMUTE_MODES[0]!, distance: line?.distance ?? null, distanceUnit: line?.distanceUnit ?? "km", wfhDaysPerYear: line?.wfhDaysPerYear ?? null, wfhHoursPerDay: line?.wfhHoursPerDay ?? null, factorId: "", state: "", detail: "" });

export function CommutingBulkPanel({ jobId, factors, notice }: { jobId: string; factors: FactorOption[]; notice: Notice }) {
  const [groups, setGroups] = useState<EmissionSourceGroup[]>([]);
  const [groupId, setGroupId] = useState("");
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastBatch, setLastBatch] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const commuteFactors = useMemo(() => factors.filter((factor) => factor.scopes.some((code) => code === "3.7" || code.startsWith("3"))), [factors]);

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

  function parse() {
    const parsed = parseCommutingLedger(raw).map((line) => blankRow({ ...line, mode: matchCommuteMode(line.mode) ?? line.mode }));
    setRows((current) => [...current, ...parsed]);
    setRaw("");
    notice(parsed.length ? { kind: "ok", text: `${parsed.length} commuting row${parsed.length === 1 ? "" : "s"} added. Confirm the mode and factor for each, then import.` } : { kind: "warn", text: "No commuting rows were recognised. Expected employee, mode, distance, unit, WFH days, WFH hours." });
  }

  function downloadTemplate() {
    const blob = new Blob([commutingTemplateCsv()], { type: "text/csv;charset=utf-8" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "employee-commuting-template.csv";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const ready = (row: Row) => row.state !== "saved" && row.employee.trim() !== "" && COMMUTE_MODES.includes(row.mode) && row.distance !== null && row.distance >= 0 && Boolean(row.factorId);

  async function importRows() {
    if (busy) return;
    const toSave = rows.filter(ready);
    if (toSave.length === 0) { notice({ kind: "warn", text: "Add at least one row with an employee, a controlled mode, a distance and a factor." }); return; }
    setBusy(true);
    const batchId = crypto.randomUUID();
    let ok = 0;
    for (const row of toSave) {
      update(row.key, { state: "saving", detail: "" });
      const factor = commuteFactors.find((item) => item.factorId === row.factorId);
      const created = await postBrowserCommand<{ sourceId: string }>(`/api/isolated/jobs/${jobId}/emission-sources`, {
        groupId: groupId || null, scope: "3.7", sourceType: "commuting", sourceSubtype: null, siteId: null,
        sourceName: row.employee.trim(), assetIdentifier: row.employee.trim(),
        purchasedGoodsCategoryId: null,
        datasetId: factor?.factorSource === "dataset" ? factor.datasetId : null,
        factorId: factor?.factorSource === "dataset" ? factor.factorId : null,
        factorSource: factor?.factorSource ?? "dataset", clientFactorId: factor?.clientFactorId ?? null,
        quantity: row.distance, unit: row.distanceUnit === "mi" ? "mi" : "km", applyPct: 100,
        dataSource: "Commuting bulk import", dataConfidence: "M", monthlyActivity: [],
        detail: { kind: "commuting", vehicleRegistration: null, commuteMode: row.mode, distanceUnit: row.distanceUnit, wfhDaysPerYear: row.wfhDaysPerYear, wfhHoursPerDay: row.wfhHoursPerDay, employeeName: row.employee.trim() },
        notes: null, importBatchId: batchId,
      }, crypto.randomUUID());
      if (created.state !== "success") { update(row.key, { state: "failed", detail: created.state === "validation_failed" ? created.issues.map((issue) => issue.message).join(" ") : created.message }); continue; }
      if (!groupId) await postBrowserCommand<{ rowId: string }>(`/api/isolated/jobs/${jobId}/emission-sources/${created.data.sourceId}/sync`, {}, crypto.randomUUID());
      update(row.key, { state: "saved", detail: groupId ? "Added to the roll-up group." : "Synced to a Scope 3.7 row, pending review." });
      ok += 1;
    }
    if (ok && groupId) {
      const rolled = await postBrowserCommand<{ enabledMemberCount: number }>(`/api/isolated/jobs/${jobId}/emission-source-groups/${groupId}/sync`, {}, crypto.randomUUID());
      if (rolled.state !== "success") notice({ kind: "warn", text: rolled.state === "validation_failed" ? rolled.issues.map((issue) => issue.message).join(" ") : rolled.message });
    }
    setBusy(false);
    setLastBatch(ok ? batchId : null);
    notice(ok ? { kind: "ok", text: `${ok} commuting row${ok === 1 ? "" : "s"} imported${groupId ? " and rolled up" : ""}. They enter the same calculation and independent-review workflow.` } : { kind: "warn", text: "No rows were imported. Check the per-row messages." });
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
    <section className="nz-panel nz-config-panel" id="commuting-bulk">
      <div className="nz-config-head">
        <div>
          <span className="nz-eyebrow">Data entry · employee commuting (bulk)</span>
          <b>Employee commuting — paste a list</b>
          <div className="sub">Paste your commuting survey, confirm a controlled mode and an emission factor per employee, then import. Each row becomes a Scope 3.7 source through the standard review workflow; group them to roll up into one canonical carbon-emissions row.</div>
        </div>
        <span className={`nz-st ${rows.length ? "done" : "need"}`}>{rows.length} rows</span>
      </div>

      {rows.length === 0 ? (
        <div className="nz-config-grid">
          <label className="nz-fl" style={{ gridColumn: "1/-1" }}>
            Commuting rows
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
              <thead><tr><th>Employee</th><th>Mode</th><th className="num">Distance / year</th><th>Unit</th><th className="num">WFH days</th><th className="num">WFH hrs/day</th><th>Factor</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td><input className="nz-inp" aria-label={`Employee for ${row.employee || "row"}`} value={row.employee} onChange={(event) => update(row.key, { employee: event.target.value })} /></td>
                    <td>
                      <select className="nz-sel" aria-label={`Commute mode for ${row.employee || "row"}`} value={COMMUTE_MODES.includes(row.mode) ? row.mode : ""} onChange={(event) => update(row.key, { mode: event.target.value })}>
                        <option value="">Select a mode</option>
                        {COMMUTE_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                      </select>
                    </td>
                    <td className="num"><input className="nz-inp" type="number" min="0" step="any" aria-label={`Distance for ${row.employee || "row"}`} value={row.distance ?? ""} onChange={(event) => update(row.key, { distance: event.target.value === "" ? null : Number(event.target.value) })} /></td>
                    <td>
                      <select className="nz-sel" aria-label={`Distance unit for ${row.employee || "row"}`} value={row.distanceUnit} onChange={(event) => update(row.key, { distanceUnit: event.target.value as "km" | "mi" })}>
                        <option value="km">km</option><option value="mi">miles</option>
                      </select>
                    </td>
                    <td className="num"><input className="nz-inp" type="number" min="0" max="366" aria-label={`WFH days for ${row.employee || "row"}`} value={row.wfhDaysPerYear ?? ""} onChange={(event) => update(row.key, { wfhDaysPerYear: event.target.value === "" ? null : Number(event.target.value) })} /></td>
                    <td className="num"><input className="nz-inp" type="number" min="0" max="24" step="any" aria-label={`WFH hours for ${row.employee || "row"}`} value={row.wfhHoursPerDay ?? ""} onChange={(event) => update(row.key, { wfhHoursPerDay: event.target.value === "" ? null : Number(event.target.value) })} /></td>
                    <td>
                      <select className="nz-sel" aria-label={`Factor for ${row.employee || "row"}`} value={row.factorId} onChange={(event) => update(row.key, { factorId: event.target.value })}>
                        <option value="">Select a factor</option>
                        {commuteFactors.map((factor) => <option key={`${factor.factorSource}:${factor.factorId}`} value={factor.factorId}>{factor.label} · {factor.activityUnit}</option>)}
                      </select>
                    </td>
                    <td><span className={`nz-st ${row.state === "saved" ? "done" : row.state === "failed" ? "nof" : "need"}`}>{row.state === "saving" ? "Saving…" : row.state === "saved" ? "Imported" : row.state === "failed" ? "Failed" : ready(row) ? "Ready" : "Incomplete"}</span>{row.detail ? <div className="muted">{row.detail}</div> : null}</td>
                    <td>{row.state === "saved" ? null : <button type="button" className="nz-btn" onClick={() => remove(row.key)}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {commuteFactors.length === 0 ? <div className="nz-banner warn" role="alert">No Scope 3 factors are available on this job. Add a dataset before importing commuting.</div> : null}
          <div className="nz-config-actions" style={{ marginTop: 12 }}>
            <button type="button" className="nz-btn" disabled={busy} onClick={() => { setRows([]); setRaw(""); }}>Clear</button>
            {lastBatch ? <button type="button" className="nz-btn" disabled={undoing} onClick={() => void undo()}>{undoing ? "Undoing…" : "Undo last import"}</button> : null}
            <button type="button" className="nz-btn pri" disabled={busy || rows.filter(ready).length === 0} onClick={() => void importRows()}>{busy ? "Importing…" : `Import ${rows.filter(ready).length} row${rows.filter(ready).length === 1 ? "" : "s"}`}</button>
          </div>
        </>
      )}
    </section>
  );
}
