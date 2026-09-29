"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/**
 * The one list surface (docs/LIST_PARITY_DESIGN.md §2): a toolbar of search and labelled filters, a table with
 * sortable headers, and a pager — used by Clients and Jobs alike.
 *
 * It is controlled and holds no list state of its own. The page owns the query (in the URL) and passes each value
 * and each change handler in; this renders them and reports what the person did. That is what lets a filtered,
 * sorted page be a link.
 *
 * ## Accessibility
 *
 * - Every sortable header carries `aria-sort` and holds a real `<button>`; the rest carry none.
 * - Every filter is a native `<select>` inside its own `<label>`; the search is a labelled `searchbox`.
 * - A row's primary cell is a real link, so a single click — or Enter from the keyboard — opens the record.
 * - Where rows are selectable (the Evidence Drawer), a row is focusable, Enter or Space selects it, and the arrow
 *   keys move between rows.
 * - The result count is a polite live region, so a filter change is announced.
 */

export type DataListColumn<Row> = {
  key: string;
  header: string;
  /** Present when the column sorts; the key the page sorts by. */
  sortKey?: string;
  numeric?: boolean;
  cell: (row: Row) => ReactNode;
};
export type DataListOption = { value: string; label: string; count?: number };
export type DataListFilter = {
  key: string;
  label: string;
  /** "" = the filter's default (usually "all"). */
  value: string;
  /** The first option's text, standing for "". */
  allLabel: string;
  options: DataListOption[];
};
export type DataListSort = { key: string; dir: "asc" | "desc" };
export type DataListPaging = { page: number; pageCount: number; pageSize: number; pageSizes: readonly number[]; total: number };

export type DataListProps<Row> = {
  /** What the list is of, for the table's name and the pager's ("Clients"). */
  label: string;
  rows: Row[];
  rowKey: (row: Row) => string;
  columns: DataListColumn<Row>[];
  search: { value: string; label: string; placeholder: string; onChange: (value: string) => void };
  filters: DataListFilter[];
  onFilter: (key: string, value: string) => void;
  /** Controls that are not a single select (a date range), placed after the filters. */
  extraControls?: ReactNode;
  sort: DataListSort;
  onSort: (sortKey: string) => void;
  paging: DataListPaging;
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
  /** Shown when anything is narrowing the list. */
  onClear?: () => void;
  /** Shown in place of the rows when the filters match nothing. */
  noMatches: ReactNode;
  selectedKey?: string;
  onSelect?: (row: Row) => void;
  /** A navigation is in flight — the rows shown are the previous query's. */
  busy?: boolean;
  /** The page's own class for the table panel (its column widths and the like). */
  tableClassName?: string;
  /** Debounce before a typed search is applied (v7: 250ms). */
  searchDelayMs?: number;
};

const countFormat = new Intl.NumberFormat("en-GB");
const ariaSort = (sort: DataListSort, sortKey: string | undefined) =>
  sortKey === undefined ? undefined : sort.key === sortKey ? (sort.dir === "asc" ? "ascending" : "descending") : "none";

