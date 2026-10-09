import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportComposition } from "@nzi/contracts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/**
 * F-0 (RULING-reporting-F Q4): the composed report's layout is versioned, and `composed@1` is pinned byte-for-byte.
 *
 * Each pin is the **unmodified** view's own render, taken before F-0 touched it:
 * - `composition-pre-s2`: `main` @ d2c1bd22's render of a real pre-S-2 composition (targets, plan and SRS are gaps);
 * - `composition-pre-f-whole`: `main` @ 6d13b92f's render of a real composition with every section filled — sites with the
 *   organisation-level line, intensity, targets, plan, SRS with radar and roadmap — from `reportCompositionSerialReal`'s
 *   fixture;
 * - `composition-pre-f-sites`: the same, recomposed for two sites (flags, unallocated statement, comparison, a period
 *   conflict).
 *
 * The bump rule is binding: if a change would alter any of these, **do not update the pin** — fork to `composed@2` and keep
 * `composed@1` drawing these exactly.
 */
describe("the composed report's layout is versioned, and composed@1 is pinned (F-0)", () => {
  const render = async (composition: ReportComposition) => {
    (globalThis as { React?: unknown }).React = React;
    const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
    return renderToStaticMarkup(createElement(ReportComposedView, { composition }));
  };
  const pins = ["composition-pre-s2", "composition-pre-f-whole", "composition-pre-f-sites"] as const;

  for (const pin of pins) {
    it(`draws ${pin} byte-for-byte as composed@1 always has`, async () => {
      assert.equal(await render(JSON.parse(fixture(`${pin}.json`))), fixture(`${pin}.html`));
    });
  }

  it("draws a composition stamped composed@1 exactly as one issued before the stamp", async () => {
    // New compositions carry the stamp; issued ones do not. Both are composed@1 and must be the same document.
    for (const pin of pins) {
      const composition = JSON.parse(fixture(`${pin}.json`)) as ReportComposition;
      assert.equal(composition.renderer, undefined, "the pins predate the stamp");
      assert.equal(await render({ ...composition, renderer: "composed@1" }), fixture(`${pin}.html`));
    }
  });

  it("refuses to draw a layout it does not carry, rather than drawing the report differently", async () => {
    const composition = JSON.parse(fixture("composition-pre-f-whole.json")) as ReportComposition;
    const html = await render({ ...composition, renderer: "composed@99" });
    assert.match(html, /issued with a layout \(composed@99\) this console does not carry/);
    assert.doesNotMatch(html, /nzr-sechd|Emissions by scope|nzr-cover/, "no section is drawn under a layout it was not issued with");
  });

  it("numbers sections from the plan: the Sites section takes 03 when frozen, and nothing leaves a hole", async () => {
    const numbers = (html: string) => [...html.matchAll(/<span class="n">(\d+)<\/span>/g)].map((match) => match[1]);
    const pages = (html: string) => [...html.matchAll(/<div class="nzr-pf"><span>[^<]*<\/span><span>(\d+)<\/span>/g)].map((match) => Number(match[1]));
    const withSites = await render(JSON.parse(fixture("composition-pre-f-whole.json")));
    assert.deepEqual(numbers(withSites), ["01", "02", "03", "04", "05", "06", "07", "08"]);
    assert.deepEqual(pages(withSites), [2, 3, 4, 5, 6, 7, 8, 9]);
    assert.match(withSites, /<span class="n">03<\/span><div><div class="eyebrow">Boundary<\/div><h2>Sites &amp; reporting boundary<\/h2>/);
    const withoutSites = await render(JSON.parse(fixture("composition-pre-s2.json")));
    assert.deepEqual(numbers(withoutSites), ["01", "02", "03", "04", "05", "06", "07"]);
    assert.deepEqual(pages(withoutSites), [2, 3, 4, 5, 6, 7, 8]);
  });
});
