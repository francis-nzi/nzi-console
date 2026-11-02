"use client";
// Portal bulk import — Spend (3.1), Phase A (RULING-portal-import-spend). One tab for the paste and the CSV: read the file with the CRM's
// own reader and column mapper (mapped for this upload only — asked again next time), preview every line from the server (where it will be
// filed, read-only; what is already here; what an adviser will reconcile), then confirm. Each accepted line becomes a pending row; the
// client neither picks nor changes the category — the staff-maintained map decides, and an unmapped line falls to Purchased goods and
// services for the adviser to move on review.
import { useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { PORTAL_IMPORT_MAX_ROWS, SPEND_IMPORT_FIELD_LABELS, SPEND_IMPORT_FIELDS, type FactorOption, type PortalSpendImportPreview, type SpendImportField } from "@nzi/contracts";
import { parseDelimited } from "../jobs/csvReader";
import { applyMapping, autoMapColumns, resolveDraftRows, type ColumnMapping } from "../jobs/spendImportMapping";
import { SPEND_IMPORT_TEMPLATE_HEADERS } from "../jobs/spendImportTemplate";
import { importErrorText } from "./data/portalImportErrors";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;
export const portalSpendTemplateName = (months: readonly string[]) =>
  months.length ? `Spend ledger template ${months[0]} to ${months[months.length - 1]}.csv` : "Spend ledger template.csv";
/** Headers only — no worked example, so nothing invented is imported by being left in. */
export const portalSpendTemplateCsv = () => SPEND_IMPORT_TEMPLATE_HEADERS.map((header) => `"${header}"`).join(",") + "\r\n";

export function PortalSpendImport({ base, factors, categories, reportingMonths, canImport, adviser, notice, onImported }: {
  /** `…/jobs/<id>` on the portal API. */
  base: string; factors: FactorOption[]; categories: Array<{ id: string; name: string }>; reportingMonths: string[];
  /** The entry window is open and this is not the staff preview. The command refuses otherwise too. */
  canImport: boolean; adviser: string; notice: Notice; onImported: () => void | Promise<void>;
}) {
  const [raw, setRaw] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [preview, setPreview] = useState<Extract<PortalSpendImportPreview, { kind: "preview" }> | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "confirm">("");
  const [error, setError] = useState("");
  const datasetFactors = useMemo(() => factors.filter((factor) => factor.factorSource === "dataset"), [factors]);
  const lines = useMemo(() => resolveDraftRows(applyMapping(dataRows, mapping), categories, datasetFactors), [dataRows, mapping, categories, datasetFactors]);

  function download() {
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([portalSpendTemplateCsv()], { type: "text/csv;charset=utf-8" }));
    anchor.download = portalSpendTemplateName(reportingMonths);
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  function ingest(text: string) {
    setPreview(null); setError("");
    const table = parseDelimited(text);
    if (table.headers.length === 0 || table.rows.length === 0) { setHeaders([]); setDataRows([]); notice({ kind: "warn", text: "No rows were recognised. Expect a header row and at least one data row." }); return; }
    if (table.rows.length > PORTAL_IMPORT_MAX_ROWS) { notice({ kind: "warn", text: `That file has ${table.rows.length} lines; a file imports at most ${PORTAL_IMPORT_MAX_ROWS} at a time — split it.` }); return; }
    setHeaders(table.headers); setDataRows(table.rows); setMapping(autoMapColumns(table.headers));
  }
  const startOver = () => { setHeaders([]); setDataRows([]); setPreview(null); setError(""); setRaw(""); };

  async function runPreview() {
    if (busy) return;
    setBusy("preview"); setError("");
    const result = await postBrowserCommand<PortalSpendImportPreview>(`${base}/spend-import/preview`, { rows: lines }, crypto.randomUUID());
    setBusy("");
    if (result.state !== "success") { setError(importErrorText(result, lines.map((line) => line.rowNumber))); return; }
    if (result.data.kind === "blocked") { setError(result.data.message); return; }
    setPreview(result.data);
  }

  async function confirm() {
    if (busy || !preview?.summary.importable) return;
    setBusy("confirm"); setError("");
    const result = await postBrowserCommand<{ count: number; alreadyImported: number; matchesCarried: number; blocked: number }>(`${base}/scope-rows/import`, { template: "spend", rows: [], spend: { lines } }, crypto.randomUUID());
    setBusy("");
    if (result.state !== "success") { setError(importErrorText(result, [])); return; }
    const { count, alreadyImported, matchesCarried, blocked } = result.data;
    startOver();
    notice({ kind: count ? "ok" : "warn", text: `${count} line${count === 1 ? "" : "s"} saved to Purchased goods and services and the categories they belong in. They wait for ${adviser}'s review.${alreadyImported ? ` ${alreadyImported} ${alreadyImported === 1 ? "was" : "were"} already here.` : ""}${matchesCarried ? ` ${matchesCarried} match${matchesCarried === 1 ? "es" : ""} a line carried forward from last year; ${adviser} will reconcile ${matchesCarried === 1 ? "it" : "them"}.` : ""}${blocked ? ` ${blocked} couldn't be imported.` : ""}` });
    await onImported();
  }

  return <div className="nz-spend-template">
    <div className="nz-sect">Spend ledger</div>
    <p className="muted">Description, net value, VAT %, GL code, invoice date and, where you know them, the purchased-goods category and emission factor. Each line is filed where {adviser} has set it to go; anything unmatched goes to Purchased goods and services for review. Nothing is saved until you confirm.</p>
    <div className="nz-config-actions">
      <button type="button" className="nz-btn" onClick={download}>Download spend template</button>
    </div>
    {!canImport ? <p className="muted">Importing opens with your entry window.</p> : headers.length === 0 ? <div className="nz-config-grid">
      <label className="nz-fl" style={{ gridColumn: "1/-1" }}>Upload a .csv file
        <input className="nz-inp" type="file" accept=".csv,text/csv" aria-label="Spend ledger CSV file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(ingest); event.target.value = ""; }} /></label>
      <label className="nz-fl" style={{ gridColumn: "1/-1" }}>…or paste the lines
        <textarea className="nz-notes" rows={5} value={raw} onChange={(event) => setRaw(event.target.value)} placeholder={SPEND_IMPORT_TEMPLATE_HEADERS.join(",")} /></label>
      <div className="nz-config-actions"><button type="button" className="nz-btn pri" disabled={!raw.trim()} onClick={() => ingest(raw)}>Read pasted lines</button></div>
    </div> : <>
      <div className="nz-sect">Match your columns <span className="muted">{dataRows.length} line{dataRows.length === 1 ? "" : "s"} · used for this upload only</span></div>
      <div className="nz-scope-fields">{SPEND_IMPORT_FIELDS.map((field: SpendImportField) => <label className="nz-fl" key={field}>{SPEND_IMPORT_FIELD_LABELS[field]}
        <select className="nz-sel" value={mapping[field] ?? ""} onChange={(event) => { setPreview(null); setMapping((current) => ({ ...current, [field]: event.target.value === "" ? undefined : Number(event.target.value) })); }}>
          <option value="">— not in file —</option>{headers.map((header, index) => <option key={index} value={index}>{header}</option>)}</select></label>)}</div>
      <div className="nz-config-actions" style={{ marginTop: 12 }}>
        <button type="button" className="nz-btn" disabled={busy !== ""} onClick={startOver}>Start over</button>
        <button type="button" className="nz-btn" disabled={busy !== ""} onClick={() => { setPreview(null); setMapping(autoMapColumns(headers)); }}>Match automatically</button>
        <button type="button" className="nz-btn pri" disabled={busy !== ""} onClick={() => void runPreview()}>{busy === "preview" ? "Checking…" : "Preview lines"}</button>
      </div>
      {error ? <p className="nz-banner warn" role="alert">{error}</p> : null}
      {preview ? <>
        <div className="nz-sect">Preview <span className="muted">{preview.summary.importable} ready · {preview.summary.blocked} blocked{preview.summary.alreadyImported ? ` · ${preview.summary.alreadyImported} already here` : ""}{preview.summary.matchesCarried ? ` · ${preview.summary.matchesCarried} left for ${adviser}` : ""}</span></div>
        <div style={{ overflowX: "auto" }}><table className="nz-tbl">
          <thead><tr><th>Line</th><th>Filed under</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>{preview.reviews.map((review) => {
            const note = review.alreadyImported ? "Already here — not imported again." : review.matchesCarried ? `Matches a line carried forward from last year; ${adviser} will reconcile it.` : "";
            return <tr key={review.rowNumber}>
              <td>{review.rowNumber}</td>
              <td>{review.filedUnder ?? <span className="muted">—</span>}</td>
              <td><span className={`nz-st ${review.status === "blocked" ? "nof" : review.alreadyImported || review.matchesCarried ? "need" : review.status === "advisory" ? "need" : "done"}`}>{review.status === "blocked" ? "Check" : review.alreadyImported || review.matchesCarried ? "Skipped" : "Ready"}</span></td>
              <td>{[...(note ? [note] : []), ...review.issues.map((issue) => issue.message)].filter((text, index, all) => all.indexOf(text) === index).map((text) => <div key={text} className="nz-hint">{text}</div>)}</td>
            </tr>;
          })}</tbody></table></div>
        <div className="nz-config-actions" style={{ marginTop: 12 }}>
          <button type="button" className="nz-btn pri" disabled={busy !== "" || preview.summary.importable === 0} onClick={() => void confirm()}>{busy === "confirm" ? "Saving…" : `Confirm ${preview.summary.importable} line${preview.summary.importable === 1 ? "" : "s"}`}</button>
        </div>
        {preview.summary.blocked ? <p className="muted">Lines marked Check aren't saved. Fix them in the file and upload again, or add them from the drawer.</p> : null}
      </> : null}
    </>}
  </div>;
}
