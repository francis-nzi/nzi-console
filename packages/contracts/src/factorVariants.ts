/**
 * Base and suffix, as one concept (NZC-145).
 *
 * A factor id may carry a suffix recording which GHG Protocol category the factor is being used under:
 * `<base>-b` is the business-travel variant of `<base>`. Every variant of a base has the same
 * kgCO₂e per unit — the suffix records the category, not a different value.
 *
 * This module is the only place that knows how to take an id apart, and it is deliberately small. The
 * alternative is `factorId.split("-")` appearing in a read model, a picker and a report, which is three
 * chances to disagree about what a factor is.
 *
 * ## A suffix is a suffix only because the registry says so
 *
 * Parsing is against the live registry and never against a shape. Every factor already in this system ends
 * in something that looks like a suffix — `diesel-demo`, `freight-demo`, `electricity-us-demo`,
 * `lca-rpet-demo` — so a parser that split on the last hyphen would report `diesel-demo` as `diesel` with a
 * `-demo` variant, attach a category nobody registered, and group unrelated factors under one base. The
 * registry is what makes the difference between a suffix and the end of a word.
 *
 * Retired variants still parse. A retired suffix is withheld from *new* fan-outs, and the factors already
 * carrying it are history that has to stay readable — an id that stopped parsing would take its category
 * with it.
 */

export type VariantStatus = "active" | "retired";

/** One row of the registry, as a consumer needs it. */
export type CategoryVariant = {
  suffixCode: string;
  label: string;
  ghgCategory: string;
  description: string;
  status: VariantStatus;
  sortOrder: number;
};

export type ParsedFactorId = {
  /** The id as stored, unchanged. */
  factorId: string;
  /** What the id is without its suffix — the same string when there is no suffix. */
  base: string;
  /** The variant this id names, or null when the id carries no registered suffix. */
  variant: CategoryVariant | null;
};

/** The shape a suffix must have to be registrable at all: a hyphen and one to four lowercase letters. */
export const SUFFIX_SHAPE = /^-[a-z]{1,4}$/;

export const isSuffixShape = (candidate: string): boolean => SUFFIX_SHAPE.test(candidate);

/**
 * Split a stored factor id into its base and its variant.
 *
 * Longest suffix first, so a registry holding both `-d` and `-ud` cannot make `x-ud` ambiguous — the more
 * specific one wins rather than the order the rows happened to arrive in.
 *
 * A suffix alone is not an id: `-c` parses as the base `-c` with no variant, because a factor whose whole
 * id is a suffix has no base to be a variant of.
 */
export function parseFactorId(
  factorId: string,
  registry: readonly CategoryVariant[],
): ParsedFactorId {
  const candidates = [...registry].sort((a, b) => b.suffixCode.length - a.suffixCode.length);
  for (const variant of candidates) {
    if (!factorId.endsWith(variant.suffixCode)) continue;
    const base = factorId.slice(0, -variant.suffixCode.length);
    // An empty base means the id *is* the suffix, which is not a variant of anything.
    if (base.length === 0) continue;
    return { factorId, base, variant };
  }
  return { factorId, base: factorId, variant: null };
}

/** The base of a stored id, for grouping. The id itself when it carries no registered suffix. */
export const factorBase = (factorId: string, registry: readonly CategoryVariant[]): string =>
  parseFactorId(factorId, registry).base;

export type VariantGroup<T> = {
  base: string;
  /** The member with no suffix, when the base itself is a factor. */
  canonical: T | null;
  /** Every suffixed member, in registry order. */
  variants: ReadonlyArray<{ variant: CategoryVariant; factor: T }>;
};

/**
 * Group factors by the base they share.
 *
 * The point of the grouping is that a surface can offer "this factor, under which category?" rather than a
 * flat list in which the same measured number appears six times with cryptic endings.
 *
 * Ordered by the registry's own `sortOrder`, so the categories read in a stated order rather than
 * alphabetically by suffix letter — which would put waste before business travel for no reason.
 */
