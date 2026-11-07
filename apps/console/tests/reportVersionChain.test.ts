import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { chainLabel, restoredMessage, RESTORE_NOTE } from "../app/jobs/[jobId]/report/versionChain";

// Client-review loop S7: the version chain panel's pure parts, and the wiring that keeps the reads staff-only and read-only.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the report version chain (S7)", () => {
  it("names a round by its revision and where it stands, and marks this version", () => {
    assert.equal(chainLabel({ revision: 1, status: "published", current: false }), "Round 1 · issued");
    assert.equal(chainLabel({ revision: 2, status: "in_client_review", current: true }), "Round 2 · open for the client's review (this version)");
    assert.equal(chainLabel({ revision: 1, status: "superseded", current: false }), "Round 1 · replaced by a later round");
  });
  it("says what a restore changes and what it does not, before and after", () => {
    assert.match(RESTORE_NOTE(1), /wording of round 1/);
    assert.match(RESTORE_NOTE(1), /sections and every figure stay as they are/);
    assert.equal(restoredMessage(["a", "b"], 1), "Restored the wording of 2 sections from round 1. The edit history shows what changed.");
    assert.equal(restoredMessage(["a"], 2), "Restored the wording of 1 section from round 2. The edit history shows what changed.");
    assert.match(restoredMessage([], 1), /Nothing to restore/);
  });
  it("the two reads are staff-only (report.view), GET-only and write nothing; the restore route runs only report.restoreVersion", () => {
    for (const file of ["../app/api/isolated/report-versions/[versionId]/chain/route.ts", "../app/api/isolated/report-versions/[versionId]/chain/[fromId]/route.ts"]) {
      const route = read(file);
      assert.match(route, /requireCapability\(principal, "report\.view"\)/, file);
      assert.match(route, /export async function GET/, file);
      assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/, file);
      assert.match(route, /withTenantRead/, file);
    }
    const restore = read("../app/api/isolated/reports/restore/route.ts");
    assert.match(restore, /requireCommandPrincipal\(request, "report\.restoreVersion"\)/);
    assert.match(restore, /restoreReportVersion\(isolatedPool\(\), body, commandContext\(request, principal\)\)/);
  });
  it("the panel offers Restore only on a round the CRM may still amend, previews through the read route, and sends the version it was looking at", () => {
    const panel = read("../app/jobs/[jobId]/report/ReportVersionChain.tsx");
    assert.match(panel, /staffMayEditNarrative\(current\.status\)/);
    assert.match(panel, /canRestore \?/);
    assert.match(panel, /expectedVersion: current\.version/);
    assert.match(panel, /RESTORE_NOTE\(entry\.revision\)/, "a confirm note before the call");
    assert.equal((panel.match(/data-version-restore-confirm/g) ?? []).length, 1);
    assert.match(read("../app/jobs/[jobId]/report/ReportStudio.tsx"), /<ReportVersionChain reportVersionId=/);
  });
});
