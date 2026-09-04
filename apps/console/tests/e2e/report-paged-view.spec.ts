import { test, expect, type Locator, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverReportVersion } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// R5b — Continuous / Page view · A4 (NZC-051; docs/ACCEPTANCE_R5_PAGED_OUTPUT.md).
// Behind `report-paged` (same flag as R5a). Page view lazy-loads Paged.js and
// applies the SAME paged-media rules the real print/PDF path uses. Once the
// toggle is present every assertion is a HARD precondition — fail loud, never
// a silent skip (stage-sections.spec.ts / data-assurance.spec.ts discipline).
// The ONE conditional skip below is for the flag not yet being live — delete
// just that `test.skip` call to harden this spec the moment `report-paged`
// flips, same one-line change as every other flag-gated spec in this suite.
//
// This spec cannot prove the Paged.js page map is byte-identical to the
// actual generated PDF — that is a deliberate human check (print/Save-as-PDF
// the same job and compare page-by-page), per the R5b acceptance note.

/** Hard precondition — the Continuous/Page-view toggle must actually be rendered. */
async function openReportVersion(page: Page): Promise<{ errors: string[]; toggle: Locator }> {
  const report = await discoverReportVersion(page.request);
  expect(report, "staging must expose a published CRP report version (seed J000712)").toBeTruthy();
  const errors = collectPageErrors(page);
  await page.goto(`/reports/${report!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);
  const toggle = page.locator(".report-view-toggle");
  test.skip(
    (await toggle.count()) === 0,
    "report-paged not enabled on target (no .report-view-toggle) — harden this spec (remove the skip) as part of the flip PR",
  );
  return { errors, toggle };
}

test.describe("R5b — Continuous / Page view · A4 toggle", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("Continuous is the default view; the report renders exactly as before", async ({ page }) => {
    const { errors, toggle } = await openReportVersion(page);

    await expect(toggle.getByRole("tab", { name: "Continuous" })).toHaveAttribute("aria-selected", "true");
    await expect(toggle.getByRole("tab", { name: "Page view · A4" })).toHaveAttribute("aria-selected", "false");
    await expect(page.locator(".report-sheet")).toBeVisible();
    await expect(page.locator(".report-sheet")).toHaveAttribute("data-report-ready", "true");

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("Page view · A4 lazy-loads Paged.js and paginates using the same rules as print", async ({ page }) => {
    const { errors, toggle } = await openReportVersion(page);

    await toggle.getByRole("tab", { name: "Page view · A4" }).click();
    await expect(toggle.getByRole("tab", { name: "Page view · A4" })).toHaveAttribute("aria-selected", "true");

    const target = page.locator(".report-pagedjs-target");
    const failed = page.locator(".report-pagedjs-wrap .nz-banner.warn");
    await expect(target.or(failed)).toBeVisible({ timeout: 20_000 });
    await expect(failed, "Paged.js failed to build the page view").toHaveCount(0);

    const pages = target.locator(".pagedjs_page");
    await expect(pages.first()).toBeVisible({ timeout: 20_000 });
    expect(await pages.count()).toBeGreaterThan(0);

    // The Continuous view underneath is hidden, not unmounted or destroyed.
    await expect(page.locator(".report-sheet")).toBeHidden();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the running header/footer is suppressed on the cover page and present from page 2", async ({ page }) => {
    const { toggle } = await openReportVersion(page);

    await toggle.getByRole("tab", { name: "Page view · A4" }).click();
    const pages = page.locator(".report-pagedjs-target .pagedjs_page");
    await expect(pages.first()).toBeVisible({ timeout: 20_000 });
    test.skip((await pages.count()) < 2, "this reviewed snapshot fits on a single A4 page — nothing to compare");

    const cover = pages.nth(0);
    await expect(cover.locator(".pagedjs_margin-bottom-right .pagedjs_margin-content")).toHaveText("");

    const second = pages.nth(1);
    await expect(second.locator(".pagedjs_margin-bottom-right .pagedjs_margin-content")).toContainText(/Page 2 of \d+/);
    await expect(second.locator(".pagedjs_margin-top-center .pagedjs_margin-content")).toContainText(/Carbon Reduction Plan/);
  });

  test("switching back to Continuous restores the normal report view", async ({ page }) => {
    const { toggle } = await openReportVersion(page);

    await toggle.getByRole("tab", { name: "Page view · A4" }).click();
    await expect(page.locator(".report-pagedjs-target .pagedjs_page, .report-pagedjs-wrap .nz-banner.warn").first()).toBeVisible({ timeout: 20_000 });

    await toggle.getByRole("tab", { name: "Continuous" }).click();
    await expect(page.locator(".report-sheet")).toBeVisible();
    await expect(page.locator(".report-sheet")).toHaveAttribute("data-report-ready", "true");
  });

  test("passes the axe baseline and holds the column with the toggle present", async ({ page }) => {
    await openReportVersion(page);
    await scanWithBaseline(page, "report-paged-view");
    await expectNoHorizontalOverflow(page, "report version with the paged-view toggle");
  });
});
