import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverReportVersion } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// R1 — print-safe chart pack (NZC-050; docs/ACCEPTANCE_R1_PRINT_SAFE_CHARTS.md).
// Runs only when a staff account is provided AND `report-svg-charts` is live on
// the target (NEXT_PUBLIC_FEATURE_REPORT_STUDIO). With the flag off the report
// renders exactly as before and the R1 markers are absent — the specs skip.

test.describe("R1 — print-safe report chart pack", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

  test("the report exposes one deterministic render-ready signal and print-safe charts", async ({ page }) => {
    const report = await discoverReportVersion(page.request);
    test.skip(!report, "no report versions on target");

    const errors = collectPageErrors(page);
    await page.goto(`/reports/${report!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);
    await expectHealthyScreen(page);

    const sheet = page.locator(".report-sheet");
    const ready = await sheet.getAttribute("data-report-ready");
    test.skip(ready === null, "report-svg-charts not enabled on target (report sheet has no data-report-ready)");

    // The single signal the PDF step waits on — set once every section + SVG is
    // in the DOM and every figure reconciles.
    await expect(sheet).toHaveAttribute("data-report-ready", "true");

    // Charts are inline SVG in the server-rendered markup, no canvas.
    await expect(page.locator(".report-sheet svg").first()).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);

    // Every rendered chart carries the visible "SVG · print-safe" marker.
    const charts = page.locator(".nz-chart-manifest-grid > div");
    const badges = page.locator(".nzc-print-safe");
    expect(await charts.count()).toBeGreaterThan(0);
    expect(await badges.count()).toBe(await charts.count());

    // The data-integrity check covers charts and passed.
    const integrity = page.locator(".nz-report-integrity");
    await expect(integrity).toBeVisible();
    await expect(integrity).not.toHaveClass(/fail/);
    await expect(integrity).toContainText(/every chart figure matches Outputs/i);

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the report surface passes the axe baseline and holds the column", async ({ page }) => {
    const report = await discoverReportVersion(page.request);
    test.skip(!report, "no report versions on target");
    await page.goto(`/reports/${report!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    test.skip(
      (await page.locator(".report-sheet[data-report-ready]").count()) === 0,
      "report-svg-charts not enabled on target",
    );

    await scanWithBaseline(page, "report-print-safe");
    await expectNoHorizontalOverflow(page, "report version");
  });
});
