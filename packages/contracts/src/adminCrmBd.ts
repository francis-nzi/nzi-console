import { defineListSpec, type ListQuery } from "./listQuery";

/**
 * CRM and business-development lookups (admin Phase F2; ruled plan `phaseF-comms-crm-plan.md`, F-Q4). CRM tags and BD
 * service lines are lookup categories on the reference-value engine (Lookups); the BD funnel's stages are typed, so they
 * are their own table, here.
 *
 * - **A stage's key is set once** — the identity an opportunity will name: lower-case letters, digits and `-`, up to 40
 *   (v7's keys are of that shape: `lead`, `qualified`). Its name, order and probability are editable, each edit a new
 *   version.
 * - **Ordered, not defaulted.** The entry stage is the first active one by order; the last active stage cannot be
 *   deactivated, so the funnel always has one.
 * - **Deactivate, never delete** (R3).
 */
export const BD_STAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const BD_STAGE_NAME_MAX = 80;
export const BD_STAGE_ORDER_MAX = 1_000_000;

/** A probability: a percentage from 0 to 100, to two places. */
export const isStageProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 && Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

/** The funnel: search (key, name), All / Active / Inactive; in the funnel's own order. */
export const bdStageListSpec = defineListSpec({
  sortKeys: ["sortOrder", "name", "probability", "status"] as const,
  defaultSort: { key: "sortOrder", dir: "asc" },
  filters: { status: "value" },
});
export type BdStageListSortKey = (typeof bdStageListSpec.sortKeys)[number];
export type BdStageListFilterKey = keyof typeof bdStageListSpec.filters;
export type BdStageListQuery = ListQuery<BdStageListSortKey, BdStageListFilterKey>;

/** What a stage's definition carries — never its key once made. */
export type BdStageEditableFields = { name: string; sortOrder: number; probabilityPct: number };
