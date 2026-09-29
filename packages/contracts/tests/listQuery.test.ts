import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  changeListQuery, clientListSpec, defaultListQuery, defineListSpec, hasActiveFilters, jobListSpec, listQueryToSearchParams,
  nextSort, parseListQuery, RISK_LEVELS, RISK_RANK,
} from "../src/index";

/**
 * The list query (docs/LIST_PARITY_DESIGN.md §2): the URL is a list's only state, so parsing it and writing it back
 * must agree exactly, and nothing the spec does not name may get through.
 */

describe("parseListQuery", () => {
  it("reads the plain path as the list's defaults", () => {
    const { query, issues } = parseListQuery(new URLSearchParams(), clientListSpec);
    assert.deepEqual(issues, []);
    assert.deepEqual(query, defaultListQuery(clientListSpec));
    assert.deepEqual(query.sort, { key: "name", dir: "asc" });
    assert.equal(query.pageSize, 50);
    assert.deepEqual(parseListQuery({}, jobListSpec).query.sort, { key: "number", dir: "desc" });
  });

  it("reads a full query — search, repeated filter values, sort, page and size", () => {
    const { query, issues } = parseListQuery(
      new URLSearchParams("q=%20acme%20&industry=Retail&industry=Food&owner=(none)&sort=owner&dir=desc&page=3&size=100"), clientListSpec);
    assert.deepEqual(issues, []);
    assert.equal(query.search, "acme");
    assert.deepEqual(query.filters, { industry: ["Retail", "Food"], owner: ["(none)"] });
    assert.deepEqual(query.sort, { key: "owner", dir: "desc" });
    assert.equal(query.page, 3);
    assert.equal(query.pageSize, 100);
  });

  it("refuses a sort key, direction, size or page the spec does not name — and falls back to the default", () => {
    const { query, issues } = parseListQuery({ sort: "name; DROP TABLE clients", dir: "sideways", size: "1000", page: "0" }, clientListSpec);
    assert.equal(issues.length, 4);
    assert.deepEqual(query.sort, { key: "name", dir: "asc" });
    assert.equal(query.pageSize, 50);
    assert.equal(query.page, 1);
  });

  it("ignores parameters that are not the list's (a page URL can carry others)", () => {
    const { query, issues } = parseListQuery({ utm_source: "email", view: "compact" }, clientListSpec);
    assert.deepEqual(issues, []);
    assert.deepEqual(query.filters, {});
  });

  it("accepts only real calendar days for a date filter", () => {
    assert.deepEqual(parseListQuery({ dueFrom: "2026-02-28", dueTo: "2026-12-31" }, jobListSpec).query.filters, { dueFrom: ["2026-02-28"], dueTo: ["2026-12-31"] });
    for (const bad of ["2026-02-30", "28/02/2026", "2026-2-1", "yesterday"]) {
      const { query, issues } = parseListQuery({ dueFrom: bad }, jobListSpec);
      assert.equal(issues.length, 1, bad);
      assert.equal(query.filters.dueFrom, undefined, bad);
    }
  });

  it("caps the search, and reports a value given twice where one is meant", () => {
    const long = "x".repeat(250);
    const { query, issues } = parseListQuery(new URLSearchParams(`q=${long}&page=2&page=3`), clientListSpec);
    assert.equal(query.search.length, 200);
    assert.equal(issues.length, 2);
  });

  it("drops blank filter values rather than filtering on nothing", () => {
    assert.deepEqual(parseListQuery({ industry: ["", "  "] }, clientListSpec).query.filters, {});
  });
});

describe("listQueryToSearchParams", () => {
  it("round-trips every query it writes", () => {
    const query = { search: "north", filters: { status: ["active", "prospect"], manager: ["(none)"] }, sort: { key: "openJobs" as const, dir: "desc" as const }, page: 4, pageSize: 25 };
    const written = listQueryToSearchParams(query, clientListSpec);
    const { query: read, issues } = parseListQuery(written, clientListSpec);
    assert.deepEqual(issues, []);
    assert.deepEqual(read, query);
  });

  it("leaves the defaults out, so the plain list is the plain path", () => {
    assert.equal(listQueryToSearchParams(defaultListQuery(clientListSpec), clientListSpec).toString(), "");
    assert.equal(listQueryToSearchParams(defaultListQuery(jobListSpec), jobListSpec).toString(), "");
  });
});

