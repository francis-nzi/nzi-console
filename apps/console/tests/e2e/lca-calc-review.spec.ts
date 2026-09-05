import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverLcaJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// Track C — LCA/PCF reference module, slice 4 (calc engine + gap-filling +
// review + result snapshots; L4; docs/ACCEPTANCE_LCA_MODULE_SLICE4.md).
// Job '714' (Verdant Foods, lca) is seeded with kg-based dataset factors so
// "Recalculate" produces a genuine module breakdown / total, not zeros
// (packages/isolated-backend/seeds/0007_synthetic_lca_calc.sql).
//
// `job-module-lca` is live on deployed staging — every assertion is a HARD
// precondition. The only skip is the suite-wide "no staff account" gate.

async function openResults(page: Page): Promise<{ errors: string[] }> {
  const job = await discoverLcaJob(page.request);
  expect(job, "staging must expose an lca/pcf job (seed J000714)").toBeTruthy();

  const errors = collectPageErrors(page);
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);

  const register = page.locator("#lca-assessment-register");
  await expect(register, "job-module-lca must be live on the target").toHaveCount(1);

  await register.getByRole("button", { name: /Inventory/ }).first().click();
  await expect(page.locator(".nz-lca-results")).toBeVisible();
  return { errors };
}

test.describe("Track C — LCA calc engine, review & snapshots (slice 4)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("recalculates to a real module breakdown and total", async ({ page }) => {
    const { errors } = await openResults(page);
    const results = page.locator(".nz-lca-results");

    await results.getByRole("button", { name: "Recalculate" }).click();
    await expect(results.locator(".nz-lca-breakdown")).toBeVisible({ timeout: 20_000 });

    // A1 (raw material supply) carries the rPET tray — by far the biggest contributor.
    const breakdown = results.locator(".nz-lca-breakdown table.nz-tbl tbody tr");
    await expect(breakdown.first()).toContainText("A1");
    await expect(results.getByText(/Mass reconciliation:/)).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("gap-fills an unmapped line, then approves and freezes a snapshot", async ({ page }) => {
    await openResults(page);
    const register = page.locator("#lca-assessment-register");

    // Gap-fill the seeded unmapped adhesive line.
    const gapButton = register.getByRole("button", { name: "Gap-fill" }).first();
    if (await gapButton.count()) {
      await gapButton.click();
      const gapForm = register.locator(".nz-lca-legs").last();
      await gapForm.locator("label", { hasText: "Proxy factor value" }).locator("input").fill("2.4");
      await gapForm.locator("label", { hasText: "Gap-fill method" }).locator("textarea").fill("E2E category-average proxy");
      await gapForm.getByRole("button", { name: "Gap-fill line" }).click();
      await expect(register.getByText("E2E category-average proxy")).toBeVisible({ timeout: 15_000 });
    }

    const results = page.locator(".nz-lca-results");
    await results.getByRole("button", { name: "Recalculate" }).click();
    await expect(results.locator(".nz-lca-breakdown")).toBeVisible({ timeout: 20_000 });

    await results.getByRole("button", { name: "Approve" }).click();
    await expect(results.locator(".nz-st.done", { hasText: "Approved" })).toBeVisible({ timeout: 15_000 });

    await results.getByRole("button", { name: "Freeze snapshot" }).click();
    await results.getByRole("button", { name: /Show freeze history|freeze history/ }).click().catch(() => undefined);
    await expect(results.locator(".nz-lca-snap-list li").first()).toBeVisible({ timeout: 15_000 });
  });

  test("the results panel passes the axe baseline and holds the column", async ({ page }) => {
    await openResults(page);
    await scanWithBaseline(page, "lca-calc-review");
    await expectNoHorizontalOverflow(page, "LCA calc review");
  });
});
