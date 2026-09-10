import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSiteBoundary, type ClientSiteReadModel } from "../src/index";

const site = (overrides: Partial<ClientSiteReadModel> = {}): ClientSiteReadModel => ({ id: "site-1", name: "Depot", isRegisteredOffice: false, inServiceFrom: "2023-04-01", vacatedEffective: null, status: "in-service", version: 1, ...overrides });

describe("effective-dated site boundary", () => {
  it("keeps a site vacated mid-FY24 in FY24 and drops it from FY25", () => {
    const sites = [site({ vacatedEffective: "2024-07-01", status: "vacated" })];
    assert.equal(resolveSiteBoundary(sites, 2024).length, 1);
    assert.equal(resolveSiteBoundary(sites, 2025).length, 0);
  });

  it("includes a site that starts during the reporting year", () => {
    const sites = [site({ inServiceFrom: "2024-06-01" })];
    assert.equal(resolveSiteBoundary(sites, 2024).length, 1);
    assert.equal(resolveSiteBoundary(sites, 2023).length, 0);
  });
});
