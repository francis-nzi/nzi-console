import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientReportingFrameworks, emissionCategoryTaxonomy, scope3CategoryCodes, validateCommand, type ClientProfileFields, type CommandContext, type CommandInputMap } from "../src/index";

const context: CommandContext = { organisationId: "org-nzi", actorId: "user-1", principal: "staff", idempotencyKey: "idem-1", correlationId: "corr-1" };
const identity = { name: "8 Doors Distillery", status: "active", sector: "Food and Drink", location: "Wick, UK", owner: "D. Hawes" } as const;
const create = (profile: ClientProfileFields = {}): CommandInputMap["client.create"] => ({ ...identity, ...profile });
const fields = (input: ClientProfileFields) => validateCommand("client.create", create(input), context).map((issue) => issue.field);

describe("client profile contract (NZC-064)", () => {
  it("accepts an identity-only client so the wizard's later steps stay optional", () => {
    assert.deepEqual(validateCommand("client.create", create(), context), []);
  });

  it("requires the identity fields the portfolio and job spine depend on", () => {
    const issues = validateCommand("client.create", { ...create(), name: "", owner: " " }, context);
    assert.deepEqual(issues.map((issue) => issue.field).sort(), ["name", "owner"]);
  });

  it("rejects a net-zero year with no reduction — the trajectory cannot anchor on one alone", () => {
    assert.deepEqual(fields({ netZeroTargetYear: 2045 }), ["netZeroTargetReductionPct"]);
    assert.deepEqual(fields({ netZeroTargetYear: 2045, netZeroTargetReductionPct: 90 }), []);
  });

  it("bounds target years and reductions", () => {
    assert.deepEqual(fields({ netZeroTargetYear: 1990, netZeroTargetReductionPct: 90 }), ["netZeroTargetYear"]);
    assert.deepEqual(fields({ scope1InterimReductionPct: 140 }), ["scope1InterimReductionPct"]);
    assert.deepEqual(fields({ scope2InterimYear: 2035, scope2InterimReductionPct: 50 }), []);
  });

  it("bounds the base-year recalculation significance threshold", () => {
    assert.deepEqual(fields({ baselineSignificanceThresholdPct: 0 }), ["baselineSignificanceThresholdPct"]);
    assert.deepEqual(fields({ baselineSignificanceThresholdPct: 101 }), ["baselineSignificanceThresholdPct"]);
    assert.deepEqual(fields({ baselineSignificanceThresholdPct: 5 }), []);
  });

  it("no longer accepts baseline figures on a client save (NZC-065)", () => {
    // The baseline is a dated `client_baselines` record set through `client.baseline.*`.
    // A client save carrying baseline fields must not silently persist them.
    const stray = { baselinePeriodStart: "2022-08-01", baselineTotalTco2e: 1234 } as never;
    assert.deepEqual(validateCommand("client.create", { ...create(), ...(stray as object) }, context), []);
  });

  it("validates reporting settings, URLs and contact email", () => {
    assert.deepEqual(fields({ dataReportingFrequency: "fortnightly" as never }), ["dataReportingFrequency"]);
    assert.deepEqual(fields({ currency: "pounds" }), ["currency"]);
    assert.deepEqual(fields({ financialYearEndMonth: 13 }), ["financialYearEndMonth"]);
    assert.deepEqual(fields({ website: "www.example.com" }), ["website"]);
    assert.deepEqual(fields({ contactEmail: "not-an-email" }), ["contactEmail"]);
    assert.deepEqual(fields({ currency: "GBP", financialYearEndMonth: 12, website: "https://www.8doorsdistillery.com/", contactEmail: "team@example.com" }), []);
  });

  it("holds compliance selections to controlled vocabularies and rejects repeats", () => {
    assert.deepEqual(fields({ reportingFrameworks: ["SECR", "Invented Framework"] }), ["reportingFrameworks"]);
    assert.deepEqual(fields({ certifications: ["B Corp", "B Corp"] }), ["certifications"]);
    assert.deepEqual(fields({ groupStructure: "conglomerate" as never }), ["groupStructure"]);
    assert.deepEqual(fields({ reportingFrameworks: [...clientReportingFrameworks], primaryScope3Categories: ["3.1", "3.6"], groupStructure: "subsidiary" }), []);
  });

  it("draws primary Scope 3 categories from the canonical taxonomy, not a parallel list", () => {
    assert.deepEqual(scope3CategoryCodes, emissionCategoryTaxonomy.filter((entry) => entry.scope === "3").map((entry) => entry.code));
    assert.equal(scope3CategoryCodes.length, 15);
    assert.deepEqual(fields({ primaryScope3Categories: ["Cat 1"] }), ["primaryScope3Categories"]);
  });

  it("requires a positive expected version on update so edits cannot clobber concurrent ones", () => {
    const base = { ...identity, clientId: "client-1" };
    assert.deepEqual(validateCommand("client.update", { ...base, expectedVersion: 0 }, context).map((issue) => issue.field), ["expectedVersion"]);
    assert.deepEqual(validateCommand("client.update", { ...base, expectedVersion: 3 }, context), []);
    assert.deepEqual(validateCommand("client.update", { ...base, clientId: "", expectedVersion: 3 }, context).map((issue) => issue.field), ["clientId"]);
  });
});
