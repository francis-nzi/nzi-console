import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverReportVersion } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// R3 — data-bound figure tokens (NZC-049; docs/ACCEPTANCE_R3_FIGURE_TOKENS.md).
// Runs only when a staff account is provided AND `report-tokens` is live on the
// target (NEXT_PUBLIC_FEATURE_REPORT_STUDIO). Hard-asserts the markers once the
// section list is present — no conditional skip on a live flag.

async function openReportVersion(page: Page): Promise<{ errors: string[] }> {
  const report = await discoverReportVersion(page.request);
  expect(report, "staging must expose a published CRP report version (seed J000712)").toBeTruthy();
  const errors = collectPageErrors(page);
  await page.goto(`/reports/${report!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);
  return { errors };
}

test.describe("R3 — data-bound report figure tokens", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("report narrative renders as ordered sections with resolved locked figure chips", async ({ page }) => {
    const { errors } = await openReportVersion(page);

    const sections = page.locator(".report-sections .nz-report-section");
    test.skip(
      (await sections.count()) === 0,
      "report-tokens not enabled on target (no .report-sections)",
    );

    // The six-section CRP narrative, each with a source pill.
    expect(await sections.count()).toBe(6);
    await expect(page.locator("#section-executive-summary .nz-report-section-h h2")).toHaveText("Executive summary");
    await expect(sections.first().locator(".nz-section-source")).toBeVisible();

    // Every figure token resolved (none left with the unresolved marker) and the
    // canonical total appears as a chip in the executive summary.
    const tokens = page.locator(".nz-fig-token");
    expect(await tokens.count()).toBeGreaterThan(4);
    expect(await page.locator(".nz-fig-token.unresolved").count()).toBe(0);
    await expect(page.locator("#section-executive-summary .nz-fig-token").first()).toContainText(/tCO₂e|%|\d/);

    // Integrity banner now covers narrative figures too, and stays green — which
    // means data-report-ready is still true.
    const integrity = page.locator(".nz-report-integrity");
    await expect(integrity).toBeVisible();
    await expect(integrity).not.toHaveClass(/(^|\s)fail(\s|$)/);
    await expect(integrity).toContainText(/narrative figure/i);
    await expect(page.locator(".report-sheet")).toHaveAttribute("data-report-ready", "true");

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the report surface with sections passes the axe baseline and holds the column", async ({ page }) => {
    await openReportVersion(page);
    test.skip((await page.locator(".report-sections").count()) === 0, "report-tokens not enabled on target");
    await scanWithBaseline(page, "report-figure-tokens");
    await expectNoHorizontalOverflow(page, "report version with sections");
  });
});
