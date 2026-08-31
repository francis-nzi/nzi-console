// B4 — spend Excel/CSV import (NZC-036). Pure shapes shared by the in-browser
// parser and the server validator, so the two cannot drift (decision D5).
//
// No crypto in this module: the integrity **signature** is an opaque string the
// isolated backend issues and verifies against the job's current version. Here we
// only carry it and structurally decode the identity for display. `btoa`/`atob`
// and `TextEncoder`/`TextDecoder` are available in both the browser and Node 20.

import type { FactorSource, MonthlyActivitySlot } from "./commands";

export const SPEND_IMPORT_TOKEN_PREFIX = "nzi-spend-import.v1";
export const IMPORT_MAX_ROWS = 10_000;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

// ---- Identity token (D5, D6) --------------------------------------------------

export type SpendImportIdentity = {
  jobId: string;
  jobNumber: string;
  clientName: string;
  jobName: string;
  reportingYear: number;
  reportingFrom: string; // YYYY-MM-DD
  reportingTo: string; // YYYY-MM-DD
  domain: "spend";
  templateVersion: number;
};

const IDENTITY_KEYS: ReadonlyArray<keyof SpendImportIdentity> = [
  "jobId", "jobNumber", "clientName", "jobName", "reportingYear", "reportingFrom", "reportingTo", "domain", "templateVersion",
];

/** Deterministic serialisation the backend signs/verifies — fixed key order so both sides agree byte-for-byte. */
export function canonicalImportIdentityJson(identity: SpendImportIdentity): string {
  return JSON.stringify(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, identity[key]])));
}

const toBase64Url = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)));

/** `nzi-spend-import.v1:<base64url(identity json)>:<signature>` */
export function encodeImportIdentity(identity: SpendImportIdentity, signature: string): string {
  return `${SPEND_IMPORT_TOKEN_PREFIX}:${toBase64Url(canonicalImportIdentityJson(identity))}:${signature}`;
}

export type ImportIdentityDecodeResult =
  | { ok: true; identity: SpendImportIdentity; signature: string }
  | { ok: false; reason: "malformed" | "wrong-version" | "corrupt" };

const isIdentity = (value: unknown): value is SpendImportIdentity => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.jobId === "string" && typeof v.jobNumber === "string" && typeof v.clientName === "string" &&
    typeof v.jobName === "string" && typeof v.reportingYear === "number" && typeof v.reportingFrom === "string" &&
    typeof v.reportingTo === "string" && v.domain === "spend" && typeof v.templateVersion === "number"
  );
};

