import { defineListSpec, type ListQuery } from "./listQuery";

/**
 * Commercial lookups (admin Phase E1; ruled plan `phaseE-commercial-catalogue-plan.md`, E-Q1–E-Q3): VAT rates and
 * currencies, each its own typed table with **exactly one default** per organisation (0145). Deactivate, never delete:
 * a deactivated rate or currency leaves the pickers but still resolves on whatever already names it (R3), and the
 * default can never be deactivated — another becomes the default first.
 *
 * - **VAT rates** (0139's table, imported by C4): a name and a percentage, 0–100 to two places.
 * - **Currencies** (0145): an ISO-4217 code — three capital letters, set once, never "UAE" (E-Q2: the set is AED, with
 *   no alias) — a name and a symbol. No exchange rate (E-Q1).
 */
export const VAT_RATE_NAME_MAX = 120;
export const CURRENCY_NAME_MAX = 80;
export const CURRENCY_SYMBOL_MAX = 8;
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** A percentage from 0 to 100, to two places at most. */
export const isVatPercentage = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 && Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

/** An ISO-4217-shaped code that is not the country "UAE" (v7's defect, E-Q2). */
export const isCurrencyCodeForSet = (value: unknown): value is string =>
  typeof value === "string" && CURRENCY_CODE_PATTERN.test(value) && value !== "UAE";

/** The VAT rates list: search (name), All / Active / Inactive; by rate. */
export const vatRateListSpec = defineListSpec({
  sortKeys: ["ratePct", "name", "status"] as const,
  defaultSort: { key: "ratePct", dir: "desc" },
  filters: { status: "value" },
});
export type VatRateListSortKey = (typeof vatRateListSpec.sortKeys)[number];
export type VatRateListFilterKey = keyof typeof vatRateListSpec.filters;
export type VatRateListQuery = ListQuery<VatRateListSortKey, VatRateListFilterKey>;

/** The currencies list: search (code, name), All / Active / Inactive; by code. */
export const currencyListSpec = defineListSpec({
  sortKeys: ["code", "name", "status"] as const,
  defaultSort: { key: "code", dir: "asc" },
  filters: { status: "value" },
});
export type CurrencyListSortKey = (typeof currencyListSpec.sortKeys)[number];
export type CurrencyListFilterKey = keyof typeof currencyListSpec.filters;
export type CurrencyListQuery = ListQuery<CurrencyListSortKey, CurrencyListFilterKey>;

/** What a VAT rate edit may change. */
export type VatRateEditableFields = { name: string; ratePct: number };
/** What a currency edit may change — never the code. */
export type CurrencyEditableFields = { name: string; symbol: string };
