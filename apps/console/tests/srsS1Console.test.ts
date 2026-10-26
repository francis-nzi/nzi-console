import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ADMIN_ITEMS } from "../app/admin/adminNav";

/**
 * SRS S1 in the console: the Admin SRS framework page (R1 — versions, a draft, publish) and the client's SRS area dated
 * on completion (R3 — in progress vs assessed, completion held until every requirement is addressed, no date typed at
 * start, a reassessment that starts a new assessment).
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const page = read("app/admin/srs-framework/page.tsx");
const board = read("app/admin/srs-framework/SrsFrameworkBoard.tsx");
const area = read("app/clients/[clientId]/SrsArea.tsx");
const start = read("app/clients/[clientId]/SrsAssessmentForms.tsx");

describe("the Admin SRS framework (R1)", () => {
  it("is on the admin rail, live, under admin.lookups", () => {
    const item = ADMIN_ITEMS.find((entry) => entry.id === "srs-framework");
    assert.deepEqual([item?.href, item?.capability, item?.phase], ["/admin/srs-framework", "admin.lookups", undefined]);
  });

  it("reads every version, the one in force and the draft, and edits only with admin.lookups and writes on", () => {
    assert.match(page, /listSrsFrameworkVersions\(db\)/);
    assert.match(page, /getSrsFramework\(db, draftId\)/);
    assert.match(page, /holds\(access\.capabilities, "admin\.lookups"\)/);
  });

  it("edits only a draft: the version in force is read-only, and a new version starts as a copy", () => {
    assert.match(board, /const editable = Boolean\(draft\) && editing\.allowed/);
    assert.match(board, /editing\.allowed && !draft && active/);
    assert.match(board, /"\/api\/isolated\/srs-framework\/publish", \{ frameworkId: draft\.frameworkId, effectiveFrom \}/);
  });

  it("routes each framework command through the command runner's principal check", () => {
    for (const [path, command] of [["srs-framework/route.ts", "srs.framework.draft.create"], ["srs-framework/requirements/route.ts", "srs.framework.requirement.upsert"],
      ["srs-framework/maturity/route.ts", "srs.framework.maturity.update"], ["srs-framework/publish/route.ts", "srs.framework.publish"]] as const) {
      assert.match(read(`app/api/isolated/${path}`), new RegExp(`requireCommandPrincipal\\(request, "${command.replace(/\./g, "\\.")}"\\)`), path);
    }
  });
});

describe("the client's SRS area, dated on completion (R3)", () => {
  it("says in progress — with how much is addressed — or assessed, never an assessed date on a draft", () => {
    // S2: the completion reads through the dashboard model (S1's `srsCompletion`), and the date only from a completed one.
    assert.match(area, /In progress · \$\{currentCompletion\.addressed\} of \$\{currentCompletion\.total\} addressed/);
    assert.match(area, /not yet assessed — it is dated when every requirement is addressed/);
    assert.match(area, /model\.assessment\.assessedOn\s*\?/);
    assert.match(read("../../packages/contracts/src/srsDashboard.ts"), /assessedOn: isAssessed\(assessment\) \? assessment\.assessedOn : null/);
  });

  it("holds Complete until every requirement is addressed, and reassessing starts a new assessment", () => {
    assert.match(area, /blocked=\{access\.state !== "allowed" \|\| !completionReady \|\| completing\}/);
    assert.match(area, /onClick=\{\(\) => onDrawer\(\{ kind: "srs-start" \}\)\}>Reassess/);
  });

  it("draws the trend from completed assessments only, and asks for no date at start", () => {
    const dashboard = read("../../packages/contracts/src/srsDashboard.ts");
    assert.match(dashboard, /const completed = assessments\.filter\(isAssessed\)/);
    assert.match(dashboard, /overall: completed\.map\(/);
    assert.match(area, /model\.trend\.overall\.map/);
    assert.doesNotMatch(start, /assessedOn/);
  });
});
