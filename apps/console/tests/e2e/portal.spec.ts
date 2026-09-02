import { test, expect } from "@playwright/test";
import { portalAccount } from "./lib/accounts";
import { discoverPortalJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

test.describe("M1 — client portal renders for a granted user", () => {
  test.skip(!portalAccount(), "ACCEPTANCE_PORTAL_* not set");

  test("portal home shows the granted portfolio", async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await expectHealthyScreen(page);
    await expect(page.getByText("Your portfolio", { exact: false })).toBeVisible();
    await expect(page.getByText("No engagements available", { exact: false })).toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("account security page renders", async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto("/portal/account", { waitUntil: "domcontentloaded" });
    await expectHealthyScreen(page);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("a granted job opens its published-report workspace or an explicit state", async ({ page }) => {
    const job = await discoverPortalJob(page.request);
    test.skip(!job, "portal user has no granted jobs on target");

    const errors = collectPageErrors(page);
    await page.goto(`/portal/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();

    // Either the report workspace, or a *valid* explicit state — never a crash.
    const workspace = page.getByText("Published report workspace", { exact: false });
    const explicit = page.getByText(/No published report is available yet|not granted to your account/i);
    await expect(workspace.or(explicit).first()).toBeVisible();
    await expect(page.getByText("could not be loaded", { exact: false })).toHaveCount(0);

    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test.describe("UX1 — client-portal data-entry accordion rendered acceptance", () => {
  test.skip(!portalAccount(), "ACCEPTANCE_PORTAL_* not set");

  // Needs `data-entry-accordion` (+ `portal-spend`) on the target AND a granted
  // job whose entry window is open with authorised buckets. Skips otherwise. The
  // constrained mirror: the shared EmissionEntryForm (audience "portal"), one
  // authorised category at a time, submit-to-review.
  test("the portal accordion mirrors the CRP capture form and offers submit-to-review", async ({ page }) => {
    const job = await discoverPortalJob(page.request);
    test.skip(!job, "portal user has no granted jobs on target");

    const errors = collectPageErrors(page);
    await page.goto(`/portal/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();

    const dataTab = page.getByRole("tab", { name: "Data entry" });
    test.skip((await dataTab.count()) === 0, "no published report / data-entry tab for this portal user");
    await dataTab.click();

    const accordion = page.locator("div.nz-acc[aria-label='Authorised data-entry categories']");
    test.skip(
      (await accordion.count()) === 0,
      "portal accordion not shown (data-entry-accordion off, window closed, or no authorised buckets)",
    );

    const header = accordion.locator("button.nz-acc-h").first();
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");

    const body = header.locator("xpath=following-sibling::div[contains(@class,'nz-acc-body')]");
    // The shared capture form, or the re-homed spend surface — never a crash.
    const sharedForm = body.locator("form.nz-ef");
    const spendPanel = body.locator("#portal-spend-entry");
    await expect(sharedForm.or(spendPanel).first()).toBeVisible();

    if ((await sharedForm.count()) > 0) {
      // Portal is a constrained mirror: no factor / quality / confidence / lineage.
      await expect(sharedForm.getByText(/Quality tier|Calculation lineage|Data confidence/)).toHaveCount(0);
      await expect(sharedForm.getByRole("button", { name: "Submit for review" })).toBeVisible();
    }

    await scanWithBaseline(page, "portal-accordion", "#portal-report-content");
    await expectNoHorizontalOverflow(page, "portal accordion");

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
