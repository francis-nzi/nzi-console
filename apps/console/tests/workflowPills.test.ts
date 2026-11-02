import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emissionCategoryTaxonomy } from "@nzi/contracts";
import { WorkflowPill } from "../app/jobs/WorkflowPill";
import { categoryWorkflowHref, scopeWorkflowHref, workflowCategoryCodes } from "../app/lib/workflowDocs";

/** The "WF" pills: bound to the stored category_code / scope, one doc each, a link that never toggles the accordion. */
(globalThis as { React?: typeof React }).React = React; // the pill is JSX; the test runner compiles it on the classic runtime
const docsDir = new URL("../public/workflows/", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("workflow doc mapping (keyed on category_code)", () => {
  it("maps every one of the 21 taxonomy categories to a doc that is hosted", () => {
    assert.equal(emissionCategoryTaxonomy.length, 21);
    for (const category of emissionCategoryTaxonomy) {
      const href = categoryWorkflowHref(category.code);
      assert.ok(href, `${category.code} has a doc`);
      assert.ok(existsSync(new URL(`.${href!.replace("/workflows", "")}`, docsDir)), `${href} is hosted`);
    }
    assert.deepEqual([...workflowCategoryCodes].sort(), emissionCategoryTaxonomy.map((c) => c.code).sort(), "no mapped code is outside the taxonomy");
  });

  it("pins the Scope 1 and Scope 2 stored codes to their docs", () => {
    assert.equal(categoryWorkflowHref("1.natural-gas"), "/workflows/WF-1-natural-gas.html");
    assert.equal(categoryWorkflowHref("1.other-stationary-fuels"), "/workflows/WF-1-other-stationary-fuels.html");
    assert.equal(categoryWorkflowHref("1.company-vehicles"), "/workflows/WF-1-company-vehicles.html");
    assert.equal(categoryWorkflowHref("1.refrigerants"), "/workflows/WF-1-refrigerants.html");
    assert.equal(categoryWorkflowHref("2.purchased-electricity"), "/workflows/WF-2-purchased-electricity.html");
    assert.equal(categoryWorkflowHref("2.renewable-electricity"), "/workflows/WF-2-renewable-electricity.html");
    assert.equal(categoryWorkflowHref("3.6"), "/workflows/WF-3.6-business-travel.html");
    assert.equal(categoryWorkflowHref("3.12"), "/workflows/WF-3.12-end-of-life-sold-products.html");
  });

  it("maps the three scope headers, and nothing else", () => {
    assert.deepEqual(["1", "2", "3"].map(scopeWorkflowHref), ["/workflows/WF-scope-1-overview.html", "/workflows/WF-scope-2-overview.html", "/workflows/WF-scope-3-overview.html"]);
    for (const scope of ["4", "", null, undefined, "constructor"]) assert.equal(scopeWorkflowHref(scope as string), null);
  });

  it("gives an unmapped or null code no doc — a label is not a key", () => {
    for (const code of [null, undefined, "", "3.16", "Natural Gas", "natural gas", "constructor", "__proto__"]) assert.equal(categoryWorkflowHref(code as string), null, String(code));
  });

  it("hosts exactly the 24 docs and the index, with no script in any", () => {
    const files = readdirSync(docsDir).filter((name) => name.endsWith(".html"));
    assert.equal(files.length, 25);
    assert.ok(files.includes("index.html"));
    for (const file of files) assert.doesNotMatch(readFileSync(new URL(file, docsDir), "utf8"), /<script/i, file);
  });

  it("is reachable without a session: a dotted static path is outside the middleware matcher", () => {
    const matcher = /^\/((?!.*\..*).*)$/;
    assert.equal(matcher.test("/workflows/WF-1-natural-gas.html"), false);
    assert.equal(matcher.test("/jobs"), true);
  });
});

describe("the WF pill", () => {
  it("renders a new-tab link to the doc", () => {
    const html = renderToStaticMarkup(createElement(WorkflowPill, { href: "/workflows/WF-3.6-business-travel.html", label: "Business Travel" }));
    assert.match(html, /^<a /);
    assert.match(html, /href="\/workflows\/WF-3\.6-business-travel\.html"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener"/);
    assert.match(html, />WF<\/a>$/);
  });

  it("renders nothing when there is no doc", () => {
    assert.equal(renderToStaticMarkup(createElement(WorkflowPill, { href: null, label: "x" })), "");
  });

  it("stops its click from reaching the row that toggles", () => {
    assert.match(source("../app/jobs/WorkflowPill.tsx"), /onClick=\{\(event: MouseEvent\) => event\.stopPropagation\(\)\}/);
  });
});

describe("the accordion headers carry the pill without nesting it in the toggle button", () => {
  const crm = source("../app/jobs/CrpDataEntryAccordion.tsx");
  const preview = source("../app/portal/PortalDataEntryAccordion.tsx");

  it("binds scope headers to the scope and category headers to the stored code", () => {
    assert.ok(crm.includes("<WorkflowPill href={scopeWorkflowHref(group.scope)}"));
    assert.ok(crm.includes("<WorkflowPill href={categoryWorkflowHref(code)}"));
    assert.ok(preview.includes("<WorkflowPill href={scopeWorkflowHref(scope)}"));
    assert.ok(preview.includes("<WorkflowPill href={categoryWorkflowHref(section.code)}"));
  });

  it("toggles on the row, with the button as its control and the pill as a sibling link", () => {
    assert.ok(crm.includes("<div className=\"nz-acc-h\" onClick={() => toggle(code)}>"));
    assert.ok(crm.includes("<button type=\"button\" className=\"nz-acc-hmain\" aria-expanded={categoryOpen}>"));
    assert.ok(crm.indexOf("</button>\n                      <WorkflowPill href={categoryWorkflowHref(code)}") > 0, "the pill follows the closing button");
    assert.ok(crm.includes("className={`nz-acc-scopehead toggle${scopeOpen ? \" open\" : \"\"}`} onClick={() => toggle(scopeKey, scopeOpenByDefault(group))}>"));
    // The coded category headers are rows, not one wrapping button. (The synthetic "imported" and "unsorted" sections have no category_code, so no pill, and keep theirs.)
    const oldHeader = '<button type="button" className="nz-acc-h" aria-expanded={categoryOpen}';
    assert.ok(!crm.includes(oldHeader) && !preview.includes('<button type="button" className="nz-acc-h" aria-expanded={isOpen}'), "a coded header is no longer one button wrapping the link");
  });
});