export function decodeImportIdentity(token: string): ImportIdentityDecodeResult {
  const parts = token.split(":");
  if (parts.length !== 3 || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
  if (parts[0] !== SPEND_IMPORT_TOKEN_PREFIX) return { ok: false, reason: "wrong-version" };
  let identity: unknown;
  try {
    identity = JSON.parse(fromBase64Url(parts[1]));
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (!isIdentity(identity)) return { ok: false, reason: "corrupt" };
  return { ok: true, identity, signature: parts[2] };
}

// ---- Normalised row + preflight review (gate §2) ----------------------------

/** The normalised spend row the browser posts to the server after parse + mapping. The raw file never leaves the browser. */
export type SpendImportRow = {
  rowNumber: number; // 1-based source row, kept for the preview
  description: string;
  netValue: number | null;
  vatPercent: number | null;
  glCode: string | null;
  invoiceDate: string | null; // YYYY-MM-DD
  purchasedGoodsCategoryId: string | null;
  factorSource: FactorSource;
  factorId: string | null;
  datasetId: string | null;
  clientFactorId: string | null;
  monthly: MonthlyActivitySlot[]; // empty unless the template carried month columns
};

export type ImportRowIssueCode =
  | "DESCRIPTION_REQUIRED" | "NET_VALUE_INVALID" | "VAT_PERCENT_INVALID"
  | "INVOICE_DATE_INVALID" | "CATEGORY_UNRESOLVED" | "FACTOR_UNRESOLVED"
  | "INVOICE_DATE_OUTSIDE_PERIOD" | "DUPLICATE_IN_FILE" | "NON_POSITIVE_NET"
  | "YOY_VARIANCE" | "ALREADY_IMPORTED";

export type ImportRowIssueSeverity = "blocker" | "advisory";

// Blockers stop a row importing; advisories never block (NZC-018).
export const IMPORT_ROW_ISSUE_SEVERITY: Record<ImportRowIssueCode, ImportRowIssueSeverity> = {
  DESCRIPTION_REQUIRED: "blocker", NET_VALUE_INVALID: "blocker", VAT_PERCENT_INVALID: "blocker",
  INVOICE_DATE_INVALID: "blocker", CATEGORY_UNRESOLVED: "blocker", FACTOR_UNRESOLVED: "blocker",
  INVOICE_DATE_OUTSIDE_PERIOD: "advisory", DUPLICATE_IN_FILE: "advisory", NON_POSITIVE_NET: "advisory",
  YOY_VARIANCE: "advisory", ALREADY_IMPORTED: "advisory",
};

export type ImportRowIssue = { code: ImportRowIssueCode; severity: ImportRowIssueSeverity; message: string };
export type ImportRowStatus = "accepted" | "advisory" | "blocked";
export type ImportRowReview = { rowNumber: number; status: ImportRowStatus; issues: ImportRowIssue[] };

export function importRowIssue(code: ImportRowIssueCode, message: string): ImportRowIssue {
  return { code, severity: IMPORT_ROW_ISSUE_SEVERITY[code], message };
}

export function importRowStatus(issues: ImportRowIssue[]): ImportRowStatus {
  if (issues.some((issue) => issue.severity === "blocker")) return "blocked";
  return issues.length > 0 ? "advisory" : "accepted";
}

export type ImportReviewSummary = { total: number; accepted: number; advisory: number; blocked: number };

export function summariseImportReview(reviews: ImportRowReview[]): ImportReviewSummary {
  return {
    total: reviews.length,
    accepted: reviews.filter((review) => review.status === "accepted").length,
    advisory: reviews.filter((review) => review.status === "advisory").length,
    blocked: reviews.filter((review) => review.status === "blocked").length,
  };
}

/** File-local + job-context validation. Server-only checks (YoY, already-imported) are appended by the backend. */
export type ImportRowContext = {
  reportingFrom: string; // YYYY-MM-DD
  reportingTo: string; // YYYY-MM-DD
  categoryIds: ReadonlySet<string>;
  factorIds: ReadonlySet<string>;
  clientFactorIds: ReadonlySet<string>;
};

export function reviewSpendImportRow(row: SpendImportRow, context: ImportRowContext, duplicateInFile: boolean): ImportRowReview {
  const issues: ImportRowIssue[] = [];
  if (!row.description.trim()) issues.push(importRowIssue("DESCRIPTION_REQUIRED", "Description is required."));
  if (row.netValue === null || !Number.isFinite(row.netValue)) issues.push(importRowIssue("NET_VALUE_INVALID", "Net value must be a number."));
  else if (row.netValue <= 0) issues.push(importRowIssue("NON_POSITIVE_NET", "Net value is zero or negative."));
  if (row.vatPercent !== null && (!Number.isFinite(row.vatPercent) || row.vatPercent < 0 || row.vatPercent > 100)) {
    issues.push(importRowIssue("VAT_PERCENT_INVALID", "VAT % must be between 0 and 100."));
  }
  if (row.invoiceDate !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.invoiceDate)) issues.push(importRowIssue("INVOICE_DATE_INVALID", "Invoice date is not a valid date."));
    else if (row.invoiceDate < context.reportingFrom || row.invoiceDate > context.reportingTo) {
      issues.push(importRowIssue("INVOICE_DATE_OUTSIDE_PERIOD", "Invoice date is outside the reporting period."));
    }
  }
  if (row.purchasedGoodsCategoryId === null || !context.categoryIds.has(row.purchasedGoodsCategoryId)) {
    issues.push(importRowIssue("CATEGORY_UNRESOLVED", "Purchased-goods category is not one of the client's controlled categories."));
  }
  const factorResolved = row.factorSource === "client"
    ? row.clientFactorId !== null && context.clientFactorIds.has(row.clientFactorId)
    : row.factorId !== null && context.factorIds.has(row.factorId);
  if (!factorResolved) issues.push(importRowIssue("FACTOR_UNRESOLVED", "Emission factor is not available on this job."));
  if (duplicateInFile) issues.push(importRowIssue("DUPLICATE_IN_FILE", "Another row in this file has the same description, net value and GL code."));
  return { rowNumber: row.rowNumber, status: importRowStatus(issues), issues };
}

/** Within-file duplicate key (description + net + GL), used to set the DUPLICATE_IN_FILE advisory. */
export function spendImportRowKey(row: Pick<SpendImportRow, "description" | "netValue" | "glCode">): string {
  return `${row.description.trim().toLowerCase()}|${row.netValue ?? ""}|${(row.glCode ?? "").trim().toLowerCase()}`;
}

// ---- The five explicit preflight states (gate §2) ---------------------------

export type ImportBlockReason = "identity-mismatch" | "stale-template" | "wrong-period" | "unreadable" | "too-large" | "too-many-rows";

export type SpendImportPreflightState =
  | { kind: "empty" }
  | { kind: "parsing" }
  | { kind: "preview"; identity: SpendImportIdentity | null; reviews: ImportRowReview[]; summary: ImportReviewSummary }
  | { kind: "blocked"; reason: ImportBlockReason; message: string }
  | { kind: "committed"; batchId: string; created: number; skipped: number; voidable: boolean };
