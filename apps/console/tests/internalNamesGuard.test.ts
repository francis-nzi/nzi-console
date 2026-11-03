import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { INTERNAL_NAME_EXEMPT, internalNameHits, isInternalNameExempt, withoutTrailingComment } from "../../../scripts/internal-names.mjs";

/**
 * "v7" is an internal name: user-facing copy never says it (`check:terminology`). This pins the rule - what it refuses, what it lets through - so it
 * cannot quietly stop working, and that the guard really fails when the name comes back.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const hits = (line: string) => (internalNameHits(line) as number[]).length;

describe("the internal-name guard", () => {
  it("refuses the name wherever it is copy", () => {
    for (const line of [
      '<span>Imported from v7</span>',
      'const text = "This row was imported from NZ Insights Pro v7.";',
      "message: `The previous figure was v7’s, not ours`,",
      'label: "v7 record of account",',
      '<p>Entries imported from v7 have no category.</p>',
      "hint=\"The client that owns this portfolio, from v7.\"",
      '  "Add the first one, or import v7’s."',
      'title: "Emission deltas against v7 — investigate"',
    ]) assert.ok(hits(line) > 0, line);
  });

  it("lets through what is not copy: comments, identifiers, codes, kebab and dotted names, a lone code literal and an object key", () => {
    for (const line of [
      "// imported from v7 in the old system",
      " * the v7 import (docs)",
      "/* v7 */",
      "const x = foo(); // v7 row",
      "{/* the v7 banner */}",
      "const v7Record = true;", "row.v7RowId", "V7_REINGEST_ACTOR", "isV7ReportedTotalReason(reason)",
      '"v7-record": "Issued before the console"', "source_system = 'nzi-pro-v7'", 'key: "v7.reingest.job"',
      'row.provenance === "v7" ? "Imported" : "Added here"', "const PROVENANCE = { v7: \"v7\", added: \"added\" };", "  v7?: { key: string };",
      "import { normaliseV7Unit } from \"./v7Reingest\";",
    ]) assert.equal(hits(line), 0, line);
  });

  it("respects quotes when it strips a trailing comment, so a URL in a string is not a comment", () => {
    assert.equal(withoutTrailingComment('const a = "https://x.test/v7"; // note v7'), 'const a = "https://x.test/v7"; ');
    assert.equal(withoutTrailingComment("<b>x</b> {/* v7 */}"), "<b>x</b> ");
  });

  it("exempts only operator tooling, each with its reason - never the screens", () => {
    for (const entry of INTERNAL_NAME_EXEMPT as Array<{ why: string }>) assert.ok(entry.why.trim().length > 20);
    for (const path of ["packages/contracts/src/v7Reingest.ts", "packages/isolated-backend/src/v7ClientImport.ts", "packages/isolated-backend/src/v7Reingest.ts", "packages/contracts/src/userFacingText.ts"]) assert.ok(isInternalNameExempt(path), path);
    for (const path of ["apps/console/app/jobs/CrpDataEntryAccordion.tsx", "apps/console/app/portal/PortalReadiness.tsx", "packages/contracts/src/reportNavigation.ts", "packages/ui/src/admin/Governance.tsx", "packages/isolated-backend/src/postgresCommands.ts"]) assert.ok(!isInternalNameExempt(path), path);
  });

  it("is run by check:terminology over the console, the packages that draw copy and the backend's messages - and the repository passes it", () => {
    const script = readFileSync(resolve(repo, "scripts/check-terminology.mjs"), "utf8");
    assert.match(script, /INTERNAL_NAME_ROOTS = \[\.\.\.ROOTS, "packages\/isolated-backend\/src"\]/);
    assert.match(script, /internalNameHits\(line\)/);
    const output = execFileSync(process.execPath, ["scripts/check-terminology.mjs"], { cwd: repo, encoding: "utf8" });
    assert.match(output, /no internal "v7" name is user-facing/);
  });
});
