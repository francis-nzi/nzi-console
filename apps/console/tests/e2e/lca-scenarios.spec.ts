import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverLcaJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// Track C — LCA/PCF reference module, slice 5 (Scenarios; L5;
// docs/ACCEPTANCE_LCA_MODULE_SLICE5.md). `job-module-lca` is live on staging.
// Job '714' is seeded with a baseline + a "Lightweight tray" scenario
// carrying a ×0.85 A1/polymers multiplier
// (packages/isolated-backend/seeds/0009_synthetic_lca_scenarios.sql). Every
// assertion is a HARD precondition; the only skip is the "no staff account"
// public-smoke gate.

async function openScenarios(page: Page): Promise<{ errors: string[] }> {
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

test.describe("Track C — LCA scenarios (slice 5)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("shows the seeded scenarios and compares them against the baseline", async ({ page }) => {
    const { errors } = await openScenarios(page);
    const results = page.locator(".nz-lca-results");

    await expect(results.getByText("Lightweight tray")).toBeVisible();
    await expect(results.getByText(/×0\.85 on A1/)).toBeVisible();

    // A comparison run needs a fresh baseline calc first.
    await results.getByRole("button", { name: "Recalculate" }).click();
    await expect(results.locator(".nz-lca-breakdown").first()).toBeVisible({ timeout: 20_000 });

    await results.getByRole("button", { name: "Compare scenarios" }).click();
    const comparison = results.locator("table.nz-tbl", { hasText: "Total tCO₂e" });
    await expect(comparison).toBeVisible({ timeout: 15_000 });
    await expect(comparison.getByRole("columnheader", { name: "Baseline" })).toBeVisible();
    await expect(comparison.getByRole("columnheader", { name: "Lightweight tray" })).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("adds a scenario and a multiplier rule", async ({ page }) => {
    await openScenarios(page);
    const results = page.locator(".nz-lca-results");

    await results.getByRole("button", { name: "+ Add scenario" }).click();
    const scenarioName = `E2E scenario ${Date.now()}`;
    await results.locator("label", { hasText: "Scenario name" }).locator("input").fill(scenarioName);
    await results.getByRole("button", { name: "Add", exact: true }).click();
    await expect(results.getByText(scenarioName)).toBeVisible({ timeout: 15_000 });

    // Open its rules editor and save a multiplier.
    const card = results.locator("div", { hasText: scenarioName }).filter({ has: page.getByRole("button", { name: "Rules" }) }).last();
    await card.getByRole("button", { name: "Rules" }).click();
    await card.locator("label", { hasText: "Multiplier" }).locator("input").fill("0.5");
    await card.getByRole("button", { name: "Save rule" }).click();
    await expect(results.getByText(/×0\.5 on/)).toBeVisible({ timeout: 15_000 });
  });

  test("the scenarios panel passes the axe baseline and holds the column", async ({ page }) => {
    await openScenarios(page);
    await scanWithBaseline(page, "lca-scenarios");
    await expectNoHorizontalOverflow(page, "LCA scenarios");
  });
});
