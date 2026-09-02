import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// UX1e-1 acceptance — the stage-as-section CRP workspace layout
// (docs/ACCEPTANCE_UX1E_STAGE_SECTIONS.md; NZC-038, crp_v3 prototype). Runs only
// when a staff account is provided AND `job-stage-sections` is on the target.
// The legacy command-centre scroll stays the default when the flag is off.

const STAGES = ["1 · Setup", "2 · Data entry", "3 · Factor mapping", "4 · Review & QA", "5 · Report & publish"];

test.describe("UX1e-1 — CRP stage-as-section layout", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

  test("the job page renders the five workflow stages, Data Entry expanded", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");

    const errors = collectPageErrors(page);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);
    await expectHealthyScreen(page);

    const sections = page.locator("section.nz-stage-sec");
    test.skip(
      (await sections.count()) === 0,
      "job-stage-sections not enabled on target (NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 has no 'job-stage-sections')",
    );

    // All five stages present, in order.
    await expect(sections).toHaveCount(5);
    const headings = page.locator("section.nz-stage-sec .nz-stage-sec-h b");
    for (let i = 0; i < STAGES.length; i++) {
      await expect(headings.nth(i)).toContainText(STAGES[i]!);
    }

    // The old command hero is gone; the compact focus strip replaces it.
    await expect(page.locator(".nz-command-hero")).toHaveCount(0);
    await expect(page.locator(".nz-focus-strip")).toBeVisible();

    // Data Entry lands expanded and holds the accordion (or the legacy adapters).
    const dataEntry = page.locator("section#stage-data-entry");
    await expect(dataEntry).toHaveClass(/open/);
    await expect(dataEntry.locator("#data-entry-accordion, .nz-config-panel").first()).toBeVisible();

    // A collapsed later stage expands on click and shows its panel.
    const mapping = page.locator("section#stage-factor-mapping");
    await expect(mapping).not.toHaveClass(/open/);
    await mapping.locator("button.nz-stage-sec-h").click();
    await expect(mapping).toHaveClass(/open/);
    await expect(mapping.locator(".nz-panel").first()).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the focus strip jumps to and opens the relevant stage", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });

    const strip = page.locator(".nz-focus-strip");
    test.skip((await strip.count()) === 0, "job-stage-sections not enabled on target");

    const review = page.locator("section#stage-review-qa");
    await expect(review).not.toHaveClass(/open/);
    await strip.getByRole("button", { name: /QA decisions/ }).click();
    await expect(review).toHaveClass(/open/);
  });

  test("the stage layout passes the axe baseline and holds the column", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    test.skip((await page.locator("section.nz-stage-sec").count()) === 0, "job-stage-sections not enabled on target");

    await scanWithBaseline(page, "stage-sections");
    await expectNoHorizontalOverflow(page, "stage sections");
  });
});
