import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverClient } from "./lib/discover";

// The client edit record (NZC-064) gates both its Save controls on unsaved
// changes. A native `disabled` would drop them out of the tab order, so a
// keyboard / screen-reader user could neither reach the control nor hear why it
// does nothing — the same defect the Data Assurance human pass found on sign-off.
// GatedButton keeps them focusable and describes the gate; this guards that, and
// that an edit actually releases it.

async function openEdit(page: Page): Promise<void> {
  const client = await discoverClient(page.request);
  expect(client, "staging must expose at least one client").toBeTruthy();
  await page.goto(`/clients/${client!.id}/edit`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expect(page.getByRole("tab", { name: "Details" })).toBeVisible();
}

const saveControls = (page: Page) => ({
  header: page.getByRole("button", { name: "Save all" }),
  panel: page.getByRole("button", { name: "Save", exact: true }),
});

test.describe("Client edit — dirty-gated Save", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("with no edits both Save controls stay focusable and expose the blocked reason", async ({ page }) => {
    await openEdit(page);
    for (const [which, control] of Object.entries(saveControls(page))) {
      await expect(control, `${which} Save must render`).toBeVisible();
      const [nativeDisabled, ariaDisabled, describedBy] = await control.evaluate((el) => [
        el.hasAttribute("disabled"), el.getAttribute("aria-disabled"), el.getAttribute("aria-describedby"),
      ]);
      expect(nativeDisabled, `${which} Save must not use the native disabled attribute`).toBe(false);
      expect(ariaDisabled, `${which} Save must be aria-disabled while clean`).toBe("true");
      expect(describedBy, `${which} Save must point at its blocked reason`).toBeTruthy();

      await control.focus();
      await expect(control, `${which} Save stays in the tab order`).toBeFocused();
      await expect(page.locator(`[id="${describedBy}"]`)).toContainText("No unsaved changes");
    }
  });

  test("a blocked Save does nothing when clicked", async ({ page }) => {
    await openEdit(page);
    // `force` bypasses Playwright's actionability wait — which by itself proves the
    // control reads as disabled to tooling. What is under test is the onClick guard
    // behind it, since aria-disabled alone does not stop a real pointer event.
    await saveControls(page).panel.click({ force: true });
    await page.waitForTimeout(500);
    await expect(page.locator(".nz-banner")).toHaveCount(0);
    await expect(saveControls(page).panel).toHaveAttribute("aria-disabled", "true");
  });

  test("editing a field releases both Save controls", async ({ page }) => {
    await openEdit(page);
    const manager = page.locator("#client-clientManager");
    await manager.fill(`${(await manager.inputValue()).trim()} `.trim() + " QA");

    for (const [which, control] of Object.entries(saveControls(page))) {
      await expect(control, `${which} Save must become actionable after an edit`).not.toHaveAttribute("aria-disabled", "true");
      await expect(control).not.toHaveAttribute("aria-describedby", /./);
    }
  });

  test("a validation error marks the field itself, not only the message", async ({ page }) => {
    await openEdit(page);
    await page.locator("#client-website").fill("not-a-url");
    await saveControls(page).panel.click();
    await expect(page.locator("#client-website-error")).toBeVisible();
    await expect(page.locator("#client-website")).toHaveClass(/\bbad\b/);
    await expect(page.locator("#client-website")).toHaveAttribute("aria-invalid", "true");
  });
});
