import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandDefinitions, composeReportChartBasis, composeScopedComparison, importWritableCount, reconcileSpendImport, REPORTING_PRIOR_YEARS,
  reportingGrainYears, spendCarryKey, spendImportLineIdentity, summariseImportReview, type CommandContext,
} from "../src/index";

const line = (over: Partial<{ description: string; netValue: number | null; glCode: string | null; invoiceDate: string | null; skip: boolean }>) =>
  ({ description: "Office paper", netValue: 100, glCode: "6100", invoiceDate: "2026-02-01", ...over });

describe("Data entry D3 (R4) — a line's carry key is its GL code, else its description, as the D2 map keys it", () => {
  it("normalises the GL code; falls back to the description; null with neither", () => {
    assert.equal(spendCarryKey({ glCode: " 61 00 ", description: "anything" }), "gl:6100");
    assert.equal(spendCarryKey({ glCode: null, description: "Pensions admin — Q1 2025" }), "description:pensions admin q");
    assert.equal(spendCarryKey({ glCode: "", description: "1234" }), null);
  });
});

describe("Data entry D3 (R2) — an import reconciles by reading first", () => {
  it("a line the job holds is not imported again — counted, so twelve months of rent absorb twelve", () => {
    const rent = (month: string) => line({ description: "Rent", glCode: "7000", netValue: 1000, invoiceDate: `2026-${month}-01` });
    const held = new Map([[spendImportLineIdentity(rent("01")), 1], [spendImportLineIdentity(rent("02")), 1]]);
    const out = reconcileSpendImport([rent("01"), rent("02"), rent("03")], held, new Map());
    assert.deepEqual(out.map((entry) => entry?.kind), ["already-imported", "already-imported", "new"], "March is a new invoice, not a duplicate");
    const twice = reconcileSpendImport([rent("01"), rent("01")], new Map([[spendImportLineIdentity(rent("01")), 1]]), new Map());
    assert.deepEqual(twice.map((entry) => entry?.kind), ["already-imported", "new"], "two in the file, one held: one is new");
  });

  it("a line whose GL code a carried-forward line holds fills it — once; a blocked line takes nothing", () => {
    const carried = new Map([["gl:6100", ["carried-1"]]]);
    const out = reconcileSpendImport([line({ skip: true }), line({}), line({ invoiceDate: "2026-03-01" })], new Map(), carried);
    assert.deepEqual(out, [null, { kind: "fills-carried", sourceId: "carried-1" }, { kind: "new" }]);
  });

  it("the import counts only what it writes", () => {
    const summary = summariseImportReview([
      { rowNumber: 1, status: "accepted", issues: [] },
      { rowNumber: 2, status: "advisory", issues: [], reconciliation: { kind: "already-imported" } },
      { rowNumber: 3, status: "advisory", issues: [], reconciliation: { kind: "fills-carried", sourceId: "s" } },
      { rowNumber: 4, status: "blocked", issues: [] },
    ]);
    assert.equal(summary.alreadyImported, 1);
    assert.equal(importWritableCount(summary), 2);
  });
});

describe("Data entry D3 (R5) — the reporting grain: baseline + current + up to four prior", () => {
  const years = (...list: number[]) => list.map((year) => ({ year }));
  it("keeps the baseline, the four most recent priors after it and the current year", () => {
    assert.equal(REPORTING_PRIOR_YEARS, 4);
    assert.deepEqual(reportingGrainYears(years(2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026), 2026, 2018).map((entry) => entry.year), [2018, 2022, 2023, 2024, 2025, 2026]);
    assert.deepEqual(reportingGrainYears(years(2023, 2024, 2025, 2026), 2026, null).map((entry) => entry.year), [2023, 2024, 2025, 2026], "no baseline: the priors and the current year");
  });
  it("baseline-only in a baseline year", () => {
    assert.deepEqual(reportingGrainYears(years(2023, 2024, 2025, 2026), 2026, 2026).map((entry) => entry.year), [2026]);
  });

  const period = (year: number) => ({ year, sitesKnown: true, rows: [{ siteId: null, scope: "1", tco2e: year - 2000 }] });
  it("the report's comparison: baseline, four priors (the latest 'Previous'), current — and only the latest prior was there before", () => {
    const comparison = composeScopedComparison({
      scope: { kind: "whole" }, currentYear: 2026, current: [{ scope: "1", tco2e: 26 }], baselineYear: 2018,
      history: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].map(period),
    });
    assert.deepEqual(comparison.columns.map((column) => column.key), ["baseline", "earlier-2022", "earlier-2023", "earlier-2024", "previous", "current"]);
    assert.deepEqual(comparison.columns.map((column) => column.label), ["Baseline (FY2018)", "FY2022", "FY2023", "FY2024", "Previous (FY2025)", "Current (FY2026)"]);
    assert.deepEqual(comparison.totals, [18, 22, 23, 24, 25, 26]);
    const first = composeScopedComparison({ scope: { kind: "whole" }, currentYear: 2026, current: [{ scope: "1", tco2e: 26 }], baselineYear: 2026, history: [period(2025)] });
    assert.deepEqual(first.columns.map((column) => column.key), ["current"], "baseline-only in a baseline year: no earlier column");
  });
  it("the report's year-on-year chart reads the same grain; without the baseline argument it is as before", () => {
    const snapshot = { id: "s", jobId: "j", jobNumber: "J1", client: "C", reportingYear: 2026, dataHash: "h", createdAt: "2026-10-01", measurements: [],
      annualComparison: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((year) => ({ year, values: [{ scope: "1", value: 1 }] })) };
    assert.deepEqual(composeReportChartBasis({ snapshot, scope: { kind: "whole" }, baselineYear: 2018 }).annualComparison.map((entry) => entry.year), [2018, 2022, 2023, 2024, 2025, 2026]);
    assert.equal(composeReportChartBasis({ snapshot, scope: { kind: "whole" } }).annualComparison.length, 9);
  });
});

describe("Data entry D3 (R6) — reopen is a request, with a reason", () => {
  const context = { organisationId: "org", actorId: "p", principal: "portal", idempotencyKey: "k", correlationId: "c" } as CommandContext;
  const definition = commandDefinitions["portal.scope.row.reopen.request"];
  it("a portal command under portal.dataentry, audited; a reason is required and bounded", () => {
    assert.equal(definition.principal, "portal");
    assert.equal(definition.permission, "portal.dataentry");
    assert.equal(definition.auditAction, "portal_scope_row_reopen_requested");
    assert.deepEqual(definition.validate({ jobId: "j", rowId: "r", expectedVersion: 2, reason: "Wrong invoice total" }, context), []);
    assert.deepEqual(definition.validate({ jobId: "j", rowId: "r", expectedVersion: 2, reason: "  " }, context).map((issue) => issue.code), ["REQUIRED"]);
    assert.deepEqual(definition.validate({ jobId: "j", rowId: "r", expectedVersion: 2, reason: "x".repeat(1001) }, context).map((issue) => issue.code), ["TOO_LONG"]);
  });
});