describe("changing a list", () => {
  const onPage7 = { ...defaultListQuery(clientListSpec), page: 7 };

  it("goes back to page 1 for anything but a page move", () => {
    assert.equal(changeListQuery(onPage7, { search: "a" }).page, 1);
    assert.equal(changeListQuery(onPage7, { filters: { status: ["active"] } }).page, 1);
    assert.equal(changeListQuery(onPage7, { sort: { key: "owner", dir: "asc" } }).page, 1);
    assert.equal(changeListQuery(onPage7, { pageSize: 100 }).page, 1);
    assert.equal(changeListQuery(onPage7, { page: 8 }).page, 8);
  });

  it("removes a filter set to nothing and keeps the others", () => {
    const filtered = changeListQuery(defaultListQuery(clientListSpec), { filters: { status: ["active"], owner: ["Ann"] } });
    assert.deepEqual(changeListQuery(filtered, { filters: { status: undefined } }).filters, { owner: ["Ann"] });
    assert.deepEqual(changeListQuery(filtered, { filters: { owner: [] } }).filters, { status: ["active"] });
  });

  it("flips the active column and starts a new one ascending, as v7 does", () => {
    assert.deepEqual(nextSort({ key: "name", dir: "asc" }, "name"), { key: "name", dir: "desc" });
    assert.deepEqual(nextSort({ key: "name", dir: "desc" }, "name"), { key: "name", dir: "asc" });
    assert.deepEqual(nextSort({ key: "name", dir: "desc" }, "owner"), { key: "owner", dir: "asc" });
  });

  it("knows when anything is narrowing the list", () => {
    assert.equal(hasActiveFilters(defaultListQuery(clientListSpec)), false);
    assert.equal(hasActiveFilters({ ...defaultListQuery(clientListSpec), search: "a" }), true);
    assert.equal(hasActiveFilters({ ...defaultListQuery(clientListSpec), filters: { owner: ["Ann"] } }), true);
    assert.equal(hasActiveFilters({ ...defaultListQuery(clientListSpec), sort: { key: "owner", dir: "desc" } }), false);
  });
});

describe("Risk on both lists (PR 2)", () => {
  it("is a filter and a sort key on Clients and Jobs, and round-trips through the URL", () => {
    for (const spec of [clientListSpec, jobListSpec] as const) {
      const { query, issues } = parseListQuery({ risk: "Not set", sort: "risk", dir: "asc" }, spec);
      assert.deepEqual(issues, []);
      assert.deepEqual(query.filters, { risk: ["Not set"] });
      assert.equal(listQueryToSearchParams(query, spec).toString(), "risk=Not+set&sort=risk&dir=asc");
    }
  });
  it("orders its levels by severity: Overdue 3 > Due 2 > Healthy 1 > Not set 0 (ruled R5)", () => {
    assert.deepEqual([...RISK_LEVELS], ["Overdue", "Due", "Healthy", "Not set"]);
    assert.deepEqual(RISK_LEVELS.map((level) => RISK_RANK[level]), [3, 2, 1, 0]);
  });
});

describe("a list spec", () => {
  it("cannot name a filter after a reserved parameter", () => {
    assert.throws(() => defineListSpec({ sortKeys: ["a"], defaultSort: { key: "a", dir: "asc" }, filters: { page: "value" } }), /reserved/);
  });
  it("must default to one of its own sort keys", () => {
    assert.throws(() => defineListSpec({ sortKeys: ["a"] as string[], defaultSort: { key: "b", dir: "asc" }, filters: {} }), /default sort/);
  });
});
