// Portal data-entry phase 2 — what the client's Data view derives, kept pure so the profile's gates, the client's write shape
// and the drawer's sections are tested without a browser (BUILD-portal-dataentry-phase2 §3; settled 22 Oct in
// `_handoff/portal-dataentry-phase2-GROUNDING.md`).
import { PORTAL_STAFF_ONLY_FIELDS, type PortalOfferedProfile, type PortalScopeRowFields, type ScopeRowWriteFields } from "@nzi/contracts";
import type { PortalDataView, PortalRowHistoryEntry, PortalScopeRow } from "@nzi/isolated-backend";

/** The data-view route's answer, verified before anything is drawn. */
export function isPortalDataView(value: unknown): value is PortalDataView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<PortalDataView>;
  return !!view.profile && Array.isArray(view.profile.areas) && Array.isArray(view.profile.rowSections) && Array.isArray(view.profile.actions)
    && !!view.categories && Array.isArray(view.categories.categories) && Array.isArray(view.rows) && Array.isArray(view.factors)
    && Array.isArray(view.sites) && Array.isArray(view.purchasedGoodsCategories) && Array.isArray(view.reportingMonths)
    && (view.access === null || (typeof view.access === "object" && (view.access.state === "open" || view.access.state === "scheduled")));
}

/** Whether the client may add or change entries now: only inside an open data-entry window (the write refuses otherwise too). */
export const windowOpen = (view: Pick<PortalDataView, "access">) => view.access?.state === "open";

/**
 * The client's write: the CRM's own mapping (`emissionEntryDraftToScopeRow`), less every staff-only field — so what is sent is
 * exactly what the portal command accepts, and a quality tier the shared form defaults is never sent for the client.
 */
export function portalScopeRowFields(fields: ScopeRowWriteFields): PortalScopeRowFields {
  const copy: Record<string, unknown> = { ...fields };
  for (const field of PORTAL_STAFF_ONLY_FIELDS) delete copy[field];
  return copy as PortalScopeRowFields;
}

/**
 * The row drawer's sections, by the profile (settled 22 Oct, point 5 and 11): Site and Monthly activity are the entry itself
 * and always shown; with the detailed drawer, each of the four profile sections the client is offered, read-only; History
 * always. A section the profile does not offer is simply absent — never a placeholder that says it is hidden.
 */
export type RowDrawerSection = "site" | "monthly" | "factorCalculation" | "dataQuality" | "sourceDetail" | "evidenceProvenance" | "history";
export function rowDrawerSections(profile: PortalOfferedProfile): RowDrawerSection[] {
  const offered = profile.entryDrawer === "detailed"
    ? (["factorCalculation", "dataQuality", "sourceDetail", "evidenceProvenance"] as const).filter((section) => profile.rowSections.includes(section))
    : [];
  return ["site", "monthly", ...offered, "history"];
}

/** Deactivate is offered only where the profile offers it, on an entry the client may change, while the window is open. */
export const mayDeactivate = (profile: PortalOfferedProfile, row: Pick<PortalScopeRow, "editable">, open: boolean) =>
  open && row.editable && profile.actions.includes("deactivate");

/** A row's review state, in the client's words. */
export function reviewLabel(row: Pick<PortalScopeRow, "reviewStatus" | "enabled">): string {
  if (row.enabled === false) return "Deactivated";
  return row.reviewStatus === "approved" ? "Reviewed" : row.reviewStatus === "rejected" ? "Returned by your adviser" : "Waiting for review";
}

const ACTIONS: Record<string, string> = {
  portal_scope_row_created: "Entered", portal_scope_row_updated: "Changed", portal_scope_row_deactivated: "Deactivated",
  scope_row_created: "Entered", scope_row_updated: "Changed", scope_row_calculated: "Calculated", scope_row_reviewed: "Reviewed",
  scope_row_deactivated: "Deactivated", scope_row_reactivated: "Reactivated",
};
/** A History entry, in the client's words: what, and by you or your adviser — never a name. */
export function historyEntry(entry: PortalRowHistoryEntry, index: number, adviser: string): { id: string; at: string; action: string; by: string } {
  return { id: `${entry.at}-${index}`, at: entry.at, action: ACTIONS[entry.action] ?? entry.action.replace(/^portal_/, "").replaceAll("_", " "),
    by: entry.who === "you" ? "You" : entry.who === "adviser" ? adviser : "The system" };
}
