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
 * the database beside the rest of the input spec rather than in a switch statement. Five kinds cover what
 * the live platform actually does:
 *
 *   - **lookup** — this category always uses this factor. Purchased electricity is metered electricity.
 *   - **basis-branch** — the factor depends on what was captured. A vehicle recorded in litres is a fuel
 *     calculation; the same vehicle recorded in kilometres is a distance calculation, and they are
 *     different factors rather than a conversion of one another.
 *   - **suffix-variant** — the factor is a registered category variant of a base (NZC-145): the same
 *     measured factor, filed under the GHG category the suffix names.
 *   - **enriched** — the basis comes from an external lookup rather than from what was typed: a
 *     registration, and what the DVLA says the vehicle is (NZC-151).
 *   - **sub-flow** — run another category's rules and file the result under this category's suffix, so
 *     business travel and commuting reuse the vehicle flow rather than restating it (NZC-158).
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
    kind: "sub-flow";
    ruleKey: string;
    ordering: number;
    /**
     * The category whose rules this one reuses — a reference, never a copy.
     *
     * Business travel by road and commuting by car identify a vehicle exactly as company vehicles does;
     * only the category the answer is filed under differs. One flow serving three consumers is what stops
     * a change to the DVLA derivations reaching one of them and not the others.
     */
    subFlowCategory: string;
    /** The registered suffix this category files the result under: "-b" is 3.6, "-c" is 3.7. */
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

/**
 * Whether an entered unit can stand for a factor's unit (NZC-146, NZC-160 D2).
 *
 * Handed in rather than implemented here: the conversions live in the backend's `checkUnit`, and a second
 * table of them in this pure module would be a second answer to the same question. The resolver only needs
 * the verdict, and the reason, so a decline can say why.
 */
export type UnitReconciler = (entered: string, factorUnit: string) => { ok: true } | { ok: false; reason: string };

export type MappingInputs = {
  /** The category's declared rules, in any order; this function sorts them. */
  rules: readonly FactorRule[];
  /** The GHG category the spec files this category under, used when no variant overrides it. */
  specGhgCategory: string;
  /** What the user has captured so far, by field key. Missing keys simply do not match. */
  entry: Readonly<Record<string, string | null | undefined>>;
  /** The factors the selected dataset offers, with what each claims about itself and the unit it is priced per. */
  available: ReadonlyArray<{ factorId: string; scopes?: readonly string[] | null; unit?: string | null }>;
  /**
   * Checks a resolved factor's unit against the unit the entry was captured in (D2).
   *
   * When the entry carries a unit, a factor must reconcile with it or its rule declines — a per-litre factor is
   * never applied to kilometres. A caller that supplies no check, or a factor whose unit is not known, declines
   * too: an entry with a unit that nothing checked is not waved through. An entry with no unit yet is not
   * checked, because nothing was entered for the factor to contradict.
   */
  reconcileUnit?: UnitReconciler;
  /** The estate-wide suffix registry (NZC-145). */
  registry: readonly CategoryVariant[];
  /**
   * What each external lookup returned, keyed by source. Omitted entirely when nothing was looked up.
   *
   * The caller does the lookup; this function never sees the key. That division is deliberate and is
   * what keeps a registration out of everything downstream of the lookup boundary (NZC-103).
   */
  enrichment?: EnrichmentResults;
  /**
   * The rules of other categories a sub-flow may reference, keyed by category code.
   *
   * Supplied by the caller rather than fetched here, because this function stays pure — and because the
   * caller already knows which categories are in play and can load them in one read.
   */
  rulesByCategory?: Readonly<Record<string, readonly FactorRule[]>>;
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
  return resolveWithin(inputs, new Set<string>());
}

/**
 * The resolver proper, carrying the set of categories already being resolved.
 *
 * A sub-flow runs another category's rules, so a chain is possible and a **cycle** is possible with it.
 * The migration refuses the shortest one — a category referencing itself — at the point it is written; a
 * longer ring can only be caught here, at the point it is run. A cycle declines rather than throwing: a
 * misconfigured spec should leave capture working through the search, not take the surface down.
 */
