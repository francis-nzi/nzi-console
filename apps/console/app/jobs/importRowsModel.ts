import {
  agreesToOneDecimalPlace, emissionCategoryTaxonomy, rankV7Candidates, v7MatchCandidate,
  type V7ImportIngestTotals, type V7ImportScope, type V7MatchResult, type V7MatchVerdict,
} from "@nzi/contracts";
import type { V7ImportCandidate, V7ImportFactorHit, V7ImportRows, V7ImportRowsAcceptItem, V7ImportRowsRow } from "@nzi/isolated-backend";

/**
 * The import rows modal, as data (BRIEF-v7-import-rows-modal §C; the mockup in _handoff). Pure: no hooks, no requests — the modal
 * renders what these return, and a test reads them directly.
 *
 * The groups, in the mockup's order: Need a match (red) · Suggested (amber) · Gone from the previous system (amber) · Linked pairs
 * (carried together) · Matched & accepted (green) · Import totals retiring. A scope total the previous system still counts beside its
 * activity rows is said on its own, and holds the job back: bringing it in would count the scope twice.
 */
export type RowsGroupKey = "unmatched" | "suggested" | "confirm-off" | "pairs" | "matched" | "switched-off" | "retiring" | "double-counted";
export type RowsGroup = { key: RowsGroupKey; title: string; rows: V7ImportRowsRow[] };

const SCOPES: readonly V7ImportScope[] = ["1", "2", "3"];
const pairWaiting = (row: V7ImportRowsRow) => row.carry === "awaiting";

