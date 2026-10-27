/**
 * Data entry D2 (27 Oct): the allocation map — a spend line routed to its proper scope and category, so PG&S stops being where
 * spend goes by default.
 *
 * A client's map keys a **GL code** (or, where the client has none, a **normalised description**) to a target category in the
 * emission taxonomy, with whether VAT applies there and, optionally, the spend factor to price it with. A line the map does not
 * know lands in **PG&S (3.1), the residual**. A line is always filed as a **spend-basis** entry (D1): it arrived as money.
 *
 * The map learns: moving a line to another category at review records the move for its key, so the same GL code routes there
 * next time (R4). Nothing here writes the map; this is the vocabulary and the pure routing both the write and the form share.
 */
import { emissionCategoryTaxonomy, type EmissionCategory } from "./commands";

/** PG&S — where a line with no more-specific mapping lands (R3). */
export const SPEND_RESIDUAL_CATEGORY = "3.1";

export const SPEND_ALLOCATION_KEY_KINDS = ["gl", "description"] as const;
export type SpendAllocationKeyKind = (typeof SPEND_ALLOCATION_KEY_KINDS)[number];

/** Where a map entry came from: set in Admin, learnt from a re-allocation at review, or a confirmed AI suggestion (D2 R5). */
export const SPEND_ALLOCATION_SOURCES = ["admin", "reallocation", "suggestion-confirmed"] as const;
export type SpendAllocationSource = (typeof SPEND_ALLOCATION_SOURCES)[number];

export const SPEND_ALLOCATION_KEY_MAX = 200;
/** D2 R5: an AI suggestion's reason — one short, figure-free sentence. */
export const SPEND_SUGGESTION_REASON_MAX = 240;

/**
 * The categories VAT does not apply to (R6): Investments — pensions, financial services. Every other category defaults to VAT
 * applying; a map entry can say otherwise for its own key. The client still enters the % per line (D1).
 */
export const NO_VAT_CATEGORIES: readonly string[] = ["3.15"];
export const vatAppliesByDefault = (categoryCode: string): boolean => !NO_VAT_CATEGORIES.includes(categoryCode);

/** A GL code as the map keys it: trimmed, inner spaces gone, upper-cased — "7420", " 74 20 " and "7420 " are one code. */
export function normaliseGlCode(value: string | null | undefined): string | null {
  const code = (value ?? "").replace(/\s+/g, "").toUpperCase();
  return code === "" ? null : code;
}

/**
 * A description as the map keys it, for a client with no GL codes: lower-cased, punctuation to spaces, digits dropped (an
 * invoice number or a month is not what the line *is*), whitespace collapsed. "Pensions admin — Q1 2025" and "PENSIONS ADMIN
 * Q2" are one key.
 */
export function normaliseDescription(value: string | null | undefined): string | null {
  const text = (value ?? "").toLowerCase().replace(/[0-9]+/g, " ").replace(/[^\p{L}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/** The key a line is looked up by: its GL code where it has one, else its description (R1). */
export function spendAllocationKey(line: { glCode?: string | null; description?: string | null }): { kind: SpendAllocationKeyKind; key: string } | null {
  const gl = normaliseGlCode(line.glCode);
  if (gl) return { kind: "gl", key: gl };
  const description = normaliseDescription(line.description);
  return description ? { kind: "description", key: description } : null;
}

/** A map entry as routing reads it. */
export type SpendAllocationEntry = {
  allocationId: string;
  keyKind: SpendAllocationKeyKind;
  matchKey: string;
  targetCategoryCode: string;
  vatApplies: boolean;
  defaultDatasetId: string | null;
  defaultFactorId: string | null;
};

/** Where one line goes, and why — shown beside the line, never applied out of sight (R2). */
export type SpendRouting = {
  categoryCode: string;
  /** `gl` / `description`: the client's map; `residual`: nothing more specific, so PG&S. */
  by: "gl" | "description" | "residual";
  vatApplies: boolean;
  allocationId: string | null;
  defaultDatasetId: string | null;
  defaultFactorId: string | null;
};

/**
 * Route a line through a client's (active) map: its GL code first; its description only where it has no GL code (a GL code the
 * map does not know does not fall back to the description — the code is the client's own classification, and a description match
 * could contradict it); else the residual.
 */
export function routeSpendLine(entries: readonly SpendAllocationEntry[], line: { glCode?: string | null; description?: string | null }): SpendRouting {
  const key = spendAllocationKey(line);
  const found = key ? entries.find((entry) => entry.keyKind === key.kind && entry.matchKey === key.key) : undefined;
  if (found) {
    return { categoryCode: found.targetCategoryCode, by: found.keyKind, vatApplies: found.vatApplies, allocationId: found.allocationId,
      defaultDatasetId: found.defaultDatasetId, defaultFactorId: found.defaultFactorId };
  }
  return { categoryCode: SPEND_RESIDUAL_CATEGORY, by: "residual", vatApplies: vatAppliesByDefault(SPEND_RESIDUAL_CATEGORY), allocationId: null,
    defaultDatasetId: null, defaultFactorId: null };
}

export const spendCategoryOf = (code: string): EmissionCategory | undefined => emissionCategoryTaxonomy.find((entry) => entry.code === code);

/** A scope row's `scope` for a category: granular for Scope 3 ("3.15"), the bare scope otherwise ("1"). */
export const rowScopeForCategory = (code: string): string | null => {
  const category = spendCategoryOf(code);
  return category ? (category.scope === "3" ? category.code : category.scope) : null;
};

/** How a routing reads beside its line: "Investments (3.15) — this client's map, by GL code". */
export function spendRoutingLabel(routing: Pick<SpendRouting, "categoryCode" | "by">): string {
  const category = spendCategoryOf(routing.categoryCode);
  const name = category ? `${category.name} (${category.code})` : routing.categoryCode;
  return routing.by === "residual" ? `${name} — not in this client's map, so the PG&S residual`
    : `${name} — this client's map, by ${routing.by === "gl" ? "GL code" : "description"}`;
}

/** A map entry as Admin lists it. */
export type SpendAllocationRow = SpendAllocationEntry & {
  clientId: string;
  displayKey: string;
  source: SpendAllocationSource;
  active: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string;
  defaultFactorLabel: string | null;
};

/** The fields a map entry is made of, checked the same way on create and update. */
export function spendAllocationFieldIssues(input: {
  targetCategoryCode?: unknown; vatApplies?: unknown; defaultDatasetId?: unknown; defaultFactorId?: unknown;
}): Array<{ field: string; code: string; message: string }> {
  const issues: Array<{ field: string; code: string; message: string }> = [];
  if (typeof input.targetCategoryCode !== "string" || !spendCategoryOf(input.targetCategoryCode)) {
    issues.push({ field: "targetCategoryCode", code: "INVALID", message: "Choose the category this line belongs in, from the emission taxonomy." });
  }
  if (typeof input.vatApplies !== "boolean") issues.push({ field: "vatApplies", code: "INVALID", message: "Say whether VAT applies to this line." });
  const dataset = input.defaultDatasetId ?? null, factor = input.defaultFactorId ?? null;
  if ((dataset === null) !== (factor === null) || (dataset !== null && (typeof dataset !== "string" || !dataset.trim() || typeof factor !== "string" || !factor.trim()))) {
    issues.push({ field: "defaultFactorId", code: "PAIRED", message: "A default spend factor names its dataset and its factor, or neither." });
  }
  return issues;
}
