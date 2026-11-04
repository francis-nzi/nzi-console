import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { drawerLabel } from "../app/clients/[clientId]/clientDrawers";

/**
 * The client's template is a DATA ENTRY template (what a job starts collecting), not a report-format template (that is Report Studio).
 * Display strings only: identifiers, routes, command keys and CSS classes keep their old names.
 */
(globalThis as { React?: unknown }).React = React;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const allowed = { state: "allowed" } as never;
const empty = { current: null, latestVersion: 0, categories: [] } as never;
const filled = {
  latestVersion: 2, categories: [{ code: "1.natural-gas", scope: "1", name: "Natural gas" }],
  current: { version: 2, active: true, origin: "job", originJobNumber: "J000612", setBy: "Ada", setAt: "2026-10-01T10:00:00Z", lines: [
    { lineId: "l1", scope: "1", categoryCode: "1.natural-gas", categoryName: "Natural gas", sourceLabel: "Office boiler", reportLabel: null, siteId: null, siteName: null, datasetId: null, factorId: null, factorLabel: null, unit: "kWh", ordering: 0 }] },
} as never;
const noop = () => undefined;

describe("the client's data entry template: what the screen says", () => {
  it("the empty card is headed Data entry template and describes data entry, not reporting", async () => {
    const { ReportingTemplateCard } = await import("../app/clients/[clientId]/ClientReportingTemplate");
    const html = renderToStaticMarkup(createElement(ReportingTemplateCard, { template: empty, access: allowed, onEdit: noop, onInitialise: noop }));
    assert.match(html, /<span class="eyebrow">Data entry<\/span><h2>Data entry template<\/h2>/);
    assert.match(html, /None set/);
    assert.doesNotMatch(html, /[Rr]eporting template|>Reporting</);
    // The card's body is collapsed in static markup, so its copy is read from the source.
    const source = readFileSync(resolve(root, "apps/console/app/clients/[clientId]/ClientReportingTemplate.tsx"), "utf8");
    assert.ok(source.includes("No data entry template yet. It holds the rows this client collects each year — scopes, categories and the lines under them — so a new job starts from them rather than a blank page."));
    assert.ok(source.includes("Initialise from a job…") && source.includes("Set it up by hand"), "the two ways in");
  });

  it("a card with a template in force offers Edit lines (the template is edited in place), under the same heading", async () => {
    const { ReportingTemplateCard } = await import("../app/clients/[clientId]/ClientReportingTemplate");
    const html = renderToStaticMarkup(createElement(ReportingTemplateCard, { template: filled, access: allowed, onEdit: noop, onInitialise: noop }));
    assert.match(html, /<h2>Data entry template<\/h2>/);
    assert.match(html, /1 line/);
    assert.doesNotMatch(html, /[Rr]eporting template/);
    const source = readFileSync(resolve(root, "apps/console/app/clients/[clientId]/ClientReportingTemplate.tsx"), "utf8");
    assert.ok(source.includes('{current ? "Edit lines" : "Set it up by hand"}'), "an existing template is reopened with Edit lines");
    assert.ok(source.includes("onClick={onInitialise}>Initialise from a job…"), "and can be re-initialised from a job");
  });

  it("both drawers carry the new title and kicker, and their saved messages say it too", async () => {
    const { ReportingTemplateForm, ReportingTemplateInitialiseForm } = await import("../app/clients/[clientId]/ClientReportingTemplate");
    const editor = renderToStaticMarkup(createElement(ReportingTemplateForm, { clientId: "c1", template: filled, access: allowed, onClose: noop, onSaved: noop }));
    assert.match(editor, /<div class="k">Data entry<\/div><h3>Data entry template<\/h3>/);
    assert.match(editor, /Saving writes the next version; the one before stays in the record/);
    const init = renderToStaticMarkup(createElement(ReportingTemplateInitialiseForm, { clientId: "c1", template: filled, jobs: [], access: allowed, onClose: noop, onSaved: noop }));
    assert.match(init, /<div class="k">Data entry<\/div><h3>Initialise from a job<\/h3>/);
    const source = readFileSync(resolve(root, "apps/console/app/clients/[clientId]/ClientReportingTemplate.tsx"), "utf8");
    for (const message of ["Data entry template saved.", "Data entry template withdrawn — kept in the record.", "Data entry template initialised from"]) assert.ok(source.includes(message), message);
    assert.equal(drawerLabel({ kind: "reporting-template" } as never), "Data entry template");
    assert.equal(drawerLabel({ kind: "reporting-template-initialise" } as never), "Initialise the data entry template from a job");
  });

  it("the job's seeding panel and the messages around the template use the same name", () => {
    const seeding = readFileSync(resolve(root, "apps/console/app/jobs/JobTemplateSeeding.tsx"), "utf8");
    assert.ok(seeding.includes('aria-label="Data entry template"') && seeding.includes("<b>Data entry template v{") && seeding.includes("The data entry template could not be read."));
    const backend = readFileSync(resolve(root, "packages/isolated-backend/src/jobTemplateSeeding.ts"), "utf8");
    assert.ok(backend.includes("This client has no data entry template in force to seed from."));
  });

  it("no 'Reporting template' is left in any string a person reads on the Client surface or the job's seeding panel (comments and identifiers aside)", () => {
    const offenders: string[] = [];
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? (["node_modules", ".next"].includes(entry) ? [] : walk(full)) : /\.(ts|tsx)$/.test(entry) ? [full] : [];
    });
    const files = [...walk(resolve(root, "apps/console/app/clients")), resolve(root, "apps/console/app/jobs/JobTemplateSeeding.tsx"), resolve(root, "apps/console/app/jobs/CrpScopeWorkspace.tsx")];
    for (const file of files) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return;                      // comments
        const code = line.replace(/\{\/\*.*?\*\/\}/g, "").replace(/(^|\s)\/\/ .*$/, "");
        if (/reporting template/i.test(code)) offenders.push(`${relative(root, file)}:${index + 1}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
