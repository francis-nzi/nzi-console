import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverLcaJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// Track C — LCA/PCF reference module, slice 6 (Charts; L6;
// docs/ACCEPTANCE_LCA_MODULE_SLICE6.md). Module-breakdown donut + hotspots
// bar, deterministic print-safe SVG built from the reviewed/frozen snapshot,
// via the shared `@nzi/charts` engine + manifest. `job-module-lca` is live.

test.describe("Track C — LCA charts (slice 6)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("the /charts demonstrator renders the LCA module donut + hotspots bar as SVG (no canvas)", async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto("/charts", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);
    await expectHealthyScreen(page);

    const lcaSection = page.locator(".nz-chart-catalogue", { hasText: "life-cycle module" }).last();
    await expect(lcaSection.locator("svg").first()).toBeVisible();
    await expect(lcaSection.getByText(/Emission hotspots/)).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.getByText("Publication gate passed").last()).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("freezing a reviewed snapshot generates the charts in the workspace", async ({ page }) => {
    const job = await discoverLcaJob(page.request);
    expect(job, "staging must expose an lca/pcf job (seed J000714)").toBeTruthy();

    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);
    await expectHealthyScreen(page);

    const register = page.locator("#lca-assessment-register");
    await expect(register, "job-module-lca must be live on the target").toHaveCount(1);
    await register.getByRole("button", { name: /Inventory/ }).first().click();
    const results = page.locator(".nz-lca-results");
    await expect(results).toBeVisible();

    await results.getByRole("button", { name: "Recalculate" }).click();
    await expect(results.locator(".nz-lca-breakdown").first()).toBeVisible({ timeout: 20_000 });
    // Approve is a no-op if already approved; ignore its disabled state.
    await results.getByRole("button", { name: "Approve" }).click().catch(() => undefined);
    await results.getByRole("button", { name: "Freeze snapshot" }).click();
    await results.getByRole("button", { name: /Show freeze history|freeze history/ }).click().catch(() => undefined);

    await expect(results.locator(".nz-lca-chart-grid svg").first()).toBeVisible({ timeout: 15_000 });
  });

  test("the /charts LCA section passes the axe baseline and holds the column", async ({ page }) => {
    await page.goto("/charts", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);
    await scanWithBaseline(page, "lca-charts");
    await expectNoHorizontalOverflow(page, "LCA charts");
  });
});