export function groupRows(rows: readonly V7ImportRowsRow[]): RowsGroup[] {
  const by = (test: (row: V7ImportRowsRow) => boolean) => rows.filter(test);
  const groups: RowsGroup[] = [
    { key: "unmatched", title: "Need a match", rows: by((row) => !pairWaiting(row) && row.lane === "unmatched") },
    { key: "suggested", title: "Suggested — confirm", rows: by((row) => !pairWaiting(row) && row.lane === "suggested") },
    { key: "confirm-off", title: "Gone from the previous system — confirm it goes off", rows: by((row) => !pairWaiting(row) && row.lane === "confirm-off") },
    { key: "pairs", title: "Linked pairs — carried together", rows: by(pairWaiting) },
    { key: "double-counted", title: "Scope totals the previous system still counts", rows: by((row) => row.totalStillCounted) },
    { key: "matched", title: "Matched & accepted", rows: by((row) => !pairWaiting(row) && !row.totalStillCounted && (row.lane === "accepted" || row.lane === "pre-accepted" || row.lane === "in-console")) },
    { key: "switched-off", title: "Switched off in the previous system", rows: by((row) => !pairWaiting(row) && row.lane === "switched-off") },
    { key: "retiring", title: "Import totals — retiring on accept", rows: by((row) => row.lane === "retiring") },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

/** A switched-off row with the previous system's own factor to come in on: "Accept all" brings it in, switched off. */
const offReady = (row: V7ImportRowsRow) => row.lane === "switched-off" && row.pick !== null && row.pick.match.categoryCode !== null && !row.pick.invalid;

/** The pairs waiting on their carry, member rows together, by group. */
export function pairGroups(rows: readonly V7ImportRowsRow[]): Array<{ pairGroup: string; rows: V7ImportRowsRow[] }> {
  const groups = new Map<string, V7ImportRowsRow[]>();
  for (const row of rows) if (pairWaiting(row) && row.pairGroup) groups.set(row.pairGroup, [...(groups.get(row.pairGroup) ?? []), row]);
  return [...groups].map(([pairGroup, members]) => ({ pairGroup, rows: members }));
}

export type RowsProgress = {
  /** Rows the task is over: every row but the totals retiring. */
  total: number; done: number;
  matched: number; suggested: number; confirmOff: number; pairs: number; unmatched: number; retiring: number; doubleCounted: number;
  /** Switched off in the previous system: all of them, and those with no factor of their own to come in on (a person finds one). */
  switchedOff: number; switchedOffUnmatched: number;
};

export function rowsProgress(rows: readonly V7ImportRowsRow[]): RowsProgress {
  const count = (key: RowsGroupKey) => groupRows(rows).find((group) => group.key === key)?.rows.length ?? 0;
  const matched = count("matched");
  const retiring = count("retiring");
  const off = groupRows(rows).find((group) => group.key === "switched-off")?.rows ?? [];
  const offDone = off.filter(offReady).length;
  return { total: rows.length - retiring, done: matched + offDone, matched, suggested: count("suggested"), confirmOff: count("confirm-off"),
    pairs: pairGroups(rows).length, unmatched: count("unmatched"), retiring, doubleCounted: count("double-counted"),
    switchedOff: off.length, switchedOffUnmatched: off.length - offDone };
}

const mapItem = (row: V7ImportRowsRow): V7ImportRowsAcceptItem => ({ kind: "map", legacyDbId: row.legacyDbId, categoryCode: row.pick!.match.categoryCode!,
  datasetId: row.pick!.datasetId, factorId: row.pick!.factorId, expectedDecisionId: row.decision?.decisionId ?? null });

/**
 * The writes "Accept all matched" sends: each pre-accepted row's mapping (decision 1); each switched-off row's, to the previous
 * system's own factor (it comes in switched off — ruled 24 Nov); and, as the activity rows come in, each import total the previous
 * system has dropped, confirmed off (it retires). Nothing amber or red is ever in it.
 */
export function pendingAccepts(rows: readonly V7ImportRowsRow[]): V7ImportRowsAcceptItem[] {
  const items: V7ImportRowsAcceptItem[] = [];
  for (const row of rows) {
    if ((row.lane === "pre-accepted" && row.pick && row.pick.match.categoryCode) || offReady(row)) items.push(mapItem(row));
  }
  // The totals retire once activity rows are coming in: some accepted now, or already.
  const activityComingIn = items.length > 0 || rows.some((row) => row.lane === "accepted" && row.decision?.kind === "map");
  if (activityComingIn) for (const row of rows) {
    if (row.lane === "retiring" && row.ownStatus === "withdrawn" && row.resolution !== "resolved") items.push({ kind: "withdraw", legacyDbId: row.legacyDbId, expectedDecisionId: row.decision?.decisionId ?? null });
  }
  return items;
}

/**
 * "Accept all N suggested" (BRIEF-v7-import-rows-autopick-fix §6): each suggestion's current pick, through the same accept — a
 * suggestion with no single category to name, or one that would not save, stays for a person. A linked pair whose members are all
 * accepted here is carried with them, as "Carry both" carries it.
 */
export function suggestedAccepts(rows: readonly V7ImportRowsRow[]): V7ImportRowsAcceptItem[] {
  const ready = (row: V7ImportRowsRow) => row.lane === "suggested" && row.pick !== null && row.pick.match.categoryCode !== null && !row.pick.invalid;
  const items = rows.filter(ready).map(mapItem);
  for (const pair of pairGroups(rows)) {
    const settled = pair.rows.every((row) => ready(row) || row.lane === "pre-accepted" || row.lane === "accepted" || row.lane === "in-console");
    if (settled && pair.rows.some(ready)) items.push({ kind: "carry", legacyDbId: pair.rows[0]!.legacyDbId });
  }
  return items;
}

/** What "Accept all suggested" asks before it writes: how many, by scope — a linked pair counted once. */
export function suggestedSummary(rows: readonly V7ImportRowsRow[]): { total: number; byScope: Array<{ scope: V7ImportScope; count: number }>; pairs: number } {
  const accepted = new Set(suggestedAccepts(rows).filter((item) => item.kind === "map").map((item) => item.legacyDbId));
  const counted = new Map<string, V7ImportScope>();
  for (const row of rows) if (accepted.has(row.legacyDbId)) counted.set(row.carry === "awaiting" && row.pairGroup ? `pair:${row.pairGroup}` : row.legacyDbId, row.scope);
  const byScope = SCOPES.map((scope) => ({ scope, count: [...counted.values()].filter((entry) => entry === scope).length })).filter((entry) => entry.count > 0);
  return { total: counted.size, byScope, pairs: [...counted.keys()].filter((key) => key.startsWith("pair:")).length };
}

/** Why the job cannot be brought in yet, in words; empty when it can (the scopes' own agreement is the preview's, after). */
export function bringInBlockers(rows: readonly V7ImportRowsRow[]): string[] {
  const progress = rowsProgress(rows);
  const say = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", String(n)));
  const out: string[] = [];
  if (progress.unmatched) out.push(say(progress.unmatched, "1 row still needs a match", "{n} rows still need a match"));
  if (progress.suggested) out.push(say(progress.suggested, "1 suggestion to confirm", "{n} suggestions to confirm"));
  if (progress.confirmOff) out.push(say(progress.confirmOff, "1 row gone from the previous system to confirm off", "{n} rows gone from the previous system to confirm off"));
  if (progress.switchedOffUnmatched) out.push(say(progress.switchedOffUnmatched, "1 switched-off row needs its factor", "{n} switched-off rows need their factor"));
  if (progress.pairs) out.push(say(progress.pairs, "1 linked pair to carry", "{n} linked pairs to carry"));
  if (progress.doubleCounted) out.push(say(progress.doubleCounted, "1 scope total still counted beside its rows in the previous system — switch it off there first",
    "{n} scope totals still counted beside their rows in the previous system — switch them off there first"));
  const stale = rows.filter((row) => row.resolution === "stale" && !pairWaiting(row)).length;
  if (stale && !progress.unmatched && !progress.suggested) out.push(say(stale, "1 earlier decision no longer stands", "{n} earlier decisions no longer stand"));
  return out;
}

// ── The reconcile strip ──────────────────────────────────────────────────────────────────────────────────────────

export type ScopeLine = { scope: V7ImportScope; previous: number; console: number | null; agrees: boolean | null; waiting: number };

/**
 * Each scope: the previous system's total, and the console's as it would stand — every counted row at the figure it would come in
 * with (its pick, or the previous system's own for a row carried as it stands) — or, once a preview has run, the preview's own.
 * `waiting` counts the rows with no figure yet; such a scope is not yet said to agree.
 */
export function scopeLines(data: Pick<V7ImportRows, "rows" | "scopeTotals">, preview: V7ImportIngestTotals | null): ScopeLine[] {
  return SCOPES.map((scope) => {
    const previous = data.scopeTotals[scope].v7Tco2e;
    if (preview) return { scope, previous: preview[scope].v7Tco2e, console: preview[scope].liveTco2e, agrees: agreesToOneDecimalPlace(preview[scope].v7Tco2e, preview[scope].liveTco2e), waiting: 0 };
    let sum = 0, waiting = 0;
    for (const row of data.rows) {
      if (row.scope !== scope || row.previous.enabled !== true || row.ownStatus === "withdrawn") continue;
      const figure = row.lane === "in-console" ? row.previous.tco2e : row.pick?.match.tco2e ?? null;
      if (figure === null) waiting += 1; else sum += figure;
    }
    const console = Math.round(sum * 1e6) / 1e6;
    return { scope, previous, console: waiting ? null : console, agrees: waiting ? null : agreesToOneDecimalPlace(previous, console), waiting };
  });
}

export const oneDp = (value: number) => value.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// ── The resolve control ─────────────────────────────────────────────────────────────────────────────────────────

/** What the verdict says on the candidate table, against the previous system — plain words, no symbols. */
export function verdictWords(match: V7MatchResult, rowScope: V7ImportScope, factorScopes: readonly string[]): { text: string; tone: "ok" | "off" | "bad" } {
  const delta = match.delta === null ? "" : `${match.delta > 0 ? "+" : ""}${oneDp(match.delta)}`;
  const otherScope = factorScopes.map((tag) => tag.split(".")[0]).find((scope) => scope !== rowScope);
  const words: Record<V7MatchVerdict, { text: string; tone: "ok" | "off" | "bad" }> = {
    reproduces: { text: "✓ matches the previous system", tone: "ok" },
    // On the row's own basis, a figure-only is a zero rate: any zero gives the figure, so it says nothing (autopick fix §4).
    "figure-only": match.rightBasis ? { text: "a zero rate — any zero gives this figure", tone: "off" }
      : { text: otherScope ? `Scope ${otherScope} — wrong basis` : "another category — wrong basis", tone: "off" },
    close: { text: `${delta} against the previous system`, tone: "bad" },
    differs: { text: `${delta} against the previous system`, tone: "bad" },
    "unit-mismatch": { text: "unit mismatch", tone: "bad" },
    "no-figure": { text: "no figure to compare", tone: "off" },
  };
  return words[match.verdict];
}

/** A search hit, judged for the row as an ID candidate is — so the two lists rank as one. */
export function judgeHit(row: V7ImportRowsRow, hit: V7ImportFactorHit, familyless: readonly string[]): V7ImportCandidate {
  const match = v7MatchCandidate({ scope: row.scope, quantity: row.previous.quantity, applyPct: row.applyPct, previousTco2e: row.previous.tco2e, categories: row.categories,
    v7Category: row.v7Category }, { rate: hit.rate, scopes: hit.scopes, categories: hit.categories, sameUnit: hit.sameUnit }, familyless);
  return { datasetId: hit.datasetId, factorId: hit.factorId, code: hit.code, label: hit.label, unit: hit.unit, rate: hit.rate, dataset: hit.dataset,
    identity: false, exactCode: false, anchor: false, year: null, scopes: hit.scopes, categories: hit.categories, match, invalid: null };
}

/** The ID candidates and the search's hits, as one ranked list, each factor once (the ID candidate kept: it carries its save check). */
export function mergeCandidates(own: readonly V7ImportCandidate[], hits: readonly V7ImportCandidate[]): V7ImportCandidate[] {
  const key = (candidate: V7ImportCandidate) => `${candidate.datasetId}|${candidate.factorId}`;
  const seen = new Set(own.map(key));
  return rankV7Candidates([...own, ...hits.filter((hit) => !seen.has(key(hit)))]);
}

/** Where a candidate may be filed for this row: its claimed categories of the row's scope, and the scope's family-less ones. */
export function fileableCategories(row: Pick<V7ImportRowsRow, "scope">, candidate: Pick<V7ImportCandidate, "categories">, familyless: readonly string[]) {
  return emissionCategoryTaxonomy.filter((category) => category.scope === row.scope && (candidate.categories.includes(category.code) || familyless.includes(category.code)));
}

/** The smart filter over the rows: every word, in any order, across the row's ids, label, site, unit and its pick. */
export function filterRows(rows: readonly V7ImportRowsRow[], text: string): V7ImportRowsRow[] {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [...rows];
  return rows.filter((row) => {
    const haystack = [row.legacyDbId, row.previous.factorCode, row.previous.label, row.previous.siteName, row.previous.unit, `scope ${row.scope}`,
      row.pick?.label, row.pick?.code].filter(Boolean).join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}
