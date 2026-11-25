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
before(async () => { panel = await import("../app/jobs/ImportRefreshPanel"); view = await import("../app/admin/import-drift/driftView"); });
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

describe("the Admin list", () => {
  const item = (over: Partial<V7DriftListItem>): V7DriftListItem => ({ jobId: "j", jobNumber: "J000663", clientId: "c", clientName: "EFF Group", spansTwoYears: true, outcome: "behind",
    checkedAt: "2026-11-25T14:02:11Z", unknownReason: null, maxDifference: 8835.26,
    scopes: [{ scope: "1", console: 80.3, previous: 93.83, difference: -13.53 }, { scope: "2", console: 77.1, previous: 2121.17, difference: -2044.07 }, { scope: "3", console: 13003.8, previous: 21839.06, difference: -8835.26 }], ...over });
  it("each scope here, in the previous system, and the difference; a tally; the two-year jobs marked", () => {
    const markup = html(createElement(view.DriftList, { items: [item({}), item({ jobNumber: "J000434", spansTwoYears: false, outcome: "level", maxDifference: 0,
      scopes: [{ scope: "1", console: 1052.6, previous: 1052.6, difference: 0 }, { scope: "2", console: 15.3, previous: 15.3, difference: 0 }, { scope: "3", console: 195.7, previous: 195.7, difference: 0 }] })] }));
    assert.ok(markup.includes("2 imported jobs · 1 behind · 1 level · 0 can&rsquo;t check · 0 not checked") || markup.includes("2 imported jobs · 1 behind · 1 level · 0 can’t check · 0 not checked"));
    assert.ok(markup.includes(`data-drift-job="J000663" data-outcome="behind"`) && markup.includes("77.1 · 2,121.2 · <b>-2,044.1</b>") && markup.includes("two dataset years"));
  });
  it("never checked, or the previous system unanswering: no figure on either side, never a zero; the reason in words", () => {
    const blank = [{ scope: "1" as const, console: null, previous: null, difference: null }, { scope: "2" as const, console: null, previous: null, difference: null }, { scope: "3" as const, console: null, previous: null, difference: null }];
    const markup = html(createElement(view.DriftList, { items: [item({ outcome: "unchecked", checkedAt: null, maxDifference: null, scopes: blank }),
      item({ jobNumber: "J000265", outcome: "unknown", unknownReason: "not-configured", maxDifference: null, scopes: blank.map((entry) => ({ ...entry, console: 0 })) })] }));
    assert.ok(markup.includes("— · — · <b>—</b>") && !markup.includes("0.0 · 0.0"));
    assert.ok(markup.includes("Not checked") && markup.includes("Can&#x27;t check") && markup.includes("the previous system&#x27;s figures are not connected yet"));
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
  });
});
