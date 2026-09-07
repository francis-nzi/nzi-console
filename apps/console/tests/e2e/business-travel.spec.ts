import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors } from "./lib/screen";

// Data-entry UX review item 5 — Business Travel joins Company Vehicles and
// Employee Commuting as a per-entity roll-up kind (many trips across modes →
// one canonical Scope 3.6 row). Behind the NEXT_PUBLIC data-entry flag
// `travel`. HARDEN at the flip PR (remove the flag skip) — same discipline as
// data-assurance / report-paged.

test.describe("Business Travel per-entity register (item 5)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("the source register offers a Business travel kind with its trip fields", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");
    const errors = collectPageErrors(page);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    const register = page.locator("section#emission-source-register");
    await expect(register).toBeVisible();

    const addSource = register.getByRole("button", { name: "Add source" });
    test.skip((await addSource.count()) === 0, "no add-source path — no per-entity adapter flag on this target");
    await addSource.click();

    const typeSelect = register.getByRole("combobox", { name: "Type" });
    await expect(typeSelect).toBeVisible();
    // Flag not yet live → no "Business travel" option. Remove this skip at the flip PR.
    test.skip(
      (await typeSelect.locator("option", { hasText: "Business travel" }).count()) === 0,
      "`travel` not in NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 on this target yet",
    );

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
