import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDefinitions, commandGrantForRole, organisationImportPolicyIssues, validateCommand, v7ImportRefreshIssues, type CommandContext, type V7ImportRefreshInput } from "../src/index";

/** The import, server-side, Phase B: import.refresh names the job, the mode and — for a commit — what its preview showed. Nothing else. */
const SHA = { summarySha256: "a".repeat(64), decisionsSha256: "b".repeat(64) };
const codes = (input: unknown) => v7ImportRefreshIssues(input as V7ImportRefreshInput).map((issue) => issue.code);
const context = (reason?: string): CommandContext => ({ organisationId: "org-a", actorId: "staff-crm", principal: "staff", idempotencyKey: "k", correlationId: "c",
  grant: commandGrantForRole("consultant", "org-a", "staff-crm"), ...(reason ? { reason } : {}) });

describe("import.refresh — the input, closed", () => {
  it("a preview names the job; a commit names the job, the summary and the decisions", () => {
    assert.deepEqual(codes({ jobId: "job-1", mode: "preview" }), []);
    assert.deepEqual(codes({ jobId: "job-1", mode: "commit", ...SHA }), []);
  });
  it("a commit without its fingerprints, or with malformed ones, is refused", () => {
    assert.deepEqual(codes({ jobId: "job-1", mode: "commit" }), ["REQUIRED", "REQUIRED"]);
    assert.deepEqual(codes({ jobId: "job-1", mode: "commit", ...SHA, summarySha256: "A".repeat(64) }), ["REQUIRED"]);
  });
  it("closed: a preview carries no fingerprints, and nothing carries the previous system's rows — the key is named, never its value", () => {
    assert.deepEqual(codes({ jobId: "job-1", mode: "preview", ...SHA }), ["UNKNOWN_FIELD"]);
    const issues = v7ImportRefreshIssues({ jobId: "job-1", mode: "commit", ...SHA, rows: [{ sourceLabel: "Van ZZ12 ABC" }] } as never);
    assert.deepEqual(issues.map((issue) => issue.code), ["UNKNOWN_FIELD"]);
    assert.ok(!issues[0]!.message.includes("ZZ12"));
  });
  it("names the job and one of the two modes", () => {
    assert.deepEqual(codes({ jobId: " ", mode: "preview" }), ["REQUIRED"]);
    assert.deepEqual(codes({ jobId: "job-1", mode: "apply" }), ["INVALID"]);
  });
  it("a commit needs a reason; a preview, which writes nothing, does not", () => {
    assert.equal(commandDefinitions["import.refresh"].permission, "import.refresh");
    assert.deepEqual(validateCommand("import.refresh", { jobId: "job-1", mode: "preview" }, context()).map((issue) => issue.code), []);
    assert.deepEqual(validateCommand("import.refresh", { jobId: "job-1", mode: "commit", ...SHA }, context()).map((issue) => [issue.field, issue.code]), [["reason", "REQUIRED"]]);
    assert.deepEqual(validateCommand("import.refresh", { jobId: "job-1", mode: "commit", ...SHA }, context("refresh it")), []);
  });
});

describe("organisation.importPolicy.set — one setting, with its version and a reason", () => {
  it("takes a boolean and a version, and nothing else", () => {
    assert.deepEqual(organisationImportPolicyIssues({ refreshCommitRequiresAdmin: true, expectedVersion: 0 }), []);
    assert.deepEqual(organisationImportPolicyIssues({ refreshCommitRequiresAdmin: "yes", expectedVersion: -1 } as never).map((issue) => issue.code), ["INVALID", "INVALID"]);
    assert.deepEqual(organisationImportPolicyIssues({ refreshCommitRequiresAdmin: true, expectedVersion: 0, role: "admin" } as never).map((issue) => issue.code), ["UNKNOWN_FIELD"]);
    assert.deepEqual(validateCommand("organisation.importPolicy.set", { refreshCommitRequiresAdmin: true, expectedVersion: 0 }, context()).map((issue) => issue.field), ["reason"]);
  });
});
