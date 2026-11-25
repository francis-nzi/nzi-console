import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { V7DriftListItem } from "@nzi/isolated-backend";

/**
 * The drift guard in the console (BRIEF-v7-import-j000663 Part C): the job's banner, the Admin list, and the check made just before a
 * publish. The checks, the gate and the list's read are proven against real Postgres in v7ReingestRevertReal.
 */
(globalThis as { React?: unknown }).React = React;
let panel: typeof import("../app/jobs/ImportRefreshPanel");
let view: typeof import("../app/admin/import-drift/driftView");
let model: typeof import("../app/admin/import-drift/driftModel");
before(async () => { panel = await import("../app/jobs/ImportRefreshPanel"); view = await import("../app/admin/import-drift/driftView"); model = await import("../app/admin/import-drift/driftModel"); });
const html = (element: React.ReactElement) => renderToStaticMarkup(element).replace(/<!-- -->/g, "");
const read = (path: string) => readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");

describe("the job's banner, from its latest check", () => {
  it("behind: the brief's line, as an alert, saying it can't be published", () => {
    const markup = html(createElement(panel.DriftBanner, { drift: { tone: "behind", line: "Behind the previous system: Scope 2 77.1 here, 2,121.2 in the previous system", checkedAt: "2026-11-25T14:02:11Z" } }));
    assert.ok(markup.includes(`data-drift="behind"`) && markup.includes(`role="alert"`) && markup.includes("nz-banner bad"));
    assert.ok(markup.includes("Behind the previous system: Scope 2 77.1 here, 2,121.2 in the previous system") && markup.includes("can&#x27;t be published until its rows are brought in"));
  });
  it("can't check: amber, never level; level, or nothing to say: no banner", () => {
    assert.ok(html(createElement(panel.DriftBanner, { drift: { tone: "unknown", line: "Can't check against the previous system just now.", checkedAt: null } })).includes(`data-drift="unknown"`));
    assert.equal(html(createElement(panel.DriftBanner, { drift: { tone: "level", line: null, checkedAt: "2026-11-25T14:02:11Z" } })), "");
    assert.equal(html(createElement(panel.DriftBanner, { drift: null })), "");
  });
});

