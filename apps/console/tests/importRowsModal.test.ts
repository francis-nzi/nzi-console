import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { v7MatchCandidate, type V7MatchFactor } from "@nzi/contracts";
import { v7ImportRowsAcceptIssues, type V7ImportCandidate, type V7ImportRows, type V7ImportRowsRow } from "@nzi/isolated-backend";
import { ADMIN_ITEMS } from "../app/admin/adminNav";
import {
  bringInBlockers, fileableCategories, filterRows, groupRows, judgeHit, mergeCandidates, pairGroups, pendingAccepts, rowsProgress, scopeLines, suggestedAccepts,
  suggestedSummary, verdictWords,
} from "../app/jobs/importRowsModel";

/**
 * The import rows modal (BRIEF-v7-import-rows-modal §C; the mockup in _handoff, on J000434): one modal from the job. Its read, the
 * matcher and the accept are proven against real Postgres in v7ReingestRevertReal, and the matcher's verdicts in contracts; this
 * proves what the modal makes of them — the groups, the progress across passes, the plain-words reconcile strip, the candidate table
 * with Use in its own column, the gate on bringing a job in — and that Import reconciliation and the in-page table are retired.
 */
(globalThis as { React?: unknown }).React = React;
let modal: typeof import("../app/jobs/ImportRowsModal");
before(async () => { modal = await import("../app/jobs/ImportRowsModal"); });
const read = (path: string) => readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");

const candidate = (label: string, over: Partial<V7MatchFactor> & { code?: string; quantity?: number; previous?: number; scope?: "1" | "2" | "3"; rowCategories?: string[] } = {}): V7ImportCandidate => {
  const { code = label, quantity = 12_400, previous = 2.953432, scope = "3", rowCategories = ["3.6"], ...factor } = over;
  const full: V7MatchFactor = { rate: 0.23818, scopes: [scope], categories: [scope === "3" ? "3.6" : "1.company-vehicles"], sameUnit: true, ...factor };
  return { datasetId: "uk-ghg-gb-2024", factorId: `uk-ghg-${code}`, code, label, unit: full.sameUnit ? "miles" : "km", rate: full.rate!, dataset: "DESNZ GB 2024",
    identity: false, exactCode: false, anchor: false, year: 2024, scopes: [...full.scopes], categories: [...full.categories],
    match: v7MatchCandidate({ scope, quantity, applyPct: 100, previousTco2e: previous, categories: rowCategories }, full, []), invalid: null };
};
const RIGHT = candidate("Business travel · Car · Petrol · Small · per mile", { code: "25_301_3069_9_2" });
const WRONG = candidate("Passenger vehicles · Small car · Petrol · per mile", { code: "4_301_3069_9_2", scopes: ["1"], categories: ["1.company-vehicles"] });
const KM = candidate("Business travel · Car · Petrol · Small · per km", { code: "25_301_3069_9_1", rate: 0.148, sameUnit: false });

