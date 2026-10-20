import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withUsage, type ReportComposition } from "@nzi/contracts";
import { USAGE_SITE, usageGroupingComposition } from "./support/usagePin";
(globalThis as { React?: unknown }).React = React;
/* eslint-disable @typescript-eslint/no-require-imports */
const { ReportComposedView } = require("../app/reports/[versionId]/ReportComposedView") as typeof import("../app/reports/[versionId]/ReportComposedView");

/**
 * Dedup slice 2 (0171): one factor reported under several usages — "Fleet diesel — HGV / Van / Car" — without a factor per label.
 *
 * A new pin beside composed@6's, not a change to it: the composed@1–6 pins are byte-identical, because a measurement with no
 * usage composes exactly as before (`withUsage` returns the label unchanged), and every existing fixture has none.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const render = (composition: ReportComposition) => renderToStaticMarkup(createElement(ReportComposedView, { composition }));

describe("usage grouping in the composed report (dedup slice 2)", () => {
  it("a line takes its usage after a dash; with no usage the label is exactly as it was", () => {
    assert.equal(withUsage("Fleet diesel", "HGV"), "Fleet diesel — HGV");
    for (const none of [null, undefined, "", "  "]) assert.equal(withUsage("Fleet diesel", none), "Fleet diesel");
  });

  it("splits one diesel line into three labelled usages that sum to it, at the site and in the audit", () => {
    const whole = JSON.parse(fixture("composition-composed6-whole.json")) as ReportComposition;
    const usage = usageGroupingComposition();
    const siteOf = (composition: ReportComposition) => (composition.emissions as unknown as { sites: Array<{ siteId: string; tco2e: number; activities: Array<{ label: string; tco2e: number }> }> }).sites.find((site) => site.siteId === USAGE_SITE)!;
    assert.deepEqual(siteOf(usage).activities.filter((activity) => activity.label.startsWith("Fleet diesel")).map((activity) => [activity.label, activity.tco2e]),
      [["Fleet diesel — HGV", 300], ["Fleet diesel — Van", 200], ["Fleet diesel — Car", 120]]);
    const sum = (activities: Array<{ tco2e: number }>) => activities.reduce((total, activity) => total + activity.tco2e, 0);
    assert.equal(sum(siteOf(usage).activities), sum(siteOf(whole).activities), "the usages sum to the one line they replace");
    assert.equal(usage.audit!.totalTco2e, whole.audit!.totalTco2e);
    assert.deepEqual(usage.audit!.rows.filter((row) => row.activity.startsWith("Fleet diesel — ")).map((row) => row.activity),
      ["Fleet diesel — HGV", "Fleet diesel — Van", "Fleet diesel — Car"]);
  });

  it("draws it byte-for-byte as pinned — the composition and its render frozen together", () => {
    const frozen = JSON.parse(fixture("composition-composed6-usage.json")) as ReportComposition;
    assert.deepEqual(frozen, usageGroupingComposition(), "the pinned composition is the one the real composer builds");
    const html = render(frozen);
    assert.equal(html, fixture("composition-composed6-usage.html"));
    for (const line of ["Fleet diesel — HGV", "Fleet diesel — Van", "Fleet diesel — Car"]) assert.ok(html.includes(line), `${line} is drawn`);
  });
});
