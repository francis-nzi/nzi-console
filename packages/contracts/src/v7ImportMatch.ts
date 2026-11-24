import { emissionCategoryTaxonomy } from "./commands";
import { V7_EMISSION_DELTA_THRESHOLD } from "./v7Reingest";
import type { V7ImportScope, V7ImportScopeTotals } from "./v7ImportSummary";
import type { V7ImportIngestTotals } from "./v7ImportIngest";

/**
 * The import rows modal's matcher (BRIEF-v7-import-rows-modal §A): for one row of the previous system, how a console factor would
 * figure it, and whether that reproduces what the previous system worked out. Pure — no database — so the rows read, the factor
 * search and the modal judge a candidate the same way.
 *
 *   reproduces    — this row's tCO2e, recomputed with the factor, agrees with the previous system's to one decimal place, and the
 *                   factor is on the row's basis (its scope, and a category the row can be filed under);
 *   figure-only   — it agrees to one decimal place, but on another basis (a Scope 1 factor for a Scope 3 row): never auto-picked;
 *   close         — on the row's unit, within the re-ingest's material threshold (5%) but not to one decimal place;
 *   differs       — on the row's unit, further out than that;
 *   unit-mismatch — the factor is priced per another unit than the row's quantity (per km for a row in miles);
 *   no-figure     — nothing to compare: the row has no quantity or no figure, or the factor no rate.
 *
 * Decision 1 (auto-pick; BRIEF-v7-import-rows-autopick-fix §1): the job-year anchor — the previous system's own factor in the job's
 * reporting-year dataset, at its own rate — reproduces → pre-accepted, whatever other years also reproduce; otherwise exactly one
 * reproduction → pre-accepted; otherwise a suggestion. Either way on a category the decision can name. Decision 2 (wrong-basis
 * guard): a figure-only candidate never auto-wins. A zero rate reproduces only as the anchor (§4): any zero gives a zero.
 */
export const V7_MATCH_VERDICTS = ["reproduces", "figure-only", "close", "differs", "unit-mismatch", "no-figure"] as const;
export type V7MatchVerdict = (typeof V7_MATCH_VERDICTS)[number];

/** Half a unit in the first decimal place: two figures within it agree "to one decimal place". */
export const V7_ONE_DECIMAL_PLACE = 0.05;
export const agreesToOneDecimalPlace = (a: number, b: number): boolean => Math.abs(a - b) < V7_ONE_DECIMAL_PLACE - 1e-12;

/**
 * A code's keys for the suffix-insensitive match, stripped in order (BRIEF-v7-import-rows-autopick-fix §3), lower-cased with
 * whitespace as hyphens (as the factor ids are minted):
 *   core     — a registered variant suffix (`-c`, `-vcp` …) taken off, or the code itself when it has none;
 *   fallback — only for a code with no variant suffix: its trailing `_n` (the unit index: `25_301_3069_9_1` per km, `_9_2` per
 *              mile) taken off, tried only when the core finds nothing. Never both on one code: `99_316_3160_11_2-c` (Walking)
 *              is `99_316_3160_11_2`, never `99_316_3160_11`, which also names Cycling (`_11_3`).
 */
export function v7CodeKeys(code: string | null | undefined, variantSuffixes: readonly string[] = []): { core: string | null; fallback: string | null } {
  if (!code || !code.trim()) return { core: null, fallback: null };
  const folded = code.trim().replace(/\s+/g, "-").toLowerCase();
  const suffix = [...variantSuffixes].map((entry) => entry.toLowerCase()).sort((a, b) => b.length - a.length).find((entry) => entry && folded.endsWith(entry) && folded.length > entry.length);
  if (suffix) return { core: folded.slice(0, -suffix.length), fallback: null };
  const unitless = folded.replace(/_\d+$/, "");
  return { core: folded, fallback: unitless && unitless !== folded ? unitless : null };
}
/** A factor's code as the row's keys are compared with it: its core (a variant suffix off), and that core without its unit index. */
export function v7FactorKeys(code: string, variantSuffixes: readonly string[] = []): { core: string | null; unitless: string | null } {
  const { core } = v7CodeKeys(code, variantSuffixes);
  return { core, unitless: core ? core.replace(/_\d+$/, "") || null : null };
}

