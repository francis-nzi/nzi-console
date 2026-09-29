import { NONE_VALUE, type ListFilterOption, type ListPage, type ListQuery, type ListSpec } from "@nzi/contracts";
import type { Queryable } from "./postgres";

/**
 * The one paged-list read (docs/LIST_PARITY_DESIGN.md §2) — search, filters, sort, paging, faceted filter options and
 * a summary, for any list described by a {@link ListSqlSpec}. Clients and Jobs are two specs over this, not two
 * implementations.
 *
 * ## Tenant safety
 *
 * Nothing here names an organisation. Every statement runs on the caller's `Queryable`, which is the tenant
 * transaction `withTenantRead` opened, so row-level security scopes the rows, the totals and the filter options
 * alike — a search or a filter can narrow what the tenant sees and can never widen it.
 *
 * ## Injection safety
 *
 * Identifiers (columns, the base SELECT, summary expressions) come only from the spec, which is code. Every value that
 * came from a request — the search, each filter value, the page — is a bound parameter. Column names are checked
 * against a plain-identifier pattern when the spec is built, so a spec cannot smuggle an expression in by accident.
 */

export type ListSqlFilter =
  /**
   * The column equals one of the chosen values. {@link NONE_VALUE} matches NULL, so the base SELECT must normalise a
   * blank to NULL for any column it filters on.
   *
   * `facet` makes the filter's options come from the data — distinct values with their counts. `whenAbsent` is a
   * predicate applied when the filter is not given at all; `allValue` is the value that means "no filter", for a list
   * whose default is not everything (the Jobs status default, ruled D5).
   */
  | { kind: "equals"; column: string; facet?: ListFacet; whenAbsent?: string; allValue?: string }
  | { kind: "onOrAfter" | "onOrBefore"; column: string };

/**
 * Where a filter's options come from. `noneLabel` names a blank. `values`, when given, is a fixed vocabulary (Risk):
 * every value is offered in that order, with a count of 0 where the data has none — the options then do not depend on
 * which levels happen to be present, and the order is the vocabulary's, not the counts'.
 */
export type ListFacet = { noneLabel: string; values?: readonly string[] };

export type ListSqlSpec<S extends string, F extends string> = {
  /**
   * One row per list item, with every column the filters, search, sort and page read. It runs inside a CTE, under
   * the caller's tenant context. It may use `$1…$n` for {@link ListSqlSpec.baseParams}.
   */
  base: string;
  search: readonly string[];
  filters: { [K in F]: ListSqlFilter };
  sort: { [K in S]: { column: string; text?: boolean } };
  /** A column unique per row, so equal sort values still page stably. */
  tiebreak: string;
  /** Extra select-list items evaluated only for the rows on the page (drawer detail and the like). */
  pageColumns?: string;
  /** A select list over the filtered rows (`FROM filtered`) — the metric strip. */
  summary?: string;
};

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function defineListSql<S extends string, F extends string>(spec: ListSqlSpec<S, F>): ListSqlSpec<S, F> {
  const columns = [...spec.search, spec.tiebreak, ...Object.values<ListSqlFilter>(spec.filters).map((filter) => filter.column),
    ...Object.values<{ column: string }>(spec.sort).map((sort) => sort.column)];
  for (const column of columns) if (!IDENTIFIER.test(column)) throw new Error(`"${column}" is not a plain column name.`);
  return spec;
}

/** `%`, `_` and `\` in a search are the characters themselves, not wildcards. */
export const likePattern = (search: string): string => `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

class Binder {
  readonly values: unknown[];
  constructor(initial: readonly unknown[]) { this.values = [...initial]; }
  bind(value: unknown): string { this.values.push(value); return `$${this.values.length}`; }
}

function conditions<S extends string, F extends string>(spec: ListSqlSpec<S, F>, query: ListQuery<S, F>, binder: Binder, except?: F): string[] {
  const where: string[] = [];
  if (query.search.trim() !== "" && spec.search.length > 0) {
    const pattern = binder.bind(likePattern(query.search.trim()));
    where.push(`(${spec.search.map((column) => `${column} ILIKE ${pattern}`).join(" OR ")})`);
  }
  for (const key of Object.keys(spec.filters) as F[]) {
    if (key === except) continue;
    const filter = spec.filters[key];
    const values = query.filters[key];
    if (filter.kind === "equals") {
      if (!values || values.length === 0) { if (filter.whenAbsent) where.push(`(${filter.whenAbsent})`); continue; }
      if (filter.allValue !== undefined && values.includes(filter.allValue)) continue;
      const named = values.filter((value) => value !== NONE_VALUE);
      const parts: string[] = [];
      if (named.length > 0) parts.push(`${filter.column} = ANY(${binder.bind(named)}::text[])`);
      if (values.includes(NONE_VALUE)) parts.push(`${filter.column} IS NULL`);
      where.push(`(${parts.join(" OR ")})`);
    } else if (values && values[0]) {
      where.push(`${filter.column} ${filter.kind === "onOrAfter" ? ">=" : "<="} ${binder.bind(values[0])}::date`);
    }
  }
  return where;
}

const whereClause = (parts: string[]) => parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`;

