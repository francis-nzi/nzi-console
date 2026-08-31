import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { monthlySlotsForLine, parseSpendLedger, suggestCategory } from "../app/jobs/spendLedger";

describe("parseSpendLedger", () => {
  it("parses a tab-separated ledger with a header row", () => {
    const lines = parseSpendLedger(
      "Description\tNet\tVAT %\tGL code\tDate\nOffice paper\t1240.00\t20\t7504\t14/03/2025\nCourier\t880.50\t20\t7501\t02/04/2025",
    );
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { description: "Office paper", netValue: 1240, vatPercent: 20, glCode: "7504", invoiceDate: "2025-03-14" });
    assert.equal(lines[1]?.invoiceDate, "2025-04-02");
  });

  it("assumes description, net, vat, gl, date order when there is no header", () => {
    const lines = parseSpendLedger("Steel framing, £12,500.00, 20, 5100, 2025-01-31");
    assert.equal(lines[0]?.description, "Steel framing");
    assert.equal(lines[0]?.netValue, 12500);
    assert.equal(lines[0]?.invoiceDate, "2025-01-31");
  });

  it("keeps a line with an unparseable amount but drops empty descriptions", () => {
    const lines = parseSpendLedger("Consultancy retainer\tn/a\t20\t7600\t\n\t100\t20\t7600\t");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.netValue, null);
  });

  it("returns nothing for blank input", () => {
    assert.deepEqual(parseSpendLedger("   \n  "), []);
  });

  it("drops rows of pure junk that carry no description", () => {
    assert.deepEqual(parseSpendLedger("\t\t\t\n,,,\n   "), []);
  });
});

describe("monthlySlotsForLine", () => {
  const months = ["2025-01", "2025-02", "2025-03"];

  it("places the whole net value on the invoice month and null elsewhere", () => {
    assert.deepEqual(monthlySlotsForLine("2025-02-14", 1240, months), [
      { month: "2025-01", quantity: null },
      { month: "2025-02", quantity: 1240 },
      { month: "2025-03", quantity: null },
    ]);
  });

  it("returns null when the line cannot be split", () => {
    assert.equal(monthlySlotsForLine(null, 1240, months), null);
    assert.equal(monthlySlotsForLine("2025-02-14", null, months), null);
    assert.equal(monthlySlotsForLine("2025-02-14", 1240, []), null);
    assert.equal(monthlySlotsForLine("2024-12-31", 1240, months), null);
  });
});

describe("suggestCategory", () => {
  const categories = [{ name: "Paper and printed materials" }, { name: "Freight and logistics" }, { name: "Professional services" }];

  it("matches on a shared word of four or more characters", () => {
    assert.equal(suggestCategory("Recycled paper reams", categories), "Paper and printed materials");
    assert.equal(suggestCategory("Inbound freight charges", categories), "Freight and logistics");
  });

  it("returns null when nothing overlaps", () => {
    assert.equal(suggestCategory("Taxi", categories), null);
    assert.equal(suggestCategory("Misc 123", categories), null);
  });
});
