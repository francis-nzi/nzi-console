import { defineListSpec, type ListQuery } from "./listQuery";

/**
 * The service catalogue (admin Phase E2; ruled plan `phaseE-commercial-catalogue-plan.md`, E-Q4/E-Q5/E-Q8/E-Q9): the
 * items a quote line or a job line is chosen from.
 *
 * - **An item's code is set once** (E-Q4): upper-case letters, digits, `-` and `_`, unique per organisation. Its name,
 *   description, category, unit, hours, VAT and order are editable, each edit a new version.
 * - **Cost and sell are commercially sensitive** (E-Q8): read and set only with finance.manage, by a command of their
 *   own (`job_item.price.set`) whose audit says which amounts were set — never the amounts (NZC-120).
 * - **One currency** (E-Q9): the organisation's selling currency, set when the item is made.
 * - **Deactivate, never delete** (R3): a deactivated item leaves the picker but still resolves where it is named. E
 *   builds the catalogue only (E-Q5); the copy into a job's lines is downstream.
 */
export const JOB_ITEM_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
export const JOB_ITEM_NAME_MAX = 120;
export const JOB_ITEM_DESCRIPTION_MAX = 1000;
export const JOB_ITEM_HOURS_MAX = 10_000;
export const JOB_ITEM_AMOUNT_MAX = 9_999_999_999.99;

/** A non-negative amount held to two places, within bounds. */
export const isCatalogueAmount = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max && Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

/** The catalogue list: search (code, name), All / Active / Inactive, a category filter; in the catalogue's own order. */
export const jobItemListSpec = defineListSpec({
  sortKeys: ["sortOrder", "code", "name", "category", "hours", "status"] as const,
  defaultSort: { key: "sortOrder", dir: "asc" },
  filters: { status: "value", category: "value" },
});
export type JobItemListSortKey = (typeof jobItemListSpec.sortKeys)[number];
export type JobItemListFilterKey = keyof typeof jobItemListSpec.filters;
export type JobItemListQuery = ListQuery<JobItemListSortKey, JobItemListFilterKey>;

/** What an item's definition carries — never its code once made, never its amounts (those are `job_item.price.set`). */
export type JobItemEditableFields = {
  name: string;
  description?: string | null;
  categoryValueId?: string | null;
  unitValueId?: string | null;
  defaultHours?: number | null;
  vatRateId?: string | null;
  sortOrder?: number;
};

/**
 * Job-type templates (admin Phase E3; ruled plan E-Q5/E-Q10): the catalogue items a new job of a type starts with —
 * the **source** of the copy at job creation, never the copy (`docs/JOB_TYPE_TEMPLATE_CONTRACT.md`). Set whole, in
 * order, by `job_type.items.set` against the template's own version; an item dropped is kept as not included, never
 * deleted.
 */
export const JOB_TYPE_ITEMS_MAX = 50;
export const JOB_TYPE_ITEM_QUANTITY_MAX = 1_000_000;
export type JobTypeTemplateEntry = { itemId: string; quantity: number; isRequired: boolean };
/** A quantity above 0, to two places. */
export const isTemplateQuantity = (value: unknown): value is number =>
  typeof value === "number" && value > 0 && isCatalogueAmount(value, JOB_TYPE_ITEM_QUANTITY_MAX);
