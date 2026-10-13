import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * B1 step 1 (RULING-report-studio-consolidation R3/R6): the pre-issue preview names one source line per chart — the
 * snapshot and its stamped datasets, by id. An issued surface keeps its charts as they were drawn when issued.
 */
describe("the report source line (R3/R6)", () => {
  it("the pre-issue preview gives every chart it draws the snapshot's source summary, once, where it resolves them", () => {
    const page = read("apps/console/app/report-preview/page.tsx");
    assert.match(page, /const charts = withSourceSummary\(resolveCrpCoreCharts\(\{/);
    assert.match(page, /\}, \{ resolverVersion: CRP_RESOLVER_AGGREGATED \}\), snapshotSourceSummary\(snapshot\)\);/, "B1: and draws activities as composed@3 will");
    assert.equal(page.split("resolveCrpCoreCharts(").length - 1, 1, "one resolution, so the manifest set and the charts above it agree");
  });

  it("no issued surface sets it — the print page, the portal dashboard, the legacy report, and the composed renderers", () => {
    for (const path of [
      "apps/console/app/portal/jobs/[jobId]/print/page.tsx",
      "apps/console/app/portal/jobs/[jobId]/PortalDashboard.tsx",
      "apps/console/app/reports/[versionId]/page.tsx",
      "apps/console/app/reports/[versionId]/scopeCharts.ts",
    ]) {
      const source = read(path);
      assert.doesNotMatch(source, /withSourceSummary|snapshotSourceSummary|sourceSummary/, `${path} stays as it was issued`);
    }
  });

  it("in the composed view only composed@3 sets it, from its frozen sources — composed@1 and composed@2 are dispatched as before", () => {
    const view = read("apps/console/app/reports/[versionId]/ReportComposedView.tsx");
    const dispatch = (renderer: string) => view.split("\n").find((line) => line.includes(`if (renderer === "${renderer}")`)) ?? "";
    assert.equal(dispatch("composed@1"), `  if (renderer === "composed@1") return <ComposedV1 composition={composition} issuerLogoSrc={issuerLogoSrc} />;`);
    assert.doesNotMatch(dispatch("composed@2"), /v3=|withSourceSummary|CRP_RESOLVER_AGGREGATED/);
    assert.match(dispatch("composed@3"), /v3=\{\{ preview \}\}/);
    assert.match(view, /const summary = v3 \? composition\.sources\?\.summary : undefined;/, "the summary is read only under composed@3");
  });
});