const row = (over: Partial<V7ImportRowsRow>): V7ImportRowsRow => ({
  legacyDbId: "10353", status: "new", ownStatus: "new", scope: "1",
  previous: { label: "Delivery vehicles — HGV (all diesel)", siteName: "Head office", quantity: 20_563, unit: "miles", factorCode: "5_304_3140_9_1", factor: 1.40489,
    factorUnit: "kgCO2e", tco2e: 28.888, enabled: true },
  intended: { categoryCode: null, datasetId: null, factorId: null, withdraw: false }, source: "none", flag: "NEW", resolution: "unresolved", decision: null, invalid: null,
  lane: "pre-accepted", applyPct: 100, categories: ["1.company-vehicles"], v7Category: null, pairGroup: null, carry: null, candidates: [], pick: null, totalStillCounted: false, ...over,
});
const HGV = candidate("HGV all · average laden · diesel", { code: "5_304_3140_9_1", quantity: 20_563, previous: 28.888, scope: "1", rate: 1.40489, rowCategories: ["1.company-vehicles"] });
const ROWS: V7ImportRowsRow[] = [
  row({ candidates: [HGV], pick: HGV }),
  row({ legacyDbId: "10382", scope: "3", lane: "unmatched", previous: { ...row({}).previous, label: "Business travel — car (small, petrol)", quantity: 12_400, factorCode: "25_301_3053_9_1", tco2e: 2.953432 },
    categories: ["3.6"], candidates: [] }),
  row({ legacyDbId: "10358", lane: "suggested", previous: { ...row({}).previous, label: "Fuels — natural gas", quantity: 154_008, unit: "kWh (GCV)", factorCode: "1_100_1004_6_1", tco2e: 28.17 },
    candidates: [], pick: { ...HGV, label: "Natural gas · gross CV", code: "1_100_1004_6_1" } }),
  row({ legacyDbId: "10364", scope: "2", status: "linked-pair-changed", lane: "pre-accepted", pairGroup: "v7-row-10365", carry: "awaiting", previous: { ...row({}).previous, label: "UK electricity", tco2e: 4.5 } }),
  row({ legacyDbId: "10365", scope: "3", status: "linked-pair-changed", lane: "in-console", ownStatus: "changed", pairGroup: "v7-row-10365", carry: "awaiting", previous: { ...row({}).previous, label: "Transmission & distribution", tco2e: 0.7 } }),
  row({ legacyDbId: "772", status: "withdrawn", ownStatus: "withdrawn", lane: "retiring", flag: "WITHDRAWN", previous: { ...row({}).previous, label: "Imported Totals", factorCode: "wfm-import-scope-1", quantity: null, tco2e: null, enabled: null } }),
  row({ legacyDbId: "999", status: "matched", ownStatus: "matched", lane: "in-console", flag: null, resolution: "matched", previous: { ...row({}).previous, label: "Natural gas", tco2e: 12.1 } }),
];
const TOTALS = { "1": { consoleRows: 1, consoleTco2e: 1052.6, v7Rows: 3, v7Tco2e: 69.878 }, "2": { consoleRows: 1, consoleTco2e: 15.3, v7Rows: 1, v7Tco2e: 4.5 },
  "3": { consoleRows: 1, consoleTco2e: 195.7, v7Rows: 2, v7Tco2e: 3.653432 } };
const DATA: V7ImportRows = { jobId: "v7-job-424", legacyJobNumber: "J000434", verdict: "needs-mapping", scopeTotals: TOTALS, summaryCurrent: false, firstTimeMapping: true,
  rows: ROWS, familyless: [] };
const props = (over: Partial<Parameters<typeof import("../app/jobs/ImportRowsModal").ImportRowsView>[0]> = {}) => ({
  data: DATA, pass: 2, busy: false, canResolve: true, writeEnabled: true, commitGated: false, error: null, notice: null, filter: "", onFilter: () => undefined,
  collapseDone: true, onCollapse: () => undefined, openRow: null, onOpenRow: () => undefined, preview: null, notAutomatic: null, reason: "", onReason: () => undefined,
  onSave: () => undefined, onSaveAndClose: () => undefined, onBringIn: () => undefined, onCommit: () => undefined, search: async () => ({ hits: [], familyless: [] }), ...over,
});
// React separates adjacent text with `<!-- -->` in a static render; the text a person reads has none.
const html = (over: Parameters<typeof props>[0] = {}) => renderToStaticMarkup(createElement(modal.ImportRowsView, props(over))).replace(/<!-- -->/g, "");

