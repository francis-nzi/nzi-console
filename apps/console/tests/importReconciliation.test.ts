import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { deriveV7ImportTotals, resolveV7Import, V7_IMPORT_ROW_STATUSES, type V7ImportDecision, type V7ImportSummaryRow } from "@nzi/contracts";
import type { V7ImportWorkbenchSession, V7ImportWorkbenchView } from "@nzi/isolated-backend";
import { ADMIN_ITEMS } from "../app/admin/adminNav";

/**
 * The import workbench, Phases 1–2: the import view renders each status, the per-scope Σ on each side, each row's resolution
 * control and the verdict its decisions give — behind import.manage, with no ingest. (The read model and the commands behind it
 * are proved against a real database in v7ReingestRevertReal.)
 */
(globalThis as { React?: unknown }).React = React;
// The view is loaded after React is global: the shared UI package's icons are evaluated as it loads.
let ImportJobView: typeof import("../app/admin/import/ImportReconciliation").ImportJobView;
let ImportSessionsList: typeof import("../app/admin/import/ImportReconciliation").ImportSessionsList;
let STATUS_LABEL: typeof import("../app/admin/import/ImportReconciliation").STATUS_LABEL;
let VERDICT_LINE: typeof import("../app/admin/import/ImportReconciliation").VERDICT_LINE;
before(async () => ({ ImportJobView, ImportSessionsList, STATUS_LABEL, VERDICT_LINE } = await import("../app/admin/import/ImportReconciliation")));

const base = { sourceSystem: "nzi-pro-v7" as const, code: "7_1", scope: "1" as const, consoleScope: "1" as const, v7Figure: 1, consoleFigure: 1, v7Enabled: true, consoleEnabled: true, pairRef: null, changedFields: [] as string[], pairGroup: null, pairQuantityConsistent: null };
const ROWS: V7ImportSummaryRow[] = [
  { ...base, legacyDbId: "1", status: "matched", consoleRowId: "v7-row-1" },
  { ...base, legacyDbId: "2", status: "changed", consoleRowId: "v7-row-2", v7Figure: 1.5, changedFields: ["migrated_record", "quantity"] },
  { ...base, legacyDbId: "3", status: "needs-mapping", consoleRowId: "v7-row-3", scope: "3", consoleScope: "3", changedFields: ["migrated_record", "migrated_record.original_id"] },
  { ...base, legacyDbId: "4", status: "new", consoleRowId: null, consoleScope: null, consoleFigure: null, consoleEnabled: null },
  { ...base, legacyDbId: "5", status: "withdrawn", consoleRowId: "v7-row-5", code: null, v7Figure: null, v7Enabled: null },
  { ...base, legacyDbId: "6", status: "linked-pair-changed", consoleRowId: "v7-row-6", pairRef: "v7-row-7", changedFields: ["migrated_record"], pairGroup: "v7-row-7", pairQuantityConsistent: false },
];
const totals = deriveV7ImportTotals(ROWS);
const SESSION = { sessionId: "v7-import-00000000-0000-0000-0000-000000000000", jobId: "job-1", jobNumber: "J000901", legacyJobNumber: "J000901", extractSha256: "c".repeat(64),
  generatedAt: "2026-11-12T09:00:00.000Z", uploadedAt: "2026-11-12T09:05:00.000Z", uploadedBy: "policy:v7-import", ...totals, format: "nzi.import-summary/2" };
const decision = (legacyDbId: string, kind: "map" | "withdraw", row: V7ImportSummaryRow): V7ImportDecision => ({
  decisionId: `v7-decision-0000000${legacyDbId}-0000-0000-0000-000000000000`, sourceSystem: "nzi-pro-v7", legacyDbId, kind,
  categoryCode: kind === "map" ? (row.scope === "3" ? "3.6" : "1.natural-gas") : null, datasetId: kind === "map" ? "ds-1" : null, factorId: kind === "map" ? `f-${legacyDbId}` : null,
  carryOption: null, forPairGroup: null,
  forStatus: row.status, forScope: row.scope, forCode: row.code, sessionId: SESSION.sessionId, reason: null, decidedBy: "staff-admin", decidedAt: "2026-11-12T10:00:00.000Z" });
