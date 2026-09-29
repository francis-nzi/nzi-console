import { utcDay } from "./dayValues";

/**
 * One list query, shared by every paged list (docs/LIST_PARITY_DESIGN.md §2).
 *
 * The URL is the only state a list has: a filtered, sorted page is a link, and it survives a refresh. This module
 * is the one place that turns a query string into a query and back, for the page (which renders the controls) and
 * for the route (which runs the read) alike — so the two cannot disagree about what `?sort=owner&page=3` means.
 *
 * ## Whitelist, never pass-through
 *
 * Every key a list understands is named in its spec. A sort key, a filter key or a page size the spec does not
 * name is never forwarded: the parser reports it as an issue and falls back to the default. The page ignores the
 * issues (a hand-edited or stale link still renders — on the defaults), and the route refuses them with a 400,
 * because the only URL it should ever receive is one this module wrote.
 */

export type SortDirection = "asc" | "desc";
export type ListSort<S extends string> = { key: S; dir: SortDirection };
/** `value` — a set of exact values; `date` — one calendar day, YYYY-MM-DD. */
export type ListFilterKind = "value" | "date";

export type ListSpec<S extends string, F extends string> = {
  sortKeys: readonly S[];
  defaultSort: ListSort<S>;
  filters: Readonly<Record<F, ListFilterKind>>;
};

export type ListQuery<S extends string, F extends string> = {
  search: string;
  filters: Partial<Record<F, string[]>>;
  sort: ListSort<S>;
  page: number;
  pageSize: number;
};

/** One option of a filter, from the tenant's own data, counted over the search and every *other* active filter. */
export type ListFilterOption = { value: string; label: string; count: number };

export type ListPage<Row, F extends string, Summary = Record<string, never>> = {
  rows: Row[];
  /** Rows matching the search and filters, across every page. */
  total: number;
  /** Every row in the list before any search or filter — what tells "none yet" from "none match". */
  unfilteredTotal: number;
  /** The page served. A page past the end is served as the last page, and this says so. */
  page: number;
  pageSize: number;
  pageCount: number;
  filterOptions: Record<F, ListFilterOption[]>;
  /** The metric strip, over the filtered set (not the page), so it stays true across pages. */
  summary: Summary;
};

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;
/** A filter value meaning "nothing recorded". Shown as Unspecified/Unassigned; matches a blank. */
export const NONE_VALUE = "(none)";
const MAX_SEARCH = 200;
const MAX_VALUES = 20;
const MAX_VALUE_LENGTH = 200;
const RESERVED = ["q", "sort", "dir", "page", "size"] as const;

export type ListParams = URLSearchParams | Record<string, string | string[] | undefined>;

function readAll(params: ListParams, key: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(key);
  const value = params[key];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

const isDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // A real calendar day survives the round trip; 2026-02-30 comes back as 2026-03-02.
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === value;
};

export function defineListSpec<S extends string, F extends string>(spec: ListSpec<S, F>): ListSpec<S, F> {
  for (const key of Object.keys(spec.filters)) {
    if ((RESERVED as readonly string[]).includes(key)) throw new Error(`A list filter cannot be named "${key}" — it is reserved.`);
  }
  if (!spec.sortKeys.includes(spec.defaultSort.key)) throw new Error("A list's default sort must be one of its sort keys.");
  return spec;
}

export function defaultListQuery<S extends string, F extends string>(spec: ListSpec<S, F>): ListQuery<S, F> {
  return { search: "", filters: {}, sort: { ...spec.defaultSort }, page: 1, pageSize: DEFAULT_PAGE_SIZE };
}

/**
 * The query a URL asks for, and what in it was not understood.
 *
 * Keys the spec does not name (other than the five reserved ones) are ignored, not reported: a page URL can carry
 * parameters that belong to something else.
 */
export function parseListQuery<S extends string, F extends string>(params: ListParams, spec: ListSpec<S, F>): { query: ListQuery<S, F>; issues: string[] } {
  const issues: string[] = [];
  const query = defaultListQuery(spec);
  const one = (key: string): string | undefined => {
    const values = readAll(params, key);
    if (values.length > 1) issues.push(`"${key}" was given more than once.`);
    return values[0];
  };

  const search = one("q");
  if (search !== undefined) {
    const trimmed = search.trim();
    if (trimmed.length > MAX_SEARCH) issues.push(`The search is longer than ${MAX_SEARCH} characters.`);
    query.search = trimmed.slice(0, MAX_SEARCH);
  }

  const sort = one("sort");
  if (sort !== undefined) {
    if ((spec.sortKeys as readonly string[]).includes(sort)) query.sort = { key: sort as S, dir: "asc" };
    else issues.push(`"${sort}" is not a column this list sorts by.`);
  }
  const dir = one("dir");
  if (dir !== undefined) {
    if (dir === "asc" || dir === "desc") query.sort.dir = dir;
    else issues.push(`"${dir}" is not a sort direction.`);
  } else if (sort === undefined) {
    query.sort.dir = spec.defaultSort.dir;
  }

  const size = one("size");
  if (size !== undefined) {
    const parsed = Number(size);
    if ((PAGE_SIZES as readonly number[]).includes(parsed)) query.pageSize = parsed;
    else issues.push(`"${size}" is not a page size (${PAGE_SIZES.join(", ")}).`);
  }
  const page = one("page");
  if (page !== undefined) {
    const parsed = Number(page);
    if (Number.isInteger(parsed) && parsed >= 1) query.page = parsed;
    else issues.push(`"${page}" is not a page number.`);
  }

  for (const [key, kind] of Object.entries(spec.filters) as Array<[F, ListFilterKind]>) {
    const raw = readAll(params, key).map((value) => value.trim()).filter((value) => value !== "");
    if (raw.length === 0) continue;
    if (kind === "date") {
      if (raw.length > 1) issues.push(`"${key}" takes one date.`);
      if (isDay(raw[0]!)) query.filters[key] = [raw[0]!];
      else issues.push(`"${raw[0]}" is not a date (YYYY-MM-DD).`);
      continue;
    }
    if (raw.length > MAX_VALUES) issues.push(`"${key}" has more than ${MAX_VALUES} values.`);
    const kept = [...new Set(raw)].slice(0, MAX_VALUES);
    if (kept.some((value) => value.length > MAX_VALUE_LENGTH)) issues.push(`A "${key}" value is longer than ${MAX_VALUE_LENGTH} characters.`);
    query.filters[key] = kept.filter((value) => value.length <= MAX_VALUE_LENGTH);
  }
  return { query, issues };
}

