import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverReportVersion } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// R1 — print-safe chart pack (NZC-050; docs/ACCEPTANCE_R1_PRINT_SAFE_CHARTS.md).
// `report-svg-charts` is live on deployed staging. Like stage-sections, this
// spec does NOT skip when the R1 markers are missing — a conditional skip is how
// a flag flip goes unverified for days. The only skip is the suite-wide "no
// staff account" gate (which turns the whole run into a public smoke run).

async function openReportVersion(page: Page): Promise<{ errors: string[] }> {
  const report = await discoverReportVersion(page.request);
  expect(report, "staging must expose a published CRP report version (seed J000712)").toBeTruthy();

  const errors = collectPageErrors(page);
  await page.goto(`/reports/${report!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);
  return { errors };
}

test.describe("R1 — print-safe report chart pack", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("the report exposes one deterministic render-ready signal and print-safe charts", async ({ page }) => {
    const { errors } = await openReportVersion(page);

    const sheet = page.locator(".report-sheet");
    // Hard precondition + the signal itself: `data-report-ready` is set once
    // every section + SVG is in the DOM and every chart figure reconciles to
    // Outputs. Absent => `report-svg-charts` is not live on the target and this
    // fails loudly (NEXT_PUBLIC_FEATURE_REPORT_STUDIO must include it).
    await expect(sheet, "report sheet has no data-report-ready — is report-svg-charts live on the target?").toHaveAttribute(
      "data-report-ready",
      "true",
    );

    // Charts are inline SVG in the server markup — no canvas anywhere.
    await expect(page.locator(".report-sheet svg").first()).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);

    // Every rendered chart carries the visible "SVG · print-safe" marker.
    const charts = page.locator(".nz-chart-manifest-grid > div");
    const badges = page.locator(".nzc-print-safe");
    expect(await charts.count(), "at least one chart rendered").toBeGreaterThan(0);
    expect(await badges.count(), "one print-safe marker per chart").toBe(await charts.count());

    // The data-integrity check covers charts and passed.
    const integrity = page.locator(".nz-report-integrity");
    await expect(integrity).toBeVisible();
    await expect(integrity).not.toHaveClass(/(^|\s)fail(\s|$)/);
    await expect(integrity).toContainText(/every chart figure matches Outputs/i);

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the report surface passes the axe baseline and holds the column", async ({ page }) => {
    await openReportVersion(page);
    await expect(page.locator(".report-sheet")).toHaveAttribute("data-report-ready", "true");
    await scanWithBaseline(page, "report-print-safe");
    await expectNoHorizontalOverflow(page, "report version");
  });
});
