import type { V7DriftListItem } from "@nzi/isolated-backend";

/**
 * "Against the previous system", made reviewable (BRIEF-drift-investigation-and-review-page Part C): the filter, the sort, the URL and
 * the CSV, pure, over what one read of the stored checks returns. Nothing here reads or calls anything.
 *
 * - **Text** is the job-datasets search's matcher (`searchActivityOptions`): split on whitespace, every word must appear, in any order,
 *   case-insensitive — over the job number, client, outcome and badges. "scope 2" is kept together as one word, so it means a scope
 *   apart, not any "2" in a job number.
 * - **Chips** combine with the text and with each other: the outcome chips (Behind · Level · Can't check) widen within their group, as
 *   do the size chips (Large: 5 t or more; Small: more than 0.1 t and under 5 t, so a level job is neither); every other chip narrows.
 * - **At least N t**: the difference in the chosen scope (or any scope), by its size either way. A job with no figure never matches.
 * - **Sort**: any column, either way; the default is the largest difference in any scope. A missing figure sorts last both ways.
 * - The cause (Part A's codes) is not a column yet: `DriftItem` gains it when the codes exist, and `haystack` and `DRIFT_SORT_KEYS` are
 *   where it joins the filter and the sort.
 */
export type DriftItem = V7DriftListItem;

/** Within 0.1 t is level (V7_DRIFT_TOLERANCE_TCO2E); 5 t is the brief's line between a small and a large difference. */
export const DRIFT_LARGE_TCO2E = 5;
const TOLERANCE = 0.1;
/** The earlier re-ingest runner's month (12–30 Oct 2026). */
export const REINGEST_MONTH = "2026-10";

export const DRIFT_CHIPS = [
  { id: "behind", label: "Behind", group: "outcome" },
  { id: "level", label: "Level", group: "outcome" },
  { id: "unknown", label: "Can't check", group: "outcome" },
  { id: "two-year", label: "Two dataset years", group: "flag" },
  { id: "no-rows", label: "No rows in the console", group: "flag" },
  { id: "previous-zero", label: "Previous system shows 0", group: "flag" },
  { id: "large", label: "Large (5 t or more)", group: "size" },
  { id: "small", label: "Small (under 5 t)", group: "size" },
  { id: "october", label: "Re-ingested in October", group: "flag" },
] as const;
export type DriftChip = typeof DRIFT_CHIPS[number]["id"];
const CHIP_IDS = new Set<string>(DRIFT_CHIPS.map((chip) => chip.id));

export const DRIFT_SORT_KEYS = ["largest", "job", "client", "outcome",
  "s1-here", "s1-previous", "s1-difference", "s2-here", "s2-previous", "s2-difference", "s3-here", "s3-previous", "s3-difference",
  "total", "checked"] as const;
export type DriftSortKey = typeof DRIFT_SORT_KEYS[number];
const SORT_KEYS = new Set<string>(DRIFT_SORT_KEYS);

export type DriftQuery = {
  text: string;
  chips: DriftChip[];
  /** The least difference, in t; null for no numeric filter. */
  atLeast: number | null;
  atLeastScope: "any" | "1" | "2" | "3";
  sort: DriftSortKey;
  dir: "asc" | "desc";
};
export const DEFAULT_DRIFT_QUERY: DriftQuery = { text: "", chips: [], atLeast: null, atLeastScope: "any", sort: "largest", dir: "desc" };

export const OUTCOME_LABEL: Record<DriftItem["outcome"], string> = { level: "Level", behind: "Behind", unknown: "Can't check", unchecked: "Not checked" };

// ── Derived figures ────────────────────────────────────────────────────────────────────────────────────────────────
/** console − previous over the three scopes; null unless all three are known. */
export function totalDifference(item: DriftItem): number | null {
  if (item.scopes.some((entry) => entry.difference === null)) return null;
  return Math.round(item.scopes.reduce((sum, entry) => sum + entry.difference!, 0) * 1e6) / 1e6;
}
/** The largest difference by size, in any scope; null when none is known. */
export function largestDifference(item: DriftItem): number | null {
  const known = item.scopes.map((entry) => entry.difference).filter((value): value is number => value !== null);
  return known.length ? Math.max(...known.map(Math.abs)) : null;
}
export const isApart = (difference: number | null) => difference !== null && Math.abs(difference) > TOLERANCE;
const previousShowsZero = (item: DriftItem) => item.scopes.every((entry) => entry.previous === 0);
const reingestedInOctober = (item: DriftItem) => item.reingestedAt !== null && item.reingestedAt.startsWith(REINGEST_MONTH);

