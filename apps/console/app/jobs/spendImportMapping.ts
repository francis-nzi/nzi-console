// B4 — map a client's CSV columns onto the canonical spend fields, remembered per
// client (NZC-036). Pure and unit-tested; the browser owns parsing + mapping and
// only sends normalised SpendImportRow[] to the server.

import type { FactorOption, SpendImportRow } from "@nzi/contracts";

export const SPEND_IMPORT_FIELDS = ["description", "netValue", "vatPercent", "glCode", "invoiceDate", "category", "factor"] as const;
export type SpendImportField = (typeof SPEND_IMPORT_FIELDS)[number];

/** field -> 0-based column index in the uploaded file. */
export type ColumnMapping = Partial<Record<SpendImportField, number>>;

export const SPEND_IMPORT_FIELD_LABELS: Record<SpendImportField, string> = {
  description: "Description", netValue: "Net value", vatPercent: "VAT %", glCode: "GL code",
  invoiceDate: "Invoice date", category: "PG&S category", factor: "Emission factor",
};

const HEADER_HINTS: Record<SpendImportField, RegExp> = {
  description: /desc|narrat|detail|supplier|item|line/i,
  netValue: /net|amount|value|total|cost|spend|gbp|£/i,
  vatPercent: /vat/i,
  glCode: /\bgl\b|nominal|account\s*code|ledger/i,
  invoiceDate: /date|invoice/i,
  category: /categ|pg&?s|purchas/i,
  factor: /factor|emission/i,
};

export function autoMapColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  for (const field of SPEND_IMPORT_FIELDS) {
    const index = headers.findIndex((header, i) => !used.has(i) && HEADER_HINTS[field].test(header));
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  }
  return mapping;
}

export type SpendImportDraft = {
  rowNumber: number;
  description: string;
  netValue: number | null;
  vatPercent: number | null;
  glCode: string | null;
  invoiceDate: string | null;
  categoryName: string | null;
  factorLabel: string | null;
};

const unquote = (value: string): string => value.replace(/^'/, "");
const num = (raw: string | undefined): number | null => {
  if (raw == null) return null;
  const cleaned = unquote(raw).replace(/[£$€,\s]/g, "").replace(/%$/, "");
  return cleaned === "" || Number.isNaN(Number(cleaned)) ? null : Number(cleaned);
};
const isoDate = (raw: string | undefined): string | null => {
  if (raw == null) return null;
  const text = unquote(raw).trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(text); // dd/mm/yyyy (NZC-040)
  if (match) {
    const year = match[3]!.length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  }
  return null;
};

export function applyMapping(rows: string[][], mapping: ColumnMapping): SpendImportDraft[] {
  const cell = (row: string[], field: SpendImportField): string | undefined => {
    const index = mapping[field];
    return index == null ? undefined : row[index];
  };
  const text = (row: string[], field: SpendImportField): string | null => {
    const value = cell(row, field);
    return value == null ? null : unquote(value).trim() || null;
  };
  return rows.map((row, i) => ({
    rowNumber: i + 1,
    description: text(row, "description") ?? "",
    netValue: num(cell(row, "netValue")),
    vatPercent: num(cell(row, "vatPercent")),
    glCode: text(row, "glCode"),
    invoiceDate: isoDate(cell(row, "invoiceDate")),
    categoryName: text(row, "category"),
    factorLabel: text(row, "factor"),
  }));
}

/** Turn drafts into normalised rows by resolving category names and factor labels against the job's controlled lists. */
export function resolveDraftRows(
  drafts: SpendImportDraft[],
  categories: ReadonlyArray<{ id: string; name: string }>,
  factors: ReadonlyArray<Pick<FactorOption, "factorId" | "label" | "factorSource" | "datasetId" | "clientFactorId">>,
): SpendImportRow[] {
  const categoryByName = new Map(categories.map((category) => [category.name.trim().toLowerCase(), category.id]));
  const factorByLabel = new Map(factors.map((factor) => [factor.label.trim().toLowerCase(), factor]));
  return drafts.map((draft) => {
    const factor = draft.factorLabel ? factorByLabel.get(draft.factorLabel.toLowerCase()) : undefined;
    return {
      rowNumber: draft.rowNumber,
      description: draft.description,
      netValue: draft.netValue,
      vatPercent: draft.vatPercent,
      glCode: draft.glCode,
      invoiceDate: draft.invoiceDate,
      purchasedGoodsCategoryId: draft.categoryName ? categoryByName.get(draft.categoryName.toLowerCase()) ?? null : null,
      factorSource: factor?.factorSource ?? "dataset",
      factorId: factor?.factorSource === "dataset" ? factor.factorId : null,
      datasetId: factor?.factorSource === "dataset" ? factor.datasetId : null,
      clientFactorId: factor?.factorSource === "client" ? factor.clientFactorId : null,
      monthly: [],
    };
  });
}
