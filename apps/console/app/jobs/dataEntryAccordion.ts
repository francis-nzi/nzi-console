// UX1b — grouping the canonical evidence register into the scope→category
// accordion (NZC-046 / DATA_ENTRY_UX.md §1). Pure: given the job's rows and the
// CRM applicable-category list, place every row in its category section, keep
// server-computed metrics authoritative, and never lose a row — anything whose
// code maps to no applicable category surfaces in that scope's "Unsorted" bucket
// (truth before apparent availability).
import type { ApplicableCategory, JobApplicableCategories, ScopeRowReadModel } from "@nzi/contracts";
import { emissionCategoryTaxonomy, scopeMeta } from "@nzi/contracts";
import { scopeRowNeedsAttention } from "./scopeRegister";

const TAXONOMY_CODES = new Set(emissionCategoryTaxonomy.map(category => category.code));

/**
 * The category a row belongs to. The stamped `category_code` wins; failing that
 * the row's own `scope` string is tried, because the Scope 3 taxonomy codes
 * (`3.1`…`3.15`) are deliberately the granular scope codes — so a legacy
 * `scope:"3.1"` row sorts into Purchased Goods and Services with no backfill.
 * Scope 1/2 legacy rows (`scope:"1"`/`"2"`) match nothing and stay Unsorted.
 */
export function rowCategoryCode(row: ScopeRowReadModel): string | null {
  const code = (row.categoryCode && row.categoryCode.trim()) || row.scope;
  return TAXONOMY_CODES.has(code) ? code : null;
}

/**
 * SPEC-review-surface-readiness §1: the category view shows the enabled rows by default. Switched-off rows — a reverted
 * re-ingest's superseded rows, deactivated rows, v7 rows a re-ingest switched off — stay reachable behind a toggle and are never
 * deleted. Totals are the server's and count enabled rows either way, so the toggle changes what is listed, never a figure.
 */
export function visibleAccordionRows(rows: ScopeRowReadModel[], showSwitchedOff: boolean): { rows: ScopeRowReadModel[]; switchedOff: number } {
  const switchedOff = rows.filter(row => !row.enabled).length;
  return { rows: showSwitchedOff ? rows : rows.filter(row => row.enabled), switchedOff };
}

export type AccordionCategory = {
  category: ApplicableCategory;
  rows: ScopeRowReadModel[];
  /** enabled rows (server truth) */
  entryCount: number;
  tco2e: number;
  completeness: number;
  needsAttention: number;
  noData: boolean;
};

export type AccordionScopeGroup = {
  scope: "1" | "2" | "3";
  label: string;
  categories: AccordionCategory[];
  /**
   * v7's history, as imported (0133): its rows carry the bare scope and no category, so they are shown as what they
   * are — imported, under v7's own labels — not as rows the console failed to sort (JW-10).
   */
  imported: ScopeRowReadModel[];
  /** Console-captured rows whose code maps to no category — a category is stamped when the row is next saved. */
  unsorted: ScopeRowReadModel[];
};

export function buildDataEntryAccordion(
  rows: ScopeRowReadModel[],
  applicable: JobApplicableCategories,
): AccordionScopeGroup[] {
  const byCode = new Map<string, ScopeRowReadModel[]>();
  const unsortedByScope = new Map<string, ScopeRowReadModel[]>();
  const importedByScope = new Map<string, ScopeRowReadModel[]>();
  const push = (map: Map<string, ScopeRowReadModel[]>, key: string, row: ScopeRowReadModel) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  };
  for (const row of rows) {
    const code = rowCategoryCode(row);
    if (code) push(byCode, code, row);
    else push(row.origin === "migrated" ? importedByScope : unsortedByScope, row.scope.split(".")[0] ?? "", row);
  }

  return applicable.includedScopes.map(scope => {
    const categories = applicable.categories
      .filter(category => category.scope === scope)
      .map<AccordionCategory>(category => {
        const categoryRows = byCode.get(category.code) ?? [];
        return {
          category,
          rows: categoryRows,
          entryCount: category.entryCount,
          tco2e: category.tco2e,
          completeness: category.completeness,
          needsAttention: categoryRows.filter(scopeRowNeedsAttention).length,
          noData: category.noData,
        };
      });
    return {
      scope,
      label: scopeMeta[scope].label,
      categories,
      imported: importedByScope.get(scope) ?? [],
      unsorted: unsortedByScope.get(scope) ?? [],
    };
  });
}

/** A scope with no rows of any kind — shown with "No data yet", never left out (JW-10). */
export function scopeHasNoData(group: AccordionScopeGroup): boolean {
  return group.categories.every(category => category.noData && category.rows.length === 0) && group.imported.length === 0 && group.unsorted.length === 0;
}

/** A category with data in it and something that still needs attention. */
export function categoryHasWork(entry: AccordionCategory): boolean {
  return !entry.noData && entry.needsAttention > 0;
}

/**
 * DESIGN-job-data-entry-usability C: what is open when the page loads. Every category starts collapsed — the capture gate's
 * at-rest rule (NZC-147), and with it completed and "no data" categories are collapsed and quiet. The first level is the scope:
 * a scope collapses by default once it has data and nothing in it needs attention, so a finished job reads as a short list. A
 * scope with work in it, or with nothing in it yet, stays open — so starting a new job is unchanged. A person's own open/close
 * always wins over these.
 */
export function scopeOpenByDefault(group: AccordionScopeGroup): boolean {
  if (scopeHasNoData(group)) return true;
  return group.categories.some(categoryHasWork) || group.unsorted.length > 0 || accordionAttentionRows(group.imported).length > 0;
}

/** A collapsed scope's summary: its entries and tCO₂e (the same server figures as its categories) and its share of the job's total. */
export function scopeSummary(group: AccordionScopeGroup, groups: AccordionScopeGroup[]): { entries: number; tco2e: number; sharePercent: number | null } {
  const tco2eOf = (scope: AccordionScopeGroup) => scope.categories.reduce((sum, category) => sum + category.tco2e, 0);
  const entries = group.categories.reduce((sum, category) => sum + category.entryCount, 0);
  const tco2e = tco2eOf(group);
  const total = groups.reduce((sum, scope) => sum + tco2eOf(scope), 0);
  return { entries, tco2e, sharePercent: total > 0 ? Math.round((tco2e / total) * 100) : null };
}

/** The flat "Needs attention" lens over the same rows (the CRP's exception-first strength, §1). */
export function accordionAttentionRows(rows: ScopeRowReadModel[]): ScopeRowReadModel[] {
  return rows.filter(scopeRowNeedsAttention);
}

export function accordionTotals(groups: AccordionScopeGroup[]) {
  const categories = groups.flatMap(group => group.categories);
  return {
    categories: categories.length,
    withData: categories.filter(category => !category.noData).length,
    needsAttention:
      categories.reduce((sum, category) => sum + category.needsAttention, 0) +
      groups.reduce((sum, group) => sum + accordionAttentionRows([...group.imported, ...group.unsorted]).length, 0),
    imported: groups.reduce((sum, group) => sum + group.imported.length, 0),
    unsorted: groups.reduce((sum, group) => sum + group.unsorted.length, 0),
  };
}
