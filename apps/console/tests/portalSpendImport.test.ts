// Portal bulk import, Spend 3.1 Phase A (RULING-portal-import-spend), in the console: one tab for paste and CSV, the CRM's reader and
// column mapper, a headers-only template, columns remembered for the upload only, the category shown and never chosen, the identity issued
// by the server — and nothing of the staff register or the staff mapping record. The review, the routing and the filing are
// `portalSpendImportReal`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React from "react";
import { PORTAL_IMPORT_TEMPLATES } from "@nzi/contracts";
import { SPEND_IMPORT_TEMPLATE_HEADERS } from "../app/jobs/spendImportTemplate";

(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
let mod: typeof import("../app/portal/PortalSpendImport");
before(async () => { mod = await import("../app/portal/PortalSpendImport"); });

describe("portal spend import (Phase A)", () => {
  it("issues the CRM's columns, headers only, named by category and reporting period", () => {
    assert.equal(mod.portalSpendTemplateCsv().trim().split(/\r?\n/).length, 1, "no worked example to be imported by being left in");
    assert.equal(mod.portalSpendTemplateCsv().replace(/"/g, "").trim(), SPEND_IMPORT_TEMPLATE_HEADERS.join(","));
    assert.equal(mod.portalSpendTemplateName(["2026-01", "2026-12"]), "Spend ledger template 2026-01 to 2026-12.csv");
    assert.equal(mod.portalSpendTemplateName([]), "Spend ledger template.csv");
    assert.ok((PORTAL_IMPORT_TEMPLATES as readonly string[]).includes("spend"));
  });

  it("is the CRM's reader and mapper, in one tab for the paste and the CSV, with the mapping for this upload only", () => {
    const component = read("app/portal/PortalSpendImport.tsx");
    for (const reused of ["parseDelimited", "autoMapColumns", "applyMapping", "resolveDraftRows"]) assert.match(component, new RegExp(reused), reused);
    assert.match(component, /Upload a \.csv file/);
    assert.match(component, /…or paste the lines/);
    assert.match(component, /used for this upload only/);
    assert.doesNotMatch(component, /import-mappings|fromNamedColumnMap|toNamedColumnMap|putBrowserCommand/, "the staff mapping record is not read or written from the portal");
  });

  it("shows where each line is filed and gives the client no way to choose or change it", () => {
    const component = read("app/portal/PortalSpendImport.tsx");
    assert.match(component, /<th>Filed under<\/th>/);
    assert.match(component, /\{review\.filedUnder \?\? /);
    // The only inputs are the file, the pasted text and the column mapping; no category select, no routing field in what is sent.
    assert.doesNotMatch(component, /categoryCode|targetCategory|routing|allocation/);
    assert.match(component, /spend-import\/preview/);
    assert.match(component, /\{ template: "spend", rows: \[\], spend: \{ lines \} \}/, "the commit sends lines only: no token, no rows");
  });

  it("says what it leaves: lines already here, and lines matching a carried-forward line, which the adviser reconciles", () => {
    const component = read("app/portal/PortalSpendImport.tsx");
    assert.match(component, /Already here — not imported again\./);
    assert.match(component, /Matches a line carried forward from last year; \$\{adviser\} will reconcile it\./);
    assert.doesNotMatch(component, /SpendLedgerAdapter|SpendRollforwardPanel|voidBatch|spend-import\/void/);
  });

  it("is offered on 3.1 only, behind the spend-import flag, uploading only inside an open window outside the staff preview", () => {
    const view = read("app/portal/jobs/[jobId]/data/PortalDataView.tsx");
    assert.match(view, /category\.code === "3\.1" && dataEntryAdapterEnabled\("spend-import"\)/);
    assert.match(view, /<PortalSpendImport[\s\S]*canImport=\{open && !surface\.readOnly\}/);
  });

  it("previews through a portal route (flag, origin, session, job grant) and commits through the import route, which issues the identity itself", () => {
    const preview = read("app/api/portal/jobs/[jobId]/spend-import/preview/route.ts");
    assert.match(preview, /requirePortalData\(\);\s+requirePortalOrigin\(request\);\s+const user = await currentPortalUserForData\(request\)/);
    assert.match(preview, /previewPortalSpendImport\(isolatedPool\(\), user, jobId, lines, process\.env\.NZI_CONSOLE_SESSION_SECRET\)/);
    assert.match(preview, /slice\(0, PORTAL_IMPORT_MAX_ROWS\)/);
    const commit = read("app/api/portal/jobs/[jobId]/scope-rows/import/route.ts");
    assert.match(commit, /issueSpendImportIdentity\(isolatedPool\(\), user\.organisationId, jobId, secret\)/);
    assert.match(commit, /spend: \{ token: issued\.token, lines: body\.spend\?\.lines \?\? \[\] \}/, "the client's own token is ignored");
    assert.match(commit, /\{ spendSecret: secret \}/);
  });

  it("never touches the staff register, the staff routes or the staff mapping record", () => {
    for (const path of ["app/portal/PortalSpendImport.tsx", "app/api/portal/jobs/[jobId]/spend-import/preview/route.ts"]) {
      assert.doesNotMatch(read(path), /\/api\/isolated\/|job_emission_sources|emission-sources|spend-import\/commit|client_import_mappings/, path);
    }
  });
});
