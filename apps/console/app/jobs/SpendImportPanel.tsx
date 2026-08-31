"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { postBrowserCommand, putBrowserCommand } from "@nzi/api-client";
import {
  IMPORT_MAX_ROWS,
  SPEND_IMPORT_FIELDS,
  SPEND_IMPORT_FIELD_LABELS,
  type FactorOption,
  type ImportRowReview,
  type PurchasedGoodsCategoryOption,
  type SpendImportColumnMap,
  type SpendImportField,
} from "@nzi/contracts";
import { parseDelimited } from "./csvReader";
import {
  applyMapping,
  autoMapColumns,
  fromNamedColumnMap,
  resolveDraftRows,
  toNamedColumnMap,
  type ColumnMapping,
} from "./spendImportMapping";
import { buildSpendImportTemplateCsv, spendImportTemplateFilename } from "./spendImportTemplate";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;
type Preflight =
  | { kind: "preview"; reviews: ImportRowReview[]; summary: { total: number; accepted: number; advisory: number; blocked: number } }
  | { kind: "blocked"; reason: string; message: string };

export function SpendImportPanel({
  jobId, clientId, jobNumber, clientName, jobName, reportingYear, categories, factors, notice,
}: {
  jobId: string; clientId: string; jobNumber: string; clientName: string; jobName: string; reportingYear: number;
  categories: PurchasedGoodsCategoryOption[]; factors: FactorOption[]; notice: Notice;
}) {
  const [raw, setRaw] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [savedMap, setSavedMap] = useState<SpendImportColumnMap | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState<"" | "preflight" | "commit" | "void">("");
  const [committed, setCommitted] = useState<{ batchId: string; created: number } | null>(null);

  useEffect(() => {
    fetch(`/api/isolated/clients/${clientId}/import-mappings/spend`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { mapping?: { columns: SpendImportColumnMap } | null } | null) => setSavedMap(body?.mapping?.columns ?? null))
      .catch(() => undefined);
  }, [clientId]);

  const scope3Factors = useMemo(() => factors.filter((factor) => factor.scopes.some((code) => code === "3.1" || code.startsWith("3"))), [factors]);
  const resolvedRows = useMemo(
    () => resolveDraftRows(applyMapping(dataRows, mapping), categories.map((c) => ({ id: c.id, name: c.name })), scope3Factors),
    [dataRows, mapping, categories, scope3Factors],
  );

  const ingest = useCallback((text: string) => {
    const table = parseDelimited(text);
    setPreflight(null);
    setCommitted(null);
    if (table.headers.length === 0) {
      setHeaders([]); setDataRows([]);
      notice({ kind: "warn", text: "No rows were recognised. Expected a header row and at least one data row." });
      return;
    }
    if (table.rows.length > IMPORT_MAX_ROWS) {
      notice({ kind: "warn", text: `That file has ${table.rows.length} rows; the limit is ${IMPORT_MAX_ROWS}.` });
      return;
    }
    setHeaders(table.headers);
    setDataRows(table.rows);
    setMapping(fromNamedColumnMap(savedMap, table.headers));
  }, [notice, savedMap]);

  function downloadTemplate() {
    const blob = new Blob([buildSpendImportTemplateCsv()], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = spendImportTemplateFilename(jobNumber, clientName, jobName, reportingYear);
    link.click();
    URL.revokeObjectURL(url);
  }

  async function runPreflight() {
    if (busy) return;
    setBusy("preflight");
    await putBrowserCommand(`/api/isolated/clients/${clientId}/import-mappings/spend`, { columns: toNamedColumnMap(mapping, headers) }, crypto.randomUUID());
    const result = await postBrowserCommand<Preflight>(`/api/isolated/jobs/${jobId}/spend-import/preflight`, { rows: resolvedRows }, crypto.randomUUID());
    setBusy("");
    if (result.state !== "success") {
      notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
      return;
    }
    setPreflight(result.data);
    if (result.data.kind === "blocked") notice({ kind: "warn", text: result.data.message });
  }

  async function commit() {
    if (busy || preflight?.kind !== "preview") return;
    setBusy("commit");
    const result = await postBrowserCommand<{ batchId: string; created: number; blocked: number }>(`/api/isolated/jobs/${jobId}/spend-import/commit`, { rows: resolvedRows }, crypto.randomUUID());
    setBusy("");
    if (result.state !== "success") {
      notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
      return;
    }
    setCommitted({ batchId: result.data.batchId, created: result.data.created });
    setPreflight(null); setHeaders([]); setDataRows([]); setRaw("");
    notice({ kind: "ok", text: `${result.data.created} spend row${result.data.created === 1 ? "" : "s"} imported as pending sources. Sync and review them from the register.` });
  }

  async function voidBatch() {
    if (busy || !committed) return;
    setBusy("void");
    const result = await postBrowserCommand<{ voided: number; skipped: number }>(`/api/isolated/jobs/${jobId}/spend-import/void`, { batchId: committed.batchId }, crypto.randomUUID());
    setBusy("");
    if (result.state !== "success") {
      notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
      return;
    }
    notice({ kind: result.data.voided ? "ok" : "warn", text: `${result.data.voided} row${result.data.voided === 1 ? "" : "s"} voided${result.data.skipped ? `; ${result.data.skipped} kept (already synced or reviewed)` : ""}.` });
    setCommitted(null);
  }

  return (
    <section className="nz-panel nz-config-panel" id="spend-import">
      <div className="nz-config-head">
        <div>
          <span className="nz-eyebrow">Data entry · spend import (flagged preview)</span>
          <b>Import a spend ledger</b>
          <div className="sub">Download the CSV template or upload the client&apos;s own export, map the columns once (remembered for this client), preview every row, then import. Rows land as pending Scope 3.1 sources for the standard sync and review.</div>
        </div>
        <button type="button" className="nz-btn" onClick={downloadTemplate}>Download CSV template</button>
      </div>

      {committed ? (
        <div className="nz-config-grid">
          <div className="nz-banner ok" role="status" style={{ gridColumn: "1/-1" }}>
            {committed.created} row{committed.created === 1 ? "" : "s"} imported (batch {committed.batchId.slice(0, 8)}). They are pending — sync and review them from the register below.
          </div>
          <div className="nz-config-actions">
            <button type="button" className="nz-btn" disabled={busy !== ""} onClick={() => void voidBatch()}>{busy === "void" ? "Voiding…" : "Void this import"}</button>
            <button type="button" className="nz-btn pri" onClick={() => setCommitted(null)}>Import another file</button>
          </div>
        </div>
      ) : headers.length === 0 ? (
        <div className="nz-config-grid">
          <label className="nz-fl" style={{ gridColumn: "1/-1" }}>
            Upload a .csv file
            <input className="nz-inp" type="file" accept=".csv,text/csv" aria-label="Spend ledger CSV file" onChange={(event) => { const file = event.target.files?.[0]; if (file) file.text().then(ingest); }} />
          </label>
          <label className="nz-fl" style={{ gridColumn: "1/-1" }}>
            …or paste the rows
            <textarea className="nz-notes" rows={5} value={raw} onChange={(event) => setRaw(event.target.value)} placeholder="Description,Net value,VAT %,GL code,Invoice date,PG&S category,Emission factor" />
          </label>
          <div className="nz-config-actions">
            <button type="button" className="nz-btn pri" disabled={!raw.trim()} onClick={() => ingest(raw)}>Parse pasted rows</button>
          </div>
        </div>
      ) : (
        <>
          <div className="nz-sect">Map columns <span className="muted">{dataRows.length} row{dataRows.length === 1 ? "" : "s"}</span></div>
          <div className="nz-scope-fields">
            {SPEND_IMPORT_FIELDS.map((field: SpendImportField) => (
              <label className="nz-fl" key={field}>
                {SPEND_IMPORT_FIELD_LABELS[field]}
                <select className="nz-sel" value={mapping[field] ?? ""} onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value === "" ? undefined : Number(event.target.value) }))}>
                  <option value="">— not in file —</option>
                  {headers.map((header, index) => <option key={index} value={index}>{header}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="nz-config-actions" style={{ marginTop: 12 }}>
            <button type="button" className="nz-btn" disabled={busy !== ""} onClick={() => { setHeaders([]); setDataRows([]); setPreflight(null); }}>Start over</button>
            <button type="button" className="nz-btn" disabled={busy !== ""} onClick={() => setMapping(autoMapColumns(headers))}>Auto-map</button>
            <button type="button" className="nz-btn pri" disabled={busy !== ""} onClick={() => void runPreflight()}>{busy === "preflight" ? "Checking…" : "Preview rows"}</button>
          </div>

          {preflight?.kind === "blocked" ? <div className="nz-banner warn" role="alert" style={{ marginTop: 12 }}>{preflight.message}</div> : null}
          {preflight?.kind === "preview" ? (
            <>
              <div className="nz-sect">Preview <span className="muted">{preflight.summary.accepted} ready · {preflight.summary.advisory} advisory · {preflight.summary.blocked} blocked</span></div>
              <div style={{ overflowX: "auto" }}>
                <table className="nz-tbl">
                  <thead><tr><th>Row</th><th>Status</th><th>Notes</th></tr></thead>
                  <tbody>
                    {preflight.reviews.map((review) => (
                      <tr key={review.rowNumber}>
                        <td>{review.rowNumber}</td>
                        <td><span className={`nz-st ${review.status === "accepted" ? "done" : review.status === "blocked" ? "nof" : "est"}`}>{review.status}</span></td>
                        <td>{review.issues.length === 0 ? <span className="muted">—</span> : review.issues.map((issue) => <div key={issue.code} className="nz-hint" style={{ color: issue.severity === "blocker" ? "#B23B2E" : "#8A6410" }} role="note">{issue.message}</div>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="nz-config-actions" style={{ marginTop: 12 }}>
                <button type="button" className="nz-btn pri" disabled={busy !== "" || preflight.summary.accepted + preflight.summary.advisory === 0} onClick={() => void commit()}>
                  {busy === "commit" ? "Importing…" : `Import ${preflight.summary.accepted + preflight.summary.advisory} row${preflight.summary.accepted + preflight.summary.advisory === 1 ? "" : "s"}`}
                </button>
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
