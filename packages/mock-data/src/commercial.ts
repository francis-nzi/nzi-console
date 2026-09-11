export type CommercialStatus = "draft" | "sent" | "approved" | "accepted" | "converted" | "overdue" | "paid" | "issued" | "applied";
export type XeroSyncStatus = "synced" | "pending" | "failed" | "not_configured";
export type CommercialDocument = { id: string; number: string; title: string; status: CommercialStatus; amount: string; currency: string; version: number; xero: { status: XeroSyncStatus; reference: string | null; lastSyncedAt: string | null }; updatedAt: string };
export type CommercialEvent = { id: string; at: string; label: string; detail: string; actor: string; tone: "neutral" | "success" | "warning" };
export type FinancialsReadModel = { quotes: CommercialDocument[]; invoices: CommercialDocument[]; creditNotes: CommercialDocument[]; xeroStatus: { state: "connected" | "degraded" | "not_configured"; label: string } };
export type DocumentHistoryReadModel = { document: CommercialDocument; events: CommercialEvent[] };

const synced = { status: "synced" as const, reference: "XERO-10482", lastSyncedAt: "10 Sep 2026, 09:42" };
const pending = { status: "pending" as const, reference: null, lastSyncedAt: null };
export const financials: FinancialsReadModel = {
  quotes: [
    { id: "quote-224", number: "Q000224", title: "2026 Carbon Reduction Programme", status: "accepted", amount: "£18,600.00", currency: "GBP", version: 3, xero: synced, updatedAt: "08 Sep 2026" },
    { id: "quote-231", number: "Q000231", title: "Supplier engagement workshop", status: "sent", amount: "£4,250.00", currency: "GBP", version: 1, xero: pending, updatedAt: "05 Sep 2026" },
  ],
  invoices: [
    { id: "invoice-881", number: "INV-000881", title: "CRP delivery · phase 1", status: "paid", amount: "£9,300.00", currency: "GBP", version: 2, xero: synced, updatedAt: "09 Sep 2026" },
    { id: "invoice-894", number: "INV-000894", title: "CRP delivery · phase 2", status: "sent", amount: "£9,300.00", currency: "GBP", version: 1, xero: synced, updatedAt: "08 Sep 2026" },
  ],
  creditNotes: [{ id: "credit-018", number: "CN-000018", title: "Workshop reschedule credit", status: "applied", amount: "£500.00", currency: "GBP", version: 1, xero: synced, updatedAt: "09 Sep 2026" }],
  xeroStatus: { state: "connected", label: "Xero connected · last checked 09:42" },
};
export const documentHistory: Record<string, DocumentHistoryReadModel> = {
  "quote-224": { document: financials.quotes[0]!, events: [
    { id: "qe-3", at: "08 Sep 2026, 15:14", label: "Accepted by client", detail: "Converted to job J000719", actor: "System", tone: "success" },
    { id: "qe-2", at: "02 Sep 2026, 11:08", label: "Version 3 sent", detail: "£18,600.00 · valid until 30/09/2026", actor: "A. Shaw", tone: "neutral" },
    { id: "qe-1", at: "27 Aug 2026, 16:32", label: "Version 2 revised", detail: "Previous version retained", actor: "A. Shaw", tone: "warning" },
  ] },
  "invoice-881": { document: financials.invoices[0]!, events: [
    { id: "ie-3", at: "09 Sep 2026, 10:21", label: "Marked paid", detail: "Reconciled from Xero payment XERO-PAY-7741", actor: "Xero reconciliation", tone: "success" },
    { id: "ie-2", at: "04 Sep 2026, 09:12", label: "Credit note applied", detail: "CN-000018 reduced balance by £500.00", actor: "F. Doherty", tone: "warning" },
    { id: "ie-1", at: "01 Sep 2026, 14:40", label: "Invoice sent", detail: "Delivered to finance@bushy-tails.example", actor: "A. Shaw", tone: "neutral" },
  ] },
};