describe("the rows, grouped as the mockup groups them", () => {
  it("need a match · suggested · linked pairs · matched & accepted · import totals retiring — a pair's members together, whatever their own lane", () => {
    assert.deepEqual(groupRows(ROWS).map((group) => [group.key, group.rows.map((entry) => entry.legacyDbId)]), [
      ["unmatched", ["10382"]], ["suggested", ["10358"]], ["pairs", ["10364", "10365"]], ["matched", ["10353", "999"]], ["retiring", ["772"]]]);
    assert.deepEqual(pairGroups(ROWS).map((group) => [group.pairGroup, group.rows.length]), [["v7-row-10365", 2]]);
  });
  it("progress: rows done of the rows the task is over (the retiring totals are not), each kind counted", () => {
    assert.deepEqual(rowsProgress(ROWS), { total: 6, done: 2, matched: 2, suggested: 1, confirmOff: 0, pairs: 1, unmatched: 1, retiring: 1, doubleCounted: 0, switchedOff: 0, switchedOffUnmatched: 0 });
  });
  it("Accept all matched writes the pre-accepted rows' mappings by row id — and, as they come in, the dropped totals retire; never an amber or red row", () => {
    assert.deepEqual(pendingAccepts(ROWS), [
      { kind: "map", legacyDbId: "10353", categoryCode: "1.company-vehicles", datasetId: "uk-ghg-gb-2024", factorId: "uk-ghg-5_304_3140_9_1", expectedDecisionId: null },
      { kind: "withdraw", legacyDbId: "772", expectedDecisionId: null }]);
    assert.deepEqual(pendingAccepts(ROWS.filter((entry) => entry.lane !== "pre-accepted")), [], "no activity coming in: the totals stay");
  });
  it("cannot be brought in while a row needs a person — said in words", () => {
    assert.deepEqual(bringInBlockers(ROWS), ["1 row still needs a match", "1 suggestion to confirm", "1 linked pair to carry"]);
    const counted = [row({}), row({ legacyDbId: "771", lane: "in-console", ownStatus: "matched", totalStillCounted: true, previous: { ...row({}).previous, factorCode: "wfm-import-scope-1" } })];
    assert.deepEqual(bringInBlockers(counted), ["1 scope total still counted beside its rows in the previous system — switch it off there first"]);
    assert.deepEqual(groupRows(counted).map((group) => group.key), ["double-counted", "matched"]);
    assert.deepEqual(bringInBlockers([row({})]), []);
  });
  it("the smart filter: any words, any order, across ids, label, site, unit and the pick", () => {
    assert.deepEqual(filterRows(ROWS, "diesel hgv").map((entry) => entry.legacyDbId), ["10353"]);
    assert.deepEqual(filterRows(ROWS, "scope 3 car").map((entry) => entry.legacyDbId), ["10382"]);
  });
});

describe("the reconcile strip — the scope totals, in plain words", () => {
  it("as worked out here: each counted row at the figure it would come in with; a scope with a row still to match is waiting, not agreeing", () => {
    // Scope 1: the HGV row and the suggested gas row at their picks' figures, and the matched row at the previous system's own.
    const lines = scopeLines(DATA, null);
    assert.deepEqual(lines.map((line) => [line.scope, line.agrees, line.waiting]), [["1", true, 0], ["2", null, 1], ["3", null, 1]]);
    assert.equal(lines[0]!.console, 69.877506);
  });
  it("once a preview runs, the preview's own totals decide", () => {
    const lines = scopeLines(DATA, { "1": { v7Tco2e: 69.158, liveTco2e: 69.16 }, "2": { v7Tco2e: 4.5, liveTco2e: 4.5 }, "3": { v7Tco2e: 3.653, liveTco2e: 3.9 } });
    assert.deepEqual(lines.map((line) => line.agrees), [true, true, false]);
  });
  it("renders with no mathematical symbol, never the internal name", () => {
    const markup = html();
    assert.ok(!/[Σε]/.test(markup), "plain 'scope total', never Σ or ε");
    assert.ok(markup.includes("Scope 1 total") && markup.includes("as worked out here"));
    assert.ok(!/(?<![\w.-])v7(?![\w-])/i.test(markup.replace(/v7-[\w-]+/g, "")), "never the internal name");
  });
  it("says the figures match only when every scope agrees", () => {
    const clean: V7ImportRows = { ...DATA, rows: [ROWS[0]!, ROWS[6]!], scopeTotals: { ...TOTALS, "1": { ...TOTALS["1"], v7Tco2e: 40.988 }, "2": { ...TOTALS["2"], v7Tco2e: 0 }, "3": { ...TOTALS["3"], v7Tco2e: 0 } } };
    const markup = html({ data: clean });
    assert.ok(markup.includes(`data-reconcile="agrees"`) && markup.includes("✓ Figures match the previous system to 1 decimal place"));
  });
});