/**
 * The console category the previous system's own category name files a row under, of the row's scope — by the taxonomy's name
 * (`Business Travel` → 3.6, `Employee Commuting` → 3.7), or the previous system's own names for one (`Fuels` → Other Stationary
 * Fuels) — or null when it does not settle one (BRIEF-v7-import-rows-autopick-fix §5).
 */
const V7_CATEGORY_NAMES: Readonly<Record<string, string>> = { fuels: "1.other-stationary-fuels" };
export function v7CategoryCode(name: string | null | undefined, scope: V7ImportScope): string | null {
  const key = name?.trim().replace(/\s+/g, " ").toLowerCase();
  if (!key) return null;
  const byName = emissionCategoryTaxonomy.find((category) => category.scope === scope && category.name.toLowerCase() === key)?.code;
  const alias = V7_CATEGORY_NAMES[key];
  const code = byName ?? alias ?? null;
  return code && emissionCategoryTaxonomy.some((category) => category.code === code && category.scope === scope) ? code : null;
}

/** The row as the matcher needs it: no label, no site — its scope, its input, the previous system's figure and its categories. */
export type V7MatchRow = {
  scope: V7ImportScope; quantity: number | null; applyPct: number; previousTco2e: number | null;
  /** The categories the row is known to belong in (its mapping, its own category code, or its levels), or none known. */
  categories: readonly string[];
  /** The console category the previous system's own category names (`v7CategoryCode`): it settles a factor filed under two. */
  v7Category?: string | null;
};
/**
 * A console factor as the matcher needs it. `categories`: the categories whose family claims it (of any scope). `anchor`: it is the
 * job-year anchor — the previous system's own factor (or, for a variant row, its core code) in the job's reporting-year dataset, at
 * the previous system's own rate.
 */
export type V7MatchFactor = { rate: number | null; scopes: readonly string[]; categories: readonly string[]; sameUnit: boolean; anchor?: boolean };
export type V7MatchResult = {
  /** This row's tCO2e with the factor (quantity × rate × apportionment), or null when it cannot be worked out. */
  tco2e: number | null;
  /** tCO2e against the previous system's figure, or null. */
  delta: number | null;
  verdict: V7MatchVerdict;
  /** The factor is on the row's scope and can be filed under a category the row belongs in. */
  rightBasis: boolean;
  /** The category the decision would name, or null when that is not one category. */
  categoryCode: string | null;
};

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const top = (tag: string) => tag.split(".")[0]!;

/**
 * Where the factor can be filed for this row. `familyless` is the categories no family rule names: their pick list is their whole
 * scope, so any factor of the scope belongs.
 */
function basisOf(row: V7MatchRow, factor: V7MatchFactor, familyless: readonly string[]): { rightBasis: boolean; categoryCode: string | null } {
  if (!factor.scopes.some((tag) => top(tag) === row.scope)) return { rightBasis: false, categoryCode: null };
  const ofScope = new Set(emissionCategoryTaxonomy.filter((category) => category.scope === row.scope).map((category) => category.code));
  const claimed = factor.categories.filter((code) => ofScope.has(code));
  const open = familyless.filter((code) => ofScope.has(code));
  const fits = (code: string) => claimed.includes(code) || open.includes(code);
  // More than one category would do: the previous system's own category settles it, when it names one of them (§5).
  const settle = (options: readonly string[]) => options.length === 1 ? options[0]! : row.v7Category && options.includes(row.v7Category) ? row.v7Category : null;
  const known = row.categories.filter((code) => ofScope.has(code));
  if (known.length) {
    const fitting = known.filter(fits);
    if (!fitting.length) return { rightBasis: false, categoryCode: null };
    const claimedFit = fitting.filter((code) => claimed.includes(code));
    return { rightBasis: true, categoryCode: fitting.length === 1 ? fitting[0]! : claimedFit.length === 1 ? claimedFit[0]! : settle(fitting) };
  }
  if (!claimed.length && !open.length) return { rightBasis: false, categoryCode: null };
  return { rightBasis: true, categoryCode: claimed.length ? settle(claimed) : settle(open) };
}

