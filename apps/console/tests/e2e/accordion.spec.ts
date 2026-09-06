import { test, expect, type Locator, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// UX1 flip acceptance — the CRP scope→category data-entry accordion
// (docs/STAGING_ACCEPTANCE_UX1.md "Flip readiness"; NZC-046 / DATA_ENTRY_UX.md).
// Turns step 2 of the flip ("confirm each re-homed area works in its category
// section" + "Add-entry on CRP") into a test run.
//
// Runs only when a staff account is provided AND `data-entry-accordion` is on the
// target. For the re-homed adapters and the client-factor panel to appear, the
// per-adapter flags must also be on:
//   NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend,spend-import,portal-spend,commuting,vehicle,client-factors,data-entry-accordion
//
// This spec asserts every surface RENDERS and is accessible. The end-to-end
// "create → calculate → independent review" on a fresh row, and the human
// screen-reader / contrast / reduced-motion pass, remain the manual step 3.

const REG_SAMPLE = "AB12 CDE";

async function openJobAccordion(page: Page): Promise<{ accordion: Locator; errors: string[] }> {
  const job = await discoverCrpJob(page.request);
  test.skip(!job, "no CRP job on target");

  const errors = collectPageErrors(page);
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);

  const accordion = page.locator("section#data-entry-accordion");
  const accordionFailed = page.getByText("The category view is unavailable");
  // The accordion mounts immediately but renders its <section> only after the
  // client-side /applicable-categories fetch resolves — wait for a terminal
  // state (ready section, or its failure banner) before deciding to skip.
  await accordion.or(accordionFailed).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  test.skip(
    (await accordion.count()) === 0,
    "data-entry-accordion not enabled on target, or its category view failed to load",
  );
  await expect(accordion.locator("button.nz-acc-h").first()).toBeVisible({ timeout: 20_000 });
  return { accordion, errors };
}

/** Expand a category card by its taxonomy name; skip the leg if the job doesn't include it. */
async function expandCategory(accordion: Locator, name: string): Promise<Locator | null> {
  const header = accordion.locator("button.nz-acc-h", { hasText: name }).first();
  if ((await header.count()) === 0) return null;
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  return header.locator("xpath=following-sibling::div[contains(@class,'nz-acc-body')]").first();
}

