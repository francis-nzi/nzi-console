import type { ImportRowIssue, ImportRowStatus, SpendImportRow } from "./spendImport";

/**
 * The client portal's spend import (RULING-portal-import-spend, Phase A): per-line pending scope rows, filed where the staff-maintained
 * allocation map routes them — the client sees "Filed under" and cannot change it — checked against both the staff register and the
 * job's own spend rows, pinned to the period and template version by a signed identity, and never filling a carried-forward line.
 */

/** What the portal's spend commit carries beyond the other imports': the lines as read from the file, and the identity token the server issued. */
export type PortalSpendImportPayload = { token: string; lines: SpendImportRow[] };

/**
 * A line's preview, as the client sees it: its status and issues, the category it will be filed under (the name, never the routing's
 * internals), and whether it matches a carried-forward line the adviser will reconcile.
 */
export type PortalSpendLineReview = {
  rowNumber: number; status: ImportRowStatus; issues: ImportRowIssue[];
  filedUnder: string | null;
  alreadyImported: boolean;
  /** The line's GL code matches a carried-forward line: it is not imported here, and the adviser reconciles it. */
  matchesCarried: boolean;
};
export type PortalSpendImportPreview =
  | { kind: "preview"; reviews: PortalSpendLineReview[]; summary: { total: number; importable: number; advisory: number; blocked: number; alreadyImported: number; matchesCarried: number } }
  | { kind: "blocked"; reason: "wrong-period" | "stale-template" | "job-not-found"; message: string };

/**
 * A spend line's note on the row it becomes. The GL code and the invoice date have no column on a scope row, so they travel here — in
 * a fixed shape the import's duplicate check reads back, so the same line is not filed twice (by the client, or by staff over it).
 */
export const SPEND_IMPORT_NOTE_PREFIX = "Spend import";
export function spendImportNote(line: Pick<SpendImportRow, "glCode" | "invoiceDate" | "vatPercent">): string {
  return [SPEND_IMPORT_NOTE_PREFIX, line.glCode ? `GL ${line.glCode.trim()}` : "", line.invoiceDate ? `Invoice ${line.invoiceDate}` : "", line.vatPercent !== null && line.vatPercent !== undefined ? `VAT ${line.vatPercent}%` : ""]
    .filter(Boolean).join(" · ");
}
export function parseSpendImportNote(notes: string | null | undefined): { glCode: string | null; invoiceDate: string | null } | null {
  if (!notes) return null;
  const parts = notes.split(" · ");
  if (parts[0] !== SPEND_IMPORT_NOTE_PREFIX) return null;
  return {
    glCode: parts.map((part) => /^GL (.+)$/.exec(part)?.[1]).find(Boolean) ?? null,
    invoiceDate: parts.map((part) => /^Invoice (\d{4}-\d{2}-\d{2})$/.exec(part)?.[1]).find(Boolean) ?? null,
  };
}
