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
  }
  | {
    kind: "enriched";
    ruleKey: string;
    ordering: number;
    factorBase: string;
    /** Which external lookup supplies the attributes — currently only `dvla`. */
    enrichmentSource: string;
    /**
     * The entry field holding the lookup key, such as a vehicle registration.
     *
     * Named rather than read here: this module never receives the key's value. The caller performs the
     * lookup and passes the *attributes*, so the plate stops at the lookup boundary and nothing
     * downstream has one to store, log or mishandle (NZC-103).
     */
    enrichmentKeyField: string;
    /** Which returned attribute decides — `fuel`, `class`. */
    basisFieldKey: string;
    /** The value of that attribute which selects this rule. */
    basisValue: string;
  };

/** What a lookup returned about the thing being captured. Values are compared like any other basis. */
export type EnrichedAttributes = Readonly<Record<string, string | null | undefined>>;

/**
 * The result of each lookup the caller performed, keyed by source.
 *
 * Three states, and the difference between the second and third is the point of the whole feature:
 *
 * - **absent** — no lookup was attempted (nothing was typed into the key field yet);
 * - **`null`** — a lookup was attempted and returned nothing, so the entry stays **unresolved**;
 * - **attributes** — a lookup returned, and its values are matched like any other basis.
 *
 * Collapsing `null` into "absent", or into an empty attribute set, is how a failed lookup would quietly
 * fall through to a rule that happens to match on something else — a factor chosen because an external
 * service was down. That is the mis-resolution this type exists to make impossible to write by accident.
 */
export type EnrichmentResults = Readonly<Record<string, EnrichedAttributes | null | undefined>>;

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
  /**
   * What each external lookup returned, keyed by source. Omitted entirely when nothing was looked up.
   *
   * The caller does the lookup; this function never sees the key. That division is deliberate and is
   * what keeps a registration out of everything downstream of the lookup boundary (NZC-103).
   */
  enrichment?: EnrichmentResults;
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
  const { rules, specGhgCategory, entry, available, registry, enrichment } = inputs;

  const byId = new Map(available.map((factor) => [factor.factorId, factor]));
  const scopesOf = (factorId: string): readonly string[] =>
    (byId.get(factorId)?.scopes ?? []).filter((scope) => scope.trim() !== "");

  const declined: RuleDeclined[] = [];
  const ordered = [...rules].sort((left, right) => left.ordering - right.ordering
    || left.ruleKey.localeCompare(right.ruleKey));

  /**
   * Which lookups were **consulted** for this entry — asked, and given an answer of some kind.
   *
   * A source counts as consulted when its key field holds something and the caller performed the
   * lookup, whether it came back with attributes or with nothing. Both are answers; only "never asked"
   * is not.
   */
  const consulted = new Set<string>();
  for (const rule of ordered) {
    if (rule.kind !== "enriched") continue;
    if (normalise(entry[rule.enrichmentKeyField]) === "") continue;
    if (enrichment?.[rule.enrichmentSource] === undefined) continue;
    consulted.add(rule.enrichmentSource);
  }

  /**
   * Once a more specific selector has been consulted, only it may answer.
   *
   * This is the rule that stops a silent downgrade. Company vehicles carries both an enriched rule
   * (the DVLA says what the vehicle is) and a coarser one (measured in litres, so diesel). If the
   * lookup is consulted and matches nothing — the vehicle is petrol and only a diesel rule is seeded —
   * letting the coarser rule stand in files a **petrol vehicle against a diesel factor**. About ten
   * per cent wrong, entirely ordinary-looking, and traceable only in a `declined` list nobody reads.
   *
   * So the coarser rules are set aside for this entry, and the answer is the search. The additive line
   * holds where it matters: falling back to the **search** is always allowed; falling back to a
   * different, less specific **declared rule** after consulting a more specific one is not.
   *
   * Note what is *not* suppressed: sibling enriched rules on the same source. A category with a rule
   * per fuel must still reach the petrol one, so the filter keeps every enriched rule of a consulted
   * source and only sets aside the rest.
   */
  const candidates = consulted.size === 0
    ? ordered
    : ordered.filter((rule) => rule.kind === "enriched" && consulted.has(rule.enrichmentSource));

  for (const rule of ordered) {
    if (candidates.includes(rule)) continue;
    declined.push({
      ruleKey: rule.ruleKey, kind: rule.kind,
      reason: `set aside: the ${[...consulted].map((source) => `'${source}'`).join(", ")} lookup was `
        + "consulted for this entry, so a less specific rule may not stand in for it",
    });
  }

  for (const rule of candidates) {
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

    if (rule.kind === "enriched") {
      // Nothing typed into the key field: there was no lookup to perform, which is the ordinary state
      // of a half-filled form rather than a failure.
      if (normalise(entry[rule.enrichmentKeyField]) === "") {
        declined.push({ ruleKey: rule.ruleKey, kind: rule.kind,
          reason: `nothing has been entered in '${rule.enrichmentKeyField}' to look up` });
        continue;
      }

      const result = enrichment?.[rule.enrichmentSource];
      if (result === undefined) {
        declined.push({ ruleKey: rule.ruleKey, kind: rule.kind,
          reason: `the '${rule.enrichmentSource}' lookup has not been performed` });
        continue;
      }
      if (result === null) {
        // The lookup ran and told us nothing — the plate is unknown, the service was down, the key was
        // malformed. It declines like any other rule; what stops the entry being answered by something
        // coarser is the consultation filter above, which has already set those rules aside.
        declined.push({ ruleKey: rule.ruleKey, kind: rule.kind,
          reason: `the '${rule.enrichmentSource}' lookup returned nothing for '${rule.enrichmentKeyField}', `
            + "so there are no attributes to resolve from" });
        continue;
      }

      const attribute = normalise(result[rule.basisFieldKey]);
      if (attribute === "") {
        declined.push({ ruleKey: rule.ruleKey, kind: rule.kind,
          reason: `the lookup returned no '${rule.basisFieldKey}' for this ${rule.enrichmentKeyField}` });
        continue;
      }
      if (attribute !== normalise(rule.basisValue)) {
        declined.push({ ruleKey: rule.ruleKey, kind: rule.kind,
          reason: `the lookup says ${rule.basisFieldKey} is '${result[rule.basisFieldKey]}', not '${rule.basisValue}'` });
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

  if (consulted.size > 0) {
    // Consulted and unmatched. Said in full, because this is the one outcome a reader is most likely to
    // mistake for the feature being broken: a rule did apply to this entry, it was the most specific one
    // available, and it declined to guess.
    return {
      kind: "free-search",
      declined,
      reason: `the ${[...consulted].map((source) => `'${source}'`).join(", ")} lookup was consulted and `
        + "matched no rule, so this entry is left for a person to resolve rather than matched on a less "
        + "specific rule that would contradict what the lookup said",
    };
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