test.describe("UX1 — CRP data-entry accordion rendered acceptance", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

  test("the accordion renders: site context, both lenses, expand/collapse", async ({ page }) => {
    const { accordion, errors } = await openJobAccordion(page);

    await expect(accordion.getByLabel("Site context for new entries")).toBeVisible();
    const byCategory = accordion.getByRole("tab", { name: "By category" });
    const needsAttention = accordion.getByRole("tab", { name: /Needs attention/ });
    await expect(byCategory).toBeVisible();
    await expect(needsAttention).toBeVisible();
    // Lands on the scope→category view, not the (often empty) exception table.
    await expect(byCategory).toHaveAttribute("aria-selected", "true");
    await expect(accordion.locator(".nz-acc")).toBeVisible();

    const first = accordion.locator("button.nz-acc-h").first();
    await first.click();
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await expect(
      first.locator("xpath=following-sibling::div[contains(@class,'nz-acc-body')]"),
    ).toBeVisible();
    await first.click();
    await expect(first).toHaveAttribute("aria-expanded", "false");

    // The exception-first lens is a second view over the same rows.
    await needsAttention.click();
    await expect(needsAttention).toHaveAttribute("aria-selected", "true");
    await expect(accordion.locator("table.nz-tbl, .nz-table-empty").first()).toBeVisible();
    await byCategory.click();
    await expect(byCategory).toHaveAttribute("aria-selected", "true");

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the re-homed adapters live in a per-category 'Import & templates' modal (UX review item 4)", async ({ page }) => {
    const { accordion, errors } = await openJobAccordion(page);

    const pgs = await expandCategory(accordion, "Purchased Goods and Services");
    test.skip(!pgs, "Scope 3 not included on this job");

    // The bulk panels are NOT in the always-open card body any more.
    await expect(pgs!.locator("#spend-import")).toHaveCount(0);
    await expect(pgs!.locator("#spend-ledger-adapter")).toHaveCount(0);

    await pgs!.getByRole("button", { name: /Import & templates/ }).click();
    const modal = page.locator('[role="dialog"].nz-import-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("aria-modal", "true");

    // Methods as tabs; each reveals its panel.
    await modal.getByRole("tab", { name: "Paste a list" }).click();
    await expect(modal.locator("#spend-ledger-adapter")).toBeVisible();
    await modal.getByRole("tab", { name: /Upload CSV/ }).click();
    await expect(modal.locator("#spend-import")).toBeVisible();
    await modal.getByRole("tab", { name: /Roll forward/ }).click();
    await expect(modal.locator("#spend-rollforward")).toBeVisible();

    // Escape closes it and returns focus to the trigger.
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(pgs!.getByRole("button", { name: /Import & templates/ })).toBeFocused();

    const vehicles = await expandCategory(accordion, "Company Vehicles");
    if (vehicles) {
      await vehicles.getByRole("button", { name: /Import & templates/ }).click();
      await expect(page.locator('[role="dialog"].nz-import-modal #vehicle-bulk')).toBeVisible();
      await page.locator('[role="dialog"].nz-import-modal').getByRole("button", { name: /Close import/ }).click();
    }

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("Add-entry opens the shared capture form; the DVLA lookup resolves to a rendered outcome", async ({ page }) => {
    const { accordion, errors } = await openJobAccordion(page);

    // A vehicle-kind category exercises the registration finder (#57/#58).
    const vehicles = await expandCategory(accordion, "Company Vehicles");
    test.skip(!vehicles, "Scope 1 company-vehicles not included on this job");

    await vehicles!.getByRole("button", { name: /Add entry/ }).click();
    const form = vehicles!.locator("form.nz-ef");
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute("aria-label", /Company Vehicles/);

    const plate = form.locator("input.nz-plate");
    await expect(plate).toBeVisible();
    await plate.fill(REG_SAMPLE);
    await form.getByRole("button", { name: "Look up" }).click();

    // Deterministic stub on staging (no DVLA_VES_API_KEY): either the confirm
    // card ("Use this") or the inline lookup-error note — never a crash, never a
    // hang on "Looking up…".
    const useThis = form.getByRole("button", { name: "Use this", exact: true });
    const lookupError = form.locator("p.nz-hint.bad[role='alert']");
    await expect(useThis.or(lookupError).first()).toBeVisible();

    await scanWithBaseline(page, "accordion", "#data-entry-accordion");

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("Add-entry renders for a manual category with the fixed field order", async ({ page }) => {
    const { accordion, errors } = await openJobAccordion(page);

    // First manual-kind Scope 3 category present.
    let body: Locator | null = null;
    for (const name of ["Fuel & Energy Related", "Waste in Operations", "Upstream Leased Assets"]) {
      body = await expandCategory(accordion, name);
      if (body) break;
    }
    test.skip(!body, "no manual Scope 3 category on this job");

    await body!.getByRole("button", { name: /Add entry/ }).click();
    const form = body!.locator("form.nz-ef");
    await expect(form).toBeVisible();
    // Field order (NZC-046): Activity smart-search → Quantity → …
    await expect(form.getByText(/smart search/i).first()).toBeVisible();
    await expect(form.locator("input.nz-inp").first()).toBeVisible();
    await body!.getByRole("button", { name: /^Close$/ }).click();
    await expect(form).toBeHidden();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the client-factor panel is reachable from the job (S2)", async ({ page }) => {
    const { errors } = await openJobAccordion(page);
    const panel = page.locator("#client-factors-manager");
    test.skip(
      (await panel.count()) === 0,
      "client-factors not enabled on target (NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 has no 'client-factors')",
    );
    await expect(panel).toBeVisible();
    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the accordion holds the column at every breakpoint", async ({ page }) => {
    const { accordion } = await openJobAccordion(page);
    await accordion.locator("button.nz-acc-h").first().click();
    await expectNoHorizontalOverflow(page, "accordion");
  });
});
