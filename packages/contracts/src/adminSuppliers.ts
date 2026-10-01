import { isCatalogueAmount } from "./adminServiceCatalogue";
import { defineListSpec, type ListQuery } from "./listQuery";

/**
 * Suppliers and their rate card (admin Phase E4; ruled plan `phaseE-commercial-catalogue-plan.md`, E-Q6–E-Q9): the
 * subcontractors a job's other costs are bought from.
 *
 * - **The company** is plain (a name, unique per organisation, and a website).
 * - **Its people** are third-party personal data (R8, E-Q6), sealed per person: each contact is its own data subject,
 *   erased by key-shred. A contact's name, email and phone are never in a command's result, and so never in the audit,
 *   the idempotency record or the outbox — those say *which* fields were set, never what to.
 * - **The rate card** — a supplier's priced services. The agreed rate is commercially sensitive (E-Q8): read and set
 *   only with finance.manage, by its own command, whose audit says that it changed and never the figure (NZC-120).
 *   One currency (E-Q9): the organisation's selling currency, set when the line is made.
 * - **Deactivate, never delete** (R3), for all three.
 */
export const SUPPLIER_NAME_MAX = 160;
export const SUPPLIER_WEBSITE_MAX = 200;
export const SUPPLIER_CONTACT_NAME_MAX = 120;
export const SUPPLIER_CONTACT_EMAIL_MAX = 254;
export const SUPPLIER_CONTACT_PHONE_MAX = 40;
export const SUPPLIER_COST_TYPE_MAX = 60;
export const SUPPLIER_ITEM_NAME_MAX = 160;
export const SUPPLIER_ITEM_DESCRIPTION_MAX = 1000;
export const SUPPLIER_RATE_MAX = 9_999_999_999.99;

/** An agreed rate: a non-negative amount to two places, within bounds. */
export const isAgreedRate = (value: unknown): value is number => isCatalogueAmount(value, SUPPLIER_RATE_MAX);
export const isSupplierContactEmail = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length <= SUPPLIER_CONTACT_EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** The supplier list: search (name), All / Active / Inactive; by name. */
export const supplierListSpec = defineListSpec({
  sortKeys: ["name", "contacts", "items", "status"] as const,
  defaultSort: { key: "name", dir: "asc" },
  filters: { status: "value" },
});
export type SupplierListSortKey = (typeof supplierListSpec.sortKeys)[number];
export type SupplierListFilterKey = keyof typeof supplierListSpec.filters;
export type SupplierListQuery = ListQuery<SupplierListSortKey, SupplierListFilterKey>;

export type SupplierEditableFields = { name: string; website?: string | null };
/** A contact's details. Personal data: sealed on write, and never echoed into a result. */
export type SupplierContactFields = { fullName: string; email?: string | null; phone?: string | null };
/** A rate-card line's definition — never its rate (that is `supplier_item.rate.set`). */
export type SupplierItemEditableFields = {
  name: string;
  costType?: string | null;
  description?: string | null;
  unitValueId?: string | null;
  vatRateId?: string | null;
};