describe("the modal's states", () => {
  it("the progress header: rows done of rows, the pass, a segmented bar and its legend", () => {
    const markup = html();
    assert.ok(markup.includes("2 of 6 rows done") && markup.includes(`data-pass="2"`) && markup.includes("Pass 2"));
    for (const piece of ["2 matched &amp; accepted", "1 suggested — confirm", "1 linked pair to carry", "1 need a match", "1 import total retiring"]) assert.ok(markup.includes(piece), piece);
    assert.ok(!markup.includes("Preview again"), "no bare Preview again");
  });
  it("the toolbar: the smart filter and Accept all N matched; the footer: Save & resume later and Accept & bring in, held while rows need a person", () => {
    const markup = html();
    assert.ok(markup.includes("Accept all 1 matched") && markup.includes("Filter rows"));
    assert.ok(markup.includes("Save &amp; resume later"));
    assert.match(markup, /<button type="button" class="nz-btn pri" data-bring-in="true" disabled=""[^>]*>Accept &amp; bring in — 5 ready<\/button>/);
    assert.ok(markup.includes("1 row still needs a match · 1 suggestion to confirm · 1 linked pair to carry"));
  });
  it("each group under its heading; a linked pair carried with one action", () => {
    const markup = html();
    for (const title of ["Need a match — 1", "Suggested — confirm — 1", "Linked pairs — carried together — 1", "Matched &amp; accepted — 2", "Import totals — retiring on accept — 1"]) assert.ok(markup.includes(title), title);
    assert.ok(markup.includes(`data-pair-group="v7-row-10365"`) && markup.includes(">Carry both<"));
    assert.ok(markup.includes(`data-row="10382" data-lane="unmatched"`) && markup.includes("— no console factor"));
    assert.ok(markup.includes(`data-row="772" data-lane="retiring"`) && markup.includes("Retires on accept"));
  });
  it("a red row opened: the cue, the smart search, and the candidate table — Console factor · This row → tCO₂e · Factor rate · Use, in its own column", () => {
    const open = { ...ROWS[1]!, candidates: mergeCandidates([], [RIGHT, WRONG, KM]) };
    const markup = html({ data: { ...DATA, rows: [open] }, openRow: "10382" });
    assert.ok(markup.includes("No match on the ID.") && markup.includes("2.953 tCO₂e") === false && markup.includes("3.0 tCO₂e"));
    assert.match(markup, /<div class="nz-irm-opthd"><span>Console factor<\/span><span>This row → tCO₂e<\/span><span>Factor rate<\/span><span>Use<\/span><\/div>/);
    const options = [...markup.matchAll(/data-candidate="([^"]+)" data-verdict="([^"]+)"/g)].map((match) => [match[1], match[2]]);
    assert.deepEqual(options, [["uk-ghg-gb-2024|uk-ghg-25_301_3069_9_2", "reproduces"], ["uk-ghg-gb-2024|uk-ghg-25_301_3069_9_1", "unit-mismatch"], ["uk-ghg-gb-2024|uk-ghg-4_301_3069_9_2", "figure-only"]]);
    assert.ok(markup.includes(`class="nz-irm-opt sel" data-candidate="uk-ghg-gb-2024|uk-ghg-25_301_3069_9_2"`), "the reproducing factor on the right basis is the highlighted one");
    assert.ok(markup.includes("✓ matches the previous system") && markup.includes("Scope 1 — wrong basis") && markup.includes("unit mismatch"));
    assert.equal([...markup.matchAll(/data-use="/g)].length, 3, "a Use button on every candidate");
    assert.match(markup, /data-use="uk-ghg-gb-2024\|uk-ghg-4_301_3069_9_2" disabled=""/, "the wrong-scope factor cannot be filed for the row");
  });
  it("for someone who may not accept: they review; nothing writes", () => {
    const markup = html({ canResolve: false });
    assert.ok(markup.includes("An Admin accepts the rows; you can review them here."));
    assert.match(markup, /data-accept-all="true" disabled=""/);
  });
  it("a deliberate preview that agrees: a reason, then Bring it in; one that does not agree is held, in words", () => {
    const preview = { mode: "preview" as const, jobId: "v7-job-424", legacyJobNumber: "J000434", outcome: "would-commit" as const, summarySha256: "a".repeat(64), decisionsSha256: "b".repeat(64),
      counts: { matched: 1, changed: 0, needsMapping: 0, new: 1, withdrawn: 0, linkedPairChanged: 0 }, verdict: "ready-to-ingest" as const, exceptions: [], refusal: null,
      chain: { resync: { unchanged: 1, superseded: 0, added: 1, withdrawn: 0 }, plan: { committed: 0, decided: 1 } },
      scopeTotals: { "1": { v7Tco2e: 40.988, liveTco2e: 40.988 }, "2": { v7Tco2e: 0, liveTco2e: 0 }, "3": { v7Tco2e: 0, liveTco2e: 0 } } };
    const ready = { ...DATA, rows: [ROWS[6]!] };
    const agrees = html({ data: ready, preview, notAutomatic: "Not automatic: manual edits." });
    assert.ok(agrees.includes(`data-commit="true"`) && agrees.includes("Reason for bringing it in") && agrees.includes("Not automatic: manual edits.") && agrees.includes("as the refresh would bring it in"));
    const off = html({ data: ready, preview: { ...preview, scopeTotals: { ...preview.scopeTotals, "1": { v7Tco2e: 40.988, liveTco2e: 41.2 } } } });
    assert.ok(!off.includes(`data-commit="true"`) && off.includes("A scope does not agree to one decimal place, so it cannot be brought in."));
  });
});

describe("the autopick fix (BRIEF-v7-import-rows-autopick-fix): switched-off rows, and Accept all suggested", () => {
  // 10372: switched off in the previous system, a duplicate of 10396 (87,803 mi, 24.0 t) — its own factor in hand.
  const OFF_PICK = { ...HGV, anchor: true, identity: true };
  const OFF = row({ legacyDbId: "10372", scope: "1", lane: "switched-off", previous: { ...row({}).previous, label: "Delivery vehicles — van (duplicate)", quantity: 87_803, tco2e: 24.0, enabled: false },
    candidates: [OFF_PICK], pick: OFF_PICK });
  const OFF_NONE = row({ legacyDbId: "10380", scope: "1", lane: "switched-off", previous: { ...row({}).previous, enabled: false }, candidates: [], pick: null });
  it("a switched-off row: its own group, after the matched; Accept all matched brings it in on its own factor; never counted in the scope total", () => {
    const rows = [...ROWS, OFF];
    assert.deepEqual(groupRows(rows).map((group) => group.key), ["unmatched", "suggested", "pairs", "matched", "switched-off", "retiring"]);
    assert.ok(pendingAccepts(rows).some((item) => item.kind === "map" && item.legacyDbId === "10372" && item.factorId === HGV.factorId));
    assert.equal(scopeLines({ ...DATA, rows }, null)[0]!.console, scopeLines(DATA, null)[0]!.console, "24.0 t switched off is not in Scope 1's total");
    assert.deepEqual([rowsProgress(rows).switchedOff, rowsProgress(rows).done], [1, 3], "one with its factor in hand is done");
  });
  it("a switched-off row with no factor of its own holds the job, in words, and opens to a search", () => {
    assert.ok(bringInBlockers([row({}), OFF_NONE]).includes("1 switched-off row needs its factor"));
    assert.deepEqual(pendingAccepts([row({ candidates: [HGV], pick: HGV }), OFF_NONE]).map((item) => item.legacyDbId), ["10353"]);
    const markup = html({ data: { ...DATA, rows: [OFF_NONE] } });
    assert.ok(markup.includes(`data-row="10380" data-lane="switched-off"`) && markup.includes(">Find a factor<"), "shown although collapsed: it needs a person");
  });
  it("the group renders collapsed, in plain words, and its rows say they are not counted", () => {
    const collapsed = html({ data: { ...DATA, rows: [row({ candidates: [HGV], pick: HGV }), OFF] } });
    assert.ok(collapsed.includes("Switched off in the previous system — 1") && collapsed.includes("come in switched off, as the previous system holds them — never counted"));
    assert.ok(!collapsed.includes(`data-row="10372"`) && collapsed.includes("+ 1 more switched-off rows"));
    assert.ok(collapsed.includes("1 switched off in the previous system"), "in the legend");
    const shown = html({ data: { ...DATA, rows: [OFF] }, collapseDone: false });
    assert.ok(shown.includes(`data-row="10372" data-lane="switched-off"`) && shown.includes("Switched off — not counted") && shown.includes("not counted")
      && shown.includes("own factor · comes in switched off"));
  });
  it("Accept all N suggested: each suggestion's pick, a pair carried with its members; asked first by scope, a pair counted once", () => {
    const S1 = row({ legacyDbId: "201", lane: "suggested", pick: HGV, candidates: [HGV] });
    const S3 = row({ legacyDbId: "202", scope: "3", lane: "suggested", pick: RIGHT, candidates: [RIGHT] });
    const NOCAT = row({ legacyDbId: "203", lane: "suggested", pick: { ...HGV, match: { ...HGV.match, categoryCode: null } } });
    const PA = row({ legacyDbId: "301", scope: "2", lane: "suggested", pick: HGV, pairGroup: "v7-row-302", carry: "awaiting", status: "linked-pair-changed" });
    const PB = row({ legacyDbId: "302", scope: "2", lane: "pre-accepted", pick: HGV, pairGroup: "v7-row-302", carry: "awaiting", status: "linked-pair-changed" });
    const rows = [S1, S3, NOCAT, PA, PB, row({ legacyDbId: "999", lane: "unmatched" })];
    assert.deepEqual(suggestedAccepts(rows).map((item) => [item.kind, item.legacyDbId]), [["map", "201"], ["map", "202"], ["map", "301"], ["carry", "301"]],
      "no single category: left for a person; nothing red; the pair carried as one");
    assert.deepEqual(suggestedSummary(rows), { total: 3, byScope: [{ scope: "1", count: 1 }, { scope: "2", count: 1 }, { scope: "3", count: 1 }], pairs: 1 });
    const markup = html({ data: { ...DATA, rows } });
    assert.match(markup, /<button type="button" class="nz-btn" data-accept-suggested="true" aria-expanded="false">Accept all 3 suggested<\/button>/);
    assert.ok(!markup.includes("data-confirm-suggested"), "nothing asked, nothing written, until it is pressed");
    const asked = renderToStaticMarkup(createElement(modal.SuggestedConfirm, { summary: suggestedSummary(rows), disabled: false, onAccept: () => undefined, onCancel: () => undefined })).replace(/<!-- -->/g, "");
    assert.ok(asked.includes("Accept 3 suggestions?") && asked.includes("Scope 1: 1 · Scope 2: 1 · Scope 3: 1") && asked.includes("a linked pair counts once (1 here)"));
    assert.ok(asked.includes(">Accept them<") && asked.includes(">Cancel<"));
    assert.match(html({ data: { ...DATA, rows: [row({})] } }), /data-accept-suggested="true" disabled=""/, "none to accept: held");
  });
  it("a zero-rate figure on the row's own basis says what it is", () => {
    assert.deepEqual(verdictWords({ tco2e: 0, delta: 0, verdict: "figure-only", rightBasis: true, categoryCode: "3.7" }, "3", ["3"]), { text: "a zero rate — any zero gives this figure", tone: "off" });
  });
});

describe("the resolve control's search, judged as the ID candidates are", () => {
  it("a hit is recomputed for the row and ranked with the row's own candidates, each factor once", () => {
    const target = ROWS[1]!;
    const hit = judgeHit(target, { datasetId: "uk-ghg-gb-2024", factorId: "uk-ghg-25_301_3069_9_2", code: "25_301_3069_9_2", label: RIGHT.label, unit: "miles", rate: 0.23818,
      dataset: "DESNZ GB 2024", scopes: ["3"], categories: ["3.6"], sameUnit: true }, []);
    assert.equal(hit.match.verdict, "reproduces");
    assert.deepEqual(mergeCandidates([KM], [hit, { ...KM }]).map((entry) => entry.code), ["25_301_3069_9_2", "25_301_3069_9_1"]);
    assert.deepEqual(verdictWords(WRONG.match, "3", WRONG.scopes), { text: "Scope 1 — wrong basis", tone: "off" });
    assert.deepEqual(fileableCategories({ scope: "3" }, { categories: ["3.6", "1.company-vehicles"] }, ["3.5"]).map((entry) => entry.code), ["3.5", "3.6"]);
  });
});

describe("the accept's shape — closed, as a decision is", () => {
  it("ids, codes and kinds only; at least one item", () => {
    assert.deepEqual(v7ImportRowsAcceptIssues({ jobId: "j", items: [{ kind: "map", legacyDbId: "1", categoryCode: "1.natural-gas", datasetId: "d", factorId: "f", expectedDecisionId: null }] }), []);
    assert.equal(v7ImportRowsAcceptIssues({ jobId: "j", items: [] })[0]!.code, "REQUIRED");
    assert.equal(v7ImportRowsAcceptIssues({ jobId: "j", items: [{ kind: "map", legacyDbId: "1", label: "Natural gas" }] })[0]!.code, "UNKNOWN_FIELD");
    assert.equal(v7ImportRowsAcceptIssues({ jobId: "j", items: [{ kind: "carry", legacyDbId: "1", categoryCode: "x" }] })[0]!.code, "UNKNOWN_FIELD");
    assert.equal(v7ImportRowsAcceptIssues({ jobId: "j", items: [{ kind: "overwrite", legacyDbId: "1" }] })[0]!.code, "INVALID");
    assert.equal(v7ImportRowsAcceptIssues({ jobId: "j", extra: 1, items: [] })[0]!.code, "UNKNOWN_FIELD");
  });
});

describe("the wiring", () => {
  it("one action on the job's panel opens the modal; ?import=rows opens it on arrival", () => {
    const panel = read("jobs/ImportRefreshPanel.tsx");
    assert.ok(panel.includes(">Import rows from the previous system</button>") && panel.includes("<ImportRowsModal state={state} open={open}"));
    assert.ok(panel.includes(`get("import") === "rows"`));
    assert.ok(!/ImportRefreshPreviewView|ImportMappingView|ImportResolution|Preview again/.test(panel), "the in-page table is retired");
  });
  it("the read and the search are import.refresh; the accept is the decision command's own principal, the job the path's", () => {
    assert.ok(read("api/isolated/jobs/[jobId]/import-refresh/rows/search/route.ts").includes(`requireCapability(principal, "import.refresh")`));
    const accept = read("api/isolated/jobs/[jobId]/import-refresh/rows/accept/route.ts");
    assert.ok(accept.includes(`requireCommandPrincipal(request, "import.decision.set")`) && accept.includes("acceptV7ImportRows(isolatedPool()") && accept.includes("JOB_MISMATCH"));
  });
  it("Import reconciliation is retired: off the admin rail, and its page sends a job to the job's modal", () => {
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "import"), undefined);
    const page = read("admin/import/page.tsx");
    assert.ok(page.includes("redirect(job ? `/jobs/${encodeURIComponent(job)}?import=rows` : \"/jobs\")"));
  });
  it("the modal is the shared centred dialog, in the design system's classes", () => {
    const source = read("jobs/ImportRowsModal.tsx");
    assert.ok(source.includes(`className="nz-import-modal"`) && source.includes(`className="nz-import-modal-card nz-irm"`));
  });
});
