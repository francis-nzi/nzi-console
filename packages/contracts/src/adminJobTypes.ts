import { defineListSpec, type ListQuery } from "./listQuery";

/**
 * Job types (admin Phase C1; ruled plan `admin-phaseC-plan.md`, Q2–Q4, Q8): the services the firm sells, each with one
 * family, a default price ex VAT, estimated hours, a VAT rate and the milestone template a new job of the type starts
 * from. Typed, so their own table (R2), not a reference-value category.
 */
export const JOB_TYPE_FAMILIES = ["crp", "consultancy", "lca", "pcf", "training"] as const;
export type JobTypeFamily = (typeof JOB_TYPE_FAMILIES)[number];
export const isJobTypeFamily = (value: unknown): value is JobTypeFamily =>
  typeof value === "string" && (JOB_TYPE_FAMILIES as readonly string[]).includes(value);

/** The Job types list: search (name, code), the family and status filters; by name unless asked otherwise. */
export const jobTypeListSpec = defineListSpec({
  sortKeys: ["name", "family", "price", "hours", "inUse", "status"] as const,
  defaultSort: { key: "name", dir: "asc" },
  filters: { family: "value", status: "value" },
});
export type JobTypeListSortKey = (typeof jobTypeListSpec.sortKeys)[number];
export type JobTypeListFilterKey = keyof typeof jobTypeListSpec.filters;
export type JobTypeListQuery = ListQuery<JobTypeListSortKey, JobTypeListFilterKey>;

/** Bounds a job type's fields hold to — the command validates them, and 0139 holds them again. */
export const JOB_TYPE_NAME_MAX = 120;
export const JOB_TYPE_CODE_MAX = 32;
export const JOB_TYPE_DESCRIPTION_MAX = 2000;
export const JOB_TYPE_PRICE_MAX = 9_999_999_999.99;
export const JOB_TYPE_HOURS_MAX = 999_999.99;

/** A job type's editable fields, as every create and update carries them. */
export type JobTypeFields = {
  name: string;
  code?: string | null;
  family: JobTypeFamily;
  description?: string | null;
  defaultPriceExVat?: number | null;
  estimatedHours?: number | null;
  vatRateId?: string | null;
  milestoneTemplateId?: string | null;
};

/** At most two decimal places, and within bounds — money and hours are held as numeric(·,2). */
export const isTwoDecimalAmount = (value: number, max: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= max && Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
