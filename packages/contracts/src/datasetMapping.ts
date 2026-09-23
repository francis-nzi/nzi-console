import { parseFactorId, variantFactorId, type CategoryVariant } from "./factorVariants";

/**
 * Resolving a capture category to a factor in the selected dataset, declaratively (NZC-149).
 *
 * ## What this replaces, and what it deliberately does not
 *
 * Until now a consultant found the factor by typing into a smart search. That works, and it is also the
 * reason two people capturing the same thing can end up on two different factors — the search is a list of
 * everything the dataset offers, and the category the entry belongs to is only advice.
 *
 * So the mapping is made explicit: a category **declares** how it reaches a factor, in rules that live in
 * the database beside the rest of the input spec rather than in a switch statement. Three kinds cover what
 * the live platform actually does:
 *
 *   - **lookup** — this category always uses this factor. Purchased electricity is metered electricity.
 *   - **basis-branch** — the factor depends on what was captured. A vehicle recorded in litres is a fuel
 *     calculation; the same vehicle recorded in kilometres is a distance calculation, and they are
 *     different factors rather than a conversion of one another.
 *   - **suffix-variant** — the factor is a registered category variant of a base (NZC-145): the same
 *     measured factor, filed under the GHG category the suffix names.
 *
 * ## Additive, with the search still underneath
 *
 * Every rule can decline. A rule naming a factor the selected dataset does not contain does **not** fail
 * the entry and does not block capture: it falls through to the next rule, and if nothing matches, to the
 * free search that exists today. This is what makes the feature safe to roll out one category at a time —
 * a category with no rules behaves exactly as it does now.
 *
 * The temptation is to treat "no rule matched" as an error, because a mapping that silently does nothing
 * looks like a mapping that is not working. It is the opposite: a consultant who cannot record a number
 * because the taxonomy is incomplete will record it somewhere else, and the somewhere else is not in the
 * system. Declining is the behaviour; what must never happen is declining *quietly*, so an outcome always
 * says which rules were considered and why each one passed.
 */

/** A rule a category declares for reaching its factor. First match wins, in `ordering`. */
export type FactorRule =
  | {
    kind: "lookup";
    ruleKey: string;
    ordering: number;
    /** The factor id, without a category suffix. */
    factorBase: string;
  }
  | {
    kind: "basis-branch";
    ruleKey: string;
    ordering: number;
    factorBase: string;
    /** The captured field whose value decides — `unit` for the fuel-or-distance split. */
    basisFieldKey: string;
    /** The value of that field which selects this branch. Compared case-insensitively, trimmed. */
    basisValue: string;
  }
  | {
    kind: "suffix-variant";
    ruleKey: string;
    ordering: number;
    factorBase: string;
    /** A suffix in the estate-wide registry (NZC-145). */
    suffixCode: string;
  };

/**
 * Whether the factor's own `scopes[]` agrees with the category the row is being filed under.
 *
 * `scopes[]` is **not** the authority, and this type exists to say so in the outcome rather than in a
 * comment somebody has to find.
 */
export type ScopeAgreement =
  /** The factor claims this category, or the scope it belongs to. */
  | "agrees"
  /** The factor claims nothing. Common and unremarkable: most factors are not category-specific. */
  | "silent"
  /** The factor claims other categories and not this one. Recorded, and the declared category still wins. */
  | "contradicts";

export type ScopeDecision = {
  /** Where the authoritative category came from. */
  authority: "suffix-variant" | "spec-category";
  /** The GHG category the row is filed under — `3.6`, or `2`. */
  ghgCategory: string;
  /** What the factor says about itself, for the record. */
  factorScopes: readonly string[];
  agreement: ScopeAgreement;
};

/** Why a rule did not produce a factor, kept so that "nothing matched" can be explained. */
export type RuleDeclined = {
  ruleKey: string;
  kind: FactorRule["kind"];
  reason: string;
};

export type MappingOutcome =
  | {
    kind: "resolved";
    factorId: string;
    rule: FactorRule;
    scope: ScopeDecision;
    /** Rules ahead of this one that declined, so a surprising answer can be traced. */
    declined: readonly RuleDeclined[];
  }
  | {
    kind: "free-search";
    /** Every rule, and why each declined. Empty when the category simply has no rules yet. */
    declined: readonly RuleDeclined[];
    reason: string;
  };

export type MappingInputs = {
  /** The category's declared rules, in any order; this function sorts them. */
  rules: readonly FactorRule[];
  /** The GHG category the spec files this category under, used when no variant overrides it. */
  specGhgCategory: string;
  /** What the user has captured so far, by field key. Missing keys simply do not match. */
  entry: Readonly<Record<string, string | null | undefined>>;
  /** The factors the selected dataset offers, with what each claims about itself. */
  available: ReadonlyArray<{ factorId: string; scopes?: readonly string[] | null }>;
  /** The estate-wide suffix registry (NZC-145). */
  registry: readonly CategoryVariant[];
};

const normalise = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * Does a factor's `scopes[]` cover this GHG category?
 *
 * `3.6` is covered by a factor claiming `3.6` and also by one claiming `3`: the sub-category is inside the
 * scope, and a factor library that lists the scope rather than every category within it is not
 * contradicting anything. The reverse is not true — a factor claiming only `3.6` does not cover `3.4`.
 */