function resolveWithin(inputs: MappingInputs, resolving: ReadonlySet<string>): MappingOutcome {
  const { rules, specGhgCategory, entry, available, registry, enrichment, rulesByCategory } = inputs;

  const byId = new Map(available.map((factor) => [factor.factorId, factor]));
  const scopesOf = (factorId: string): readonly string[] =>
    (byId.get(factorId)?.scopes ?? []).filter((scope) => scope.trim() !== "");
  const unitRefusal = (factorId: string): string | null => unitMismatch(inputs, factorId);

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

    if (rule.kind === "sub-flow") {
      const outcome = resolveSubFlow(rule, inputs, resolving);
      if (outcome.kind === "declined") {
        declined.push({ ruleKey: rule.ruleKey, kind: rule.kind, reason: outcome.reason });
        if (outcome.stop) {
          // **The leak this primitive is shaped around.** The referenced flow answered — we know what the
          // vehicle is — and the variant for this category could not be produced. The tempting behaviour
          // is to use the base, because it is nearly right: same fuel, same litres, same arithmetic. It is
          // a commute priced with the company's Scope 1 factor and filed under Scope 3, and nothing about
          // the number looks wrong.
          //
          // So it stops, exactly as a consulted-and-unmatched lookup does (NZC-151). Falling back to the
          // search is additive; falling back to the base is the wrong answer wearing the right shape.
          return {
            kind: "free-search",
            declined,
            reason: `the ${rule.subFlowCategory} flow resolved but its '${rule.suffixCode}' variant could `
              + "not be composed, so this entry is left for a person rather than filed against the base "
              + "factor, which belongs to a different scope",
          };
        }
        continue;
      }
      return {
        kind: "resolved",
        factorId: outcome.factorId,
        rule,
        declined,
        scope: decideScope(outcome.ghgCategory, "suffix-variant", scopesOf(outcome.factorId)),
      };
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

    // The unit the entry was captured in must be one this factor can price (D2). The enriched rule reads
    // fuel and nothing else, so without this a diesel van recorded in kilometres resolved to a per-litre
    // factor. A decline here is like any other: after a consulted lookup the coarser rules are already set
    // aside, so the entry goes to a person — never to a less specific rule, never to the ILIKE matcher.
    const refused = unitRefusal(factorId);
    if (refused) {
      declined.push({ ruleKey: rule.ruleKey, kind: rule.kind, reason: refused });
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
 * Why a factor cannot price this entry's unit, or null when it can (D2).
 *
 * Unchecked is refused, not passed: an entry that carries a unit declines if the caller supplied no check or
 * the factor's own unit is unknown. That is the fail-safe direction — the cost is a person picking a factor,
 * where the alternative is a quantity multiplied by a rate priced in something else.
 */
function unitMismatch(inputs: MappingInputs, factorId: string): string | null {
  const entered = (inputs.entry.unit ?? "").trim();
  if (entered === "") return null;
  const factorUnit = (inputs.available.find((factor) => factor.factorId === factorId)?.unit ?? "").trim();
  if (factorUnit === "" || !inputs.reconcileUnit) {
    return `the entry is in '${entered}' and '${factorId}''s unit could not be checked against it, so it is left `
      + "for a person rather than assumed to match";
  }
  const verdict = inputs.reconcileUnit(entered, factorUnit);
  return verdict.ok ? null
    : `the entry is in '${entered}' and '${factorId}' is priced per '${factorUnit}': ${verdict.reason}`;
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

// ── Companions: one entry resolving to more than one row (NZC-154) ──────────────────────────────────

/**
 * An additional row a category proposes alongside its resolved primary.
 *
 * Not another way to choose the primary factor — the rules above do that, first match wins. A companion
 * is another *row*, with its own factor and its own GHG category: transmission and distribution losses on
 * a Scope 2 purchase are Scope 3.3, and belong to a different factor from the supply itself.
 */
export type CompanionRule = {
  companionKey: string;
  ordering: number;
  kind: "transmission-distribution" | "end-of-life";
  factorBase: string;
  /** The companion row's own category, which is not the primary's. */
  ghgCategory: string;
  /** The captured field the condition reads. */
  whenFieldKey: string;
  /**
   * The values that **do** fire this companion.
   *
   * Positively enumerated, never negated. "Everything except self-generated" would make a supply kind
   * added later claim transmission losses from the day it was introduced — silently, and for every entry.
   */
  whenValues: readonly string[];
  label: string;
};

export type ProposedCompanion = {
  companionKey: string;
  kind: CompanionRule["kind"];
  factorId: string;
  ghgCategory: string;
  label: string;
  /** Which captured value fired it, so a proposed row can explain itself. */
  firedBy: { fieldKey: string; value: string };
};

export type CompanionProposal = {
  /** Every companion whose condition held and whose factor the dataset carries. */
  proposed: readonly ProposedCompanion[];
  /** Every companion that did not fire, and why — so an absent row is legible rather than silent. */
  declined: readonly RuleDeclined[];
};

/**
 * Which companion rows an entry proposes.
 *
 * **Every** matching companion fires, unlike the primary rules where the first match wins: two companions
 * are not competing answers to one question, and a waste stream with two treatments is two rows.
 *
 * A companion is proposed only when the primary resolved. A companion to nothing is not a row — it would
 * be transmission losses attributed to a supply the system could not identify, which is a number with no
 * parent and no way to check it.
 */
export function proposeCompanions(inputs: {
  companions: readonly CompanionRule[];
  entry: Readonly<Record<string, string | null | undefined>>;
  available: ReadonlyArray<{ factorId: string; scopes?: readonly string[] | null }>;
  /** The primary outcome. Companions are proposed only alongside a resolved primary. */
  primary: MappingOutcome;
}): CompanionProposal {
  const { companions, entry, available, primary } = inputs;
  const declined: RuleDeclined[] = [];

  if (primary.kind !== "resolved") {
    for (const rule of companions) {
      declined.push({ ruleKey: rule.companionKey, kind: "lookup",
        reason: "the entry has no resolved factor of its own, so there is nothing for this to accompany" });
    }
    return { proposed: [], declined };
  }

  const carried = new Set(available.map((factor) => factor.factorId));
  const proposed: ProposedCompanion[] = [];

  for (const rule of [...companions].sort((left, right) => left.ordering - right.ordering
    || left.companionKey.localeCompare(right.companionKey))) {
    const captured = entry[rule.whenFieldKey];
    const value = normalise(captured);

    if (value === "") {
      declined.push({ ruleKey: rule.companionKey, kind: "basis-branch",
        reason: `'${rule.whenFieldKey}' has not been captured, so it is not known whether this applies` });
      continue;
    }
    if (!rule.whenValues.some((candidate) => normalise(candidate) === value)) {
      // The self-generated case, and every other value nobody listed. Said as "not among" rather than
      // "is excluded", because the rule never excluded anything — it named what fires.
      declined.push({ ruleKey: rule.companionKey, kind: "basis-branch",
        reason: `'${rule.whenFieldKey}' is '${captured}', which is not among the values this companion `
          + `fires for (${rule.whenValues.join(", ")})` });
      continue;
    }
    if (!carried.has(rule.factorBase)) {
      declined.push({ ruleKey: rule.companionKey, kind: "lookup",
        reason: `'${rule.factorBase}' is not in the selected dataset, so the companion cannot be priced` });
      continue;
    }

    proposed.push({
      companionKey: rule.companionKey, kind: rule.kind, factorId: rule.factorBase,
      ghgCategory: rule.ghgCategory, label: rule.label,
      firedBy: { fieldKey: rule.whenFieldKey, value: String(captured).trim() },
    });
  }

  return { proposed, declined };
}

/**
 * Run another category's flow and file the result under this category's suffix (NZC-158).
 *
 * `stop` distinguishes the two ways this declines, and the distinction is the whole safety property:
 *
 * - **not a stop** — the referenced flow itself did not resolve. Nothing was learned, so there is nothing
 *   to protect: the entry carries on to whatever other rules this category declares.
 * - **a stop** — the referenced flow *did* resolve and the variant could not be composed. Something was
 *   learned and could not be filed correctly, and the one thing that must not happen now is the base being
 *   used because it is nearly right.
 */
function resolveSubFlow(
  rule: Extract<FactorRule, { kind: "sub-flow" }>,
  inputs: MappingInputs,
  resolving: ReadonlySet<string>,
): { kind: "resolved"; factorId: string; ghgCategory: string } | { kind: "declined"; reason: string; stop: boolean } {
  const { available, registry, rulesByCategory } = inputs;

  if (resolving.has(rule.subFlowCategory)) {
    return { kind: "declined", stop: false,
      reason: `'${rule.subFlowCategory}' is already being resolved — the rules form a cycle` };
  }

  const referenced = rulesByCategory?.[rule.subFlowCategory];
  if (referenced === undefined) {
    // The caller did not supply them. Declining rather than assuming an empty rule set: "that category
    // has no rules" and "nobody loaded that category" are different, and treating the second as the first
    // would make a loading bug look like a spec decision.
    return { kind: "declined", stop: false,
      reason: `the rules for '${rule.subFlowCategory}' were not supplied, so its flow could not be run` };
  }

  const inner = resolveWithin(
    { ...inputs, rules: referenced, specGhgCategory: rule.subFlowCategory },
    new Set([...resolving, rule.subFlowCategory]),
  );
  if (inner.kind !== "resolved") {
    return { kind: "declined", stop: false,
      reason: `the '${rule.subFlowCategory}' flow did not resolve a factor of its own (${inner.reason})` };
  }

  const variant = registry.find((entry) => entry.suffixCode === rule.suffixCode);
  if (!variant) {
    return { kind: "declined", stop: true,
      reason: `'${rule.suffixCode}' is not in the variant registry, so the result cannot be filed under `
        + "this category" };
  }
  if (variant.status !== "active") {
    return { kind: "declined", stop: true,
      reason: `'${rule.suffixCode}' is retired and is not used for new entries` };
  }

  // The base is recovered through the registry, never by splitting on the last hyphen: every seeded factor
  // ends in something suffix-shaped, so a naive parser reads `diesel-demo` as `diesel` with a `-demo`
  // variant and composes an id nobody registered (NZC-145). Taking the base also means a flow that already
  // resolved a variant is re-filed rather than double-suffixed.
  const base = parseFactorId(inner.factorId, registry).base;
  const composed = variantFactorId(base, variant);

  if (!available.some((factor) => factor.factorId === composed)) {
    return { kind: "declined", stop: true,
      reason: `'${composed}' is not in the selected dataset` };
  }

  // The inner flow already checked the base's unit; the variant is checked in its own right, because a variant
  // carrying a different unit from its base is exactly the drift NZC-145 forbids and this is where it would bite.
  const refused = unitMismatch(inputs, composed);
  if (refused) return { kind: "declined", stop: true, reason: refused };

  return { kind: "resolved", factorId: composed, ghgCategory: variant.ghgCategory };
}
