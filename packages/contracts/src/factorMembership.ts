import { emissionCategoryTaxonomy } from "./commands";
import { isCurrencyUnit } from "./entryBasis";
import type { CategoryVariant } from "./factorVariants";

/**
 * Which factors belong to which category (NZC-171, ruled): derived from the DESNZ `source_levels` each factor already stores, through
 * a reviewable map of (level 1, level 2, level 3) -> category, never from a code list. This file is the rule; the map is data
 * (`factor_category_membership`, migration 0209) and a person with `factor.manage` edits it.
 *
 * - A rule names a level 1 and, optionally, a level 2 and a level 3. An absent level is "any". Levels compare case-insensitively with
 *   runs of whitespace collapsed (the source data carries double spaces and newlines).
 * - A rule with no category is a family deliberately held back until its category exists (Heat and steam - there is no Scope 2 heat
 *   category yet). It is not "unfiled": it is known, and it is listed.
 * - A **variant** id (`<base>-c`) is a member of the category its suffix names - what the id says it is - and of nothing else. Reading
 *   the base's families instead would put a commuting copy under business travel.
 * - A **spend** factor (priced in a currency) is not in the DESNZ taxonomy: it belongs to every spend-kind category, and to the category
 *   an applicability pair names.
 * - A category no rule names has no family of its own (3.10, 3.11, 3.14, and 3.15 outside spend): its list is the whole scope, with a
 *   notice. It is never empty.
 */
export type MembershipRule = { sourceL1: string; sourceL2: string | null; sourceL3: string | null; categoryCode: string | null };

export const normaliseLevel = (level: string | null | undefined): string => (level ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Whether one rule claims a factor's level path. */
export function ruleMatches(rule: MembershipRule, levels: readonly string[]): boolean {
  if (normaliseLevel(levels[0]) !== normaliseLevel(rule.sourceL1) || normaliseLevel(rule.sourceL1) === "") return false;
  if (rule.sourceL2 !== null && normaliseLevel(levels[1]) !== normaliseLevel(rule.sourceL2)) return false;
  if (rule.sourceL3 !== null && normaliseLevel(levels[2]) !== normaliseLevel(rule.sourceL3)) return false;
  return true;
}

/** The categories a level path is mapped to (sorted, de-duplicated). Rules held back (no category) add none. */
export function categoriesForLevels(rules: readonly MembershipRule[], levels: readonly string[]): string[] {
  return [...new Set(rules.filter((rule) => rule.categoryCode !== null && ruleMatches(rule, levels)).map((rule) => rule.categoryCode!))].sort();
}

/** Whether any rule - including a held-back one - claims the level path. A physical factor nothing claims is "unfiled". */
export const levelsAreFiled = (rules: readonly MembershipRule[], levels: readonly string[]): boolean => rules.some((rule) => ruleMatches(rule, levels));

/** The category codes no rule names: their list is scope-wide, with a notice. */
export function familylessCategories(rules: readonly MembershipRule[]): string[] {
  const named = new Set(rules.map((rule) => rule.categoryCode).filter((code): code is string => code !== null));
  return emissionCategoryTaxonomy.map((category) => category.code).filter((code) => !named.has(code));
}

export const SCOPE_WIDE_NOTICE = "No category-specific factors for this category - showing all of this scope; choose carefully.";

/** The category a variant suffix serves. The four vehicle suffixes (GHG category "1") are Company Vehicles'. */
export const variantCategoryCode = (variant: Pick<CategoryVariant, "ghgCategory">): string => (variant.ghgCategory === "1" ? "1.company-vehicles" : variant.ghgCategory);

/** What the membership read needs to know about one offered factor. */
export type MembershipFactor = { factorId: string; activityUnit: string; sourceLevels: readonly string[] };

const spendCategoryCodes = (): Set<string> => new Set(emissionCategoryTaxonomy.filter((category) => category.kind === "spend").map((category) => category.code));

/**
 * The factor ids a category offers, out of the factors a job has, or `null` when the category has no family and so no list to enforce.
 *
 * `pairedCategories(baseFactorId)` is the applicability read: the category codes an active pair files the base under.
 * `parse` is the registry's parser (`parseFactorId`).
 */
export function membersOfCategory(input: {
  categoryCode: string; rules: readonly MembershipRule[]; factors: readonly MembershipFactor[];
  parse: (factorId: string) => { base: string; variant: CategoryVariant | null };
  pairedCategories: (baseFactorId: string) => ReadonlySet<string> | undefined;
}): string[] | null {
  if (!input.rules.some((rule) => rule.categoryCode === input.categoryCode)) return null;
  const spendKind = spendCategoryCodes().has(input.categoryCode);
  const members = new Set<string>();
  for (const factor of input.factors) {
    const { base, variant } = input.parse(factor.factorId);
    if (variant) { if (variantCategoryCode(variant) === input.categoryCode) members.add(factor.factorId); continue; }
    if (input.pairedCategories(base)?.has(input.categoryCode)) { members.add(factor.factorId); continue; }
    if (isCurrencyUnit(factor.activityUnit)) { if (spendKind) members.add(factor.factorId); continue; }
    if (categoriesForLevels(input.rules, factor.sourceLevels).includes(input.categoryCode)) members.add(factor.factorId);
  }
  return [...members].sort();
}

/** A physical, unvarianted factor that no rule claims and no pair files: offered in no list until the map names its family. */
export function isUnfiled(factor: MembershipFactor, rules: readonly MembershipRule[], parse: (factorId: string) => { variant: CategoryVariant | null }, paired: boolean): boolean {
  if (paired || parse(factor.factorId).variant || isCurrencyUnit(factor.activityUnit)) return false;
  return !levelsAreFiled(rules, factor.sourceLevels);
}

/** Add or retire, as the commands validate them. */
export const MEMBERSHIP_NOTE_MAX = 300;
