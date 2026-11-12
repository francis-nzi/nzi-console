import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveV7ImportTotals, resolveV7Import, v7ImportDecisionClearIssues, v7ImportDecisionFits, v7ImportDecisionSetIssues, v7ImportOwnStatus, v7ImportSummaryIssues, V7_IMPORT_SUMMARY_FORMAT,
  type V7ImportDecision, type V7ImportDecisionSetInput, type V7ImportSummaryRow,
} from "../src/index";

/** The import workbench, Phase 2: the decision's shape, what it resolves, and the verdict the decisions give. */
const row = (legacyDbId: string, status: V7ImportSummaryRow["status"], over: Partial<V7ImportSummaryRow> = {}): V7ImportSummaryRow => ({
  sourceSystem: "nzi-pro-v7", legacyDbId, status, code: "7_1", scope: "1", consoleScope: null, v7Figure: 1, consoleFigure: null, v7Enabled: true, consoleEnabled: null,
  consoleRowId: null, pairRef: null, changedFields: [], pairGroup: null, pairQuantityConsistent: null, ...over });
const decision = (legacyDbId: string, kind: "map" | "withdraw", over: Partial<V7ImportDecision> = {}): V7ImportDecision => ({
  decisionId: `v7-decision-${legacyDbId.padStart(8, "0")}-0000-0000-0000-000000000000`, sourceSystem: "nzi-pro-v7", legacyDbId, kind,
  categoryCode: kind === "map" ? "1.natural-gas" : null, datasetId: kind === "map" ? "ds-1" : null, factorId: kind === "map" ? "f-gas" : null,
  carryOption: null, forPairGroup: null, forStatus: kind === "map" ? "new" : "withdrawn", forScope: "1", forCode: kind === "map" ? "7_1" : null,
  sessionId: "v7-import-00000000-0000-0000-0000-000000000000", reason: null, decidedBy: "staff-admin", decidedAt: "2026-11-12T10:00:00.000Z", ...over });
const set = (over: Partial<V7ImportDecisionSetInput> & Record<string, unknown> = {}) =>
  v7ImportDecisionSetIssues({ jobId: "job-1", sourceSystem: "nzi-pro-v7", legacyDbId: "4", kind: "map", categoryCode: "1.natural-gas", datasetId: "ds-1", factorId: "f-gas", ...over } as V7ImportDecisionSetInput)
    .map((issue) => issue.code);

describe("import.decision.set / clear — the input's shape", () => {
  it("accepts a mapping and a withdrawal", () => {
    assert.deepEqual(set(), []);
    assert.deepEqual(set({ kind: "withdraw", categoryCode: undefined, datasetId: undefined, factorId: undefined }), []);
  });
  it("refuses a mapping without its category or factor, a withdrawal that names one, and an unknown kind", () => {
    assert.deepEqual(set({ categoryCode: null }), ["REQUIRED"]);
    assert.deepEqual(set({ factorId: undefined }), ["REQUIRED"]);
    assert.deepEqual(set({ kind: "withdraw" }), ["NO_PAYLOAD"]);
    assert.deepEqual(set({ kind: "hold" as never }), ["INVALID"], "hold records nothing: it is not a kind");
  });
  it("is closed: an unknown key is refused by name, never by value; ids are shapes, never free text", () => {
    const issues = v7ImportDecisionSetIssues({ jobId: "job-1", sourceSystem: "nzi-pro-v7", legacyDbId: "4", kind: "withdraw", note: "Acme Ltd, 1 High St" } as never);
    assert.deepEqual(issues.map((issue) => issue.code), ["UNKNOWN_FIELD"]);
    assert.ok(!JSON.stringify(issues).includes("Acme"));
    assert.deepEqual(set({ factorId: "Natural gas (gross)" }), ["REQUIRED"], "a label is not a factor id");
    assert.deepEqual(set({ legacyDbId: "row 4" }), ["INVALID"]);
    assert.deepEqual(set({ sourceSystem: "elsewhere" as never }), ["INVALID"]);
    assert.deepEqual(set({ expectedDecisionId: "latest" }), ["INVALID"]);
  });
  it("a clear names the decision it clears", () => {
    const clear = (expectedDecisionId: unknown) => v7ImportDecisionClearIssues({ jobId: "job-1", sourceSystem: "nzi-pro-v7", legacyDbId: "4", expectedDecisionId } as never).map((issue) => issue.code);
    assert.deepEqual(clear("v7-decision-00000004-0000-0000-0000-000000000000"), []);
    assert.deepEqual(clear(undefined), ["REQUIRED"]);
  });
});

