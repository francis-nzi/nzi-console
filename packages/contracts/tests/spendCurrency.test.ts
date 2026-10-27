import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDefinitions, isFxRate, siteCurrencyOf, spendInClientCurrency, spendValueLabel, type CommandContext, type JobSiteFxRate } from "../src/index";

const context = { organisationId: "org", actorId: "u", principal: "staff", idempotencyKey: "k", correlationId: "c" } as CommandContext;
const rate = (over: Partial<JobSiteFxRate>): JobSiteFxRate => ({ siteId: "paris", fromCurrency: "EUR", toCurrency: "GBP", rate: 0.85, version: 1, ...over });

describe("Data entry D3 (R1) — local-first currency", () => {
  it("a site's own currency, else the client's", () => {
    assert.equal(siteCurrencyOf({ currency: "EUR" }, "GBP"), "EUR");
    assert.equal(siteCurrencyOf({ currency: null }, "GBP"), "GBP");
    assert.equal(siteCurrencyOf(null, "GBP"), "GBP");
  });

  it("money in the client's currency: its own lines as they are, others at their site's rate — never a guessed rate", () => {
    const lines = [
      { unit: "GBP", quantity: 1000, siteId: "leeds" },
      { unit: "EUR", quantity: 2000, siteId: "paris" },
      { unit: "EUR", quantity: 500, siteId: "lyon" },
      { unit: "EUR", quantity: 100, siteId: null },
      { unit: "km", quantity: 9999, siteId: "leeds" },
    ];
    const spend = spendInClientCurrency(lines, "GBP", [rate({})]);
    assert.equal(spend.total, 1000 + 2000 * 0.85);
    assert.deepEqual([spend.lines, spend.converted], [2, 1]);
    assert.deepEqual(spend.unconverted, [{ currency: "EUR", siteId: "lyon", lines: 1, amount: 500 }, { currency: "EUR", siteId: null, lines: 1, amount: 100 }],
      "Lyon has no rate and a site-less line has none to use: both said, neither counted");
    assert.equal(spendInClientCurrency(lines, "GBP", [rate({ toCurrency: "USD" })]).converted, 0, "a rate to another currency is not this one");
  });

  it("the value's label follows the currency", () => {
    assert.equal(spendValueLabel("Net value (£)", "EUR"), "Net value (€)");
    assert.equal(spendValueLabel("Spend value", "GBP"), "Spend value (£)");
    assert.equal(spendValueLabel("Net value (£)", "CHF"), "Net value (CHF)");
    assert.equal(spendValueLabel("Net value (£)", null), "Net value");
  });

  it("a site's currency is validated on its edit; the FX rate is staff's and a positive number", () => {
    const edit = commandDefinitions["site.edit"];
    const base = { siteId: "s", name: "Paris", inServiceFrom: null, expectedVersion: 1 };
    assert.deepEqual(edit.validate({ ...base, currency: "EUR" }, context), []);
    assert.deepEqual(edit.validate({ ...base, currency: "euro" }, context).map((issue) => issue.field), ["currency"]);
    assert.deepEqual(edit.validate({ ...base, currency: null }, context), [], "null hands the site back to the client's currency");
    const fx = commandDefinitions["job.site.fx.set"];
    assert.equal(fx.permission, "scoperow.edit");
    assert.equal(fx.auditAction, "job_site_fx_rate_set");
    assert.deepEqual(fx.validate({ jobId: "j", siteId: "s", rate: 0.85 }, context), []);
    for (const bad of [0, -1, Number.NaN, 2_000_000]) assert.equal(isFxRate(bad), false, String(bad));
    assert.deepEqual(fx.validate({ jobId: "j", siteId: "s", rate: 0 }, context).map((issue) => issue.field), ["rate"]);
  });
});
