// NZC-062 — "Add rows from template": a fast, forgiving search across the
// whole job factor library (every selected dataset + client factor, every
// scope/category), independent of the per-category smart-search. Pure so the
// matching itself is unit-testable without a DOM.
import { emissionCategoryTaxonomy, type FactorOption } from "@nzi/contracts";

/**
 * One pickable result: a factor stamped to one specific scope/category. A
 * factor whose `scopes` names a Scope 3 code resolves to exactly that one
 * category (Scope 3 taxonomy codes ARE the GHG codes — unambiguous). A Scope
 * 1/2 factor names only the bare scope, which spans several UI categories
 * (e.g. "1" → Natural Gas / Company Vehicles / Refrigerants) with no way to
 * tell which one a factor belongs to from the factor alone — so it expands to
 * one candidate per category in that scope, each independently pickable and
 * distinguishable by the category shown, rather than guessing.
 */
export type TemplateSearchResult = {
  factor: FactorOption;
  scope: string;
  categoryCode: string | null;
  categoryLabel: string;
  searchText: string;
};

export function buildTemplateSearchIndex(factors: readonly FactorOption[]): TemplateSearchResult[] {
  const results: TemplateSearchResult[] = [];
  for (const factor of factors) {
    for (const category of factor.categories) {
      const candidates = category.scope === "3"
        ? [{ code: category.scopeCode, name: category.label }]
        : emissionCategoryTaxonomy.filter((entry) => entry.scope === category.scope).map((entry) => ({ code: entry.code, name: entry.name }));
      for (const candidate of candidates) {
        results.push({
          factor,
          scope: category.scopeCode,
          categoryCode: candidate.code,
          categoryLabel: candidate.name,
          searchText: `${factor.label} ${candidate.name} ${factor.activityUnit} ${factor.datasetName}`,
        });
      }
    }
  }
  return results;
}

/**
 * A cheap, forgiving fuzzy match: an exact substring hit ranks highest (by
 * how early it appears); failing that, every query character must appear in
 * order somewhere in the target (a subsequence match, like a quick-open file
 * picker), scored higher for consecutive / early hits. Returns null for no
 * match at all.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = target.toLowerCase();
  const substringIndex = t.indexOf(q);
  if (substringIndex !== -1) return 10_000 - substringIndex;

  let cursor = 0;
  let score = 0;
  let streak = 0;
  for (const char of q) {
    const found = t.indexOf(char, cursor);
    if (found === -1) return null;
    score += found === cursor ? 3 + streak : 1;
    streak = found === cursor ? streak + 1 : 0;
    cursor = found + 1;
  }
  return score;
}

export function searchTemplateIndex(index: readonly TemplateSearchResult[], query: string, limit = 30): TemplateSearchResult[] {
  if (!query.trim()) return index.slice(0, limit);
  return index
    .map((result) => ({ result, score: fuzzyScore(query, result.searchText) }))
    .filter((entry): entry is { result: TemplateSearchResult; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.result);
}