/** The words a job answers to in the text box: its number, client, outcome, badges and the scopes it is apart in. */
export function haystack(item: DriftItem): string {
  const largest = largestDifference(item);
  return [item.jobNumber, item.clientName, OUTCOME_LABEL[item.outcome], item.outcome,
    item.spansTwoYears ? "two-year two dataset years" : "",
    item.consoleRows === 0 ? "no rows in the console" : "",
    previousShowsZero(item) ? "previous system shows 0" : "",
    largest === null ? "" : largest >= DRIFT_LARGE_TCO2E ? "large" : isApart(largest) ? "small" : "",
    reingestedInOctober(item) ? "re-ingested in october" : "",
    ...item.scopes.filter((entry) => isApart(entry.difference)).map((entry) => `scope ${entry.scope}`)].join(" ").toLowerCase();
}

/** The query's words: whitespace-split, lower-case, "scope 2" kept as one. */
export function queryWords(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const joined: string[] = [];
  for (let at = 0; at < words.length; at += 1) {
    if (words[at] === "scope" && /^[123]$/.test(words[at + 1] ?? "")) { joined.push(`scope ${words[at + 1]}`); at += 1; }
    else joined.push(words[at]!);
  }
  return joined;
}

const chipMatches = (item: DriftItem, chip: DriftChip): boolean => {
  const largest = largestDifference(item);
  switch (chip) {
    case "behind": case "level": case "unknown": return item.outcome === chip;
    case "two-year": return item.spansTwoYears;
    case "no-rows": return item.consoleRows === 0;
    case "previous-zero": return previousShowsZero(item);
    case "large": return largest !== null && largest >= DRIFT_LARGE_TCO2E;
    case "small": return isApart(largest) && largest! < DRIFT_LARGE_TCO2E;
    case "october": return reingestedInOctober(item);
  }
};

export function driftMatches(item: DriftItem, query: DriftQuery): boolean {
  const words = queryWords(query.text);
  if (words.length) { const hay = haystack(item); if (!words.every((word) => hay.includes(word))) return false; }
  // Outcome and size chips widen within their group; each other chip is a group of its own, so it narrows.
  const groups = new Map<string, DriftChip[]>();
  for (const chip of query.chips) {
    const group = DRIFT_CHIPS.find((entry) => entry.id === chip)!.group;
    const key = group === "flag" ? chip : group;
    groups.set(key, [...(groups.get(key) ?? []), chip]);
  }
  for (const chips of groups.values()) if (!chips.some((chip) => chipMatches(item, chip))) return false;
  if (query.atLeast !== null) {
    const differences = query.atLeastScope === "any" ? item.scopes.map((entry) => entry.difference) : [item.scopes.find((entry) => entry.scope === query.atLeastScope)?.difference ?? null];
    if (!differences.some((value) => value !== null && Math.abs(value) >= query.atLeast!)) return false;
  }
  return true;
}