/** One candidate, judged: its figure for this row, the verdict against the previous system's, and its basis. */
export function v7MatchCandidate(row: V7MatchRow, factor: V7MatchFactor, familyless: readonly string[]): V7MatchResult {
  const basis = basisOf(row, factor, familyless);
  if (row.quantity === null || factor.rate === null || !Number.isFinite(factor.rate)) return { tco2e: null, delta: null, verdict: "no-figure", ...basis };
  const tco2e = round6(row.quantity * factor.rate * (row.applyPct / 100) / 1000);
  if (row.previousTco2e === null) return { tco2e, delta: null, verdict: "no-figure", ...basis };
  const delta = round6(tco2e - row.previousTco2e);
  // A zero rate gives a zero whatever it is: it reproduces only as the job-year anchor, never on the figure alone (§4).
  const indistinct = factor.rate === 0 && factor.anchor !== true;
  const verdict: V7MatchVerdict = !factor.sameUnit ? "unit-mismatch"
    : agreesToOneDecimalPlace(tco2e, row.previousTco2e) ? (basis.rightBasis && !indistinct ? "reproduces" : "figure-only")
      : row.previousTco2e !== 0 && Math.abs(delta / row.previousTco2e) <= V7_EMISSION_DELTA_THRESHOLD ? "close" : "differs";
  return { tco2e, delta, verdict, ...basis };
}

const VERDICT_RANK: Record<V7MatchVerdict, number> = { reproduces: 0, close: 1, "figure-only": 2, differs: 3, "unit-mismatch": 4, "no-figure": 5 };

/**
 * A candidate as ranked: its match, whether it was found by the row's own ID (exactly, or its suffix-insensitive core), and whether
 * it is the job-year anchor (`V7MatchFactor.anchor`).
 */
export type V7RankedCandidate = { match: V7MatchResult; label: string; exactCode?: boolean; identity?: boolean; anchor?: boolean };

/**
 * Right basis first, then the job-year anchor (§1: the previous system's own factor in the job's year leads, every other year an
 * alternative), then the verdict (reproduces first), then the smallest delta; the row's own factor, then its exact code, break a tie.
 */
export function rankV7Candidates<T extends V7RankedCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => Number(b.match.rightBasis) - Number(a.match.rightBasis)
    || Number(b.anchor === true) - Number(a.anchor === true)
    || VERDICT_RANK[a.match.verdict] - VERDICT_RANK[b.match.verdict]
    || Math.abs(a.match.delta ?? Infinity) - Math.abs(b.match.delta ?? Infinity)
    || Number(b.identity === true) - Number(a.identity === true)
    || Number(b.exactCode === true) - Number(a.exactCode === true)
    || a.label.localeCompare(b.label));
}

/**
 * Decision 1: the one candidate a row comes in pre-accepted with, or null — and it must name one category and would save
 * (`invalid` null):
 *   the job-year anchor, when exactly one anchor reproduces (right basis, by construction) — whatever other years also reproduce;
 *   otherwise exactly one candidate that reproduces. Two that reproduce, with no anchor among them, is ambiguity: the person chooses.
 */
export function v7AutoPick<T extends V7RankedCandidate & { invalid?: string | null }>(candidates: readonly T[]): T | null {
  const reproducing = candidates.filter((candidate) => candidate.match.verdict === "reproduces");
  const anchored = reproducing.filter((candidate) => candidate.anchor === true);
  const only = anchored.length === 1 ? anchored[0]! : anchored.length === 0 && reproducing.length === 1 ? reproducing[0]! : null;
  return only && only.match.categoryCode !== null && !only.invalid ? only : null;
}

/** Each scope's two totals and whether they agree to one decimal place — the reconcile strip, and the gate on bringing a job in. */
export type V7ScopeAgreement = { scope: V7ImportScope; previous: number; live: number; agrees: boolean };
export function v7ScopeAgreement(totals: V7ImportIngestTotals): V7ScopeAgreement[] {
  return (["1", "2", "3"] as const).map((scope) => ({ scope, previous: totals[scope].v7Tco2e, live: totals[scope].liveTco2e,
    agrees: agreesToOneDecimalPlace(totals[scope].v7Tco2e, totals[scope].liveTco2e) }));
}

/** The previous system's own total per scope, from the summary (before anything is brought in). */
export const v7PreviousScopeTotals = (totals: V7ImportScopeTotals): Record<V7ImportScope, number> =>
  ({ "1": totals["1"].v7Tco2e, "2": totals["2"].v7Tco2e, "3": totals["3"].v7Tco2e });
