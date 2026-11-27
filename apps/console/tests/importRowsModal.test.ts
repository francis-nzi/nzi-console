import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emissionCategoryTaxonomy, v7MatchCandidate, V7_IMPORT_TWO_DATASET_YEARS_UNREAD, type V7MatchFactor } from "@nzi/contracts";
import { v7ImportRowsAcceptIssues, type V7ImportCandidate, type V7ImportRows, type V7ImportRowsRow } from "@nzi/isolated-backend";
import { ADMIN_ITEMS } from "../app/admin/adminNav";
import {
  BRING_IN_REASON, bringInBlockers, bringInReason, broughtInLine, editionLabel, factorIdentity, manualDecisions, fileableCategories, filterRows, groupRows, judgeHit, mergeCandidates, pairGroups, partsLine, pendingAccepts, reasonOutcome, refusedOutcome, rowFigure, rowLabel, rowsNamed,
  rowsProgress, scopeLines, suggestedAccepts, suggestedSummary, verdictWords,
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
    match: v7MatchCandidate({ scope, quantity, applyPct: 100, previousTco2e: previous, categories: rowCategories }, full, []), unitRefusal: null, invalid: null, parts: null };
};
const RIGHT = candidate("Business travel · Car · Petrol · Small · per mile", { code: "25_301_3069_9_2" });
const WRONG = candidate("Passenger vehicles · Small car · Petrol · per mile", { code: "4_301_3069_9_2", scopes: ["1"], categories: ["1.company-vehicles"] });
const KM = candidate("Business travel · Car · Petrol · Small · per km", { code: "25_301_3069_9_1", rate: 0.148, sameUnit: false });

const row = (over: Partial<V7ImportRowsRow>): V7ImportRowsRow => ({
  legacyDbId: "10353", status: "new", ownStatus: "new", scope: "1",
  previous: { label: "Delivery vehicles — HGV (all diesel)", siteName: "Head office", quantity: 20_563, unit: "miles", factorCode: "5_304_3140_9_1", factor: 1.40489,
    factorUnit: "kgCO2e", tco2e: 28.888, enabled: true },
  intended: { categoryCode: null, datasetId: null, factorId: null, withdraw: false }, source: "none", flag: "NEW", resolution: "unresolved", decision: null, invalid: null,
  lane: "pre-accepted", applyPct: 100, categories: ["1.company-vehicles"], v7Category: null, codeCategory: null, pairGroup: null, carry: null, candidates: [], pick: null, totalStillCounted: false, held: null, previousSystem: null, ...over,
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
  rows: ROWS, familyless: [], periodRefusal: null, ownFigures: false };
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
    assert.ok(markup.includes(`data-reconcile="agrees"`) && markup.includes("✓ Scope totals match those worked out from the previous system’s factors, to 1 decimal place"));
  });
  it("the previous system's figure is said as what it is: worked out from its factor, never as its own figure", () => {
    const markup = html();
    assert.ok(markup.includes(`<span>Here</span> 28.9 <span>·</span> <span>Previous system</span> 28.9 ✓<div class="nz-irm-s">tCO₂e, worked out from the previous system’s factor</div>`),
      "a calendar-year job keeps its tick");
    assert.ok(markup.includes(`<span>Previous system</span> 12.1<div class="nz-irm-s">tCO₂e, worked out from the previous system’s factor</div>`));
    assert.ok(!markup.includes("tCO₂e, previous system"));
  });
});