describe("what a decision resolves, and the verdict", () => {
  it("a decision fits while the row stands as decided — its status, scope and code", () => {
    assert.ok(v7ImportDecisionFits(decision("4", "map"), row("4", "new")));
    assert.ok(v7ImportDecisionFits(decision("4", "map"), row("4", "needs-mapping")), "a map resolves a needs-mapping row too");
    assert.ok(!v7ImportDecisionFits(decision("4", "map"), row("4", "new", { code: "7_2" })), "the code moved");
    assert.ok(!v7ImportDecisionFits(decision("4", "map"), row("4", "new", { scope: "3" })), "the scope moved");
    assert.ok(!v7ImportDecisionFits(decision("4", "map"), row("4", "withdrawn", { code: null })), "a map never confirms a withdrawal");
  });

  it("ranks the verdict: pairs, then mappings, then confirmations, then ready — and all-matched is clean", () => {
    const rows = [row("1", "matched"), row("2", "changed"), row("4", "new"), row("5", "withdrawn", { code: null, v7Figure: null, v7Enabled: null })];
    const verdict = (list: V7ImportSummaryRow[], decisions: V7ImportDecision[], invalid?: Map<string, string>) => resolveV7Import(list, decisions, invalid).verdict;
    assert.equal(verdict([...rows, row("6", "linked-pair-changed", { pairRef: "v7-row-7" })], [decision("4", "map"), decision("5", "withdraw")]), "blocked-on-pairs");
    assert.equal(verdict(rows, []), "needs-mapping");
    assert.equal(verdict(rows, [decision("4", "map")]), "needs-confirmation");
    assert.equal(verdict(rows, [decision("4", "map"), decision("5", "withdraw")]), "ready-to-ingest");
    assert.equal(verdict(rows, [decision("4", "map"), decision("5", "withdraw")], new Map([[decision("4", "map").decisionId, "retired"]])), "needs-mapping", "an invalid mapping resolves nothing");
    assert.equal(verdict([row("1", "matched")], []), "clean");
    assert.equal(verdict([row("1", "matched"), row("2", "changed")], []), "ready-to-ingest", "a changed row is accepted automatically");
  });

  it("names each row's resolution; a decision for a row that has moved is stale, and one for another job's identity is ignored", () => {
    const resolved = resolveV7Import([row("1", "matched"), row("2", "changed"), row("4", "new", { code: "7_9" }), row("5", "withdrawn", { code: null, v7Figure: null, v7Enabled: null }), row("6", "linked-pair-changed", { pairRef: "v7-row-7" })],
      [decision("4", "map"), decision("99", "withdraw")]);
    assert.deepEqual(resolved.rows.map((entry) => [entry.legacyDbId, entry.resolution]),
      [["1", "matched"], ["2", "auto-accepted"], ["4", "stale"], ["5", "unresolved"], ["6", "unresolved"]]);
    assert.equal(resolved.rows[4]!.carry, "needs-fresh-summary", "a pair without a group (a /1 summary) cannot be carried");
  });
});

