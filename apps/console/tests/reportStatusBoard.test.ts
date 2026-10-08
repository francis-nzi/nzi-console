import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/** R-ST1 (ruled): the report pipeline on the Reports page — derived, read-only, honest about what it could not read. */
describe("the report pipeline board (R-ST1)", () => {
  const board = read("apps/console/app/reports/ReportStatusBoard.tsx");
  const route = read("apps/console/app/api/isolated/report-status/route.ts");
  const page = read("apps/console/app/reports/page.tsx");

  it("derives every stage from the one contracts rule, and decides nothing itself", () => {
    assert.match(board, /countReportStages\(scoped\)/);
    assert.ok(!/deriveReportStatus/.test(board), "the stage arrives derived from the server; the board only counts and filters");
  });

  it("is read-only oversight: no writes, no editing affordances", () => {
    for (const write of ["method: \"POST\"", "postBrowserCommand", "putBrowserCommand", "GatedButton"]) assert.ok(!board.includes(write), write);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) assert.doesNotMatch(route, new RegExp(`export async function ${method}\\b`), method);
    assert.match(route, /requireCapability\(principal,"report\.view"\)/);
  });

  it("says the pipeline is unavailable rather than showing zeros when the read fails", () => {
    assert.match(board, /Report pipeline unavailable/);
    assert.match(board, /No stage counts are shown/);
  });

  it("offers 'My clients' as a view over the client's owner, not a permission", () => {
    assert.match(board, /job\.ownerUserId === viewer/);
  });

  it("sits on the Reports page above the version register", () => {
    assert.ok(page.indexOf("<ReportStatusBoard/>") > -1 && page.indexOf("<ReportStatusBoard/>") < page.indexOf("<LiveReportRegister/>"));
  });
});
