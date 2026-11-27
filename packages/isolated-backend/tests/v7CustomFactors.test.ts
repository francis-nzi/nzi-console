import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseFactorForYear } from "../src/monthlyPricing";
import { isV7JobOnlyFactorId, scopeRowFigure, type ScopeRowInput } from "../src/v7EmissionsFormula";
// @ts-expect-error — plain .mjs, deliberately untyped: it must run with no toolchain on the extracting machine.
import { extractSql, parseTables, preflightColumns } from "../scripts/v7-extract-sql.mjs";

/** V7's client custom factors (cause 7; PLAN-v7-client-custom-factors): the year choice, the formula's flag, and the extract. */

describe("a client factor's year value, as V7's _choose_factor_for_year chooses it", () => {
  const values = new Map([[2019, 0.19], [2021, 0.21], [2024, 0.24]]);
  it("takes the year's own value when there is one", () => assert.deepEqual(chooseFactorForYear(values, 2021), { value: 0.21, year: 2021 }));
  it("else the closest earlier year's", () => assert.deepEqual(chooseFactorForYear(values, 2023), { value: 0.21, year: 2021 }));
  it("else the earliest year's", () => assert.deepEqual(chooseFactorForYear(values, 2015), { value: 0.19, year: 2019 }));
  it("with no year asked for, the latest", () => assert.deepEqual(chooseFactorForYear(values, null), { value: 0.24, year: 2024 }));
  it("none with no values", () => assert.equal(chooseFactorForYear(new Map(), 2024), null));
});

describe("the formula's custom-factor flag (D-1)", () => {
  const custom = (originalId: string): ScopeRowInput => ({ scope: "Scope 1", qty: "1200", uom: "kWh", factor: "0.5", ghgUnit: "kgCO2e", applyPct: null,
    months: Array(12).fill("100"), datasetId: null, factorDbId: null, originalId, notes: null, referenceFactor: null, referenceGhgUnit: null });
  it("reads a V7 job-only id as V7 mints it", () => {
    assert.equal(isV7JobOnlyFactorId("JCF-669-115"), true);
    assert.equal(isV7JobOnlyFactorId(" JCF-1-2 "), true);
    for (const id of ["CF-GAS", "JCF-669", "jcf-1-2x", "", null]) assert.equal(isV7JobOnlyFactorId(id), false, String(id));
  });
  it("a job-only row is replayable — V7 prices it at its stored factor, every month", () => {
    const figure = scopeRowFigure(custom("JCF-669-115"));
    assert.deepEqual(figure.notReplayable, []);
    assert.ok(Math.abs(figure.tco2e - 0.6) < 1e-12);
  });
  it("a custom_factors row is still flagged — V7 prices it from year values the formula does not read", () => {
    assert.deepEqual(scopeRowFigure(custom("CF-GAS")).notReplayable, ["custom-factor-monthly"]);
  });
});

describe("the extract carries V7's four custom-factor tables", () => {
  const tables = ["custom_factors", "custom_factor_year_values", "job_custom_factors", "job_custom_factor_year_values"];
  const sql: string = extractSql({ out: "C:/v7-extract-cf", tables: parseTables(tables) });
  const copy = (table: string) => sql.split("\n").find((line) => line.startsWith("\\copy") && line.includes(`/${table}.csv'`))!;
  it("an in-scope client's own custom factors and V7's global ones, as V7's resolver reads is_global", () =>
    assert.match(copy("custom_factors"), /FROM custom_factors t WHERE t\.client_db_id IN \(SELECT db_id FROM ac\) OR COALESCE\(t\.is_global, TRUE\)/));
  it("job-only factors by their client (0057), and each family's year values for exactly those factors", () => {
    assert.match(copy("job_custom_factors"), /FROM job_custom_factors t WHERE t\.client_db_id IN \(SELECT db_id FROM ac\)/);
    assert.match(copy("custom_factor_year_values"), /WHERE t\.factor_id IN \(SELECT factor_id FROM custom_factors WHERE client_db_id IN \(SELECT db_id FROM ac\) OR COALESCE\(is_global, TRUE\)\)/);
    assert.match(copy("job_custom_factor_year_values"), /WHERE t\.factor_id IN \(SELECT factor_id FROM job_custom_factors WHERE client_db_id IN \(SELECT db_id FROM ac\)\)/);
  });
  it("labels only as V7's report label: no description, no source", () => {
    for (const table of tables) assert.doesNotMatch(copy(table), /\bt\.(description|source)\b/);
  });
  it("preflights the columns the filters read, even when only the year values are copied", () => {
    const checked = new Set(preflightColumns(new Set(), ["custom_factor_year_values"]).map(([table, column]: [string, string]) => `${table}.${column}`));
    for (const pair of ["custom_factors.factor_id", "custom_factors.client_db_id", "custom_factors.is_global"]) assert.ok(checked.has(pair), pair);
  });
});
