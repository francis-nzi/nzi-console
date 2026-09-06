import { expect, type Page } from "@playwright/test";

// Data-entry UX review item 4: the bulk adapters (spend ledger / spend import /
// roll-forward / commuting / vehicle) moved from the always-open category card
// body into a per-category "Import & templates" modal. On the accordion surface
// the panel only exists once the modal is open; on the legacy flat surface it is
// inline. This opens the modal when the accordion is present, and is a no-op
// otherwise — so an adapter spec works on both.
//
// Returns false when the category / trigger is absent (adapter flag off, or the
// category is not included on the job) — the caller then `test.skip`s, exactly
// as it did when the panel was inline.
export async function openImportModal(
  page: Page,
  category: RegExp,
  method?: RegExp,
): Promise<boolean> {
  const accordion = page.locator("section#data-entry-accordion");
  const failed = page.getByText("The category view is unavailable");
  await accordion.or(failed).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if ((await accordion.count()) === 0) return true; // legacy flat surface — panel is inline

  const header = accordion.locator("button.nz-acc-h", { hasText: category }).first();
  if ((await header.count()) === 0) return false;
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  const body = header.locator("xpath=following-sibling::div[contains(@class,'nz-acc-body')]").first();

  const trigger = body.getByRole("button", { name: /Import & templates/ });
  if ((await trigger.count()) === 0) return false;
  await trigger.click();

  const modal = page.locator('[role="dialog"].nz-import-modal');
  await expect(modal).toBeVisible();
  if (method) {
    const tab = modal.getByRole("tab", { name: method });
    if ((await tab.count()) > 0) await tab.click();
  }
  return true;
}
