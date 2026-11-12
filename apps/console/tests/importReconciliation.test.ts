import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveV7ImportTotals, V7_IMPORT_ROW_STATUSES, type V7ImportSummaryRow } from "@nzi/contracts";
import type { V7ImportView } from "@nzi/isolated-backend";
import { ADMIN_ITEMS } from "../app/admin/adminNav";
import { ImportJobView, ImportSessionsList, STATUS_LABEL, VERDICT_LINE } from "../app/admin/import/ImportReconciliation";

/**
 * The import workbench, Phase 1: the import view renders each status, the per-scope Σ on each side and the verdict, read-only,
 * behind import.manage. (The read model behind it is proved against a real database in v7ReingestRevertReal.)
 */
(globalThis as { React?: unknown }).React = React;

const base = { sourceSystem: "nzi-pro-v7" as const, code: "7_1", scope: "1" as const, consoleScope: "1" as const, v7Figure: 1, consoleFigure: 1, v7Enabled: true, consoleEnabled: true, pairRef: null, changedFields: [] as string[] };
const ROWS: V7ImportSummaryRow[] = [
  { ...base, legacyDbId: "1", status: "matched", consoleRowId: "v7-row-1" },
  { ...base, legacyDbId: "2", status: "changed", consoleRowId: "v7-row-2", v7Figure: 1.5, changedFields: ["migrated_record", "quantity"] },
  { ...base, legacyDbId: "3", status: "needs-mapping", consoleRowId: "v7-row-3", scope: "3", consoleScope: "3", changedFields: ["migrated_record", "migrated_record.original_id"] },
  { ...base, legacyDbId: "4", status: "new", consoleRowId: null, consoleScope: null, consoleFigure: null, consoleEnabled: null },
  { ...base, legacyDbId: "5", status: "withdrawn", consoleRowId: "v7-row-5", code: null, v7Figure: null, v7Enabled: null },
  { ...base, legacyDbId: "6", status: "linked-pair-changed", consoleRowId: "v7-row-6", pairRef: "v7-row-7", changedFields: ["migrated_record"] },
];
const totals = deriveV7ImportTotals(ROWS);
const VIEW: V7ImportView = {
  session: { sessionId: "v7-import-00000000-0000-0000-0000-000000000000", jobId: "job-1", jobNumber: "J000901", legacyJobNumber: "J000901", extractSha256: "c".repeat(64),
    generatedAt: "2026-11-12T09:00:00.000Z", uploadedAt: "2026-11-12T09:05:00.000Z", uploadedBy: "policy:v7-import", ...totals },
  rows: ROWS, earlierSessions: 0,
};

describe("the import view (import workbench, Phase 1)", () => {
  const html = renderToStaticMarkup(createElement(ImportJobView, { view: VIEW }));

  it("renders every status, once per row", () => {
    for (const status of V7_IMPORT_ROW_STATUSES) {
      assert.ok(html.includes(`data-status="${status}"`), status);
      assert.ok(html.includes(`>${STATUS_LABEL[status]}<`), STATUS_LABEL[status]);
    }
    assert.ok(html.includes("paired with"), "a pair names its partner");
  });

  it("renders the per-scope Σ on each side, and the verdict line", () => {
    for (const scope of ["1", "2", "3"]) assert.ok(html.includes(`data-scope="${scope}"`), scope);
    assert.equal(totals.verdict, "blocked-on-pairs");
    assert.ok(html.includes(VERDICT_LINE["blocked-on-pairs"]));
    assert.ok(html.includes("Console Σ") && html.includes("Previous system Σ"));
  });

  it("is read-only: no form, button or input", () => {
    const list = renderToStaticMarkup(createElement(ImportSessionsList, { sessions: [VIEW.session], selected: "job-1" }));
    for (const markup of [html, list]) assert.ok(!/<(form|button|input|select|textarea)\b/.test(markup));
  });

  it("is gated on import.manage, in the rail and on the page", () => {
    assert.equal(ADMIN_ITEMS.find((item) => item.id === "import")?.capability, "import.manage");
    const page = readFileSync(new URL("../app/admin/import/page.tsx", import.meta.url), "utf8");
    assert.ok(page.includes(`holds(access.capabilities, "import.manage")`));
  });

  it("never says the internal name on the screen", () => {
    assert.ok(!/(?<![\w.-])v7(?![\w-])/i.test(html.replace(/v7-(row|import)-[\w-]+/g, "")));
  });
});