const viewOf = (rows: V7ImportSummaryRow[], decisions: V7ImportDecision[], invalid = new Map<string, string>()): V7ImportWorkbenchView => {
  const resolved = resolveV7Import(rows, decisions, invalid);
  return { session: { ...SESSION, ...deriveV7ImportTotals(rows), format: "nzi.import-summary/2" }, rows, earlierSessions: 0, decisions, resolvedVerdict: resolved.verdict, groups: resolved.groups,
    resolutions: resolved.rows.map((entry) => ({ ...entry, invalid: entry.decision ? invalid.get(entry.decision.decisionId) ?? null : null })) };
};
// The resolution controls refresh the page through the app router once a decision saves; a static render needs one mounted.
const ROUTER = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const render = (view: V7ImportWorkbenchView) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: ROUTER }, createElement(ImportJobView, { view })));
const rowHtml = (html: string, legacyDbId: string) => html.slice(html.indexOf(`data-table="rows"`)).split("<tr").find((chunk) => chunk.includes(`<td class="nz-a-mono">${legacyDbId}</td>`)) ?? "";

describe("the import view (import workbench, Phases 1–2)", () => {
  let html = "";
  before(() => { html = render(viewOf(ROWS, [])); });

  it("renders every status, once per row", () => {
    for (const status of V7_IMPORT_ROW_STATUSES) {
      assert.ok(html.includes(`data-status="${status}"`), status);
      assert.ok(html.includes(`>${STATUS_LABEL[status]}<`), STATUS_LABEL[status]);
    }
    assert.ok(html.includes("paired with"), "a pair names its partner");
  });

  it("renders the per-scope Σ on each side, and the verdict line", () => {
    for (const scope of ["1", "2", "3"]) assert.ok(html.includes(`data-scope="${scope}"`), scope);
    assert.ok(html.includes(VERDICT_LINE["blocked-on-pairs"]));
    assert.ok(html.includes("Console Σ") && html.includes("Previous system Σ"));
  });

  it("offers each row its own resolution: a category and factor picker for new and needs-mapping, a confirm for withdrawn", () => {
    for (const id of ["3", "4"]) {
      const row = rowHtml(html, id);
      assert.ok(/<select[^>]*id="import-\d-category"/.test(row) && row.includes(">Save mapping<"), `row ${id} has the picker`);
    }
    assert.ok(rowHtml(html, "3").includes("Choose a Scope 3 category") && rowHtml(html, "3").includes("(3.6)") && !rowHtml(html, "3").includes("(1.natural-gas)"), "scope-constrained");
    assert.ok(rowHtml(html, "5").includes(">Confirm withdrawal<") && rowHtml(html, "5").includes("switch off at ingest"));
  });

  it("asks nothing of a matched or changed row; a pair member resolves under its own status, and its group carries as one", () => {
    assert.ok(!/<(button|select)\b/.test(rowHtml(html, "1")) && !/<(button|select)\b/.test(rowHtml(html, "2")));
    assert.ok(rowHtml(html, "2").includes("the re-plan carries it"), "changed: accepted automatically");
    // Member 6 only moved in its figures: its own status is changed, so it asks nothing itself — its pair does.
    assert.ok(!/<(button|select)\b/.test(rowHtml(html, "6")) && rowHtml(html, "6").includes("pair to carry"));
    const pairs = html.slice(html.indexOf(`data-table="pairs"`), html.indexOf(`data-table="rows"`));
    assert.ok(pairs.includes(`data-pair-group="v7-row-7"`) && pairs.includes(">Carry both, unlinked<") && pairs.includes("Or hold"), "one option, A, and the hold");
    assert.ok(pairs.includes(`data-quantity="inconsistent"`), "the T&D quantity check is shown");
    assert.ok(!/>\s*(Treat as new|Carry the parent only)/i.test(pairs), "no C, no B");
    const carried = render(viewOf(ROWS, [{ ...decision("6", "withdraw", ROWS[5]!), kind: "carry", carryOption: "A", forPairGroup: "v7-row-7", forStatus: "linked-pair-changed" }]));
    assert.ok(carried.includes(`data-carry="carried"`) && !carried.includes(VERDICT_LINE["blocked-on-pairs"]), "carried, the job is no longer blocked on it");
  });

  it("recomputes the verdict as decisions land: mapping, then confirmation, then ready to ingest", () => {
    const noPair = ROWS.filter((row) => row.status !== "linked-pair-changed");
    const step = (decisions: V7ImportDecision[]) => viewOf(noPair, decisions).resolvedVerdict;
    const [needs, fresh, gone] = [noPair[2]!, noPair[3]!, noPair[4]!];
    assert.equal(step([]), "needs-mapping");
    assert.equal(step([decision("3", "map", needs)]), "needs-mapping");
    assert.equal(step([decision("3", "map", needs), decision("4", "map", fresh)]), "needs-confirmation");
    const all = [decision("3", "map", needs), decision("4", "map", fresh), decision("5", "withdraw", gone)];
    assert.equal(step(all), "ready-to-ingest");
    const ready = render(viewOf(noPair, all));
    assert.ok(ready.includes(VERDICT_LINE["ready-to-ingest"]) && ready.includes(`data-verdict="ready-to-ingest"`));
    assert.ok(rowHtml(ready, "3").includes(">Mapped<") && rowHtml(ready, "3").includes("f-3") && rowHtml(ready, "3").includes(">Change<"));
    assert.ok(rowHtml(ready, "5").includes(">Confirmed off<") && rowHtml(ready, "5").includes(">Clear<"));
    // A mapping that no longer validates does not resolve its row.
    const invalid = new Map([[all[0]!.decisionId, "'f-3' is not one of Waste in Operations's factors."]]);
    const lapsed = viewOf(noPair, all, invalid);
    assert.equal(lapsed.resolvedVerdict, "needs-mapping");
    assert.ok(rowHtml(render(lapsed), "3").includes("no longer stands"));
    // All rows matching is clean: nothing to ingest.
    assert.equal(viewOf([ROWS[0]!], []).resolvedVerdict, "clean");
  });

  it("offers no ingest, anywhere", () => {
    const list: V7ImportWorkbenchSession[] = [{ ...SESSION, resolvedVerdict: "ready-to-ingest", resolved: 3, toResolve: 3 }];
    for (const markup of [html, render(viewOf(ROWS.slice(0, 5), [])), renderToStaticMarkup(createElement(ImportSessionsList, { sessions: list, selected: "job-1" }))]) {
      assert.ok(![...markup.matchAll(/<button[^>]*>([^<]*)</g)].some(([, label]) => /ingest/i.test(label!)), "no ingest button");
      assert.ok(!/<form\b/.test(markup), "no form posts");
    }
    const listHtml = renderToStaticMarkup(createElement(ImportSessionsList, { sessions: list, selected: "job-1" }));
    assert.ok(listHtml.includes(">Ready to ingest<") && listHtml.includes("3 / 3") && !/<(button|input|select)\b/.test(listHtml));
  });

  it("is gated on import.manage, in the rail, on the page and on every route", () => {
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "import")?.capability, "import.manage");
    const page = readFileSync(new URL("../app/admin/import/page.tsx", import.meta.url), "utf8");
    assert.ok(page.includes(`holds(access.capabilities, "import.manage")`));
    const route = (path: string) => readFileSync(new URL(`../app/api/isolated/import/${path}`, import.meta.url), "utf8");
    assert.ok(route("decisions/route.ts").includes(`requireCommandPrincipal(request, "import.decision.set")`));
    assert.ok(route("decisions/clear/route.ts").includes(`requireCommandPrincipal(request, "import.decision.clear")`));
    assert.ok(route("factors/route.ts").includes(`requireCapability(principal, "import.manage")`));
  });

  it("never says the internal name on the screen", () => {
    for (const markup of [html, render(viewOf(ROWS.slice(0, 5), [decision("3", "map", ROWS[2]!)]))])
      assert.ok(!/(?<![\w.-])v7(?![\w-])/i.test(markup.replace(/v7-(row|import|decision)-[\w-]+/g, "")));
  });
});

