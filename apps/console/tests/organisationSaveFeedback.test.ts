import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { fieldIssues, statusOf } from "../app/admin/organisation/actionStatus";

/**
 * Admin → Organisation, the D1 fast-follow: every action says what happened, beside its button. A repeated Save used to
 * look silent — the confirmation and the refusal were both rendered out of view — so it read as "nothing saved".
 */
const here = dirname(fileURLToPath(import.meta.url));
const board = readFileSync(resolve(here, "../app/admin/organisation/OrganisationBoard.tsx"), "utf8");

describe("what a Save says (admin → Organisation)", () => {
  it("names each outcome plainly", () => {
    assert.deepEqual(statusOf({ state: "validation_failed", message: "x", issues: [{ field: "organisationId", code: "NO_CHANGE", message: "Nothing to change." }] }, "profile"),
      { kind: "nochange", text: "No changes to save." });
    assert.deepEqual(statusOf({ state: "conflict", message: "x" }, "profile").kind, "conflict");
    assert.match(statusOf({ state: "conflict", message: "x" }, "profile").text, /changed since you opened it\. Reload/);
    assert.deepEqual(statusOf({ state: "validation_failed", message: "x", issues: [{ field: "vatNumber", code: "INVALID", message: "A VAT number." }] }, "profile"), { kind: "error", text: "A VAT number." });
    assert.deepEqual(statusOf({ state: "failed", message: "The service could not be reached.", retryable: true }, "profile"), { kind: "error", text: "The service could not be reached." });
  });

  it("keeps 'nothing to change' off the fields, and field messages on them", () => {
    assert.deepEqual(fieldIssues({ state: "validation_failed", message: "x", issues: [{ field: "organisationId", code: "NO_CHANGE", message: "Nothing to change." }, { field: "vatNumber", code: "INVALID", message: "A VAT number." }] }),
      { vatNumber: "A VAT number." });
  });

  it("puts the status beside every action, in a live region, with the button disabled and a spinner while in flight", () => {
    // Every card renders its status next to its own buttons — the header notice (out of view) is gone.
    assert.ok(!board.includes("nz-a-notice"), "the out-of-view header notice is gone");
    assert.equal((board.match(/<StatusLine status=\{status\} \/>/g) ?? []).length >= 5, true, "profile, logo, bank (2), defaults");
    assert.match(board, /aria-live=\{alert \? "assertive" : "polite"\}/);
    assert.match(board, /disabled=\{busy \|\| disabled\} aria-busy=\{busy\}/);
    assert.match(board, /<span className="nz-a-spinner" aria-hidden="true" \/>/);
    // A second click while one is in flight is dropped, whatever the render in between.
    assert.match(board, /if \(flying\.current\) return;/);
    // A confirmation survives the reload that brings in the saved version, and says which version.
    assert.match(board, /Held here, above the cards/);
    assert.match(board, /Saved — the profile is now version \$\{result\.data\.version\}/);
    // No change is detected before anything is sent, too.
    assert.match(board, /No changes to save\./);
    // Conflicts offer the reload they ask for.
    assert.match(board, /window\.location\.reload\(\)/);
  });

  it("adds no edit mode, and no create, archive or delete: the profile is one row", () => {
    assert.ok(!/Edit profile|Delete|Archive|New organisation/.test(board));
  });
});
