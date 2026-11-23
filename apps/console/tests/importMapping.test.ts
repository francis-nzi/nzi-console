import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthorizationError, V7ImportViewConnectionRefused, type StaffPrincipal, type V7ImportMapping, type V7ImportMappingRow } from "@nzi/isolated-backend";
import { handleImportMapping, type ImportMappingDeps } from "../app/lib/importMappingHandler";
import { IMPORT_SOURCE_UNAVAILABLE } from "../app/lib/importRefreshHandler";
import { PlanDirectoryMissing } from "../app/lib/importRefreshPlan";

/**
 * The job's mapping view (BRIEF-v7-import-rowid-match-and-mapping-view, Part 2). The read itself — what it maps each row to, from
 * where, and that it writes nothing — is proven against real Postgres in v7ReingestRevertReal. This proves what the console adds:
 * the route's order and fail-closed read, what the view shows, and the batch queue's first-time-mapping line.
 */
(globalThis as { React?: unknown }).React = React;
let view: typeof import("../app/jobs/importMappingView");
let batch: typeof import("../app/clients/[clientId]/importBatchView");
before(async () => {
  view = await import("../app/jobs/importMappingView");
  batch = await import("../app/clients/[clientId]/importBatchView");
});
const read = (path: string) => readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");

const PRINCIPAL = { organisationId: "org-a", userId: "staff-consultant", role: "consultant", capabilities: [] } as unknown as StaffPrincipal;
const TOTALS = { "1": { consoleRows: 3, consoleTco2e: 1052.6, v7Rows: 2, v7Tco2e: 1052.59 }, "2": { consoleRows: 0, consoleTco2e: 0, v7Rows: 0, v7Tco2e: 0 },
  "3": { consoleRows: 0, consoleTco2e: 0, v7Rows: 1, v7Tco2e: 0.0015 } };
const row = (over: Partial<V7ImportMappingRow>): V7ImportMappingRow => ({
  legacyDbId: "1001", status: "matched", ownStatus: "matched", scope: "1",
  previous: { label: "Natural gas", siteName: "Head office", quantity: 1200, unit: "kWh", factorCode: "7_1001", factor: 0.2, factorUnit: "kgCO2e", tco2e: 0.24, enabled: true },
  intended: { categoryCode: "1.natural-gas", datasetId: "v7-vintage-2025", factorId: "gas", withdraw: false },
  source: "plan", flag: null, resolution: "matched", decision: null, invalid: null, ...over,
});
const MAPPING: V7ImportMapping = {
  jobId: "v7-job-424", legacyJobNumber: "J000434", verdict: "needs-mapping", scopeTotals: TOTALS, summaryCurrent: false, firstTimeMapping: false,
  rows: [
    row({}),
    row({ legacyDbId: "2001", status: "new", ownStatus: "new", source: "none", flag: "NEW", resolution: "unresolved", intended: { categoryCode: null, datasetId: null, factorId: null, withdraw: false } }),
    row({ legacyDbId: "772", status: "withdrawn", ownStatus: "withdrawn", source: "decision", flag: null, resolution: "resolved", intended: { categoryCode: null, datasetId: null, factorId: null, withdraw: true } }),
  ],
};

const harness = (over: Partial<ImportMappingDeps> = {}) => {
  const calls = { read: [] as unknown[][] };
  const deps: ImportMappingDeps = {
    principal: async () => PRINCIPAL,
    pool: () => ({}) as never,
    source: () => (async () => ({ sourceSha256: "e".repeat(64), rows: [] })),
    options: async () => ({ basePlan: { jobId: "v7-job-424", crosswalkVersion: "none", crosswalkSha256: "0".repeat(64), vintageDatasetIds: [], rows: [] } }),
    read: (async (...args: unknown[]) => { calls.read.push(args); return MAPPING; }) as never,
    failure: (error) => Response.json({ code: "FAILED" }, { status: error instanceof AuthorizationError ? 403 : 500 }),
    log: () => undefined,
    ...over,
  };
  return { deps, calls };
};
const get = () => new Request("http://localhost/api/isolated/jobs/v7-job-424/import-refresh/mapping");

