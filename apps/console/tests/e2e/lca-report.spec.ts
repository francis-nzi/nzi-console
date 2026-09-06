import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverLcaJob } from "./lib/discover";
import { collectPageErrors } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// Track C — LCA/PCF reference module, slice 7 (Report manifest + PCF
// labelling; L7; docs/ACCEPTANCE_LCA_MODULE_SLICE7.md). The family report is
// built entirely from one frozen result snapshot (seed
// 0010_synthetic_lca_snapshot.sql: `snap-714-6l-demo` on job 714), reusing
// the R-track paged machinery + the L6 charts. `job-module-lca` is live.
const SNAPSHOT_ID = "snap-714-6l-demo";

test.describe("Track C — LCA report (slice 7)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("renders the LCA report from the frozen snapshot — charts, module table, frozen factor citation", async ({ page }) => {
    const job = await discoverLcaJob(page.request);
    expect(job, "staging must expose the seeded lca job J000714").toBeTruthy();
    const errors = collectPageErrors(page);

    await page.goto(`/jobs/${job!.id}/lca-report/${SNAPSHOT_ID}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    const sheet = page.locator(".report-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-report-ready", "true");
    // LCA job → LCA terminology, not "Product Carbon Footprint".
    await expect(sheet.locator("h1")).toContainText("Life-cycle Assessment");
    await expect(sheet.getByText("Product Carbon Footprint")).toHaveCount(0);

    // The L6 charts, deterministic SVG, no canvas.
    await expect(sheet.locator(".nz-chart-manifest-grid svg").first()).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(sheet.getByText(/Data integrity check passed/)).toBeVisible();

    // The frozen factor citation, verbatim from the snapshot (incl. the manual "—" entry).
    const factorTable = sheet.locator("section", { hasText: "Emission factors used" });
    await expect(factorTable.getByText("frozen at sign-off")).toBeVisible();
    await expect(factorTable.getByText("Recycled PET granulate — demonstration factor")).toBeVisible();
    await expect(factorTable.getByText("27_320_3235_14_1")).toBeVisible();
    await expect(factorTable.getByText("Category-average printing ink, DEFRA 2025")).toBeVisible();

    // Module breakdown table totals to the snapshot total.
    await expect(sheet.getByText(/Emissions by life-cycle module/)).toBeVisible();
    await expect(sheet.locator("tr.total", { hasText: "100%" })).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the A4 page view builds from the same paged-media rules", async ({ page }) => {
    const job = await discoverLcaJob(page.request);
    await page.goto(`/jobs/${job!.id}/lca-report/${SNAPSHOT_ID}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    await page.getByRole("tab", { name: "Page view · A4" }).click();
    await expect(page.locator(".report-pagedjs-target .pagedjs_page").first()).toBeVisible({ timeout: 20_000 });
  });

  test("the freeze history in the workspace links to the report", async ({ page }) => {
    const job = await discoverLcaJob(page.request);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);
    const register = page.locator("#lca-assessment-register");
    await expect(register).toHaveCount(1);
    await register.getByRole("button", { name: /Inventory/ }).first().click();
    const results = page.locator(".nz-lca-results");
    await results.getByRole("button", { name: /Show freeze history|freeze history/ }).click().catch(() => undefined);
    const link = results.getByRole("link", { name: "Open report" }).first();
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveAttribute("href", new RegExp(`/lca-report/${SNAPSHOT_ID}`));
  });

  test("the report passes the axe baseline and holds the column", async ({ page }) => {
    const job = await discoverLcaJob(page.request);
    await page.goto(`/jobs/${job!.id}/lca-report/${SNAPSHOT_ID}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);
    await scanWithBaseline(page, "lca-report");
    await expectNoHorizontalOverflow(page, "LCA report");
  });
});