/** The URL for a query. Defaults are left out, so the plain list is the plain path. */
export function listQueryToSearchParams<S extends string, F extends string>(query: ListQuery<S, F>, spec: ListSpec<S, F>): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search.trim()) params.set("q", query.search.trim());
  for (const key of Object.keys(spec.filters) as F[]) {
    for (const value of query.filters[key] ?? []) params.append(key, value);
  }
  if (query.sort.key !== spec.defaultSort.key || query.sort.dir !== spec.defaultSort.dir) {
    params.set("sort", query.sort.key);
    params.set("dir", query.sort.dir);
  }
  if (query.pageSize !== DEFAULT_PAGE_SIZE) params.set("size", String(query.pageSize));
  if (query.page !== 1) params.set("page", String(query.page));
  return params;
}

/**
 * The next query after a control changes. Anything but a page move goes back to page 1 — a new filter on page 7
 * would otherwise land past the end of a shorter list.
 */
export function changeListQuery<S extends string, F extends string>(query: ListQuery<S, F>, change: Partial<Omit<ListQuery<S, F>, "filters">> & { filters?: Partial<Record<F, string[] | undefined>> }): ListQuery<S, F> {
  const filters = { ...query.filters };
  for (const [key, values] of Object.entries(change.filters ?? {}) as Array<[F, string[] | undefined]>) {
    if (values === undefined || values.length === 0) delete filters[key];
    else filters[key] = values;
  }
  const pageOnly = Object.keys(change).every((key) => key === "page");
  return { ...query, ...change, filters, page: pageOnly ? (change.page ?? query.page) : 1 };
}

/** The sort a header click asks for: the active column flips; a new column starts ascending (as v7). */
export function nextSort<S extends string>(current: ListSort<S>, key: S): ListSort<S> {
  return current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}

export const hasActiveFilters = <S extends string, F extends string>(query: ListQuery<S, F>): boolean =>
  query.search.trim() !== "" || Object.values(query.filters).some((values) => Array.isArray(values) && values.length > 0);

// ── Risk (PR 2) ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The milestone traffic light, most severe first. The rule itself is `milestoneRisk.ts` in the isolated backend;
 * this is only the vocabulary and the order (ruled R5: Overdue 3 > Due 2 > Healthy 1 > Not set 0).
 */
export const RISK_LEVELS = ["Overdue", "Due", "Healthy", "Not set"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const RISK_RANK: Readonly<Record<RiskLevel, number>> = { Overdue: 3, Due: 2, Healthy: 1, "Not set": 0 };

// ── The two lists ────────────────────────────────────────────────────────────────────────────────────────────────

export const clientListSpec = defineListSpec({
  sortKeys: ["name", "industry", "status", "owner", "emissions", "completeness", "openJobs", "risk"] as const,
  defaultSort: { key: "name", dir: "asc" },
  filters: { industry: "value", status: "value", owner: "value", portfolio: "value", manager: "value", risk: "value" },
});
export type ClientListSortKey = (typeof clientListSpec.sortKeys)[number];
export type ClientListFilterKey = keyof typeof clientListSpec.filters;
export type ClientListQuery = ListQuery<ClientListSortKey, ClientListFilterKey>;

/**
 * `status` absent means every status except `cancelled` (ruled D5 — v7 hides archived work by default, and an
 * imported archived job is `cancelled`); `status=all` means every status. The default is shown in the control.
 */
export const JOB_STATUS_ALL = "all";
export const jobListSpec = defineListSpec({
  sortKeys: ["number", "client", "title", "family", "manager", "dueDate", "status", "risk"] as const,
  defaultSort: { key: "number", dir: "desc" },
  filters: { client: "value", manager: "value", family: "value", status: "value", risk: "value", dueFrom: "date", dueTo: "date" },
});
export type JobListSortKey = (typeof jobListSpec.sortKeys)[number];
export type JobListFilterKey = keyof typeof jobListSpec.filters;
export type JobListQuery = ListQuery<JobListSortKey, JobListFilterKey>;