export function DataList<Row>(props: DataListProps<Row>) {
  const { label, rows, rowKey, columns, search, filters, onFilter, extraControls, sort, onSort, paging, onPage, onPageSize, onClear, noMatches, selectedKey, onSelect, busy, tableClassName, searchDelayMs = 250 } = props;
  const [typed, setTyped] = useState(search.value);
  const applied = useRef(search.value);
  const onSearch = useRef(search.onChange);
  onSearch.current = search.onChange;
  const body = useRef<HTMLTableSectionElement>(null);

  // A search changed from outside (Clear filters, back button) replaces what is in the box.
  useEffect(() => { if (search.value !== applied.current) { applied.current = search.value; setTyped(search.value); } }, [search.value]);
  useEffect(() => {
    if (typed.trim() === applied.current.trim()) return;
    const timer = setTimeout(() => { applied.current = typed.trim(); onSearch.current(typed.trim()); }, searchDelayMs);
    return () => clearTimeout(timer);
  }, [typed, searchDelayMs]);

  const moveFocus = (event: KeyboardEvent<HTMLTableRowElement>, row: Row) => {
    if (event.key === "Enter" || event.key === " ") {
      if ((event.target as HTMLElement).tagName === "A") return;
      event.preventDefault();
      onSelect?.(row);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const all = Array.from(body.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]") ?? []);
    const at = all.indexOf(event.currentTarget);
    const next = all[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) { event.preventDefault(); next.focus(); }
  };

  const first = paging.total === 0 ? 0 : (paging.page - 1) * paging.pageSize + 1;
  const last = Math.min(paging.page * paging.pageSize, paging.total);

  return <div className="nz-datalist">
    <div className="nz-datalist-toolbar" role="search" aria-label={`Search and filter ${label.toLowerCase()}`}>
      <label className="nz-fl nz-datalist-search">{search.label}
        <input className="nz-inp" type="search" value={typed} placeholder={search.placeholder}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { applied.current = typed.trim(); search.onChange(typed.trim()); } }} />
      </label>
      {filters.map((filter) => <label key={filter.key} className="nz-fl nz-datalist-filter">{filter.label}
        <select className="nz-sel" value={filter.value} onChange={(event) => onFilter(filter.key, event.target.value)}>
          <option value="">{filter.allLabel}</option>
          {filter.options.map((option) => <option key={option.value} value={option.value}>
            {option.count === undefined ? option.label : `${option.label} (${countFormat.format(option.count)})`}
          </option>)}
        </select>
      </label>)}
      {extraControls}
      {onClear ? <button type="button" className="nz-btn nz-datalist-clear" onClick={onClear}>Clear filters</button> : null}
    </div>

    <p className="nz-datalist-count" role="status" aria-live="polite">
      {paging.total === 0 ? `No ${label.toLowerCase()} match` : `${countFormat.format(paging.total)} total · showing ${countFormat.format(first)}–${countFormat.format(last)}`}
    </p>

    <div className={`nz-panel nz-datalist-table${tableClassName ? ` ${tableClassName}` : ""}`}>
      <table className="nz-tbl" aria-label={label} aria-busy={busy || undefined}>
        <thead><tr>{columns.map((column) => <th key={column.key} scope="col" className={column.numeric ? "num" : undefined} aria-sort={ariaSort(sort, column.sortKey)}>
          {column.sortKey === undefined ? column.header : <button type="button" className="nz-sort" onClick={() => onSort(column.sortKey!)}>
            {column.header}<span aria-hidden="true" className="nz-sort-mark">{sort.key === column.sortKey ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
          </button>}
        </th>)}</tr></thead>
        <tbody ref={body}>{rows.map((row) => {
          const key = rowKey(row);
          const selectable = onSelect !== undefined;
          return <tr key={key} data-row="" className={`row${selectable && key === selectedKey ? " sel" : ""}`}
            tabIndex={selectable ? 0 : undefined} aria-selected={selectable ? key === selectedKey : undefined}
            onClick={selectable ? (event) => { if ((event.target as HTMLElement).closest("a")) return; onSelect(row); } : undefined}
            onKeyDown={(event) => moveFocus(event, row)}>
            {columns.map((column) => <td key={column.key} className={column.numeric ? "num" : undefined}>{column.cell(row)}</td>)}
          </tr>;
        })}</tbody>
      </table>
      {rows.length === 0 ? <div className="nz-list-empty">{noMatches}</div> : null}
    </div>

    <nav className="nz-datalist-pager" aria-label={`${label} pages`}>
      <label className="nz-fl nz-datalist-size">Rows per page
        <select className="nz-sel" value={paging.pageSize} onChange={(event) => onPageSize(Number(event.target.value))}>
          {paging.pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <button type="button" className="nz-btn" disabled={paging.page <= 1} onClick={() => onPage(paging.page - 1)}>Prev</button>
      <span className="nz-datalist-page">Page {countFormat.format(paging.page)} of {countFormat.format(paging.pageCount)}</span>
      <button type="button" className="nz-btn" disabled={paging.page >= paging.pageCount} onClick={() => onPage(paging.page + 1)}>Next</button>
    </nav>
  </div>;
}
