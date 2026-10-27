// Data entry D3 (R1, R7): local-first currency in the console — a spend line opens in its site's currency, the value's label follows
// the currency, a currency nothing is priced in is said rather than silently swapped, sites carry a currency, and the job's Currency &
// FX panel sets per-site rates and shows spend in the client's currency (staff only). The write is proved in dataEntryD3CurrencyReal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { openingCurrency } from "../app/jobs/emissionEntryModel";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const gbpOnly = [{ unit: "GBP" }];

describe("R1 — the opening currency is local-first", () => {
  it("a site with its own currency opens in it, even where nothing is priced in it yet", () => {
    assert.equal(openingCurrency(gbpOnly, "GBP", "EUR"), "EUR");
  });
  it("without one, D1's rule stands: the client's where priced, else the first priced", () => {
    assert.equal(openingCurrency(gbpOnly, "GBP", null), "GBP");
    assert.equal(openingCurrency([{ unit: "EUR" }], "USD", null), "EUR");
  });
});

describe("the wiring", () => {
  const form = source("app/jobs/EmissionEntryForm.tsx");
  it("the drawer opens on the entry site's currency and keeps it once the job's settings arrive — until someone chooses", () => {
    assert.match(form, /openingCurrency\(factors, props\.entryBasis\?\.currency, site\.id \? props\.entryBasis\?\.siteCurrencies\?\.\[site\.id\] : null\)/);
    assert.match(form, /currencyTouched\.current = true/);
  });
  it("the value's label follows the currency; a currency with no factor is said, and the line is never converted", () => {
    assert.match(form, /spendValueLabel\(field\.label, draft\.currency\)/);
    assert.match(form, /No spend factor is priced in \{draft\.currency\}/);
  });
  it("a site carries a currency (blank is the client's)", () => {
    const sites = source("app/clients/[clientId]/ClientSites.tsx");
    assert.match(sites, /aria-label="Site currency"/);
    assert.match(sites, /currency: currency \|\| null/);
  });
  it("the job's Currency & FX panel: per-site rates through the gated command, spend in the client's currency, staff only", () => {
    const panel = source("app/jobs/JobCurrencyPanel.tsx");
    assert.match(panel, /spendInClientCurrency\(/);
    assert.match(panel, /the emissions don't use it/);
    assert.match(source("app/api/isolated/jobs/[jobId]/fx-rates/route.ts"), /requireCommandPrincipal\(request, "job\.site\.fx\.set"\)/);
    assert.match(source("app/jobs/CrpScopeWorkspace.tsx"), /<JobCurrencyPanel jobId=\{job\.header\.id\}/);
    assert.ok(!/JobCurrencyPanel/.test(source("app/portal/jobs/[jobId]/data/PortalDataView.tsx")), "money is never shown back to the client");
  });
});
