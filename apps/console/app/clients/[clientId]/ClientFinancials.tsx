"use client";

import { useState } from "react";
import { Drawer } from "@nzi/ui";
import type { CommercialDocument, DocumentHistoryReadModel, FinancialsReadModel } from "@nzi/mock-data";

const statusLabel: Record<string, string> = { draft: "Draft", sent: "Sent", approved: "Approved", accepted: "Accepted", converted: "Converted", overdue: "Overdue", paid: "Paid", issued: "Issued", applied: "Applied" };
const statusClass: Record<string, string> = { draft: "need", sent: "est", approved: "need", accepted: "done", converted: "done", overdue: "nof", paid: "done", issued: "est", applied: "done" };
const typeRows = ["Quotes", "Invoices", "Credit notes"] as const;
type Tab = (typeof typeRows)[number];

export function ClientFinancials({ ledger, history }: { ledger: FinancialsReadModel; history: Record<string, DocumentHistoryReadModel> }) {
  const [tab, setTab] = useState<Tab>("Quotes");
  const [selected, setSelected] = useState<DocumentHistoryReadModel | null>(null);
  const rows = tab === "Quotes" ? ledger.quotes : tab === "Invoices" ? ledger.invoices : ledger.creditNotes;
  return <section className="nz-panel" id="financials">
    <div style={{ display: "flex", alignItems: "center", padding: "13px 16px", borderBottom: "1px solid var(--line2)" }}>
      <div><div className="eyebrow">Commercial ledger</div><h2 style={{ fontSize: 15, margin: "3px 0 0" }}>Financials</h2></div>
      <span className={`nz-st ${ledger.xeroStatus.state === "connected" ? "done" : "est"}`} style={{ marginLeft: "auto" }}>{ledger.xeroStatus.label}</span>
    </div>
    <div style={{ display: "flex", gap: 6, padding: "12px 16px 0" }} role="tablist" aria-label="Commercial documents">
      {typeRows.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} className={`nz-btn ${tab === item ? "pri" : ""}`} onClick={() => setTab(item)}>{item} <span className="muted">{item === "Quotes" ? ledger.quotes.length : item === "Invoices" ? ledger.invoices.length : ledger.creditNotes.length}</span></button>)}
    </div>
    <div className="sub" style={{ padding: "10px 16px 4px" }}>The console is the source of record. Xero is a downstream projection and payment reconciliation service.</div>
    {rows.length === 0 ? <div className="sub" style={{ padding: 18 }}>No {tab.toLowerCase()} have been recorded for this client.</div> : <table className="nz-tbl"><thead><tr><th>Document</th><th>Status</th><th>Version</th><th className="num">Amount</th><th>Xero</th><th>Updated</th><th /></tr></thead><tbody>{rows.map((row) => <LedgerRow key={row.id} row={row} onHistory={() => setSelected(history[row.id] ?? { document: row, events: [] })} />)}</tbody></table>}
    <Drawer open={selected !== null} onClose={() => setSelected(null)} ariaLabel={selected ? `${selected.document.number} history` : "Document history"} className="nz-drawer">
      {selected ? <HistoryPanel history={selected} onClose={() => setSelected(null)} /> : null}
    </Drawer>
  </section>;
}

function LedgerRow({ row, onHistory }: { row: CommercialDocument; onHistory: () => void }) {
  return <tr><td><b>{row.number}</b><div className="muted">{row.title}</div></td><td><span className={`nz-st ${statusClass[row.status]}`}>{statusLabel[row.status] ?? row.status}</span></td><td><span className="nz-st need">v{row.version}</span></td><td className="num">{row.amount}</td><td><span className={`nz-st ${row.xero.status === "synced" ? "done" : row.xero.status === "failed" ? "nof" : "est"}`}>{row.xero.status}</span></td><td className="muted">{row.updatedAt}</td><td><button type="button" className="nz-table-link" onClick={onHistory}>View history →</button></td></tr>;
}

function HistoryPanel({ history, onClose }: { history: DocumentHistoryReadModel; onClose: () => void }) {
  return <div style={{ background: "var(--paper)", marginLeft: "auto", width: "min(480px, 100vw)", minHeight: "100%", padding: 24, overflowY: "auto" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}><div><div className="eyebrow">Document history</div><h2 style={{ margin: "5px 0" }}>{history.document.number}</h2><div className="sub">{history.document.title}</div></div><button type="button" className="nz-btn" onClick={onClose} aria-label="Close document history">Close</button></div><div className="nz-kv" style={{ marginTop: 22 }}><span className="k">Console record</span><span className="v">v{history.document.version} · {statusLabel[history.document.status]}</span></div><div className="nz-kv"><span className="k">Xero projection</span><span className="v">{history.document.xero.status}{history.document.xero.reference ? ` · ${history.document.xero.reference}` : ""}</span></div><div className="tl" style={{ marginTop: 24 }}>{history.events.map((event) => <div className="ev" key={event.id}><div className="eyebrow">{event.at}</div><b>{event.label}</b><p className="sub" style={{ margin: "4px 0" }}>{event.detail}</p><small className="muted">{event.actor}</small></div>)}</div></div>;
}
