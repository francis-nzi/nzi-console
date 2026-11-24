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
 * Decision 1 (auto-pick): a row comes in pre-accepted only when exactly one of the candidates found by its own ID reproduces, on a
 * category the decision can name. Decision 2 (wrong-basis guard): a figure-only candidate never auto-wins.
 */
export const V7_MATCH_VERDICTS = ["reproduces", "figure-only", "close", "differs", "unit-mismatch", "no-figure"] as const;
export type V7MatchVerdict = (typeof V7_MATCH_VERDICTS)[number];

/** Half a unit in the first decimal place: two figures within it agree "to one decimal place". */
export const V7_ONE_DECIMAL_PLACE = 0.05;
export const agreesToOneDecimalPlace = (a: number, b: number): boolean => Math.abs(a - b) < V7_ONE_DECIMAL_PLACE - 1e-12;

/**
 * A code with its suffix taken off, for a suffix-insensitive match: lower-cased, whitespace as hyphens (as the factor ids are
 * minted), a registered variant suffix (`-c`, `-vcp` …) removed, then the trailing `_n` segment (the unit or variant index:
 * `25_301_3069_9_1` per km, `_9_2` per mile). The match is on what is left; the recompute then tells the variants apart.
 */
export function v7CoreCode(code: string | null | undefined, variantSuffixes: readonly string[] = []): string | null {
  if (!code || !code.trim()) return null;
  let core = code.trim().replace(/\s+/g, "-").toLowerCase();
  const suffix = [...variantSuffixes].map((entry) => entry.toLowerCase()).sort((a, b) => b.length - a.length).find((entry) => entry && core.endsWith(entry) && core.length > entry.length);
  if (suffix) core = core.slice(0, -suffix.length);
  core = core.replace(/_\d+$/, "");
  return core || null;
}

/** The row as the matcher needs it: no label, no site — its scope, its input, the previous system's figure and its categories. */
export type V7MatchRow = {
  scope: V7ImportScope; quantity: number | null; applyPct: number; previousTco2e: number | null;
  /** The categories the row is known to belong in (its mapping, its own category code, or its levels), or none known. */
  categories: readonly string[];
};
/** A console factor as the matcher needs it. `categories`: the categories whose family claims it (of any scope). */
export type V7MatchFactor = { rate: number | null; scopes: readonly string[]; categories: readonly string[]; sameUnit: boolean };
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
  const known = row.categories.filter((code) => ofScope.has(code));
  if (known.length) {
    const fitting = known.filter(fits);
    if (!fitting.length) return { rightBasis: false, categoryCode: null };
    const claimedFit = fitting.filter((code) => claimed.includes(code));
    return { rightBasis: true, categoryCode: fitting.length === 1 ? fitting[0]! : claimedFit.length === 1 ? claimedFit[0]! : null };
  }
  if (!claimed.length && !open.length) return { rightBasis: false, categoryCode: null };
  return { rightBasis: true, categoryCode: claimed.length === 1 ? claimed[0]! : claimed.length === 0 && open.length === 1 ? open[0]! : null };
}

/** One candidate, judged: its figure for this row, the verdict against the previous system's, and its basis. */
export function v7MatchCandidate(row: V7MatchRow, factor: V7MatchFactor, familyless: readonly string[]): V7MatchResult {
  const basis = basisOf(row, factor, familyless);
  if (row.quantity === null || factor.rate === null || !Number.isFinite(factor.rate)) return { tco2e: null, delta: null, verdict: "no-figure", ...basis };
  const tco2e = round6(row.quantity * factor.rate * (row.applyPct / 100) / 1000);
  if (row.previousTco2e === null) return { tco2e, delta: null, verdict: "no-figure", ...basis };
  const delta = round6(tco2e - row.previousTco2e);
  const verdict: V7MatchVerdict = !factor.sameUnit ? "unit-mismatch"
    : agreesToOneDecimalPlace(tco2e, row.previousTco2e) ? (basis.rightBasis ? "reproduces" : "figure-only")
      : row.previousTco2e !== 0 && Math.abs(delta / row.previousTco2e) <= V7_EMISSION_DELTA_THRESHOLD ? "close" : "differs";
  return { tco2e, delta, verdict, ...basis };
}

const VERDICT_RANK: Record<V7MatchVerdict, number> = { reproduces: 0, close: 1, "figure-only": 2, differs: 3, "unit-mismatch": 4, "no-figure": 5 };

/** A candidate as ranked: its match, and whether it was found by the row's own ID (exactly, or its suffix-insensitive core). */
export type V7RankedCandidate = { match: V7MatchResult; label: string; exactCode?: boolean; identity?: boolean };

/** Right basis first, then the verdict (reproduces first), then the smallest delta; the row's own factor, then its exact code, break a tie. */
export function rankV7Candidates<T extends V7RankedCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => Number(b.match.rightBasis) - Number(a.match.rightBasis)
    || VERDICT_RANK[a.match.verdict] - VERDICT_RANK[b.match.verdict]
    || Math.abs(a.match.delta ?? Infinity) - Math.abs(b.match.delta ?? Infinity)
    || Number(b.identity === true) - Number(a.identity === true)
    || Number(b.exactCode === true) - Number(a.exactCode === true)
    || a.label.localeCompare(b.label));
}

/**
 * Decision 1: the one candidate a row comes in pre-accepted with — exactly one that reproduces (right basis, by construction), names
 * one category and would save (`invalid` null) — or null. Two that reproduce is ambiguity: the person chooses.
 */
export function v7AutoPick<T extends V7RankedCandidate & { invalid?: string | null }>(candidates: readonly T[]): T | null {
  const reproducing = candidates.filter((candidate) => candidate.match.verdict === "reproduces");
  if (reproducing.length !== 1) return null;
  const only = reproducing[0]!;
  return only.match.categoryCode !== null && !only.invalid ? only : null;
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
