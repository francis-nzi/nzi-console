import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors } from "./lib/screen";

// Data-entry UX review item 5 — Business Travel joins Company Vehicles and
// Employee Commuting as a per-entity roll-up kind (many trips across modes →
// one canonical Scope 3.6 row). `travel` is LIVE on deployed staging (added to
// NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 by Francis, 7 Sep 2026). Hardened: the
// Business-travel kind is a HARD precondition — the only skip is the suite-wide
// "no staff account" gate.

test.describe("Business Travel per-entity register (item 5)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("the source register offers a Business travel kind with its trip fields", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");
    const errors = collectPageErrors(page);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    const register = page.locator("section#emission-source-register");
    await expect(
      register,
      "per-entity source register absent — commuting / vehicle / travel must be live on the target",
    ).toBeVisible();

    await register.getByRole("button", { name: "Add source" }).click();

    const typeSelect = register.getByRole("combobox", { name: "Type" });
    await expect(typeSelect).toBeVisible();
    await expect(
      typeSelect.locator("option", { hasText: "Business travel" }),
      "Business travel kind missing — `travel` must be in NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2",
    ).toHaveCount(1);

    await typeSelect.selectOption({ label: "Business travel" });
    // The scope follows the kind (Scope 3.6 · Business travel).
    await expect(register.getByRole("combobox", { name: "Scope" })).toHaveValue("3.6");
    // The trip-detail fields appear.
    await expect(register.getByRole("combobox", { name: "Travel mode" })).toBeVisible();
    await expect(register.getByRole("textbox", { name: "From" })).toBeVisible();
    await expect(register.getByRole("textbox", { name: "To" })).toBeVisible();
    await expect(register.getByRole("textbox", { name: "Carrier" })).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