export function groupByBase<T>(
  factors: readonly T[],
  idOf: (factor: T) => string,
  registry: readonly CategoryVariant[],
): VariantGroup<T>[] {
  const groups = new Map<string, VariantGroup<T>>();

  for (const factor of factors) {
    const parsed = parseFactorId(idOf(factor), registry);
    const group = groups.get(parsed.base)
      ?? { base: parsed.base, canonical: null, variants: [] };
    if (parsed.variant === null) {
      groups.set(parsed.base, { ...group, canonical: factor });
    } else {
      groups.set(parsed.base, {
        ...group,
        variants: [...group.variants, { variant: parsed.variant, factor }],
      });
    }
  }

  return [...groups.values()].map((group) => ({
    ...group,
    variants: [...group.variants].sort((a, b) => a.variant.sortOrder - b.variant.sortOrder),
  }));
}

/**
 * The variants a new fan-out may use: active only.
 *
 * Retired ones are deliberately absent here and deliberately still parseable — the two are different
 * questions, and a single "is this variant usable" flag would have to answer both and get one wrong.
 */
export const availableVariants = (registry: readonly CategoryVariant[]): CategoryVariant[] =>
  registry.filter((variant) => variant.status === "active")
    .sort((a, b) => a.sortOrder - b.sortOrder);

/**
 * A category one base factor may be filed under, held once for every year (BUILD-dataset-factor-dedup slice 1, migration 0170).
 *
 * Applicability, not a value: the number stays on the factor's own row, one per edition. NZI-curated, so it may name a category
 * the source never shipped a row for. Retired keeps the record and withholds the category from new use.
 */
export type FactorApplicability = {
  factorId: string;
  suffixCode: string;
  status: VariantStatus;
  source: "migration" | "admin";
  /** Dedup slice 3 (0172): what a line filed under this (factor, category) prints — the variant identity's label, relocated. */
  reportLabel?: string | null;
  /** Dedup slice 3 (0172): the factor's curated label under this category — what a row filed so stores as its factor label. */
  label?: string | null;
};

/**
 * Dedup slice 3: which categories a base factor may be filed under, by base factor id — the active suffixes of its applicability
 * (`factor_identity_categories`, 0170). Undefined for a factor with none.
 */
export type ApplicabilityLookup = (baseFactorId: string) => ReadonlySet<string> | undefined;

/** The GHG category a scope row's category code files under, in the registry's terms: `3.7` → `3.7`, `1.company-vehicles` → `1`. */
export const categoryGhgOf = (categoryCode: string): string => (/^3\.\d+$/.test(categoryCode) ? categoryCode : categoryCode.split(".")[0]!);

/**
 * Dedup slice 3: the suffix a dataset factor is filed under in a category by applicability, or null.
 *
 * Only a **base** is filed so — a variant id already says what it is. The base must be applicable under a suffix whose GHG category
 * is the category's own, and that suffix must be active in the registry. Several (a business-travel `-b` and `-bcp`) resolve to
 * the registry's first by its stated order, so the answer never depends on the order rows arrived in. Null means the factor is used
 * as itself — natively, as before — and says nothing about whether it may be (that is the D1 rule's to decide).
 */
export function filedSuffixFor(input: { factorId: string; categoryCode: string; applicability: ApplicabilityLookup; registry: readonly CategoryVariant[] }): string | null {
  if (parseFactorId(input.factorId, input.registry).variant) return null;
  const applicable = input.applicability(input.factorId);
  if (!applicable || applicable.size === 0) return null;
  const ghg = categoryGhgOf(input.categoryCode);
  const candidate = availableVariants(input.registry).find((variant) => variant.ghgCategory === ghg && applicable.has(variant.suffixCode));
  return candidate?.suffixCode ?? null;
}

/** The variant id a fan-out would write for one base and one suffix. */
export const variantFactorId = (base: string, variant: CategoryVariant): string =>
  `${base}${variant.suffixCode}`;