const covers = (scopes: readonly string[], ghgCategory: string): boolean => {
  const root = ghgCategory.split(".")[0]!;
  return scopes.some((claim) => {
    const value = claim.trim();
    return value === ghgCategory || value === root;
  });
};

function decideScope(
  ghgCategory: string,
  authority: ScopeDecision["authority"],
  factorScopes: readonly string[],
): ScopeDecision {
  const agreement: ScopeAgreement = factorScopes.length === 0
    ? "silent"
    : covers(factorScopes, ghgCategory) ? "agrees" : "contradicts";
  return { authority, ghgCategory, factorScopes, agreement };
}

/**
 * Resolve the factor a captured entry should use, or say that the search is still the answer.
 *
 * ## The `scopes[]` ruling, which is the part with a decision in it
 *
 * A factor's `scopes[]` is what the factor library says the factor may be used for. It is **advisory**.
 * The authority is what the *category* says: for a suffix-variant, the registry's `ghg_category` for that
 * suffix; otherwise the category's own scope in the input spec.
 *
 * That has to be the way round, because a suffix exists precisely to file one measured factor under
 * several categories. A base factor priced per passenger-kilometre carries `scopes = {3}` or `{3.6}`
 * whatever suffix is attached to it, so letting `scopes[]` decide would either forbid the commuting
 * variant of a business-travel factor or silently file a commute under business travel. Both are wrong,
 * and the second is wrong invisibly.
 *
 * So `scopes[]` is **reconciled, and demoted when it disagrees**: the declared category still wins, the
 * disagreement is recorded on the outcome, and the caller surfaces it. It is never silently dropped —
 * a factor that claims it is not for this category is worth a person's attention even when the mapping is
 * right, because the other possibility is that the mapping is wrong.
 */
export function resolveFactorForEntry(inputs: MappingInputs): MappingOutcome {
  const { rules, specGhgCategory, entry, available, registry } = inputs;

  const byId = new Map(available.map((factor) => [factor.factorId, factor]));
  const scopesOf = (factorId: string): readonly string[] =>
    (byId.get(factorId)?.scopes ?? []).filter((scope) => scope.trim() !== "");

  const declined: RuleDeclined[] = [];
  const ordered = [...rules].sort((left, right) => left.ordering - right.ordering
    || left.ruleKey.localeCompare(right.ruleKey));

  for (const rule of ordered) {
    if (rule.kind === "basis-branch") {
      const captured = normalise(entry[rule.basisFieldKey]);
      if (captured === "") {
        declined.push({ ruleKey: rule.ruleKey, kind: rule.kind,
          reason: `'${rule.basisFieldKey}' has not been captured yet` });
        continue;
      }
      if (captured !== normalise(rule.basisValue)) {
        declined.push({ ruleKey: rule.ruleKey, kind: rule.kind,
          reason: `'${rule.basisFieldKey}' is '${entry[rule.basisFieldKey]}', not '${rule.basisValue}'` });
        continue;
      }
    }

    let factorId = rule.factorBase;
    let authority: ScopeDecision["authority"] = "spec-category";
    let ghgCategory = specGhgCategory;

    if (rule.kind === "suffix-variant") {
      const variant = registry.find((entryVariant) => entryVariant.suffixCode === rule.suffixCode);
      if (!variant) {
        // A rule naming a suffix the registry does not have is a broken rule, and it declines rather
        // than guessing: a suffix invented here would attach a category nobody registered (NZC-145).
        declined.push({ ruleKey: rule.ruleKey, kind: rule.kind,
          reason: `'${rule.suffixCode}' is not in the variant registry` });
        continue;
      }
      if (variant.status !== "active") {
        // A retired suffix still parses — the factors already carrying it are history — but it is not
        // offered to something new.
        declined.push({ ruleKey: rule.ruleKey, kind: rule.kind,
          reason: `'${rule.suffixCode}' is retired and is not used for new entries` });
        continue;
      }
      factorId = variantFactorId(rule.factorBase, variant);
      authority = "suffix-variant";
      ghgCategory = variant.ghgCategory;
    }

    if (!byId.has(factorId)) {
      // The rule is fine; this dataset just does not carry that factor. Falling through is the whole
      // reason this is additive — a dataset without the factor must not stop somebody capturing.
      declined.push({ ruleKey: rule.ruleKey, kind: rule.kind,
        reason: `'${factorId}' is not in the selected dataset` });
      continue;
    }

    return { kind: "resolved", factorId, rule, declined, scope: decideScope(ghgCategory, authority, scopesOf(factorId)) };
  }

  return {
    kind: "free-search",
    declined,
    reason: ordered.length === 0
      ? "this category declares no factor rules yet, so the search is the mapping"
      : `none of its ${ordered.length} rule(s) applied`,
  };
}

/**
 * The base a factor id is built on, according to the registry.
 *
 * Re-exported through this module because mapping is where callers meet the question, and there must be
 * one answer to it: splitting on the last hyphen would read `electricity-demo` as `electricity` with a
 * `-demo` variant and group unrelated factors together (NZC-145).
 */
export const baseOf = (factorId: string, registry: readonly CategoryVariant[]): string =>
  parseFactorId(factorId, registry).base;
