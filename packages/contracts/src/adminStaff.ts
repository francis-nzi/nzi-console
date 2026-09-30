import { defineListSpec, type ListQuery } from "./listQuery";

/**
 * Team & access (admin Phase B, B1; ruled `phaseB-team-access-plan.md`). The roster is `memberships` (Q1): each person
 * with a name, a work email (read-only here, Q6), a position from the governed `positions` lookup, one of the five
 * roles, and a status — active or deactivated, never deleted. Rates are their own effective-dated table (R9 (c)),
 * behind finance.manage.
 */

/** The Staff list: search by name, filters for role, status and position; by name unless asked otherwise. */
export const staffListSpec = defineListSpec({
  sortKeys: ["name", "role", "position", "status"] as const,
  defaultSort: { key: "name", dir: "asc" },
  filters: { role: "value", status: "value", position: "value" },
});
export type StaffListSortKey = (typeof staffListSpec.sortKeys)[number];
export type StaffListFilterKey = keyof typeof staffListSpec.filters;
export type StaffListQuery = ListQuery<StaffListSortKey, StaffListFilterKey>;

/** The two statuses the roster shows. `invited` and `suspended` remain in the schema and are not written. */
export const STAFF_STATUSES = ["active", "deactivated"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

export const STAFF_NAME_MAX = 120;
export const STAFF_EMAIL_MAX = 254;
/** An hourly rate's ceiling, and its currency when none is given. */
export const STAFF_RATE_MAX = 9_999_999_999.99;
export const STAFF_RATE_DEFAULT_CURRENCY = "GBP";

/** An address shape, not a deliverability check: something@domain.tld, no spaces. */
export const isWorkEmail = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length <= STAFF_EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export const isCurrencyCode = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/.test(value);
