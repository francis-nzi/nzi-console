import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJobAtStage } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen, expandJobStage } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// DA3a — Data Assurance read surface (NZC-059; docs/ACCEPTANCE_DA3_ASSURANCE.md).
// Behind `data-assurance`. Once the surface is present every assertion is a HARD
// precondition (fail loud, never a silent skip — stage-sections.spec.ts
// discipline). The one conditional skip is for the flag not yet being live on
// the target; **this is removed and the precondition made unconditional in the
// DA3a flip PR**, exactly as stage-sections / R1 were hardened after their flip.

async function openAssurance(page: Page): Promise<{ errors: string[]; surface: ReturnType<Page["locator"]> }> {
  const job = await discoverCrpJobAtStage(page.request, "Data entry");
  expect(job, "staging must expose a CRP job (seed J000712)").toBeTruthy();
  const errors = collectPageErrors(page);
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);
  await expandJobStage(page, "stage-review-qa");
  const surface = page.locator(".nz-assurance");
  const failedState = page.locator(".nz-assurance-banner.warn, .nz-config-panel .nz-banner.warn");
  test.skip(
    (await surface.count()) === 0 && (await failedState.count()) === 0,
    "data-assurance not live on the target — harden this spec (remove the skip) as part of the flip PR",
  );
  await expect(surface, "Data Assurance surface must render in Review & QA").toBeVisible();
  return { errors, surface };
}

test.describe("DA3a — Data Assurance read surface", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("renders the five-year trend with the BL pill, a % vs BL column and the tabs", async ({ page }) => {
    const { errors, surface } = await openAssurance(page);

    // Persistent header: total + scope summary, baseline year + BL pill.
    await expect(surface.locator(".nz-assurance-summary")).toBeVisible();
    await expect(surface.locator(".nz-assurance-meta .nz-bl-pill").first()).toBeVisible();

    // Integrity banner — status or alert, never a zeroed report.
    await expect(surface.locator(".nz-assurance-banner")).toBeVisible();

    // Trend table: a baseline column with BL pill, a current column, a % vs BL
    // column, an "All scopes total" row.
    const trend = surface.locator("table.nz-assurance-trend");
    await expect(trend).toBeVisible();
    await expect(trend.locator("thead th.bl .nz-bl-pill")).toBeVisible();
    await expect(trend.locator("thead th.cur .nz-cur-pill")).toBeVisible();
    await expect(trend.locator("thead th", { hasText: "% vs BL" })).toBeVisible();
    await expect(trend.locator("tr.total", { hasText: "All scopes total" })).toBeVisible();

    // Tabs switch the view.
    for (const label of ["By scope", "By site", "Audit table", "Intensity"]) {
      await surface.getByRole("tab", { name: label }).click();
      await expect(surface.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
    }
    await surface.getByRole("tab", { name: "By site" }).click();
    await expect(surface.locator(".nz-assurance-scroll")).toContainText(/Unallocated|by site/i);

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the gap drawer overlays without shrinking the trend table, and the reopen tab works", async ({ page }) => {
    const { surface } = await openAssurance(page);
    const trend = surface.locator("table.nz-assurance-trend");
    const widthBefore = await trend.evaluate((el) => el.getBoundingClientRect().width);

    const drawer = page.locator(".nz-assurance-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".nz-assurance-drawer-seg button", { hasText: /Gaps/ })).toHaveClass(/on/);

    // The drawer overlays (position: fixed) — closing it must not change the
    // trend table's rendered width; it is never part of the grid layout.
    const widthWithDrawer = await trend.evaluate((el) => el.getBoundingClientRect().width);
    expect(widthWithDrawer).toBe(widthBefore);

    await drawer.locator(".nz-assurance-drawer-h .close").click();
    await expect(drawer).toHaveCount(0);
    const reopen = surface.getByRole("button", { name: /Data assurance/ });
    await expect(reopen).toBeVisible();
    const widthAfterClose = await trend.evaluate((el) => el.getBoundingClientRect().width);
    expect(widthAfterClose).toBe(widthBefore);

    await reopen.click();
    await expect(page.locator(".nz-assurance-drawer")).toBeVisible();
  });

  test("a gap can be resolved with a reason, and re-opens for editing", async ({ page }) => {
    await openAssurance(page);
    const drawer = page.locator(".nz-assurance-drawer");
    const firstGap = drawer.locator(".nz-assurance-gap").first();
    test.skip((await firstGap.count()) === 0, "no open integrity gaps on this job to resolve");

    await firstGap.getByRole("button", { name: /Resolve…/ }).click();
    const reason = `e2e resolution ${Date.now()}`;
    await firstGap.locator("textarea").fill(reason);
    await firstGap.getByRole("button", { name: "Save" }).click();
    await expect(firstGap.locator(".rtag", { hasText: reason })).toBeVisible({ timeout: 15_000 });

    // Reload the stage: the resolution persisted server-side.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expandJobStage(page, "stage-review-qa");
    const reloaded = page.locator(".nz-assurance-drawer .nz-assurance-gap").first();
    await expect(reloaded.locator(".rtag", { hasText: reason })).toBeVisible();
  });

  test("selecting an audit row shows its evidence in the row-detail drawer segment", async ({ page }) => {
    const { surface } = await openAssurance(page);
    await surface.getByRole("tab", { name: "Audit table" }).click();
    const row = surface.locator(".nz-audit-row").first();
    test.skip((await row.count()) === 0, "no audit rows on this job");
    await row.click();

    const drawer = page.locator(".nz-assurance-drawer");
    await expect(drawer.locator("h3", { hasText: "Row detail" })).toBeVisible();
    await expect(drawer.locator(".nz-assurance-row-detail .nz-kv")).not.toHaveCount(0);
  });

  test("a failed /assurance read shows an alert, not a zeroed report", async ({ page }) => {
    const job = await discoverCrpJobAtStage(page.request, "Data entry");
    expect(job).toBeTruthy();
    // Break the assurance fetch and confirm the surface degrades honestly.
    await page.route("**/api/isolated/jobs/*/assurance", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "UNAVAILABLE", message: "forced" }) }));
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);
    await expandJobStage(page, "stage-review-qa");
    const failed = page.locator(".nz-assurance-banner, [role='alert']").filter({ hasText: /unavailable/i }).first();
    // either the component-level failed state or nothing rendered — but never a table of zeros
    await expect(page.locator("table.nz-assurance-trend")).toHaveCount(0);
    await expect(failed.or(page.getByRole("button", { name: "Retry" }))).toBeVisible();
  });

  test("passes the axe baseline and holds the column at every breakpoint", async ({ page }) => {
    await openAssurance(page);
    await scanWithBaseline(page, "data-assurance");
    await expectNoHorizontalOverflow(page, "data assurance surface");
  });
});
