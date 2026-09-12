import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Breadcrumbs, type Crumb } from "../src/index";

/**
 * The breadcrumb's contract: a labelled nav, every crumb a real link — the current page
 * included, so it can be copied or reopened — decorative separators, and exactly one
 * `aria-current="page"`.
 */
const trail: Crumb[] = [
  { label: "Clients", href: "/clients" },
  { label: "Northwind Manufacturing", href: "/clients/client-a" },
  { label: "Jobs", href: "/jobs?client=client-a" },
  { label: "J000712", href: "/jobs/job-712" },
  { label: "Scope rows", href: "/jobs/job-712", current: true },
];

describe("Breadcrumbs", () => {
  const html = renderToStaticMarkup(createElement(Breadcrumbs, { items: trail }));

  it("is a labelled navigation landmark holding an ordered list", () => {
    assert.match(html, /<nav aria-label="Breadcrumb"/);
    assert.match(html, /<ol class="nz-crumblist">/);
    assert.equal((html.match(/<li>/g) ?? []).length, trail.length);
  });

  it("makes every crumb a link, the current one included", () => {
    assert.equal((html.match(/<a /g) ?? []).length, trail.length);
    for (const crumb of trail) assert.ok(html.includes(`href="${crumb.href}"`), crumb.label);
  });

  it("marks exactly one crumb as the current page without disabling it", () => {
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    assert.match(html, /href="\/jobs\/job-712" class="nz-crumb current" aria-current="page">Scope rows</);
  });

  it("hides the separators from assistive technology", () => {
    assert.equal((html.match(/aria-hidden="true">\//g) ?? []).length, trail.length - 1);
  });

  it("renders through the app's own link component when one is given", () => {
    const withRouterLink = renderToStaticMarkup(createElement(Breadcrumbs, {
      items: trail.slice(0, 2),
      link: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { ...rest, href: `${href}#routed` }, children as never),
    }));
    assert.match(withRouterLink, /href="\/clients#routed"/);
  });
});
