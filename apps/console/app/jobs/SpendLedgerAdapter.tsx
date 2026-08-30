"use client";
import { useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import type { FactorOption, PurchasedGoodsCategoryOption } from "@nzi/contracts";
import { formatDate } from "../lib/formatDate";
import { parseSpendLedger, suggestCategory, type SpendLedgerLine } from "./spendLedger";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;
type Row = SpendLedgerLine & { key: string; currency: string; category: string; factorId: string; state: "" | "importing" | "done" | "failed"; detail: string };

const SAMPLE = "Description\tNet\tVAT %\tGL code\tDate\nOffice paper and stationery\t1240.00\t20\t7504\t14/03/2025\nCourier and postage\t880.50\t20\t7501\t02/04/2025";

const toRow = (line: SpendLedgerLine, categories: PurchasedGoodsCategoryOption[]): Row => ({
  ...line,
  key: crypto.randomUUID(),
  currency: "GBP",
  category: suggestCategory(line.description, categories) ?? "",
  factorId: "",
  state: "",
  detail: "",
});

export function SpendLedgerAdapter({
  jobId,
  factors,
  categories,
  notice,
}: {
  jobId: string;
  factors: FactorOption[];
  categories: PurchasedGoodsCategoryOption[];
  notice: Notice;
}) {
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const scope3Factors = useMemo(() => factors.filter((factor) => factor.scopes.some((code) => code === "3.1" || code.startsWith("3"))), [factors]);

  const update = (key: string, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  function parse() {
    const parsed = parseSpendLedger(raw).map((line) => toRow(line, categories));
    setRows(parsed);
    notice(parsed.length ? { kind: "ok", text: `${parsed.length} ledger line${parsed.length === 1 ? "" : "s"} parsed. Confirm each category and factor, then import.` } : { kind: "warn", text: "No ledger lines were recognised. Expected description, net value, VAT %, GL code, date." });
  }

  const ready = rows.filter((row) => row.state !== "done" && row.description.trim() && row.netValue !== null && row.factorId);

  async function importReady() {
    if (busy || ready.length === 0) return;
    setBusy(true);
    let ok = 0;
    for (const row of ready) {
      update(row.key, { state: "importing", detail: "" });
      const selected = scope3Factors.find((factor) => factor.factorId === row.factorId);
      const created = await postBrowserCommand<{ sourceId: string }>(
        `/api/isolated/jobs/${jobId}/emission-sources`,
        {
          groupId: null,
          scope: "3.1",
          sourceType: "spend",
          sourceSubtype: row.glCode,
          siteId: null,
          sourceName: row.description.trim(),
          assetIdentifier: row.invoiceDate,
          datasetId: selected?.factorSource === "dataset" ? selected.datasetId : null,
          factorId: selected?.factorSource === "dataset" ? selected.factorId : null,
          factorSource: selected?.factorSource ?? "dataset",
          clientFactorId: selected?.clientFactorId ?? null,
          quantity: row.netValue,
          unit: row.currency || "GBP",
          applyPct: 100,
          dataSource: "Spend ledger",
          dataConfidence: null,
          monthlyActivity: [],
          detail: { kind: "spend", netValue: row.netValue ?? 0, vatPercent: row.vatPercent, glCode: row.glCode, category: row.category.trim() || "Uncategorised" },
          notes: null,
        },
        crypto.randomUUID(),
      );
      if (created.state !== "success") {
        update(row.key, { state: "failed", detail: created.state === "validation_failed" ? created.issues.map((issue) => issue.message).join(" ") : created.message });
        continue;
      }
      const synced = await postBrowserCommand<{ rowId: string }>(`/api/isolated/jobs/${jobId}/emission-sources/${created.data.sourceId}/sync`, {}, crypto.randomUUID());
      update(row.key, synced.state === "success" ? { state: "done", detail: "Synced to a Scope 3.1 row (spend-based), pending calculation and review." } : { state: "failed", detail: "Source created; its canonical row still needs syncing from the register." });
      if (synced.state === "success") ok += 1;
    }
    setBusy(false);
    notice(ok ? { kind: "ok", text: `${ok} spend line${ok === 1 ? "" : "s"} imported as Scope 3.1 rows. They enter the same calculation, lineage and independent-review workflow.` } : { kind: "warn", text: "No spend lines were imported. Check the per-line messages." });
  }

  return (
    <section className="nz-panel nz-config-panel" id="spend-ledger-adapter">
      <div className="nz-config-head">
        <div>
          <span className="nz-eyebrow">Data entry · spend (flagged preview)</span>
          <b>Spend ledger</b>
          <div className="sub">Paste ledger lines, confirm a controlled category and factor per line, then import. Each line becomes a Scope 3.1 emission source carrying the Spend-based quality tier, synced through the standard review workflow.</div>
        </div>
        <span className={`nz-st ${rows.length ? "done" : "need"}`}>{rows.length} lines</span>
      </div>

      {rows.length === 0 ? (
        <div className="nz-config-grid">
          <label className="nz-fl" style={{ gridColumn: "1/-1" }}>
            Ledger lines
            <textarea className="nz-notes" rows={6} value={raw} placeholder={SAMPLE} onChange={(event) => setRaw(event.target.value)} />
          </label>
          <div className="nz-config-actions">
            <button type="button" className="nz-btn" disabled={!raw.trim()} onClick={() => setRaw(SAMPLE)}>
              Use sample
            </button>
            <button type="button" className="nz-btn pri" disabled={!raw.trim()} onClick={parse}>
              Parse ledger
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table className="nz-tbl">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num">Net</th>
                  <th className="num">VAT %</th>
                  <th>GL code</th>
                  <th>Invoice date</th>
                  <th>Category</th>
                  <th>Factor</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <input className="nz-inp" value={row.description} onChange={(event) => update(row.key, { description: event.target.value })} />
                    </td>
                    <td className="num">
                      <input className="nz-inp" type="number" min="0" step="any" value={row.netValue ?? ""} onChange={(event) => update(row.key, { netValue: event.target.value === "" ? null : Number(event.target.value) })} />
                    </td>
                    <td className="num">
                      <input className="nz-inp" type="number" min="0" max="100" step="any" value={row.vatPercent ?? ""} onChange={(event) => update(row.key, { vatPercent: event.target.value === "" ? null : Number(event.target.value) })} />
                    </td>
                    <td>
                      <input className="nz-inp" value={row.glCode ?? ""} onChange={(event) => update(row.key, { glCode: event.target.value || null })} />
                    </td>
                    <td>
                      <span className="muted">{formatDate(row.invoiceDate) || "—"}</span>
                    </td>
                    <td>
                      <input className="nz-inp" list="spend-pgs-categories" value={row.category} onChange={(event) => update(row.key, { category: event.target.value })} />
                      {suggestCategory(row.description, categories) && suggestCategory(row.description, categories) !== row.category ? (
                        <button type="button" className="nz-btn" style={{ marginTop: 3 }} onClick={() => update(row.key, { category: suggestCategory(row.description, categories) ?? "" })}>
                          Suggest: {suggestCategory(row.description, categories)}
                        </button>
                      ) : null}
                    </td>
                    <td>
                      <select className="nz-sel" aria-label={`Factor for ${row.description || "line"}`} value={row.factorId} onChange={(event) => update(row.key, { factorId: event.target.value })}>
                        <option value="">Select a factor</option>
                        {scope3Factors.map((factor) => (
                          <option key={`${factor.factorSource}:${factor.factorId}`} value={factor.factorId}>
                            {factor.label} · {factor.activityUnit}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className={`nz-st ${row.state === "done" ? "done" : row.state === "failed" ? "nof" : "need"}`}>{row.state === "importing" ? "Importing…" : row.state === "done" ? "Imported" : row.state === "failed" ? "Failed" : "Ready"}</span>
                      {row.detail ? <div className="muted">{row.detail}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="spend-pgs-categories">
              {categories.map((category) => (
                <option key={category.id} value={category.name} />
              ))}
            </datalist>
          </div>
          <div className="nz-config-actions" style={{ marginTop: 12 }}>
            <button type="button" className="nz-btn" disabled={busy} onClick={() => { setRows([]); setRaw(""); }}>
              Clear
            </button>
            <button type="button" className="nz-btn pri" disabled={busy || ready.length === 0} onClick={() => void importReady()}>
              {busy ? "Importing…" : `Import ${ready.length} line${ready.length === 1 ? "" : "s"}`}
            </button>
          </div>
          {scope3Factors.length === 0 ? <div className="nz-banner warn" role="alert">No Scope 3 factors are available on this job. Add a dataset or client factor before importing spend.</div> : null}
        </>
      )}
    </section>
  );
}
