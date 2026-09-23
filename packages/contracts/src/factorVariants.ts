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

/** The variant id a fan-out would write for one base and one suffix. */
export const variantFactorId = (base: string, variant: CategoryVariant): string =>
  `${base}${variant.suffixCode}`;
