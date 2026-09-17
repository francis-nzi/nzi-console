import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Add-client Identity step's four lookup-backed fields (redesign Part 2).
 *
 * Asserted on the source, because the acceptance criterion is an absence — "no free-text-only or
 * basic dropdown remains for these four" — and an absence is exactly what a rendering test tends
 * not to notice.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/**
 * Code lines only, and one line at a time.
 *
 * Stripping `//` as a comment ate the `//` in `placeholder="https://…"`, which removed that line's
 * closing `/>` and let a `[^>]*` pattern run across the newline into the next field — so a field
 * that *is* a lookup read as free text. Matching per line removes both the need to strip and the
 * chance of a pattern spanning two fields.
 */
const codeLines = (path: string) =>
  readFileSync(join(ROOT, path), "utf8").split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
  });

const formLines = () => codeLines("apps/console/app/clients/clientForm.tsx");
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "");
const form = () => formLines().join("\n");

describe("the Identity step searches curated lists", () => {
  it("backs all four fields with a lookup, not free text", () => {
    const lines = formLines();
    for (const field of ["owner", "clientManager", "sector", "referral"]) {
      const rendered = lines.filter((line) => line.includes(`name="${field}"`));
      assert.ok(rendered.length > 0, `${field} is not on the form at all`);
      assert.ok(rendered.every((line) => line.includes("<Lookup")), `${field} must be a smart-search`);
      assert.ok(!rendered.some((line) => line.includes("<Text")), `${field} must not remain free text`);
    }
  });

  it("points owner and manager at the same roster", () => {
    // Part 1 defaults a job's Client Manager from the client's. Two fields reading different
    // rosters would make that default resolve to someone who is not on the other list.
    const code = form();
    assert.match(code, /name="owner"[^>]*list=\{lookups\.team\}/);
    assert.match(code, /name="clientManager"[^>]*list=\{lookups\.team\}/);
  });

  it("uses the one shared smart-search rather than a fourth typeahead", () => {
    assert.match(form(), /SmartSearch/);
    assert.match(readFileSync(join(ROOT, "packages/ui/src/index.tsx"), "utf8"), /export \{ SmartSearch/);
  });

  it("keeps Headquarters gone and both helper lines removed", () => {
    const code = form();
    assert.doesNotMatch(code, /name="headquarters"/);
    const wizard = strip(readFileSync(join(ROOT, "apps/console/app/clients/new/ClientCreateWizard.tsx"), "utf8"));
    assert.doesNotMatch(wizard, /Only identity is required/);
    assert.doesNotMatch(wizard, /Who the client is, who owns the relationship/);
  });

  it("says a failed list is a fault, never an empty one", () => {
    // The platform's oldest failure mode, applied to a dropdown: a consultant hunting for a
    // missing industry when the request actually failed.
    const hook = strip(readFileSync(join(ROOT, "apps/console/app/clients/useReferenceOptions.ts"), "utf8"));
    assert.match(hook, /that is a fault, not an empty list/);
    assert.match(hook, /state: "failed"/);
    assert.match(hook, /state: "loading"/);
  });

  it("shows a SIC only once one exists, so the auto-fill activates itself", () => {
    // Live carries no SIC codes. The hint is conditional on the value actually having one, so
    // curation switches the behaviour on without a code change.
    assert.match(strip(readFileSync(join(ROOT, "apps/console/app/clients/useReferenceOptions.ts"), "utf8")),
      /value\.code \? \{ hint: value\.code \} : \{\}/);
  });
});