describe("the linked-pair carry (RULING-v7-import-pair-carry: A only)", () => {
  const GROUP = "v7-row-7";
  // A T&D group: parent 6 moved (needs-mapping), parent 8 new, the T&D row 7 unchanged.
  const pair = (legacyDbId: string, over: Partial<V7ImportSummaryRow>) => row(legacyDbId, "linked-pair-changed", { pairRef: GROUP, pairGroup: GROUP, pairQuantityConsistent: true, ...over });
  const ROWS = [
    row("1", "matched", { consoleRowId: "v7-row-1", consoleScope: "1", consoleFigure: 1, consoleEnabled: true }),
    pair("6", { consoleRowId: "v7-row-6", consoleScope: "2", consoleFigure: 1, consoleEnabled: true, scope: "2", changedFields: ["migrated_record", "migrated_record.original_id"] }),
    pair("8", { scope: "2" }),
    row("7", "matched", { scope: "3", consoleRowId: "v7-row-7", consoleScope: "3", consoleFigure: 1, consoleEnabled: true, pairRef: "v7-row-6", pairGroup: GROUP, pairQuantityConsistent: true }),
  ];
  const carry = (legacyDbId: string, over: Partial<V7ImportDecision> = {}) => decision(legacyDbId, "map", { kind: "carry", categoryCode: null, datasetId: null, factorId: null, carryOption: "A", forPairGroup: GROUP, ...over });
  const mapped = (legacyDbId: string) => decision(legacyDbId, "map", { forScope: "2", categoryCode: "2.purchased-electricity", forStatus: legacyDbId === "6" ? "needs-mapping" : "new" });

  it("a member resolves under its own status — the one it has outside the pair", () => {
    assert.deepEqual(ROWS.map(v7ImportOwnStatus), ["matched", "needs-mapping", "new", "matched"]);
    assert.equal(v7ImportOwnStatus(pair("9", { consoleRowId: "v7-row-9", consoleScope: "2", consoleFigure: 1, consoleEnabled: true, v7Figure: null, v7Enabled: null, code: null })), "withdrawn");
    assert.equal(v7ImportOwnStatus(pair("9", { consoleRowId: "v7-row-9", consoleScope: "2", consoleFigure: 1, consoleEnabled: true, changedFields: ["migrated_record", "quantity"] })), "changed");
  });

  it("the group carries once every member has the group's carry — the unchanged T&D row included; until then, blocked on pairs", () => {
    const verdict = (decisions: V7ImportDecision[]) => resolveV7Import(ROWS, decisions);
    assert.equal(verdict([mapped("6"), mapped("8")]).verdict, "blocked-on-pairs");
    assert.equal(verdict([mapped("6"), mapped("8"), carry("6"), carry("8")]).verdict, "blocked-on-pairs", "the T&D row lacks it");
    const all = verdict([mapped("6"), mapped("8"), carry("6"), carry("8"), carry("7")]);
    assert.deepEqual([all.verdict, all.groups], ["ready-to-ingest", [{ pairGroup: GROUP, members: ["6", "8", "7"], quantityConsistent: true, moved: true, carried: true }]]);
    // Carried but a member still to map: the pair is done, the mapping is not.
    assert.equal(verdict([mapped("6"), carry("6"), carry("8"), carry("7")]).verdict, "needs-mapping");
    // A carry made for another group does not carry this one.
    assert.equal(verdict([mapped("6"), mapped("8"), carry("6"), carry("8"), carry("7", { forPairGroup: "v7-row-99" })]).verdict, "blocked-on-pairs");
    assert.deepEqual(verdict([]).rows.map((entry) => [entry.legacyDbId, entry.resolution, entry.carry]),
      [["1", "matched", null], ["6", "unresolved", "awaiting"], ["8", "unresolved", "awaiting"], ["7", "matched", "awaiting"]]);
  });

  it("a pair from a summary without groups (/1) waits on a fresh summary", () => {
    const old = resolveV7Import([row("6", "linked-pair-changed", { pairRef: GROUP, consoleRowId: "v7-row-6", consoleScope: "2", consoleFigure: 1, consoleEnabled: true, changedFields: ["migrated_record"] })], []);
    assert.deepEqual([old.rows[0]!.carry, old.verdict], ["needs-fresh-summary", "blocked-on-pairs"]);
  });

  it("the carry input: option A only, no category or factor", () => {
    assert.deepEqual(set({ kind: "carry", categoryCode: undefined, datasetId: undefined, factorId: undefined, carryOption: "A" }), []);
    assert.deepEqual(set({ kind: "carry", categoryCode: undefined, datasetId: undefined, factorId: undefined, carryOption: "C" as never }), ["INVALID"], "C is deferred");
    assert.deepEqual(set({ kind: "carry", carryOption: "A" }), ["NO_PAYLOAD"]);
    assert.deepEqual(set({ carryOption: "A" }), ["NO_PAYLOAD"], "a mapping names no carry option");
  });

  it("summary /2: a paired row names its group and the group's quantity check; members agree on it", () => {
    const summary = (rows: V7ImportSummaryRow[]) => ({ format: V7_IMPORT_SUMMARY_FORMAT, jobId: "job-1", legacyJobNumber: "J000901", extractSha256: "c".repeat(64),
      generatedAt: "2026-11-12T09:00:00.000Z", rows, ...deriveV7ImportTotals(rows) });
    assert.equal(V7_IMPORT_SUMMARY_FORMAT, "nzi.import-summary/2");
    assert.deepEqual(v7ImportSummaryIssues(summary(ROWS)), []);
    assert.deepEqual(v7ImportSummaryIssues(summary([ROWS[0]!, { ...ROWS[3]!, pairGroup: null }])).map((issue) => issue.code), ["INVALID_ROW"], "a partner without a group");
    assert.deepEqual(v7ImportSummaryIssues(summary([ROWS[1]!, { ...ROWS[3]!, pairQuantityConsistent: false }])).map((issue) => issue.code), ["PAIR_GROUP_DISAGREES"]);
    assert.deepEqual(v7ImportSummaryIssues({ ...summary(ROWS), format: "nzi.import-summary/1" }).map((issue) => issue.code), ["UNKNOWN_FORMAT"]);
  });
});