describe("the mapping route: who, a fail-closed source, then the read", () => {
  it("a caller who may not refresh is refused first — nothing is read", async () => {
    const { deps, calls } = harness({ principal: async () => { throw new AuthorizationError("import.refresh"); } });
    assert.equal((await handleImportMapping(get(), "v7-job-424", deps)).status, 403);
    assert.equal(calls.read.length, 0);
  });
  it("no reachable source, or no committed plans: 503, and nothing is read", async () => {
    for (const error of [new V7ImportViewConnectionRefused("unset"), new PlanDirectoryMissing()]) {
      const { deps, calls } = harness({ source: () => { throw error; } });
      const response = await handleImportMapping(get(), "v7-job-424", deps);
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as { message: string }).message, IMPORT_SOURCE_UNAVAILABLE);
      assert.equal(calls.read.length, 0);
    }
  });
  it("the read is the caller's — the principal is the holder its access is checked against — with the committed plan; never cached", async () => {
    const { deps, calls } = harness();
    const response = await handleImportMapping(get(), "v7-job-424", deps);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(((await response.json()) as { data: V7ImportMapping }).data.legacyJobNumber, "J000434");
    assert.deepEqual([calls.read[0]![2], calls.read[0]![3], (calls.read[0]![4] as { basePlan: { crosswalkVersion: string } }).basePlan.crosswalkVersion], [PRINCIPAL, "v7-job-424", "none"]);
  });
  it("is wired: the route reads the real mapping under import.refresh; the job's refresh panel shows it, resolving inline", () => {
    const route = read("api/isolated/jobs/[jobId]/import-refresh/mapping/route.ts");
    assert.ok(route.includes(`requireCapability(principal, "import.refresh")`));
    assert.ok(route.includes("read: readV7ImportMapping"));
    const panel = read("jobs/ImportRefreshPanel.tsx");
    for (const piece of ["`${path}/mapping`", "<ImportMappingView mapping={mapping} resolve={resolveRow} />", "onSaved={() => void readMapping()}"]) assert.ok(panel.includes(piece), piece);
  });
});

describe("the mapping view", () => {
  const html = (mapping: V7ImportMapping, resolve?: (row: V7ImportMappingRow) => React.ReactNode) =>
    renderToStaticMarkup(createElement(view.ImportMappingView, { mapping, resolve }));

  it("every row, both sides: the previous system's record, label, site, quantity, factor and tCO2e; the console's mapping, its source and status", () => {
    const markup = html(MAPPING);
    for (const piece of ["1001", "Natural gas", "Head office", "1,200 kWh", "7_1001", "0.24", "1.natural-gas", "gas", "Crosswalk plan", "Resolved"]) assert.ok(markup.includes(piece), piece);
    assert.ok(markup.includes(`data-row="2001" data-source="none" data-flag="NEW"`));
    assert.ok(markup.includes(view.FLAG_LABEL.NEW) && markup.includes(view.SOURCE_LABEL.none));
    assert.ok(markup.includes("Off at refresh") && markup.includes(view.SOURCE_LABEL.decision), "a decided withdrawal");
    assert.ok(markup.includes("3 rows · 1 flagged · Needs mapping"));
  });
  it("Σ per scope on both sides, so the totals can be seen to tie out", () => {
    const markup = html(MAPPING);
    assert.ok(markup.includes("1,052.59") && markup.includes("1,052.6"));
  });
  it("a flagged row carries the panel's control; a resolved one does not", () => {
    const markup = html(MAPPING, (target) => createElement("span", { "data-control": target.legacyDbId }));
    assert.ok(markup.includes(`data-control="2001"`));
    assert.ok(!markup.includes(`data-control="1001"`) && !markup.includes(`data-control="772"`));
  });
  it("a totals-only job says it is a first-time mapping, not a regression; no internal name on screen", () => {
    const markup = html({ ...MAPPING, firstTimeMapping: true });
    assert.ok(markup.includes(batch.FIRST_TIME_MAPPING_LINE));
    assert.ok(!html(MAPPING).includes(batch.FIRST_TIME_MAPPING_LINE));
    assert.ok(!/v7/i.test(markup.replace(/v7-[a-z0-9-]+/g, "")), "no internal name on screen");
  });
});

describe("the batch queue's first-time-mapping line", () => {
  const item = { jobId: "j1", jobNumber: "J000434", status: "queued" as const, because: ["flagged" as const], flagged: 53, refusalCodes: [], failureClass: null };
  it("a totals-only job flagged reads as new activity data to map — never as flagged", () => {
    assert.equal(batch.FIRST_TIME_MAPPING_LINE, "Now has activity data in the previous system — map its rows.");
    assert.equal(batch.queueLine({ ...item, firstTimeMapping: true }), batch.FIRST_TIME_MAPPING_LINE);
    assert.equal(batch.queueLine(item), "Not automatic: 53 flagged.", "any other flagged job, as before");
  });
  it("its other blockers are still said", () => {
    assert.equal(batch.queueLine({ ...item, because: ["issued-report", "flagged"], firstTimeMapping: true }),
      `${batch.FIRST_TIME_MAPPING_LINE} Also not automatic: issued report.`);
  });
});
