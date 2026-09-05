import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverLcaJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// Track C — LCA/PCF reference module, slice 2 (Inventory; NZC-053/054/056;
// docs/ACCEPTANCE_LCA_MODULE_SLICE2.md). Behind `job-module-lca` in
// `NEXT_PUBLIC_FEATURE_JOB_MODULES`. Job '714' (Verdant Foods, lca) is seeded
// with a Model Register assessment and a handful of inventory lines
// (packages/isolated-backend/seeds/0005_synthetic_lca_pcf.sql) so this suite
// never has to skip for want of a job to discover.
//
// `job-module-lca` is live on deployed staging — every assertion below is a
// HARD precondition (fail loud, never a silent skip — stage-sections.spec.ts
// / data-assurance.spec.ts discipline). The only skip is the suite-wide "no
// staff account" gate.

/** Discover the seeded LCA job, open it, expand its assessment's inventory. */
async function openInventory(page: Page): Promise<{ errors: string[] }> {
  const job = await discoverLcaJob(page.request);
  expect(job, "staging must expose an lca/pcf job (seed J000714)").toBeTruthy();

  const errors = collectPageErrors(page);
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);

  const register = page.locator("#lca-assessment-register");
  await expect(
    register,
    "job-module-lca shell absent — the flag must be live on the target (NEXT_PUBLIC_FEATURE_JOB_MODULES must include 'job-module-lca')",
  ).toHaveCount(1);

  const toggle = register.getByRole("button", { name: /Inventory/ }).first();
  await expect(toggle, "an inventory toggle for the seeded assessment").toBeVisible();
  await toggle.click();
  await expect(register.locator(".nz-lca-inventory")).toBeVisible();

  return { errors };
}

test.describe("Track C — LCA inventory (slice 2)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("groups seeded line items by EN 15804 module, showing factor status", async ({ page }) => {
    const { errors } = await openInventory(page);
    const inventory = page.locator(".nz-lca-inventory");

    // The seed carries a mapped (dataset), an unmapped, and a gap-filled line
    // under module A1 — every state the register must be able to show.
    await expect(inventory.getByText("rPET tray")).toBeVisible();
    await expect(inventory.getByText("Food-grade adhesive")).toBeVisible();
    await expect(inventory.getByText("Label ink")).toBeVisible();
    await expect(inventory.locator(".nz-st.done", { hasText: "Mapped" }).first()).toBeVisible();
    await expect(inventory.locator(".nz-st.need", { hasText: "Unmapped" }).first()).toBeVisible();
    await expect(inventory.locator(".nz-chip-mini.todo", { hasText: "Gap-filled" }).first()).toBeVisible();

    // The placeholder assembly row is flagged excluded, not silently hidden.
    await expect(inventory.getByText(/Secondary packaging assembly/)).toBeVisible();
    await expect(inventory.locator(".nz-chip-mini.nodata", { hasText: "Excluded" }).first()).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("adds a manual line item to a chosen module", async ({ page }) => {
    await openInventory(page);
    const inventory = page.locator(".nz-lca-inventory");

    await inventory.getByRole("button", { name: "+ Add line item" }).click();
    const form = inventory.locator(".nz-acc-extra").last();
    await expect(form).toBeVisible();

    const label = `E2E test line ${Date.now()}`;
    await form.locator("label", { hasText: "Line label" }).locator("input").fill(label);
    await form.locator("label", { hasText: "Quantity" }).locator("input").fill("1.5");

    await form.getByRole("button", { name: "Add line item" }).click();
    await expect(inventory.getByText(label)).toBeVisible({ timeout: 15_000 });
  });

  test("the inventory passes the axe baseline and holds the column", async ({ page }) => {
    await openInventory(page);
    await scanWithBaseline(page, "lca-inventory");
    await expectNoHorizontalOverflow(page, "LCA inventory");
  });
});