describe("the Admin list, made reviewable", () => {
  const known = (c: [number, number, number], p: [number, number, number]) => (["1", "2", "3"] as const).map((scope, at) => ({ scope, console: c[at]!, previous: p[at]!, difference: Math.round((c[at]! - p[at]!) * 1e6) / 1e6 }));
  const blank = (["1", "2", "3"] as const).map((scope) => ({ scope, console: null, previous: null, difference: null }));
  const item = (over: Partial<V7DriftListItem>): V7DriftListItem => ({ jobId: "j663", jobNumber: "J000663", clientId: "c-eff", clientName: "EFF Group", spansTwoYears: true, outcome: "behind",
    checkedAt: "2026-11-25T22:00:00Z", unknownReason: null, maxDifference: 8835.26, consoleRows: 180, reingestedAt: "2026-10-29T10:00:00Z",
    scopes: known([80.3, 77.1, 13003.8], [93.83, 2121.17, 21839.06]), history: [], ...over });
  const ITEMS: V7DriftListItem[] = [
    item({}),
    item({ jobId: "j434", jobNumber: "J000434", clientName: "Kays Medical", spansTwoYears: false, outcome: "level", maxDifference: 0.02, reingestedAt: null, scopes: known([1052.6, 15.25, 195.7], [1052.62, 15.25, 195.74]) }),
    item({ jobId: "j548", jobNumber: "J000548", clientName: "Gama Healthcare", spansTwoYears: false, outcome: "behind", maxDifference: 22378, scopes: known([10, 0, 2579], [10, 0, 24957]) }),
    item({ jobId: "j265", jobNumber: "J000265", clientName: "Gama Healthcare", outcome: "behind", consoleRows: 0, reingestedAt: null, maxDifference: 537.82, scopes: known([0, 0, 0], [17.72, 15.31, 504.78]) }),
    item({ jobId: "j573", jobNumber: "J000573", clientName: "Sustainable X", spansTwoYears: false, outcome: "behind", maxDifference: 40, scopes: known([12, 28, 0], [0, 0, 0]) }),
    item({ jobId: "j073", jobNumber: "J000073", clientName: "Lowmac", outcome: "behind", maxDifference: 1.4, scopes: known([84.3, 1.77, 1957.95], [84.3, 3.17, 1957.95]) }),
    item({ jobId: "j900", jobNumber: "J000900", clientName: "=Formula Ltd, \"quoted\"", spansTwoYears: false, outcome: "unknown", unknownReason: "timeout", maxDifference: null, reingestedAt: null,
      scopes: blank.map((entry) => ({ ...entry, console: 4 })) }),
    item({ jobId: "j901", jobNumber: "J000901", clientName: "Never Checked", spansTwoYears: false, outcome: "unchecked", checkedAt: null, maxDifference: null, reingestedAt: null, scopes: blank }),
  ];
  const Q = (over: Partial<import("../app/admin/import-drift/driftModel").DriftQuery> = {}) => ({ ...model.DEFAULT_DRIFT_QUERY, ...over });
  const jobs = (list: readonly V7DriftListItem[]) => list.map((entry) => entry.jobNumber);
  const table = (items = ITEMS, open: string | null = null) => html(createElement(view.DriftTable, { items, query: Q(), onSort: () => undefined, open, onToggle: () => undefined }));

  /** The cells of each <tr> as [data-col, colspan, rowspan], from the markup (no nested table unless a history is open). */
  const rowsOf = (markup: string) => [...markup.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) => [...row[1]!.matchAll(/<(th|td)\b([^>]*)>/g)]
    .map((cell) => ({ col: /data-col="([^"]+)"/.exec(cell[2]!)?.[1] ?? null, id: /\bid="([^"]+)"/.exec(cell[2]!)?.[1] ?? null, span: Number(/colSpan="(\d+)"|colspan="(\d+)"/i.exec(cell[2]!)?.slice(1).find(Boolean) ?? 1),
      rows: Number(/rowSpan="(\d+)"|rowspan="(\d+)"/i.exec(cell[2]!)?.slice(1).find(Boolean) ?? 1), headers: /headers="([^"]+)"/.exec(cell[2]!)?.[1] ?? null })));

  it("a two-row header: each figure cell sits in the column of the heading that names it, and says so in `headers`", () => {
    const markup = table();
    const [top, second, ...body] = rowsOf(markup);
    // Lay the two header rows out on a grid, honouring row and column spans.
    const grid: Array<Array<{ col: string | null; id: string | null }>> = [[], []];
    let at = 0;
    for (const cell of top!) { while (grid[0]![at]) at += 1; for (let k = 0; k < cell.span; k += 1) { grid[0]![at + k] = cell; if (cell.rows === 2) grid[1]![at + k] = cell; } at += cell.span; }
    at = 0;
    for (const cell of second!) { while (grid[1]![at]) at += 1; grid[1]![at] = cell; at += 1; }
    const columns = grid[1]!.map((cell) => cell.col);
    assert.deepEqual(columns, ["job", "client", "outcome", "s1-here", "s1-previous", "s1-difference", "s2-here", "s2-previous", "s2-difference", "s3-here", "s3-previous", "s3-difference", "total", "checked"]);
    assert.deepEqual(grid[0]!.slice(3, 13).map((cell) => cell.id), ["dh-s1", "dh-s1", "dh-s1", "dh-s2", "dh-s2", "dh-s2", "dh-s3", "dh-s3", "dh-s3", "dh-total"], "each scope heading spans its three columns");
    assert.equal(body.length, ITEMS.length);
    for (const row of body) {
      assert.deepEqual(row.map((cell) => cell.col), columns, "every figure in its own column, in the heading's order");
      for (const [index, cell] of row.entries()) {
        const heading = grid[1]![index]!;
        assert.ok(cell.headers?.split(" ").includes(heading.id!), `${cell.col} names its heading ${heading.id}`);
        if (index >= 3 && index < 13) assert.ok(cell.headers!.split(" ").includes(grid[0]![index]!.id!), `${cell.col} names its scope`);
      }
    }
    assert.ok(markup.includes(`<thead>`) && markup.includes(`class="nz-a-drift-wrap"`));
  });

  it("compact rows: the two-year badge beside the job number; differences signed, toned by sign beyond 0.1 t, never colour alone; no zero for a missing figure", () => {
    const markup = table();
    assert.ok(/data-col="job"><a href="\/jobs\/j663">J000663<\/a><span class="nz-a-prov"[^>]*>Two-year<\/span><\/th>/.test(markup), "the badge sits beside the number, not on a line of its own");
    assert.ok(markup.includes(`<span class="nz-a-drift-diff lower" title="Lower here than in the previous system">−2,044.1</span>`));
    assert.ok(markup.includes(`<span class="nz-a-drift-diff higher" title="Higher here than in the previous system">+28.0</span>`));
    assert.ok(markup.includes(`<span class="nz-a-drift-diff even">0.0</span>`), "within 0.1 t: no tone, no sign");
    const unchecked = rowsOf(table([ITEMS[7]!]))[2]!;
    assert.equal(unchecked.length, 14);
    const never = html(createElement(view.DriftTable, { items: [ITEMS[7]!], query: Q(), onSort: () => undefined, open: null, onToggle: () => undefined }));
    assert.ok(!/>0\.0</.test(never) && (never.match(/>—</g) ?? []).length === 11, "never checked: a dash in every figure and the checked time, never 0");
    const unknown = html(createElement(view.DriftTable, { items: [ITEMS[6]!], query: Q(), onSort: () => undefined, open: null, onToggle: () => undefined }));
    assert.ok(unknown.includes(`title="the previous system took too long">Can&#x27;t check</td>`));
  });

  it("the default order is the largest difference in any scope; sorting works on every column, both ways, a missing figure last", () => {
    assert.deepEqual(jobs(model.applyDrift(ITEMS, Q())), ["J000548", "J000663", "J000265", "J000573", "J000073", "J000434", "J000900", "J000901"]);
    for (const key of model.DRIFT_SORT_KEYS) for (const dir of ["asc", "desc"] as const) {
      const values = model.sortDrift(ITEMS, key, dir).map((entry) => model.sortValue(entry, key));
      const present = values.filter((value) => value !== null);
      assert.deepEqual(values.slice(0, present.length), present, `${key} ${dir}: missing figures last`);
      for (let k = 1; k < present.length; k += 1) {
        const order = typeof present[k] === "number" ? (present[k] as number) - (present[k - 1] as number) : String(present[k]).localeCompare(String(present[k - 1]));
        assert.ok(dir === "asc" ? order >= 0 : order <= 0, `${key} ${dir} at ${k}`);
      }
    }
    assert.deepEqual(model.nextSort(Q(), "s2-difference"), { sort: "s2-difference", dir: "desc" });
    assert.deepEqual(model.nextSort(Q({ sort: "s2-difference", dir: "desc" }), "s2-difference"), { sort: "s2-difference", dir: "asc" });
    assert.deepEqual(model.nextSort(Q(), "client"), { sort: "client", dir: "asc" });
    // Every heading is a sort button, marked with aria-sort.
    const markup = table();
    assert.equal((markup.match(/<button type="button" class="nz-sort">/g) ?? []).length, 14);
    assert.ok(markup.includes(`aria-sort="none"`) && !markup.includes(`aria-sort="descending"`), "the default (largest difference) is no single column");
  });

  it("each chip filters; outcome and size chips widen within their group; chips combine with the text and the figure filter", () => {
    const only = (chips: string[], over = {}) => jobs(model.applyDrift(ITEMS, Q({ chips: chips as never, ...over }))).sort();
    assert.deepEqual(only(["behind"]), ["J000073", "J000265", "J000548", "J000573", "J000663"]);
    assert.deepEqual(only(["level"]), ["J000434"]);
    assert.deepEqual(only(["unknown"]), ["J000900"]);
    assert.deepEqual(only(["two-year"]), ["J000073", "J000265", "J000663"]);
    assert.deepEqual(only(["no-rows"]), ["J000265"]);
    assert.deepEqual(only(["previous-zero"]), ["J000573"]);
    assert.deepEqual(only(["large"]), ["J000265", "J000548", "J000573", "J000663"]);
    assert.deepEqual(only(["small"]), ["J000073"], "a level job is neither small nor large");
    assert.deepEqual(only(["october"]), ["J000073", "J000548", "J000573", "J000663"]);
    assert.deepEqual(only(["behind", "level"]), ["J000073", "J000265", "J000434", "J000548", "J000573", "J000663"], "outcomes widen");
    assert.deepEqual(only(["behind", "two-year", "small"]), ["J000073"], "groups narrow");
    assert.deepEqual(only(["behind"], { text: "gama" }), ["J000265", "J000548"]);
    assert.deepEqual(only([], { text: "behind gama" }), only([], { text: "Gama   BEHIND" }), "any words, any order, any case");
    assert.deepEqual(only([], { text: "two-year scope 2" }), ["J000073", "J000265", "J000663"], "\"scope 2\" means apart in Scope 2");
    assert.deepEqual(only([], { text: "kays" }), ["J000434"]);
    assert.deepEqual(only([], { atLeast: 1000 }), ["J000548", "J000663"]);
    assert.deepEqual(only([], { atLeast: 1000, atLeastScope: "2" }), ["J000663"]);
    assert.deepEqual(only(["two-year"], { atLeast: 100, text: "gama" }), ["J000265"]);
    assert.deepEqual(only([], { atLeast: 0 }), jobs(ITEMS.filter((entry) => entry.scopes.some((scope) => scope.difference !== null))).sort(), "no figure never matches a figure filter");
  });

  it("the filter and the sort round-trip through the URL; the plain view has a plain address; junk is ignored", () => {
    const query = Q({ text: "gama behind", chips: ["two-year", "large"], atLeast: 5, atLeastScope: "3", sort: "s3-previous", dir: "asc" });
    const search = model.driftQueryString(query);
    assert.deepEqual(model.parseDriftQuery(new URLSearchParams(search.slice(1))), query);
    assert.equal(model.driftQueryString(Q()), "");
    assert.deepEqual(model.parseDriftQuery(new URLSearchParams("chips=behind,nonsense,behind&min=-3&minScope=9&sort=drop&dir=sideways")), Q({ chips: ["behind"] }));
  });

  it("the tally counts the filtered set; the CSV is exactly the filtered rows, in order, figures only", () => {
    const shown = model.applyDrift(ITEMS, Q({ chips: ["two-year"] }));
    assert.equal(model.driftTally(ITEMS, shown), "Showing 3 of 8 · 3 behind");
    const board = html(createElement(view.DriftBoard, { items: ITEMS, initialQuery: Q({ chips: ["two-year"] }) }));
    assert.ok(board.includes(`data-drift-tally="true" role="status">Showing 3 of 8 · 3 behind</p>`));
    assert.equal((board.match(/data-drift-job=/g) ?? []).length, 3);
    assert.ok(board.includes(`data-chip="two-year" aria-pressed="true" class="on"`));
    const lines = model.driftCsv(model.applyDrift(ITEMS, Q())).trimEnd().split("\r\n");
    assert.equal(lines[0], model.DRIFT_CSV_COLUMNS.join(","));
    assert.equal(lines.length, ITEMS.length + 1);
    assert.equal(lines[1], "j548,J000548,c-eff,Gama Healthcare,behind,10,10,0,0,0,0,2579,24957,-22378,2026-11-25T22:00:00Z");
    assert.ok(lines.includes(`j900,J000900,c-eff,"'=Formula Ltd, ""quoted""",unknown,4,,,4,,,4,,,2026-11-25T22:00:00Z`), "quoted, and never run as a formula; no figure is empty, not 0");
    assert.ok(lines.includes("j901,J000901,c-eff,Never Checked,unchecked,,,,,,,,,,"));
    const csvJobs = model.driftCsv(shown).trimEnd().split("\r\n").slice(1).map((line) => line.split(",")[1]);
    assert.deepEqual(csvJobs, jobs(shown));
  });

  it("clicking a job's checked time opens its last checks: when, by what, the outcome and each scope's difference", () => {
    const withHistory = { ...ITEMS[0]!, history: [
      { checkedAt: "2026-11-25T22:00:00Z", outcome: "behind" as const, trigger: "nightly" as const, unknownReason: null, differences: [-13.53, -2044.07, -8835.26] as [number, number, number] },
      { checkedAt: "2026-11-25T14:02:11Z", outcome: "unknown" as const, trigger: "admin" as const, unknownReason: "timeout", differences: [null, null, null] as [null, null, null] }] };
    const closed = table([withHistory]);
    assert.ok(closed.includes(`aria-expanded="false" aria-controls="drift-history-j663"`) && !closed.includes("nz-a-drift-history"));
    const open = table([withHistory], "j663");
    assert.ok(open.includes(`id="drift-history-j663"`) && open.includes("Last 2 checks of J000663"));
    assert.ok(open.includes("<td>Nightly</td>") && open.includes("<td>Check now</td>") && open.includes("Can&#x27;t check: the previous system took too long"));
    assert.ok(open.includes(">−8,835.3</span>"));
  });
});

describe("wiring", () => {
  it("publish checks the job against the previous system just before the command, outside its transaction", () => {
    const route = read("api/isolated/reports/publish/route.ts");
    assert.ok(route.indexOf("checkBeforePublish(") > 0 && route.indexOf("checkBeforePublish(") < route.indexOf("publishCrpReport(isolatedPool()"));
  });
  it("Check now is an Admin's (import.refresh_batch), needs the write API and our origin, and answers at once", () => {
    const route = read("api/isolated/admin/import-drift/route.ts");
    for (const piece of [`NZI_WRITE_API_ENABLED !== "true"`, "requireAuthOrigin(request)", `requireCapability(principal, "import.refresh_batch")`, "status: 202", "RUN_IN_PROGRESS"]) assert.ok(route.includes(piece), piece);
  });
  it("the page reads stored checks only: it never calls the previous system on opening", () => {
    const page = read("admin/import-drift/page.tsx");
    assert.ok(page.includes("listV7Drift(") && !page.includes("checkV7Drift") && !page.includes("runV7DriftChecks"));
    assert.ok(page.includes("parseDriftQuery(") && page.includes("<DriftBoard"), "the view arrives from the address");
    const board = read("admin/import-drift/driftView.tsx");
    assert.ok(board.includes("window.history.replaceState(") && board.includes("driftQueryString(next)"), "every change is written back to the address, without a navigation");
    assert.ok(!board.includes("fetch("), "the list never reads anything itself");
  });
});
