// Data entry D3 (R2–R6) in the console: the import preview says what it will do with each line and counts only what it writes; the
// roll-forward says whether its prior job is the stored basis or proposed, one line per GL code; the Review & QA trend opens a
// category's lines across the years in a drawer; the portal offers "Ask to reopen" on a reviewed entry the client made (no recall),
// and the CRM sees the job's open requests. The writes are proved in dataEntryD3CarryReal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { mayAskToReopen } from "../app/portal/data/portalDataView";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");

describe("R6 — who may ask to reopen", () => {
  const row = (over: Record<string, unknown>) => ({ editable: false, enabled: true, origin: "live", reviewStatus: "approved", provenance: { capturedAs: "client-portal" }, ...over }) as never;
  it("a reviewed entry the client made, live and enabled", () => {
    assert.equal(mayAskToReopen(row({})), true);
    assert.equal(mayAskToReopen(row({ reviewStatus: "rejected" })), true);
  });
  it("not one they can still change, one staff made, a migrated one or a deactivated one", () => {
    assert.equal(mayAskToReopen(row({ editable: true, reviewStatus: "pending" })), false);
    assert.equal(mayAskToReopen(row({ provenance: { capturedAs: "staff" } })), false);
    assert.equal(mayAskToReopen(row({ origin: "migrated" })), false);
    assert.equal(mayAskToReopen(row({ enabled: false })), false);
  });
});

describe("the wiring", () => {
  it("R2/R4: the import preview names each line's reconciliation, and imports only what it writes", () => {
    const panel = source("app/jobs/SpendImportPanel.tsx");
    assert.match(panel, /Fills the line carried forward for its GL code/);
    assert.match(panel, /Already on this job — not imported again/);
    assert.match(panel, /importWritableCount\(preflight\.summary\)/);
  });
  it("R3/R4: the roll-forward says whether its prior job is fixed, and that it carries one line per GL code", () => {
    const panel = source("app/jobs/SpendRollforwardPanel.tsx");
    assert.match(panel, /preview\.priorJob\.fixed/);
    assert.match(panel, /carried as one/);
  });
  it("R5: each category in the trend opens its lines across the years, from the line-years read", () => {
    assert.match(source("app/jobs/CrpAssuranceStage.tsx"), /<CategoryLinesDrawer jobId=\{jobId\} category=\{linesFor\}/);
    assert.match(source("app/jobs/CategoryLinesDrawer.tsx"), /\/line-years\?category=/);
    assert.match(source("app/api/isolated/jobs/[jobId]/line-years/route.ts"), /readCategoryLineYears\(db, jobId, category\)/);
  });
  it("R6: the portal asks through its own route (the console origin from the environment, never the body); the CRM sees open requests", () => {
    const route = source("app/api/portal/jobs/[jobId]/scope-rows/[rowId]/reopen-request/route.ts");
    assert.match(route, /requestScopeRowReopen\(/);
    assert.match(route, /process\.env\.NZI_ISOLATED_API_URL/);
    assert.match(route, /requirePortalData\(\)/);
    assert.match(source("app/portal/jobs/[jobId]/data/PortalDataView.tsx"), /\$\{base\}\/reopen-request/);
    assert.match(source("app/jobs/CrpScopeWorkspace.tsx"), /<ReopenRequestsBanner jobId=\{job\.header\.id\}/);
  });
});

describe("the import preview's route answers in the envelope the panel reads", () => {
  it("wraps the preview (and the no-period refusal) in { data } — a bare body was read as a failure", () => {
    const route = source("app/api/isolated/jobs/[jobId]/spend-import/preflight/route.ts");
    assert.match(route, /Response\.json\(\{ data: await previewSpendImport\(/);
    assert.match(route, /Response\.json\(\{ data: \{ kind: "blocked"/);
  });
});
