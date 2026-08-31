import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { neutraliseCell, parseDelimited } from "../app/jobs/csvReader";
import { applyMapping, autoMapColumns, resolveDraftRows } from "../app/jobs/spendImportMapping";
import { buildSpendImportTemplateCsv, spendImportTemplateFilename } from "../app/jobs/spendImportTemplate";

describe("parseDelimited", () => {
  it("reads comma CSV with a BOM and a header row", () => {
    const table = parseDelimited("﻿Description,Net,VAT\r\nOffice paper,1240,20\r\nCourier,880.50,20\r\n");
    assert.deepEqual(table.headers, ["Description", "Net", "VAT"]);
    assert.deepEqual(table.rows, [["Office paper", "1240", "20"], ["Courier", "880.50", "20"]]);
    assert.equal(table.delimiter, ",");
  });

  it("honours quoted fields with embedded commas, quotes and newlines", () => {
    const table = parseDelimited('A,B\r\n"Smith, John","say ""hi""\r\nnext line"\r\n');
    assert.deepEqual(table.rows, [["Smith, John", 'say "hi"\r\nnext line']]);
  });

  it("detects a semicolon or tab delimiter", () => {
    assert.equal(parseDelimited("a;b;c\r\n1;2;3").delimiter, ";");
    assert.equal(parseDelimited("a\tb\tc\r\n1\t2\t3").delimiter, "\t");
  });

  it("neutralises formula-injection cells on the way in", () => {
    assert.equal(neutraliseCell("=1+1"), "'=1+1");
    assert.equal(neutraliseCell("@SUM(A1)"), "'@SUM(A1)");
    assert.equal(neutraliseCell("Office paper"), "Office paper");
    const table = parseDelimited("Desc\r\n=cmd|' /C calc'!A1\r\n");
    assert.equal(table.rows[0]![0], "'=cmd|' /C calc'!A1");
  });

  it("returns empty structure for blank input", () => {
    assert.deepEqual(parseDelimited("   \r\n  "), { delimiter: ",", headers: [], rows: [] });
  });
});

describe("column mapping", () => {
  it("auto-maps common header names without reusing a column", () => {
    const mapping = autoMapColumns(["Supplier detail", "Net amount (£)", "VAT %", "Nominal code", "Invoice date", "PG&S category", "Emission factor"]);
    assert.deepEqual(mapping, { description: 0, netValue: 1, vatPercent: 2, glCode: 3, invoiceDate: 4, category: 5, factor: 6 });
  });

  it("applies a mapping to rows, parsing money and dd/mm/yyyy", () => {
    const drafts = applyMapping([["Office paper", "£1,240.00", "20", "7504", "14/03/2025", "Paper", "Paper factor"]], { description: 0, netValue: 1, vatPercent: 2, glCode: 3, invoiceDate: 4, category: 5, factor: 6 });
    assert.deepEqual(drafts[0], { rowNumber: 1, description: "Office paper", netValue: 1240, vatPercent: 20, glCode: "7504", invoiceDate: "2025-03-14", categoryName: "Paper", factorLabel: "Paper factor" });
  });

  it("resolves category names and factor labels against the job's controlled lists", () => {
    const rows = resolveDraftRows(
      [{ rowNumber: 1, description: "Paper", netValue: 100, vatPercent: null, glCode: null, invoiceDate: null, categoryName: "PAPER", factorLabel: "paper factor" }],
      [{ id: "pg-1", name: "Paper" }],
      [{ factorId: "f-1", label: "Paper factor", factorSource: "dataset", datasetId: "d-1", clientFactorId: null }],
    );
    assert.equal(rows[0]!.purchasedGoodsCategoryId, "pg-1");
    assert.equal(rows[0]!.factorId, "f-1");
    assert.equal(rows[0]!.datasetId, "d-1");
  });

  it("leaves an unresolved category or factor null (the preflight blocks it)", () => {
    const rows = resolveDraftRows(
      [{ rowNumber: 1, description: "X", netValue: 1, vatPercent: null, glCode: null, invoiceDate: null, categoryName: "Unknown", factorLabel: "Unknown" }],
      [{ id: "pg-1", name: "Paper" }], [],
    );
    assert.equal(rows[0]!.purchasedGoodsCategoryId, null);
    assert.equal(rows[0]!.factorId, null);
  });
});

describe("template", () => {
  it("builds a headered CSV and round-trips through the reader", () => {
    const table = parseDelimited(buildSpendImportTemplateCsv());
    assert.equal(table.headers[0], "Description");
    assert.equal(table.headers[4], "Invoice date (dd/mm/yyyy)");
    assert.equal(table.rows.length, 1);
  });

  it("sanitises the identifiers in the filename", () => {
    assert.equal(spendImportTemplateFilename("J000712", "Bushy Tails Ltd", "Annual CRP", 2024), "J000712_BushyTailsLtd_AnnualCRP_2024_Spend.csv");
  });
});