describe("the ingest panel (import workbench, Phase 3): the rehearsal and the ingested state, read-only — no ingest button", () => {
  let ImportIngestPanel: typeof import("../app/admin/import/ImportIngestPanel").ImportIngestPanel;
  before(async () => ({ ImportIngestPanel } = await import("../app/admin/import/ImportIngestPanel")));
  const totals = { "1": { v7Tco2e: 0.34, liveTco2e: 0.34 }, "2": { v7Tco2e: 0, liveTco2e: 0 }, "3": { v7Tco2e: 0.0015, liveTco2e: 0.0015 } };
  const entry = { ingestId: "v7-ingest-00000000-0000-0000-0000-000000000001", sessionId: SESSION.sessionId, decisionsSha256: "a".repeat(64),
    resync: { unchanged: 1, superseded: 1, added: 1, withdrawn: 1 }, plan: { committed: 2, decided: 1 }, resyncRunId: null, reingestRunId: null,
    createdAt: "2026-11-12T11:00:00.000Z", createdBy: "policy:v7-import" };
  const panel = (state: Parameters<typeof ImportIngestPanel>[0]["state"], verdict: Parameters<typeof ImportIngestPanel>[0]["verdict"] = "ready-to-ingest") =>
    renderToStaticMarkup(createElement(ImportIngestPanel, { state, verdict }));
  const noControls = (markup: string) => assert.ok(!/<(form|button|input|select|textarea)\b/.test(markup), "read-only");

  it("shows a rehearsal that would commit with its Σ per scope, and says when it is out of date", () => {
    const html = panel({ rehearsal: { ...entry, kind: "rehearsal", outcome: "would-commit", refusedStage: null, refusalCodes: [], scopeTotals: totals, current: true }, ingest: null });
    assert.ok(html.includes("Would commit — D7 met") && html.includes(`data-table="rehearsal-totals"`) && html.includes("1 superseded") && html.includes("2 committed + 1 decided"));
    assert.ok(!html.includes(`data-rehearsal-current="false"`));
    noControls(html);
    const stale = panel({ rehearsal: { ...entry, kind: "rehearsal", outcome: "would-commit", refusedStage: null, refusalCodes: [], scopeTotals: totals, current: false }, ingest: null });
    assert.ok(stale.includes(`data-rehearsal-current="false"`) && stale.includes("rehearse again"));
  });

  it("shows a refused rehearsal by its step and codes, with no totals", () => {
    const html = panel({ rehearsal: { ...entry, kind: "rehearsal", outcome: "refused", refusedStage: "reingest", refusalCodes: ["PLAN_QUANTITY_MISMATCH"], scopeTotals: null, current: true }, ingest: null });
    assert.ok(html.includes("Refused at the re-ingest (D7)") && html.includes("PLAN_QUANTITY_MISMATCH") && !html.includes(`data-table="rehearsal-totals"`));
    noControls(html);
  });

  it("shows the ingested state: the run, its reconciliation, and how much a reviewer has attested", () => {
    const html = panel({ rehearsal: null, ingest: { ...entry, kind: "ingest", outcome: "committed", refusedStage: null, refusalCodes: [], scopeTotals: totals,
      resyncRunId: "v7-resync-00000000-0000-0000-0000-000000000002", reingestRunId: "v7-reingest-00000000-0000-0000-0000-000000000003", runStatus: "completed", rowsApproved: 0, rowsPending: 3 } });
    assert.ok(html.includes(">Ingested<") && html.includes("attested 0 of 3") && html.includes("a reviewer attests") && html.includes(`data-table="ingest-totals"`));
    noControls(html);
  });

  it("when ready, says the operator runs the ingest — and offers no button for it", () => {
    const html = panel({ rehearsal: null, ingest: null });
    assert.ok(html.includes(`data-ingest="ready"`) && html.includes("import-ingest script"));
    noControls(html);
    assert.ok(!/(?<![\w.-])v7(?![\w-])/i.test(html.replace(/v7-[a-z]+-[\w-]+/g, "")), "never the internal name");
  });
});