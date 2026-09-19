import assert from "node:assert/strict";
import { test } from "node:test";
import { factorAliasKey, resolveReportLabel, rowLabelWasChosen } from "../src/reportLabelResolution";

/**
 * The precedence, asserted as correct (NZC-109). Narrowest decision wins: a name chosen on the row,
 * then the client's name for the factor, then the source label.
 */

const FACTOR = "Diesel (average biofuel blend) — HGV rigid";

test("a name chosen on the row wins, because it was said about this row", () => {
  const resolved = resolveReportLabel({
    rowReportLabel: "Depot deliveries", sourceLabel: FACTOR, alias: "Fleet fuel", factorSource: "dataset",
  });
  assert.deepEqual(resolved, { label: "Depot deliveries", from: "row" });
});

test("the client's name for the factor wins over the source label", () => {
  const resolved = resolveReportLabel({
    rowReportLabel: FACTOR, sourceLabel: FACTOR, alias: "Fleet fuel", factorSource: "dataset",
  });
  assert.deepEqual(resolved, { label: "Fleet fuel", from: "alias" });
});

test("with neither, the source label is what prints", () => {
  const resolved = resolveReportLabel({ rowReportLabel: FACTOR, sourceLabel: FACTOR, factorSource: "dataset" });
  assert.deepEqual(resolved, { label: FACTOR, from: "source" });
});

test("a row is only 'chosen' when its label differs from the source label", () => {
  // The signal, stated on its own because two other places depend on it meaning this.
  assert.equal(rowLabelWasChosen("Fleet fuel", FACTOR), true);
  assert.equal(rowLabelWasChosen(FACTOR, FACTOR), false);
  assert.equal(rowLabelWasChosen(null, FACTOR), false);
  assert.equal(rowLabelWasChosen("", FACTOR), false);
  // Whitespace is not a decision.
  assert.equal(rowLabelWasChosen("  Fleet fuel  ", "Fleet fuel"), false);
});

test("a client's own factor names itself, and no alias applies to it", () => {
  // A client factor (0034) already belongs to one client. Its label is the client's name for it.
  const resolved = resolveReportLabel({
    rowReportLabel: "Bespoke blend", sourceLabel: "Bespoke blend",
    factorSource: "client", clientFactorLabel: "Bespoke blend", alias: "should not be consulted",
  });
  assert.deepEqual(resolved, { label: "Bespoke blend", from: "clientFactor" });
});

test("a row-level name still wins on a client's own factor", () => {
  const resolved = resolveReportLabel({
    rowReportLabel: "This site only", sourceLabel: "Bespoke blend",
    factorSource: "client", clientFactorLabel: "Bespoke blend",
  });
  assert.deepEqual(resolved, { label: "This site only", from: "row" });
});

test("a blank alias is not a name, and does not displace anything", () => {
  assert.deepEqual(
    resolveReportLabel({ rowReportLabel: FACTOR, sourceLabel: FACTOR, alias: "   ", factorSource: "dataset" }),
    { label: FACTOR, from: "source" });
  assert.deepEqual(
    resolveReportLabel({ rowReportLabel: FACTOR, sourceLabel: FACTOR, alias: null, factorSource: "dataset" }),
    { label: FACTOR, from: "source" });
});

test("a row with no label of its own still prints something", () => {
  // Rows predating 0030 can carry a null report label. A row always has something to print.
  assert.deepEqual(
    resolveReportLabel({ rowReportLabel: null, sourceLabel: FACTOR, factorSource: "dataset" }),
    { label: FACTOR, from: "source" });
  assert.deepEqual(
    resolveReportLabel({ rowReportLabel: null, sourceLabel: FACTOR, alias: "Fleet fuel", factorSource: "dataset" }),
    { label: "Fleet fuel", from: "alias" });
});

test("the resolution says where the name came from, so a drawer can explain it", () => {
  // Not decoration: a client asking "why does my report say this?" is answered by the source, and
  // the four answers are different decisions by different people.
  const froms = [
    resolveReportLabel({ rowReportLabel: "Chosen", sourceLabel: FACTOR }).from,
    resolveReportLabel({ rowReportLabel: FACTOR, sourceLabel: FACTOR, alias: "Fleet fuel" }).from,
    resolveReportLabel({ rowReportLabel: FACTOR, sourceLabel: FACTOR }).from,
    resolveReportLabel({ rowReportLabel: "Own", sourceLabel: "Own", factorSource: "client", clientFactorLabel: "Own" }).from,
  ];
  assert.deepEqual(froms, ["row", "alias", "source", "clientFactor"]);
});

test("the alias key names one factor in one dataset", () => {
  assert.equal(factorAliasKey("ds-1", "f-diesel"), "ds-1|f-diesel");
  // Two datasets can each carry a factor of the same id; they are different factors.
  assert.notEqual(factorAliasKey("ds-1", "f-diesel"), factorAliasKey("ds-2", "f-diesel"));
});
