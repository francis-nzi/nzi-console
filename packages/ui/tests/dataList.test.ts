import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataList, type DataListProps } from "../src/index";

/**
 * The shared list's accessibility contract (docs/LIST_PARITY_DESIGN.md §2): `aria-sort` on every sortable header and
 * only there, a real button to sort with, every filter a labelled native select, a labelled search, the primary cell
 * a real link, focusable selectable rows, and a pager that says where you are.
 */

type Row = { id: string; name: string; owner: string };
const noop = () => {};
const props = (overrides: Partial<DataListProps<Row>> = {}): DataListProps<Row> => ({
  label: "Clients",
  rows: [{ id: "c-1", name: "Acme", owner: "Ann" }, { id: "c-2", name: "Birch", owner: "Bo" }],
  rowKey: (row) => row.id,
  columns: [
    { key: "name", header: "Client", sortKey: "name", cell: (row) => createElement("a", { href: `/clients/${row.id}` }, row.name) },
    { key: "owner", header: "Owner", sortKey: "owner", cell: (row) => row.owner },
    { key: "note", header: "Next report", cell: () => "—" },
  ],
  search: { value: "ac", label: "Search clients", placeholder: "Client name or industry…", onChange: noop },
  filters: [{ key: "status", label: "Status", allLabel: "All statuses", value: "active", options: [{ value: "active", label: "Active", count: 1200 }, { value: "prospect", label: "Prospect", count: 3 }] }],
  onFilter: noop,
  sort: { key: "name", dir: "desc" },
  onSort: noop,
  paging: { page: 2, pageCount: 9, pageSize: 50, pageSizes: [25, 50, 100, 200], total: 433 },
  onPage: noop,
  onPageSize: noop,
  noMatches: "No clients match",
  ...overrides,
});
const render = (overrides?: Partial<DataListProps<Row>>) => renderToStaticMarkup(createElement(DataList<Row>, props(overrides)));

describe("DataList", () => {
  const html = render({ selectedKey: "c-2", onSelect: noop, onClear: noop });

  it("marks the sorted column's direction, the other sortable columns none, and the unsortable ones not at all", () => {
    assert.match(html, /<th scope="col" aria-sort="descending"><button type="button" class="nz-sort">Client/);
    assert.match(html, /<th scope="col" aria-sort="none"><button type="button" class="nz-sort">Owner/);
    assert.match(html, /<th scope="col">Next report<\/th>/);
  });

  it("labels the search and every filter, and shows each option's count", () => {
    assert.match(html, /<label class="nz-fl nz-datalist-search">Search clients<input class="nz-inp" type="search" placeholder="Client name or industry…" value="ac"/);
    assert.match(html, /<label class="nz-fl nz-datalist-filter">Status<select class="nz-sel">/);
    assert.match(html, /<option value="">All statuses<\/option>/);
    assert.match(html, /<option value="active" selected="">Active \(1,200\)<\/option>/);
  });

  it("puts a real link in the primary cell, so one click opens the record", () => {
    assert.match(html, /<td><a href="\/clients\/c-1">Acme<\/a><\/td>/);
  });

  it("makes selectable rows focusable, and says which is selected", () => {
    assert.equal((html.match(/<tr data-row="" class="row[^"]*" tabindex="0"/g) ?? []).length, 2);
    assert.match(html, /class="row sel" tabindex="0" aria-selected="true"/);
  });

  it("does not make rows focusable where there is nothing to select", () => {
    assert.doesNotMatch(render(), /tabindex/);
  });

  it("says where you are: the total, the range on screen, and the page of pages", () => {
    assert.match(html, /role="status" aria-live="polite">433 total · showing 51–100</);
    assert.match(html, /<nav class="nz-datalist-pager" aria-label="Clients pages">/);
    assert.match(html, /Page 2 of 9/);
    assert.match(html, /<option value="50" selected="">50<\/option>/);
  });

  it("disables Prev on the first page and Next on the last", () => {
    assert.match(render({ paging: { ...props().paging, page: 1 } }), /<button type="button" class="nz-btn" disabled="">Prev/);
    assert.match(render({ paging: { ...props().paging, page: 9 } }), /<button type="button" class="nz-btn" disabled="">Next/);
  });

  it("offers Clear filters only when something is narrowing the list", () => {
    assert.match(html, /Clear filters/);
    assert.doesNotMatch(render(), /Clear filters/);
  });

  it("shows the no-match message, not an empty table, when nothing matches", () => {
    const empty = render({ rows: [], paging: { ...props().paging, total: 0, page: 1, pageCount: 1 } });
    assert.match(empty, /<div class="nz-list-empty">No clients match<\/div>/);
    assert.match(empty, /No clients match/);
  });
});
