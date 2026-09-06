import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJobAtStage } from "./lib/discover";
import { expandJobStage } from "./lib/screen";

// Regression guard for the three shared a11y building blocks (@nzi/ui) built
// after the Data Assurance human pass — a tablist with roving-tabindex arrow
// nav, a dismissible overlay Drawer with Escape + focus management, and a
// GatedButton that stays focusable + describes why it is blocked. Exercised
// on the surfaces that use them so the same three defects can't reappear in a
// future human pass. `data-assurance` is live on staging.

async function openAssurance(page: Page): Promise<ReturnType<Page["locator"]>> {
  const job = await discoverCrpJobAtStage(page.request, "Data entry");
  expect(job, "staging must expose a CRP job at Data entry (seed J000712)").toBeTruthy();
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expandJobStage(page, "stage-review-qa");
  const surface = page.locator(".nz-assurance");
  await expect(surface, "the Data Assurance surface must be live on the target").toBeVisible();
  return surface;
}

test.describe("A11y primitives — shared keyboard / screen-reader building blocks", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("Tabs: roving tabindex + Arrow/Home/End move and activate; Tab leaves the tablist", async ({ page }) => {
    const surface = await openAssurance(page);
    const tablist = surface.locator('[role="tablist"][aria-label="Data assurance views"]');
    const tabs = tablist.getByRole("tab");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await expect(tabs.first()).toHaveAttribute("tabindex", "0");
    await expect(tabs.nth(1)).toHaveAttribute("tabindex", "-1");

    await tabs.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(surface.locator('[role="tabpanel"]#assurance-panel-scope')).toBeVisible();

    await page.keyboard.press("End");
    await expect(tabs.last()).toBeFocused();
    await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(tabs.first()).toBeFocused();

    // Tab moves OUT of the tablist, not to the next tab.
    await page.keyboard.press("Tab");
    await expect(tabs.nth(1)).not.toBeFocused();
  });

  test("Drawer: role=dialog, Escape closes it, focus returns to the opener", async ({ page }) => {
    const surface = await openAssurance(page);
    const dialog = page.locator('[role="dialog"][aria-label="Data assurance detail"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    // Close it, then reopen via the keyboard-reachable reopen button.
    await dialog.getByRole("button", { name: /Close data assurance detail/ }).click();
    await expect(dialog).toHaveCount(0);
    const reopen = surface.locator("button.nz-assurance-reopen");
    await expect(reopen).toBeVisible();
    await reopen.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();

    // Focus is inside the drawer; Escape closes and returns focus to the reopen button.
    await expect(async () => {
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }).toPass({ timeout: 3_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(reopen).toBeFocused();
  });

  test("GatedButton: sign-off is aria-disabled (not disabled), focusable, and describes why it is blocked", async ({ page }) => {
    const surface = await openAssurance(page);
    const signOff = surface.getByRole("button", { name: /Sign off & freeze snapshot/ });
    await expect(signOff).toBeVisible();

    const [nativeDisabled, ariaDisabled, describedBy] = await signOff.evaluate((el) => [
      el.hasAttribute("disabled"), el.getAttribute("aria-disabled"), el.getAttribute("aria-describedby"),
    ]);
    // If the target job's data happens to be sign-off-ready this test is moot.
    test.skip(ariaDisabled !== "true", "this job's assurance state is already sign-off-ready");
    expect(nativeDisabled, "a gated button must not use the native disabled attribute").toBe(false);
    expect(describedBy, "a blocked gated button must point at its reason").toBeTruthy();

    await signOff.focus();
    await expect(signOff, "a gated button stays in the tab order").toBeFocused();
    const reason = page.locator(`[id="${describedBy}"]`);
    await expect(reason).toContainText(/Blocked:/);
  });
});