describe("the two-dataset-year guard (J000265): refused at the top, before anything is tried, and nothing shown as agreeing", () => {
  const TWO_YEAR = V7_IMPORT_TWO_DATASET_YEARS_UNREAD;
  it("says so at the top in the reconcile strip's place, holds Accept & bring in, and shows no tick on any row", () => {
    const clean: V7ImportRows = { ...DATA, rows: [ROWS[0]!, ROWS[6]!], periodRefusal: TWO_YEAR,
      scopeTotals: { ...TOTALS, "1": { ...TOTALS["1"], v7Tco2e: 40.988 }, "2": { ...TOTALS["2"], v7Tco2e: 0 }, "3": { ...TOTALS["3"], v7Tco2e: 0 } } };
    const markup = html({ data: clean });
    assert.ok(markup.includes(`data-outcome="refused"`) && markup.includes(TWO_YEAR.replace(/'/g, "&#x27;")), "the refusal, at the top");
    assert.ok(!markup.includes("data-reconcile="), "no reconcile strip — so no scope said to agree");
    assert.ok(!markup.includes("✓"), "no tick anywhere");
    assert.ok(markup.includes(`<span>Previous system</span> 28.9<div class="nz-irm-s">tCO₂e, worked out from the previous system’s factor</div>`), "the row's figure, labelled, without its tick");
    assert.match(markup, /data-bring-in="true" disabled=""/);
  });
  it("an opened row's candidate table shows no tick either", () => {
    const open = { ...ROWS[1]!, candidates: mergeCandidates([], [RIGHT, WRONG, KM]) };
    const markup = html({ data: { ...DATA, rows: [open], periodRefusal: TWO_YEAR }, openRow: "10382" });
    assert.ok(markup.includes(`data-verdict="reproduces"`) && markup.includes("matches the previous system’s factor") && !markup.includes("✓"));
  });
});

describe("a spanning job with the previous system's own figures read (Datasets Part 2, increment 2): judged against them, in yearly parts", () => {
  // J000265's row 9278: UK electricity, Apr 2025 – Mar 2026, V7 at 0.177 for 2025 and 0.13096 for 2026 = 15.3.
  const parts = [
    { from: "2025-04", to: "2025-12", months: 9, year: 2025, datasetId: "uk-ghg-gb-2025", kg: 0.177, tco2e: 9.679068, previous: 9.679068, agrees: true, issue: null },
    { from: "2026-01", to: "2026-03", months: 3, year: 2026, datasetId: "uk-ghg-gb-2026", kg: 0.13096, tco2e: 5.627613, previous: 5.627613, agrees: true, issue: null },
  ] as NonNullable<V7ImportCandidate["parts"]>;
  const ELEC: V7ImportCandidate = { ...candidate("Electricity · UK", { code: "elec-uk", quantity: 97_656, previous: 15.306681, scope: "2", rate: 0.177, rowCategories: ["2.purchased-electricity"],
    categories: ["2.purchased-electricity"], priced: 15.306681 }), datasetId: "uk-ghg-gb-2025", factorId: "uk-ghg-elec-uk", parts };
  const SPANNING = row({ legacyDbId: "9278", scope: "2", candidates: [ELEC], pick: ELEC, categories: ["2.purchased-electricity"],
    previous: { ...row({}).previous, label: "UK electricity", quantity: 97_656, unit: "kWh", factorCode: "elec-uk", tco2e: 17.285112 },
    previousSystem: { tco2e: 15.306681, blended: true, customFactor: false, spans: [{ from: "2025-04", to: "2025-12", year: 2025, tco2e: 9.679068 }, { from: "2026-01", to: "2026-03", year: 2026, tco2e: 5.627613 }] } });
  const OWN: V7ImportRows = { ...DATA, jobId: "v7-job-256", legacyJobNumber: "J000265", rows: [SPANNING], periodRefusal: null, ownFigures: true };

  it("the row: the console's monthly-priced figure against the previous system's own, with its tick, and each yearly part ticked", () => {
    const markup = html({ data: OWN });
    assert.ok(markup.includes(`<span>Here</span> 15.3 <span>·</span> <span>Previous system</span> 15.3 ✓<div class="nz-irm-s">tCO₂e, the previous system’s figure</div>`), "its own figure, not the single-factor 17.3");
    assert.ok(markup.includes("Apr–Dec 2025 @ DESNZ GB 2025 ✓ · Jan–Mar 2026 @ DESNZ GB 2026 ✓"));
    assert.ok(!markup.includes("worked out from the previous system’s factor"), "never the single-factor recompute");
  });
  it("the strip: the scope totals are the previous system's own; nothing at the top holds the job back", () => {
    const markup = html({ data: OWN });
    assert.ok(!markup.includes(`data-outcome="refused"`));
    assert.deepEqual(scopeLines(OWN, null).map((line) => [line.scope, line.previous, line.agrees]), [["1", 0, true], ["2", 15.306681, true], ["3", 0, true]]);
    assert.ok(markup.includes("✓ Scope totals match the previous system’s own, to 1 decimal place"));
  });
  it("a part on an edition the job does not hold says what happens, no tick: one the library holds joins on accept; a year it holds none of is added first", () => {
    const held = { ...ELEC, parts: [parts[0]!, { ...parts[1]!, issue: "dataset-not-on-job" as const, agrees: true }] };
    const markup = html({ data: { ...OWN, rows: [{ ...SPANNING, pick: held, candidates: [held] }] } });
    assert.ok(markup.includes("Apr–Dec 2025 @ DESNZ GB 2025 ✓ · Jan–Mar 2026 @ DESNZ GB 2026 — added to the job when you accept"), "another year's edition, too (R1)");
    assert.ok(!markup.includes("not on the job"));
    const own = { ...ELEC, parts: [{ ...parts[0]!, issue: "dataset-not-on-job" as const }, parts[1]!] };
    assert.equal(partsLine(own), "Apr–Dec 2025 @ DESNZ GB 2025 — added to the job when you accept · Jan–Mar 2026 @ DESNZ GB 2026 ✓");
    const none = { ...ELEC, parts: [parts[0]!, { ...parts[1]!, datasetId: null, kg: null, tco2e: null, agrees: false, issue: "dataset-not-on-job" as const }] };
    assert.equal(partsLine(none), "Apr–Dec 2025 @ DESNZ GB 2025 ✓ · Jan–Mar 2026 @ DESNZ GB 2026 — add it to the job's datasets first", "named as the refusal names it");
  });
  it("a search hit on a row priced over two editions has no figure to compare: one rate cannot be its figure", () => {
    const hit = judgeHit(SPANNING, { datasetId: "uk-ghg-gb-2025", factorId: "uk-ghg-elec-uk", code: "elec-uk", label: "Electricity · UK", unit: "kWh", rate: 0.177, dataset: "DESNZ GB 2025",
      scopes: ["2"], categories: ["2.purchased-electricity"], sameUnit: true, unitRefusal: null }, []);
    assert.equal(hit.match.verdict, "no-figure");
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
    assert.ok(markup.includes("✓ matches the previous system’s factor") && markup.includes("Scope 1 — wrong basis") && markup.includes("unit mismatch"));
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
    assert.ok(agrees.includes(`data-commit="true"`) && agrees.includes("Reason for bringing it in"));
    assert.ok(agrees.includes(`data-outcome="reason"`) && agrees.includes("Not automatic — give a reason to bring it in") && agrees.includes("Not automatic: manual edits."),
      "amber, at the top, in the reconcile strip's place");
    assert.ok(!agrees.includes("data-reconcile="));
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
    const none = html({ data: { ...DATA, rows: [row({ lane: "accepted", resolution: "resolved", pick: HGV })] } });
    assert.ok(!none.includes("data-accept-suggested") && !none.includes("data-accept-all") && !/Accept all 0/.test(none), "a count of zero: no button at all");
  });
  it("a zero-rate figure on the row's own basis says what it is", () => {
    assert.deepEqual(verdictWords({ tco2e: 0, delta: 0, verdict: "figure-only", rightBasis: true, categoryCode: "3.7" }, "3", ["3"]), { text: "a zero rate — any zero gives this figure", tone: "off" });
  });
});

describe("bringing it in: the outcome at the top, and a row the unit rule refuses back to Need a match (J000434, 24 Nov)", () => {
  const REFUSAL = ["v7 row v7-row-10357: the plan's unit kWh (Gross CV) is not v7's kWh — its quantity cannot be carried faithfully.",
    "v7 row v7-row-10358: the plan's unit kWh (Gross CV) is not v7's kWh — its quantity cannot be carried faithfully."];
  it("a refusal: red, in the reconcile strip's place, each message and the rows it names", () => {
    assert.deepEqual(rowsNamed([...REFUSAL, "v7 row v7-row-1001-r1: …", "row 772 is gone"]), ["10357", "10358", "1001", "772"]);
    const markup = html({ refusal: refusedOutcome(REFUSAL) });
    assert.ok(markup.includes(`class="nz-irm-rec bad" role="alert" data-outcome="refused"`) && markup.includes("Not brought in — nothing was written"));
    assert.ok(markup.includes(`data-outcome-rows="10357,10358"`) && markup.includes("Rows: <b>10357, 10358</b>") && markup.includes("unit kWh (Gross CV) is not v7"));
    assert.ok(!markup.includes("data-reconcile="), "it takes the strip's place");
    assert.ok(!html().includes("data-outcome="), "nothing to say: the reconcile strip");
  });
  it("a preview that would not bring it in is the same red outcome", () => {
    const preview = { mode: "preview" as const, jobId: "v7-job-424", legacyJobNumber: "J000434", outcome: "refused" as const, summarySha256: "a".repeat(64), decisionsSha256: "b".repeat(64),
      counts: { matched: 0, changed: 0, needsMapping: 0, new: 1, withdrawn: 0, linkedPairChanged: 0 }, verdict: "ready-to-ingest" as const, exceptions: [],
      refusal: { stage: "reingest", issues: [{ field: "rows", code: "PLAN_QUANTITY_MISMATCH", message: REFUSAL[0]! }] }, chain: { resync: null, plan: null }, scopeTotals: null };
    const markup = html({ preview: preview as never });
    assert.ok(markup.includes(`data-outcome="refused"`) && markup.includes(`data-outcome-rows="10357"`));
    assert.deepEqual(reasonOutcome("Not automatic: manual edits.", [{ legacyDbId: "10353" }]).rows, ["10353"]);
  });
  it("a row bringing it in would refuse for its unit: Need a match, the reason on the row, the job held — never counted ready", () => {
    const why = "the previous system holds it in kWh (Net CV); the factor is priced per kWh, so bringing it in would be refused";
    const net = row({ legacyDbId: "10361", lane: "unmatched", held: why, candidates: [{ ...HGV, unitRefusal: why, invalid: why }] });
    const markup = html({ data: { ...DATA, rows: [row({ candidates: [HGV], pick: HGV }), net] } });
    assert.ok(markup.includes(`data-row="10361" data-lane="unmatched"`) && markup.includes(`data-held="true"`) && markup.includes(why));
    assert.ok(markup.includes("Need a match — 1") && markup.includes("Accept &amp; bring in — 1 ready"), "the refused row is not one of the ready");
    assert.deepEqual(bringInBlockers([row({}), net]), ["1 row still needs a match"]);
    const hit = judgeHit(net, { datasetId: "d", factorId: "f", code: "c", label: "Natural gas", unit: "kWh", rate: 0.2, dataset: "D", scopes: ["1"], categories: ["1.natural-gas"],
      sameUnit: false, unitRefusal: why }, []);
    assert.equal(hit.invalid, why, "a search hit bringing it in would refuse cannot be used either");
  });
});

describe("readability (Francis's walk-through of J000265)", () => {
  const css = readFileSync(new URL("../../../packages/ui/src/styles.css", import.meta.url), "utf8");
  it("the row label: the site's name, never the previous system's site id; no label → the category and the site", () => {
    const waste = row({ previous: { ...row({}).previous, label: "Waste disposal — site 374", siteName: "Registered Office" } });
    assert.deepEqual(rowLabel(waste), { text: "Waste disposal — Registered Office", siteInLabel: true });
    const markup = html({ data: { ...DATA, rows: [waste] } });
    assert.ok(markup.includes(">Waste disposal — Registered Office<") && !/site 374/.test(markup));
    assert.ok(markup.includes(`<div class="nz-irm-s">Scope 1</div>`), "the site is not said twice");
    const gas = emissionCategoryTaxonomy.find((entry) => entry.code === "1.company-vehicles")!.name;
    assert.deepEqual(rowLabel(row({ v7Category: "1.company-vehicles", previous: { ...row({}).previous, label: null, siteName: "Registered Office" } })).text, `${gas} — Registered Office`);
    assert.deepEqual(rowLabel(row({ previous: { ...row({}).previous, label: "Fuels — site 11", siteName: null } })).text, "Fuels", "no site name: the category alone, never the id");
    assert.deepEqual(rowLabel(row({})).text, "Delivery vehicles — HGV (all diesel)", "a kept label stays as it is");
  });
  it("column titles: one sticky header row — Previous system row · Quantity · Console factor · Status · Here vs previous system", () => {
    assert.match(html(), /<div class="nz-irm-colhd" data-row-header="true"><span>Previous system row<\/span><span>Quantity<\/span><span>Console factor<\/span><span>Status<\/span><span>Here vs previous system<\/span><\/div>/);
    assert.match(css, /\.nz-irm-colhd\{position:sticky;top:0/);
    assert.match(css, /\.nz-irm-rows\{overflow:auto;flex:1 1 auto;min-height:0\}/, "the rows are the scroller, so the header sticks");
  });
  it("column widths: label narrow, factor and status wide; the factor name two lines at most, in full on hover; no sideways scroll at 1280px", () => {
    const columns = /\.nz-irm-row,\.nz-irm-colhd\{display:grid;grid-template-columns:([^;]+);gap:(\d+)px\}/.exec(css);
    assert.ok(columns, "header and rows share one grid");
    assert.equal(columns[1], "minmax(0,1fr) 90px minmax(0,1.25fr) 168px 160px");
    // The card is 1040px at 1280px; fixed columns, gaps and padding leave the flexible ones room, and those shrink to nothing before overflowing.
    const fixed = [90, 168, 160].reduce((sum, width) => sum + width, 0) + 4 * Number(columns[2]) + 18 + 15 + 3;
    assert.ok(fixed < 1040 - 400, `${fixed}px fixed leaves the label and factor room at 1040px`);
    assert.match(css, /\.nz-irm-fac \.nz-irm-t\{display:-webkit-box;-webkit-line-clamp:2;/);
    const picked = html({ data: { ...DATA, rows: [row({ candidates: [HGV], pick: HGV })] } });
    assert.ok(picked.includes(`<div class="nz-irm-fac"><div class="nz-irm-t" title="HGV all · average laden · diesel">`));
  });
  it("figures: both labelled — Here · Previous system — and two decimal places under 1 t", () => {
    assert.deepEqual([rowFigure(0.009), rowFigure(0.1), rowFigure(0.99), rowFigure(28.888), rowFigure(null)], ["0.01", "0.10", "0.99", "28.9", "—"]);
    const small = candidate("Waste · landfill", { code: "w", quantity: 0.04, previous: 0.009, scope: "3", rate: 225, rowCategories: ["3.5"], categories: ["3.5"] });
    const markup = html({ data: { ...DATA, rows: [row({ scope: "3", categories: ["3.5"], candidates: [small], pick: small, previous: { ...row({}).previous, quantity: 0.04, tco2e: 0.009 } })] } });
    assert.ok(markup.includes("<span>Here</span> 0.01 <span>·</span> <span>Previous system</span> 0.01 ✓"), "0.009 is never 0.0");
  });
});

describe("Find a factor (J000265 source:1169): one row per factor, named by its edition, never the file it was loaded from", () => {
  // The hotel night in DESNZ 2022, 2025 and 2026, all at 10.4 — the job-year anchor (2025) stands for them; the 2026 edition is
  // the file "tmpai4mgnde.csv" in the library, which the modal never shows.
  const night = (year: number, over: Partial<V7ImportCandidate> = {}): V7ImportCandidate => ({ ...candidate("Hotel stay · UK", { code: "29_600_4000_13_1", quantity: 29, previous: 0.3016,
    scope: "3", rate: 10.4, rowCategories: ["3.6"], categories: ["3.6"] }), datasetId: `uk-ghg-gb-${year}`, factorId: "uk-ghg-29_600_4000_13_1", year,
    dataset: year === 2026 ? "tmpai4mgnde.csv" : "DESNZ DEFRA Conversion Factors 2019-2025.xlsx", unit: "nights", ...over });
  const ANCHOR = night(2025, { anchor: true, identity: true });
  const EDITIONS = [night(2022), night(2026), ANCHOR];
  const HOTEL_ROW = row({ legacyDbId: "source:1169", scope: "3", lane: "unmatched", categories: ["3.6"], candidates: EDITIONS, pick: null,
    previous: { ...row({}).previous, label: "Business Travel", quantity: 29, unit: "Room per night", factorCode: "29_600_4000_13_1", tco2e: 0.3016 } });

  it("one factor in three editions is one row — the job-year anchor standing for it; another series' copy is its own row", () => {
    assert.deepEqual(mergeCandidates(EDITIONS, []).map((entry) => entry.datasetId), ["uk-ghg-gb-2025"]);
    const nzi = { ...night(2025), datasetId: "nzi-gb-2025" };
    assert.deepEqual(mergeCandidates(EDITIONS, [nzi, night(2026)]).map((entry) => entry.datasetId), ["uk-ghg-gb-2025", "nzi-gb-2025"], "a search hit of the same factor in another edition: still one row");
    assert.equal(factorIdentity(night(2022)), factorIdentity(night(2026)));
    assert.notEqual(factorIdentity(night(2025)), factorIdentity(nzi));
  });
  it("the opened row: one candidate, named \"DESNZ GB 2025\", the count one — never a workbook or temp file's name", () => {
    const markup = html({ data: { ...DATA, rows: [HOTEL_ROW] }, openRow: "source:1169" });
    assert.equal([...markup.matchAll(/data-candidate="/g)].length, 1);
    assert.ok(markup.includes("29_600_4000_13_1 · DESNZ GB 2025<") && markup.includes("1 found by the row&#x27;s ID"));
    assert.ok(!/tmpai4mgnde|\.xlsx|\.csv/.test(markup), "no file name anywhere");
    assert.equal(editionLabel({ datasetId: "uk-ghg-gb-2026" }), "DESNZ GB 2026");
  });
});

describe("the resolve control's search, judged as the ID candidates are", () => {
  it("a hit is recomputed for the row and ranked with the row's own candidates, each factor once", () => {
    const target = ROWS[1]!;
    const hit = judgeHit(target, { datasetId: "uk-ghg-gb-2024", factorId: "uk-ghg-25_301_3069_9_2", code: "25_301_3069_9_2", label: RIGHT.label, unit: "miles", rate: 0.23818,
      dataset: "DESNZ GB 2024", scopes: ["3"], categories: ["3.6"], sameUnit: true, unitRefusal: null }, []);
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

describe("the bring-in reason (26 Nov): prefilled from the decisions, its own labelled box, recorded as written", () => {
  const decision = (entry: V7ImportRowsRow, categoryCode: string, factor: Pick<V7ImportCandidate, "datasetId" | "factorId">) => ({ decisionId: `d-${entry.legacyDbId}`,
    sourceSystem: "nzi-pro-v7", legacyDbId: entry.legacyDbId, kind: "map", categoryCode, datasetId: factor.datasetId, factorId: factor.factorId, carryOption: null, forPairGroup: null,
    forStatus: "new", forScope: entry.scope, forCode: null, sessionId: "s", reason: null, decidedBy: "staff-admin", decidedAt: "2026-11-26T10:00:00Z" }) as unknown as V7ImportRowsRow["decision"];
  const decided = (entry: V7ImportRowsRow, categoryCode: string, factor: V7ImportCandidate): V7ImportRowsRow =>
    ({ ...entry, lane: "accepted", resolution: "resolved", pick: factor, decision: decision(entry, categoryCode, factor) });
  // Came in on its own: the pick rule's factor, filed where the matcher files it.
  const AUTO = decided(row({ legacyDbId: "501", candidates: [HGV] }), HGV.match.categoryCode!, HGV);
  // The factor reproduces, but the matcher names no category: a person filed it — the category is theirs, the factor is not.
  const UNFILED = { ...RIGHT, match: { ...RIGHT.match, categoryCode: null } };
  const filed = (id: string, code: string) => decided(row({ legacyDbId: id, scope: "3", categories: [], candidates: [UNFILED] }), code, UNFILED);
  const CATEGORY = [..."abcdef"].map((letter) => filed(`60${letter}`, "3.5")).concat(filed("610", "3.9"));
  // No candidate reproduces it: a person found the factor ("Find a factor"), filed where the matcher files that factor.
  const HAND = { ...RIGHT, factorId: "uk-ghg-29_600_4000_13_1", match: { ...RIGHT.match, categoryCode: "3.6" } };
  const SOURCE = decided(row({ legacyDbId: "source:1169", scope: "3", candidates: [] }), "3.6", HAND);
  // Not decided at all: pre-accepted (it comes in on its own) and matched rows say nothing.
  const PENDING = row({ legacyDbId: "701", candidates: [HGV], pick: HGV });

  it("the prefill lists exactly the manual decisions: category on 7 rows (3.5 ×6, 3.9 ×1), factor on 1 row (source:1169)", () => {
    const rows = [AUTO, ...CATEGORY, SOURCE, PENDING, ROWS[6]!];
    assert.equal(bringInReason(rows), "Imported and reconciled from previous system · manual: category on 7 rows (3.5 ×6, 3.9 ×1), factor on 1 row (source:1169)");
    assert.deepEqual(manualDecisions(rows).factorRows, ["source:1169"], "the filed rows' factor came in on its own; the automatic row is not listed");
    assert.equal(bringInReason([AUTO, PENDING]), BRING_IN_REASON, "nothing manual: the first words alone");
    const many = Array.from({ length: 7 }, (_, at) => decided(row({ legacyDbId: `source:${at}`, scope: "3", candidates: [] }), "3.6", HAND));
    assert.match(bringInReason(many), /factor on 7 rows \(source:0, source:1, source:2, source:3, source:4 and 2 more\)$/);
  });
  it("the reason box: a visible label above, beside Bring it in, its own style — the row filter unchanged", () => {
    const preview = { mode: "preview" as const, jobId: "v7-job-424", legacyJobNumber: "J000434", outcome: "would-commit" as const, summarySha256: "a".repeat(64), decisionsSha256: "b".repeat(64),
      counts: { matched: 1, changed: 0, needsMapping: 0, new: 1, withdrawn: 0, linkedPairChanged: 0 }, verdict: "ready-to-ingest" as const, exceptions: [], refusal: null,
      chain: { resync: { unchanged: 1, superseded: 0, added: 1, withdrawn: 0 }, plan: { committed: 0, decided: 1 } },
      scopeTotals: { "1": { v7Tco2e: 40.988, liveTco2e: 40.988 }, "2": { v7Tco2e: 0, liveTco2e: 0 }, "3": { v7Tco2e: 0, liveTco2e: 0 } } };
    const at = (reason: string) => html({ data: { ...DATA, rows: [ROWS[6]!] }, preview, notAutomatic: "Not automatic: manual edits.", reason });
    const filled = at(`${BRING_IN_REASON} · manual: factor on 1 row (source:1169)`);
    assert.match(filled, /<div class="nz-irm-ft-r">.*<label class="nz-irm-reason" data-bring-in-reason="true"><span>Reason for bringing it in<\/span><textarea rows="2">Imported and reconciled from previous system · manual: factor on 1 row \(source:1169\)<\/textarea><\/label><button type="button" class="nz-btn pri" data-commit="true">Bring it in<\/button>/s,
      "the label above the box, the box beside the button, the button enabled");
    assert.ok(filled.includes(`placeholder="Filter rows — ID, label, site, unit… (e.g. “van diesel miles”)"`) && !/class="nz-inp"[^>]*Reason/.test(filled), "the filter keeps its placeholder; the reason is not a filter-style input");
    assert.match(readFileSync(new URL("../../../packages/ui/src/styles.css", import.meta.url), "utf8"), /\.nz-irm-reason textarea\{[^}]*border-left:3px solid var\(--pine\)/,
      "its own style, not the filter's .nz-inp");
    // An emptied box (or only spaces) holds Bring it in.
    for (const empty of ["", "   "]) assert.match(at(empty), /data-commit="true" disabled=""/, JSON.stringify(empty));
  });
  it("the modal prefills the box once, and never overwrites what the person wrote", () => {
    const source = read("jobs/ImportRowsModal.tsx");
    assert.ok(source.includes("setReason((current) => (current.trim() ? current : bringInReason(decided)))"));
    assert.ok(source.includes(`commitKey.current ??= crypto.randomUUID(), reason.trim())`), "sent as written (trimmed, as every reason is), through the encoded header");
  });
});

describe("after a bring-in (26 Nov): the modal closes, the whole job's page catches up, one line says so", () => {
  it("the line: \"Brought in 15 rows · reconciles with the previous system\" — from the commit's own counts", () => {
    assert.equal(broughtInLine({ plan: { committed: 3, decided: 12 } }), "Brought in 15 rows · reconciles with the previous system");
    assert.equal(broughtInLine({ plan: { committed: 0, decided: 1 } }), "Brought in 1 row · reconciles with the previous system");
    // Cause 8: a clean job whose derived rows alone came in.
    assert.equal(broughtInLine({ derivedOnly: true, derived: { added: 1, updated: 0, unchanged: 2, switchedOff: 1 } }),
      "Brought in the previous system's derived rows (1 added, 0 updated, 1 switched off) · reconciles with the previous system");
    const source = read("jobs/ImportRowsModal.tsx");
    assert.ok(source.includes(`onBroughtIn(broughtInLine(result.data.committed)); onClose(); return;`), "the automatic path closes the modal");
    assert.match(source, /onBroughtIn\(broughtInLine\(result\.data\)\);\s*onClose\(\);/, "the deliberate path closes it too");
  });
  it("the job's change is heard by this job's readers only — and unsubscribing stops it", async () => {
    const { announceJobDataChanged, onJobDataChanged } = await import("../app/jobs/jobDataChanged");
    const target = new EventTarget();
    const heard: string[] = [];
    const stop = onJobDataChanged("v7-job-256", () => heard.push("256"), target);
    onJobDataChanged("v7-job-424", () => heard.push("424"), target);
    announceJobDataChanged("v7-job-256", target);
    stop();
    announceJobDataChanged("v7-job-256", target);
    assert.deepEqual(heard, ["256"]);
  });
  it("on success the panel says the line, refreshes the server's parts and announces the change; each own-read part re-reads on it", () => {
    const panel = read("jobs/ImportRefreshPanel.tsx");
    assert.ok(panel.includes("const broughtIn = (line: string) => { setDone(line); router.refresh(); announceJobDataChanged(jobId); };"));
    assert.ok(panel.includes("useJobDataChanged(jobId, () => setReads((count) => count + 1));") && panel.includes("}, [jobId, reads]);"), "the panel's drift banner re-reads");
    assert.ok(panel.includes("if (reads === 0 && value.applies"), "?import=rows opens the modal on arrival only");
    const summary = read("jobs/EmissionsSummary.tsx");
    assert.ok(summary.includes("useJobDataChanged(jobId, () => setChanges((count) => count + 1));") && summary.includes("[jobId, siteId, emissionsUrl, changes]"), "the totals band re-reads, still narrowed to its site");
    assert.ok(read("jobs/CrpDataEntryAccordion.tsx").includes("useJobDataChanged(jobId, () => { void load(); });"), "the category list re-reads");
  });
});

describe("the category pre-select (26 Nov): a factor's categories narrowed to one are filed there; otherwise the row asks", () => {
  // Freight, claimed by 3.4 and 3.9: a suggestion whose categories do not narrow carries no category.
  const FREIGHT = candidate("Freight · HGV · diesel · average laden", { code: "9_402_3401_10_1", categories: ["3.4", "3.9"], rowCategories: ["3.4", "3.9"] });
  const UNFILED = row({ legacyDbId: "40003", scope: "3", lane: "suggested", categories: ["3.4", "3.9"], candidates: [FREIGHT], pick: FREIGHT });
  it("the code's suffix settles it where V7's category does not: -u → 3.4; V7's own category still first", () => {
    assert.equal(FREIGHT.match.categoryCode, null);
    const base = { scope: "3" as const, quantity: 12_400, applyPct: 100, previousTco2e: 2.953432, categories: ["3.4", "3.9"] };
    const factor = { rate: 0.23818, scopes: ["3"], categories: ["3.4", "3.9"], sameUnit: true };
    assert.equal(v7MatchCandidate({ ...base, codeCategory: "3.4" }, factor, []).categoryCode, "3.4");
    assert.equal(v7MatchCandidate({ ...base, v7Category: "3.9", codeCategory: "3.4" }, factor, []).categoryCode, "3.9", "V7's own category first");
    assert.equal(judgeHit({ ...UNFILED, codeCategory: "3.9" }, { datasetId: "uk-ghg-gb-2024", factorId: "uk-ghg-9_402_3401_10_1", code: "9_402_3401_10_1", label: "Freight", unit: "miles",
      rate: 0.23818, dataset: "DESNZ GB 2024", scopes: ["3"], categories: ["3.4", "3.9"], sameUnit: true, unitRefusal: null }, []).match.categoryCode, "3.9", "a search hit is judged with it too");
  });
  it("a suggestion with no single category shows \"Choose a category to confirm\" — never no button — and it opens the row's File under", () => {
    const opened: Array<string | null> = [];
    const markup = html({ data: { ...DATA, rows: [UNFILED] }, onOpenRow: (id: string | null) => { opened.push(id); } });
    const at = markup.indexOf(`data-row="40003"`);
    const rowMarkup = markup.slice(at, markup.indexOf(`data-figures="40003"`));
    assert.ok(rowMarkup.includes("data-choose-category") && rowMarkup.includes(">Choose a category to confirm<"), rowMarkup);
    assert.ok(!rowMarkup.includes(">Confirm<") && !rowMarkup.includes(">Change<"), "one button: the choice");
    const open = html({ data: { ...DATA, rows: [UNFILED] }, openRow: "40003" });
    assert.ok(open.includes("File under") && open.includes("Choose a Scope 3 category"), "opened, the row's own File under");
    assert.ok(open.slice(open.indexOf(`data-row="40003"`)).includes(">Close<"));
  });
  it("a suggestion filed in one category keeps its Confirm", () => {
    const filed = { ...FREIGHT, match: { ...FREIGHT.match, categoryCode: "3.4" } };
    const markup = html({ data: { ...DATA, rows: [{ ...UNFILED, candidates: [filed], pick: filed }] } });
    assert.ok(markup.includes(">Confirm<") && !markup.includes("data-choose-category"));
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