type FacetRow = { facet: number; value: string | null; count: number };

export async function readListPage<Row, S extends string, F extends string, Summary>(
  db: Queryable,
  spec: ListSqlSpec<S, F>,
  listSpec: ListSpec<S, F>,
  query: ListQuery<S, F>,
  options: { baseParams?: readonly unknown[]; mapRow: (row: Record<string, unknown>) => Row; mapSummary: (row: Record<string, unknown>) => Summary },
): Promise<ListPage<Row, F, Summary>> {
  const baseParams = options.baseParams ?? [];

  // 1. The totals and the summary, over the filtered set, in one statement.
  const totals = new Binder(baseParams);
  const filteredWhere = whereClause(conditions(spec, query, totals));
  const { rows: [counted] } = await db.query<Record<string, unknown>>(
    `WITH base AS (${spec.base}), filtered AS (SELECT * FROM base ${filteredWhere})
     SELECT (SELECT count(*) FROM base)::int AS unfiltered_total, (SELECT count(*) FROM filtered)::int AS total
       ${spec.summary ? `, summary.* FROM (SELECT ${spec.summary} FROM filtered) summary` : ""}`,
    totals.values);
  const total = Number(counted?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pageCount);

  // 2. The page. The sort column is looked up in the spec, never read from the request.
  const sort = spec.sort[query.sort.key] ?? spec.sort[listSpec.defaultSort.key];
  const dir = query.sort.dir === "desc" ? "DESC" : "ASC";
  const order = `${sort.text ? `lower(${sort.column})` : sort.column} ${dir} NULLS LAST, ${spec.tiebreak} ${dir}`;
  const paged = new Binder(baseParams);
  const pageWhere = whereClause(conditions(spec, query, paged));
  const limit = paged.bind(query.pageSize), offset = paged.bind((page - 1) * query.pageSize);
  const { rows } = await db.query<Record<string, unknown>>(
    `WITH base AS (${spec.base})
     SELECT base.*${spec.pageColumns ? `, ${spec.pageColumns}` : ""} FROM base ${pageWhere}
     ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    paged.values);

  // 3. Filter options: each facet counted over the search and every *other* filter (ruled D4), so choosing an
  //    option never leads to an empty page.
  const facetKeys = (Object.keys(spec.filters) as F[]).filter((key) => {
    const filter = spec.filters[key];
    return filter.kind === "equals" && filter.facet !== undefined;
  });
  const filterOptions = Object.fromEntries((Object.keys(spec.filters) as F[]).map((key) => [key, [] as ListFilterOption[]])) as Record<F, ListFilterOption[]>;
  if (facetKeys.length > 0) {
    const facets = new Binder(baseParams);
    const selects = facetKeys.map((key, index) => {
      const column = spec.filters[key].column;
      return `SELECT ${index} AS facet, ${column}::text AS value, count(*)::int AS count FROM base ${whereClause(conditions(spec, query, facets, key))} GROUP BY ${column}`;
    });
    const { rows: facetRows } = await db.query<FacetRow>(`WITH base AS (${spec.base}) ${selects.join(" UNION ALL ")}`, facets.values);
    facetKeys.forEach((key, index) => {
      const filter = spec.filters[key] as Extract<ListSqlFilter, { kind: "equals" }>;
      const noneLabel = filter.facet!.noneLabel;
      const options: ListFilterOption[] = facetRows.filter((row) => Number(row.facet) === index).map((row) =>
        row.value === null ? { value: NONE_VALUE, label: noneLabel, count: Number(row.count) } : { value: row.value, label: row.value, count: Number(row.count) });
      // A chosen value always stays choosable, even when the search has left it with nothing.
      for (const chosen of query.filters[key] ?? []) {
        if (chosen === filter.allValue || options.some((option) => option.value === chosen)) continue;
        options.push({ value: chosen, label: chosen === NONE_VALUE ? noneLabel : chosen, count: 0 });
      }
      const fixed = filter.facet!.values;
      if (fixed) {
        for (const value of fixed) if (!options.some((option) => option.value === value)) options.push({ value, label: value, count: 0 });
        options.sort((a, b) => fixed.indexOf(a.value) - fixed.indexOf(b.value));
      } else {
        options.sort((a, b) => (a.value === NONE_VALUE ? 1 : 0) - (b.value === NONE_VALUE ? 1 : 0) || b.count - a.count || a.label.localeCompare(b.label, "en-GB"));
      }
      filterOptions[key] = options;
    });
  }

  return {
    rows: rows.map(options.mapRow),
    total,
    unfilteredTotal: Number(counted?.unfiltered_total ?? 0),
    page,
    pageSize: query.pageSize,
    pageCount,
    filterOptions,
    summary: options.mapSummary(counted ?? {}),
  };
}
