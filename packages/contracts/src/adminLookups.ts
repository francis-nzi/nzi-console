import { defineListSpec, type ListQuery } from "./listQuery";

/**
 * The reference-value engine's lookups (admin Phase A2; ruled P3): the categories the Lookups screen manages, in the
 * order its chips show them. Industries and referrals are 0089's; the ten after them 0138's; CRM tags and BD service
 * lines 0150's (admin F2).
 *
 * Deliberately a closed list rather than "every category": `emission_category` is a reference category too, but its
 * codes live in the migration-owned input spec (0093) and it is not edited here. A command naming any category outside
 * this list is refused.
 */
export const LOOKUP_CATEGORIES = [
  "industries", "referrals", "portfolios", "payment_terms", "positions", "processes",
  "client_teams", "action_categories", "governance_subjects", "bd_bin_reasons", "units_of_measure", "job_item_categories",
  "crm_tags", "bd_service_lines",
] as const;
export type LookupCategory = (typeof LOOKUP_CATEGORIES)[number];
export const isLookupCategory = (value: unknown): value is LookupCategory =>
  typeof value === "string" && (LOOKUP_CATEGORIES as readonly string[]).includes(value);

/** The Lookups list: search, the category chip, the All / Active / Inactive segment; sorted by the value's own order. */
export const referenceValueListSpec = defineListSpec({
  sortKeys: ["sortOrder", "label", "inUse", "status"] as const,
  defaultSort: { key: "sortOrder", dir: "asc" },
  filters: { category: "value", status: "value" },
});
export type ReferenceValueListSortKey = (typeof referenceValueListSpec.sortKeys)[number];
export type ReferenceValueListFilterKey = keyof typeof referenceValueListSpec.filters;
export type ReferenceValueListQuery = ListQuery<ReferenceValueListSortKey, ReferenceValueListFilterKey>;

/** Longest label and code a value may carry — enough for any real lookup, short enough to stay a label. */
export const LOOKUP_LABEL_MAX = 120;
export const LOOKUP_CODE_MAX = 32;
