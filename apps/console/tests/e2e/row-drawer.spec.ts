import { test, expect, type Locator, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";

// Data-entry UX review (docs/_handoff_DATA_ENTRY_UX_review.md) — the row-detail
// drawer. Item 1: EVERY displayed row opens the shared right-hand drawer,
// including rows that are not in the flat register's current filter (a
// calculated + independently-approved row is not "needs attention", so before
// the fix clicking it snapped the drawer to the first attention row instead).
//
// Behind `data-entry-accordion` (+ the per-adapter flags for the source
// register). Hard precondition once the flag is live — the only skips are the
// public-smoke gate and the target job's data state.

async function openAccordion(page: Page): Promise<{ accordion: Locator; errors: string[] }> {
  const job = await discoverCrpJob(page.request);
  test.skip(!job, "no CRP job on target");
  const errors = collectPageErrors(page);
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);

  const accordion = page.locator("section#data-entry-accordion");
  const failed = page.getByText("The category view is unavailable");
  await accordion.or(failed).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  test.skip((await accordion.count()) === 0, "data-entry-accordion not enabled on target");
  await expect(accordion.locator("button.nz-acc-h").first()).toBeVisible({ timeout: 20_000 });
  return { accordion, errors };
}

test.describe("Data-entry row-detail drawer", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("item 1 — a calculated + approved category row opens in the drawer, not the first attention row", async ({ page }) => {
    const { accordion, errors } = await openAccordion(page);

    // Expand every category card so their row tables are in the DOM.
    const headers = accordion.locator("button.nz-acc-h");
    for (let i = 0; i < (await headers.count()); i += 1) {
      const header = headers.nth(i);
      if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    }

    // A row that is NOT "needs attention": enabled, calculated, and approved —
    // its Review cell carries `.nz-st.done`. This is exactly the row class that
    // the flat register's default "attention" filter hides.
    const approvedRow = accordion.locator("tr.row", { has: page.locator("td .nz-st.done") }).first();
    test.skip((await approvedRow.count()) === 0, "no calculated + approved row on this job to open");

    const label = (await approvedRow.locator("td").first().innerText()).split("\n")[0]!.trim();
    await approvedRow.click();

    const drawer = page.locator("aside.nz-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".nz-dh h3")).toHaveText(label);
    await expect(approvedRow).toHaveClass(/sel/);

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("item 1 — a synced source in the per-entity register opens its canonical row in the drawer", async ({ page }) => {
    await openAccordion(page);
    const register = page.locator("section#emission-source-register");
    await expect(register).toBeVisible();

    // A synced source renders its name as a link-style button (`.nz-linkish`);
    // an unsynced one stays plain text.
    const linked = register.locator("td button.nz-linkish").first();
    test.skip((await linked.count()) === 0, "no synced per-entity source on this job");

    await linked.click();

    const drawer = page.locator("aside.nz-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".nz-dh .kick")).toContainText(/Scope row/);
    await expect(drawer.locator(".nz-dh h3")).not.toBeEmpty();
  });
});
