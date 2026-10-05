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
