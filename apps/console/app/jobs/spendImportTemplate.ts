// B4 — the downloadable spend import template (NZC-036, decision D1: CSV-first).
// Plain CSV: headers + one worked example. No embedded identity block — CSV is
// import-only and takes its job identity from the app context (decision D6); the
// consultant downloads this from the job they are already on.

import { SPEND_IMPORT_FIELD_LABELS, SPEND_IMPORT_FIELDS } from "./spendImportMapping";

const csvCell = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export const SPEND_IMPORT_TEMPLATE_HEADERS: string[] = SPEND_IMPORT_FIELDS.map((field) =>
  field === "invoiceDate" ? "Invoice date (dd/mm/yyyy)" : SPEND_IMPORT_FIELD_LABELS[field],
);

const SAMPLE_ROW: string[] = [
  "Office paper and stationery", "1240.00", "20", "7504", "14/03/2025",
  "Paper and printed materials", "Paper products (spend-based)",
];

export function buildSpendImportTemplateCsv(): string {
  return [SPEND_IMPORT_TEMPLATE_HEADERS, SAMPLE_ROW].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function spendImportTemplateFilename(jobNumber: string, clientName: string, jobName: string, reportingYear: number): string {
  const clean = (value: string) => value.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, "").trim();
  return `${clean(jobNumber)}_${clean(clientName)}_${clean(jobName)}_${reportingYear}_Spend.csv`;
}
