import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseReportScope, reportScopeIssues, reportScopeKey, reportScopeLabel, selectableScopeSites } from "../src/reportScope";
import { commandDefinitions } from "../src/commands";

// Reporting S-1 (ruled): the scope a report version issues — the whole client, or a set of the snapshot's sites.
describe("a report's scope (S-1)", () => {
  it("has one canonical form and one key per view; 'every site' is never 'whole client'", () => {
    assert.deepEqual(normaliseReportScope(undefined), { kind: "whole" });
    assert.deepEqual(normaliseReportScope({ kind: "sites", siteIds: ["b", "a", "b"] }), { kind: "sites", siteIds: ["a", "b"] });
    assert.equal(reportScopeKey({ kind: "whole" }), "whole");
    assert.equal(reportScopeKey({ kind: "sites", siteIds: ["b", "a"] }), "sites:a,b", "matches 0163's generated key");
    assert.notEqual(reportScopeKey({ kind: "sites", siteIds: ["a", "b", "c"] }), "whole", "a site scope stays a site scope, however many");
  });

  it("names a scope by its sites, falling back to the id", () => {
    const names = new Map([["a", "Works"], ["b", "Annex"]]);
    assert.equal(reportScopeLabel({ kind: "whole" }, names), "Whole client");
    assert.equal(reportScopeLabel({ kind: "sites", siteIds: ["a", "b", "zz"] }, names), "Works, Annex, zz");
  });

  it("lets a scope pick the boundary stamp's sites, or a pre-stamp snapshot's rows' own sites", () => {
    assert.deepEqual(selectableScopeSites({ provenance: { boundary: { siteIds: ["c", "a"] } }, measurements: [{ siteId: "b" }] }), ["a", "c"], "the stamp, when present");
    assert.deepEqual(selectableScopeSites({ measurements: [{ siteId: "b" }, { siteId: null }, { siteId: "a" }, { siteId: "b" }] }), ["a", "b"], "else the rows'");
  });

  it("refuses a malformed scope on report.validate, and takes an absent one as the whole client", () => {
    const issues = (scope: unknown) => commandDefinitions["report.validate"].validate({ reviewedSnapshotId: "s", manifestVersion: 1, scope } as never, { organisationId: "o", actorId: "a", principal: "staff", idempotencyKey: "k", correlationId: "c" } as never);
    assert.deepEqual(issues(undefined), []);
    assert.deepEqual(issues({ kind: "whole" }), []);
    assert.deepEqual(reportScopeIssues({ kind: "sites", siteIds: [] }).map((issue) => issue.code), ["REQUIRED"]);
    assert.deepEqual(reportScopeIssues({ kind: "sites", siteIds: ["a", ""] }).map((issue) => issue.code), ["INVALID"]);
    assert.deepEqual(reportScopeIssues({ kind: "region" }).map((issue) => issue.field), ["scope"]);
    assert.ok(issues({ kind: "sites", siteIds: [] }).some((issue) => issue.field === "scope.siteIds"), "the command carries the scope's issues");
  });
});
