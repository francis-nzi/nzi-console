"use client";

import { useState } from "react";
import { Drawer } from "@nzi/ui";
import type { ScreenResult } from "@nzi/contracts";
import type { CommercialDocumentReadModel, DocumentHistoryReadModel, FinancialsReadModel } from "@nzi/isolated-backend";
import { formatDate, formatDateTime } from "../../lib/formatDate";

/**
 * NZC-069 (Open — awaiting Francis) — this client's commercial ledger, read from its
 * own records; Xero is a downstream projection whose status is derived, never assumed.
 */

const statusLabel: Record<string, string> = { draft: "Draft", sent: "Sent", approved: "Approved", accepted: "Accepted", converted: "Converted", overdue: "Overdue", paid: "Paid", issued: "Issued", applied: "Applied" };
const statusClass: Record<string, string> = { draft: "need", sent: "est", approved: "need", accepted: "done", converted: "done", overdue: "nof", paid: "done", issued: "est", applied: "done" };
const xeroLabel: Record<CommercialDocumentReadModel["xero"]["status"], string> = { synced: "Synced", pending: "Awaiting sync", failed: "Sync failed", not_configured: "Not connected" };
const xeroClass: Record<CommercialDocumentReadModel["xero"]["status"], string> = { synced: "done", pending: "est", failed: "nof", not_configured: "need" };
const ledgerXeroClass: Record<FinancialsReadModel["xeroStatus"]["state"], string> = { connected: "done", degraded: "nof", not_configured: "need" };
const typeRows = [{ label: "Quotes", type: "quote" }, { label: "Invoices", type: "invoice" }, { label: "Credit notes", type: "credit_note" }] as const;
type DocumentType = (typeof typeRows)[number]["type"];

const money = (amount: number, currency: string) => {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount); } catch { return `${amount.toLocaleString("en-GB", { minimumFractionDigits: 2 })} ${currency}`; }
};

type HistoryState = { document: CommercialDocumentReadModel; state: "loading" } | { document: CommercialDocumentReadModel; state: "failed"; message: string } | { document: CommercialDocumentReadModel; state: "loaded"; history: DocumentHistoryReadModel };

export function ClientFinancials({ result }: { result: ScreenResult<FinancialsReadModel> }) {
  const [tab, setTab] = useState<DocumentType>("quote");
  const [selected, setSelected] = useState<HistoryState | null>(null);

  if (result.state !== "success" && result.state !== "degraded") {
    const text = result.state === "failed" ? `Financials are unavailable (reference ${result.error.correlationId ?? result.meta.requestId}). No figures are shown rather than a partial ledger.` : result.state === "loading" ? "Loading the commercial ledger…" : "No commercial records exist for this client.";
    return <section className="nz-panel" id="financials"><Head /><div className={result.state === "failed" ? "nz-banner warn" : "sub"} role="status" style={{ margin: 16 }}>{text}</div></section>;
  }
  const ledger = result.data;
  const rows = tab === "quote" ? ledger.quotes : tab === "invoice" ? ledger.invoices : ledger.creditNotes;

  async function openHistory(document: CommercialDocumentReadModel) {
    setSelected({ document, state: "loading" });
    try {
      const response = await fetch(`/api/isolated/commercial/${tab}/${encodeURIComponent(document.id)}/history`, { cache: "no-store" });
      if (!response.ok) { setSelected({ document, state: "failed", message: `History is unavailable (status ${response.status}).` }); return; }
      setSelected({ document, state: "loaded", history: await response.json() as DocumentHistoryReadModel });
    } catch { setSelected({ document, state: "failed", message: "History could not be reached." }); }
  }

  return <section className="nz-panel" id="financials">
    <Head right={<span className={`nz-st ${ledgerXeroClass[ledger.xeroStatus.state]}`}>Xero: {ledger.xeroStatus.label}</span>} />
    {result.state === "degraded" ? <div className="nz-banner warn" role="status" style={{ margin: "12px 16px 0" }}>{result.warning.message}</div> : null}
    <div style={{ display: "flex", gap: 6, padding: "12px 16px 0" }} role="tablist" aria-label="Commercial documents">
      {typeRows.map((item) => <button key={item.type} type="button" role="tab" aria-selected={tab === item.type} className={`nz-btn ${tab === item.type ? "pri" : ""}`} onClick={() => setTab(item.type)}>{item.label} <span className="muted">{item.type === "quote" ? ledger.quotes.length : item.type === "invoice" ? ledger.invoices.length : ledger.creditNotes.length}</span></button>)}
    </div>
    <div className="sub" style={{ padding: "10px 16px 4px" }}>The console is the source of record. Xero is a downstream projection and payment-reconciliation service.</div>
    {rows.length === 0
      ? <div className="sub" style={{ padding: 18 }}>No {typeRows.find((item) => item.type === tab)!.label.toLowerCase()} have been recorded for this client.</div>
      : <table className="nz-tbl"><thead><tr><th>Document</th><th>Status</th><th>Version</th><th className="num">Amount</th><th>Xero</th><th>Updated</th><th /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
        <td><b>{row.number}</b><div className="muted">{row.title}</div></td>
        <td><span className={`nz-st ${statusClass[row.status] ?? "need"}`}>{statusLabel[row.status] ?? row.status}</span></td>
        <td><span className="nz-st need">v{row.version}</span></td>
        <td className="num">{money(row.amount, row.currency)}</td>
        <td><span className={`nz-st ${xeroClass[row.xero.status]}`}>{xeroLabel[row.xero.status]}</span></td>
        <td className="muted">{formatDate(row.updatedAt)}</td>
        <td><button type="button" className="nz-table-link" onClick={() => void openHistory(row)}>View history →</button></td>
      </tr>)}</tbody></table>}
    <Drawer open={selected !== null} onClose={() => setSelected(null)} ariaLabel={selected ? `${selected.document.number} history` : "Document history"} className="nz-site-drawer">
      {selected ? <div className="nz-site-drawer-body">
        <div className="nz-site-drawer-h"><div><div className="eyebrow">Document history</div><h3>{selected.document.number}</h3><div className="sub">{selected.document.title}</div></div><button type="button" className="close" onClick={() => setSelected(null)} aria-label="Close document history">✕</button></div>
        <div className="nz-kv"><span className="k">Console record</span><span className="v">v{selected.document.version} · {statusLabel[selected.document.status] ?? selected.document.status}</span></div>
        <div className="nz-kv"><span className="k">Xero projection</span><span className="v">{xeroLabel[selected.document.xero.status]}{selected.document.xero.reference ? ` · ${selected.document.xero.reference}` : ""}</span></div>
        {selected.state === "loading" ? <p className="sub" role="status">Loading history…</p> : null}
        {selected.state === "failed" ? <div className="nz-banner warn" role="alert">{selected.message}</div> : null}
        {selected.state === "loaded" ? (selected.history.events.length === 0
          ? <p className="sub">No events have been recorded for this document.</p>
          : <div className="tl" style={{ marginTop: 18 }}>{selected.history.events.map((event) => <div className="ev" key={event.id}><div className="eyebrow">{formatDateTime(event.at)}</div><b>{event.label}</b><p className="sub" style={{ margin: "4px 0" }}>{event.detail}</p><small className="muted">{event.actor}</small></div>)}</div>) : null}
      </div> : null}
    </Drawer>
  </section>;
}

function Head({ right }: { right?: React.ReactNode }) {
  return <div className="nz-panel-head"><div><div className="eyebrow">Commercial ledger</div><h2>Financials</h2></div>{right}</div>;
}
