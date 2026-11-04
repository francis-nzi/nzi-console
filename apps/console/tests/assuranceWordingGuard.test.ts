import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ASSURANCE_SANCTIONED, assuranceHits, isAssuranceSanctioned } from "../../../scripts/assurance-wording.mjs";

/**
 * NZI offers emissions verification, not assurance (`check:terminology`). This pins the rule - what it refuses, what it lets through, every exception
 * with its reason - and that the repository passes it, so the word cannot quietly come back into anything a client or member of staff reads.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const hits = (line: string) => (assuranceHits(line) as number[]).length;

describe("the verification-wording guard", () => {
  it("refuses assurance / assured / assure wherever it is copy", () => {
    for (const line of [
      "<span className=\"al\"><b>Reviewed snapshot</b> · evidence state <b>Assured</b></span>",
      "<p>Boundary and methodology decisions are recorded in the assurance record.</p>",
      'label: "Assured emissions",',
      "`FY${year} assured emissions: ${total} tCO₂e`",
      "<div className=\"sub\">Create, assure and release decision-grade carbon reports</div>",
      'message: "Data assurance is available only for CRP jobs."',
      "<span>Independent assurance</span>",
      'title="From the assured NZI record"',
      "export const REPORT_X = \"Reviewed snapshot (internal review); not third-party assured\";",
      "  Assurance basis",
    ]) assert.ok(hits(line) > 0, line);
  });

  it("lets through what is not copy: identifiers, compounds, classes, dotted codes, lone code literals, object keys and comments", () => {
    for (const line of [
      "const assuredTotal = 3; const AssuranceGap = 1;", "row.assuredYears", "facts.independentlyAssured", "aggregateAssuranceYear(rows)",
      'className="nz-assurance-drawer nz-assurance-gap"', '<div data-assurance="gaps">', 'import { getAssuranceScreen } from "./assuranceScreen";',
      '"assurance.gap.resolve": job,', 'topic: "assurance.gap.resolved",', "CommandInputMap[\"assurance.gap.resolve\"]",
      'idBase="assurance"', 'source === "assured"', "export type BaselineSource = \"assured\" | \"declared\";",
      "  assurance: ReportAssuranceBasis;", "{ assured: 3, declared: 1 }",
      "// the assured snapshot", " * Assurance is not shown here", "/* assured */", "{/* the assurance banner */}",
      'const kind = "ok"; // assured by the reviewer',
    ]) assert.equal(hits(line), 0, line);
  });

  it("exempts only what is not carbon verification or is held for a decision, each with its reason", () => {
    for (const entry of ASSURANCE_SANCTIONED as Array<{ why: string }>) assert.ok(entry.why.trim().length > 25, entry.why);
    assert.equal(isAssuranceSanctioned("apps/console/app/platform/PlatformBoard.tsx", "anything assurance"), true, "platform security/audit assurance");
    assert.equal(isAssuranceSanctioned("apps/console/app/portal/portalTermsContent.ts", "x assured"), true, "legal text");
    assert.equal(isAssuranceSanctioned("apps/console/app/admin/suppliers/SuppliersBoard.tsx", 'placeholder="e.g. Limited assurance"'), true);
    for (const path of ["apps/console/app/portal/jobs/[jobId]/PortalDashboard.tsx", "packages/contracts/src/reportComposition.ts", "apps/console/app/reports/[versionId]/ReportComposedV5.tsx"]) {
      assert.equal(isAssuranceSanctioned(path, "<b>Assured</b>"), false, path);
    }
  });

  it("is run by check:terminology over the console, the packages that draw copy and the backend's messages - and the repository passes it", () => {
    const script = readFileSync(resolve(repo, "scripts/check-terminology.mjs"), "utf8");
    assert.match(script, /assuranceHits\(line\)/);
    assert.match(script, /INTERNAL_NAME_ROOTS = \[\.\.\.ROOTS, "packages\/isolated-backend\/src"\]/);
    const output = execFileSync(process.execPath, ["scripts/check-terminology.mjs"], { cwd: repo, encoding: "utf8" });
    assert.match(output, /carbon copy says "verification", never "assurance"/);
  });
});
