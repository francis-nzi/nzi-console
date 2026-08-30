import { test, expect } from "@playwright/test";
import { portalAccount } from "./lib/accounts";
import { discoverPortalJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";

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