// ── Sort ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const OUTCOME_ORDER: Record<DriftItem["outcome"], number> = { behind: 0, unknown: 1, unchecked: 2, level: 3 };
export function sortValue(item: DriftItem, key: DriftSortKey): number | string | null {
  const scoped = /^s([123])-(here|previous|difference)$/.exec(key);
  if (scoped) {
    const entry = item.scopes.find((scope) => scope.scope === scoped[1])!;
    return scoped[2] === "here" ? entry.console : scoped[2] === "previous" ? entry.previous : entry.difference;
  }
  switch (key) {
    case "largest": return largestDifference(item);
    case "job": return item.jobNumber;
    case "client": return item.clientName.toLowerCase();
    case "outcome": return OUTCOME_ORDER[item.outcome];
    case "total": return totalDifference(item);
    case "checked": return item.checkedAt;
    default: return null;
  }
}
export function sortDrift(items: readonly DriftItem[], sort: DriftSortKey, dir: "asc" | "desc"): DriftItem[] {
  const sign = dir === "asc" ? 1 : -1;
  return items.map((item, index) => ({ item, index, value: sortValue(item, sort) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
      const order = typeof a.value === "number" && typeof b.value === "number" ? a.value - b.value : String(a.value).localeCompare(String(b.value));
      return order === 0 ? a.index - b.index : sign * order;
    })
    .map((entry) => entry.item);
}
/** Clicking a heading: the same column turns round; a new one starts descending for figures, ascending for words. */
export function nextSort(query: DriftQuery, key: DriftSortKey): Pick<DriftQuery, "sort" | "dir"> {
  if (query.sort === key) return { sort: key, dir: query.dir === "asc" ? "desc" : "asc" };
  return { sort: key, dir: key === "job" || key === "client" || key === "outcome" ? "asc" : "desc" };
}

export function applyDrift(items: readonly DriftItem[], query: DriftQuery): DriftItem[] {
  return sortDrift(items.filter((item) => driftMatches(item, query)), query.sort, query.dir);
}
export function driftTally(all: readonly DriftItem[], shown: readonly DriftItem[]): string {
  return `Showing ${shown.length.toLocaleString("en-GB")} of ${all.length.toLocaleString("en-GB")} · ${shown.filter((item) => item.outcome === "behind").length.toLocaleString("en-GB")} behind`;
}

// ── The URL ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function parseDriftQuery(params: URLSearchParams): DriftQuery {
  const atLeast = Number(params.get("min"));
  const scope = params.get("minScope");
  const sort = params.get("sort");
  return {
    text: params.get("q") ?? "",
    chips: (params.get("chips") ?? "").split(",").filter((chip): chip is DriftChip => CHIP_IDS.has(chip)).filter((chip, at, all) => all.indexOf(chip) === at),
    atLeast: params.get("min") !== null && params.get("min") !== "" && Number.isFinite(atLeast) && atLeast >= 0 ? atLeast : null,
    atLeastScope: scope === "1" || scope === "2" || scope === "3" ? scope : "any",
    sort: sort && SORT_KEYS.has(sort) ? sort as DriftSortKey : DEFAULT_DRIFT_QUERY.sort,
    dir: params.get("dir") === "asc" ? "asc" : params.get("dir") === "desc" ? "desc" : sort && SORT_KEYS.has(sort) ? "desc" : DEFAULT_DRIFT_QUERY.dir,
  };
}
/** Only what differs from the default is written, so the plain page has a plain URL. */
export function driftQueryString(query: DriftQuery): string {
  const params = new URLSearchParams();
  if (query.text.trim()) params.set("q", query.text);
  if (query.chips.length) params.set("chips", query.chips.join(","));
  if (query.atLeast !== null) params.set("min", String(query.atLeast));
  if (query.atLeast !== null && query.atLeastScope !== "any") params.set("minScope", query.atLeastScope);
  if (query.sort !== DEFAULT_DRIFT_QUERY.sort || query.dir !== DEFAULT_DRIFT_QUERY.dir) { params.set("sort", query.sort); params.set("dir", query.dir); }
  const text = params.toString();
  return text ? `?${text}` : "";
}

// ── The CSV ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const DRIFT_CSV_COLUMNS = ["job_id", "job_number", "client_id", "client_name", "outcome",
  "scope1_here", "scope1_previous_system", "scope1_difference", "scope2_here", "scope2_previous_system", "scope2_difference",
  "scope3_here", "scope3_previous_system", "scope3_difference", "checked_at"] as const;
const cell = (value: string | number | null): string => {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  // A text cell a spreadsheet would run as a formula is written as text.
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
/** The filtered rows, in their order: ids, client name, the three scopes × three figures, the outcome and when it was checked. */
export function driftCsv(items: readonly DriftItem[]): string {
  const lines = items.map((item) => [item.jobId, item.jobNumber, item.clientId, item.clientName, item.outcome,
    ...item.scopes.flatMap((entry) => [entry.console, entry.previous, entry.difference]), item.checkedAt].map(cell).join(","));
  return [DRIFT_CSV_COLUMNS.join(","), ...lines].join("\r\n") + "\r\n";
}
