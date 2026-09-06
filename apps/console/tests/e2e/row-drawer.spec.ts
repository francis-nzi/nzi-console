import { test, expect, type Locator, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";

// Data-entry UX review (docs/_handoff_DATA_ENTRY_UX_review.md) — the row-detail
// drawer.
//   Item 1: EVERY displayed row opens the shared right-hand drawer, including
//   rows not in the flat register's current filter (a calculated + approved row
//   is not "needs attention", so before the fix clicking it snapped the drawer
//   to the first attention row).
//   Item 2: the drawer is reworked to the prototype — 7 key fields always
//   visible, everything else in collapsed-by-default sections, single column,
//   the Source-detail section adapts to the row type, ⓘ tooltips.
//
// Behind `data-entry-accordion` (+ the per-adapter flags for the source
// register). Hard precondition once the flag is live — the only skips are the
// public-smoke gate and the target job's data state.

const KEY_LABELS = ["Site", "Scope", "Category", "Report label", "Quantity", "UoM", "tCO₂e"];
const SECTIONS = ["Factor & calculation", "Data quality", "Apportionment & site", "Monthly activity", "Evidence & provenance"];

async function openFirstRowDrawer(page: Page, accordion: Locator): Promise<Locator> {
  const headers = accordion.locator("button.nz-acc-h");
  for (let i = 0; i < (await headers.count()); i += 1) {
    const header = headers.nth(i);
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  }
  const firstRow = accordion.locator("tr.row").first();
  test.skip((await firstRow.count()) === 0, "no category rows on this job");
  await firstRow.click();
  const drawer = page.locator("aside.nz-drawer");
  await expect(drawer).toBeVisible();
  return drawer;
}

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

  test("item 2 — the 7 key fields are always visible; the other sections are collapsed by default", async ({ page }) => {
    const { accordion } = await openAccordion(page);
    const drawer = await openFirstRowDrawer(page, accordion);

    const keys = drawer.locator(".nz-rd-keys .kv");
    await expect(keys).toHaveCount(KEY_LABELS.length);
    for (const [i, label] of KEY_LABELS.entries()) {
      await expect(keys.nth(i).locator(".l")).toHaveText(label);
    }

    // Every collapsible section is closed on open.
    const sections = drawer.locator(".nz-collapsible");
    await expect(sections.first()).toBeVisible();
    for (const heading of SECTIONS) {
      const header = drawer.locator(".nz-collapsible-h", { hasText: heading });
      if ((await header.count()) === 0) continue;
      await expect(header).toHaveAttribute("aria-expanded", "false");
    }

    // No sideways scroll inside the drawer.
    const overflow = await drawer.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "the row drawer must not scroll horizontally").toBeLessThanOrEqual(1);
  });

  test("item 2 — a section expands on click and its ⓘ tooltip opens and closes by keyboard", async ({ page }) => {
    const { accordion } = await openAccordion(page);
    const drawer = await openFirstRowDrawer(page, accordion);

    const factorHeader = drawer.locator(".nz-collapsible-h", { hasText: "Factor & calculation" });
    await factorHeader.click();
    await expect(factorHeader).toHaveAttribute("aria-expanded", "true");
    const factorPanel = drawer.locator(".nz-collapsible.open", { has: factorHeader });
    await expect(factorPanel.locator("select").first()).toBeVisible();

    const info = factorPanel.locator(".nz-infotip").first();
    test.skip((await info.count()) === 0, "no info tooltip in this section");
    await info.locator("button.nz-infotip-btn").click();
    await expect(info).toHaveClass(/open/);
    await expect(info.locator(".nz-infotip-pop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(info).not.toHaveClass(/open/);
  });

  test("item 2 — the Source detail section title adapts to the row type", async ({ page }) => {
    const { accordion } = await openAccordion(page);
    const headers = accordion.locator("button.nz-acc-h");
    for (let i = 0; i < (await headers.count()); i += 1) {
      const header = headers.nth(i);
      if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    }
    // A Purchased Goods & Services row → "Spend detail (PG&S)" section.
    const pgsCard = accordion.locator(".nz-acc-cat", { has: page.locator(".nz-acc-h", { hasText: /Purchased Goods/i }) });
    test.skip((await pgsCard.count()) === 0, "job has no Purchased Goods & Services category");
    const pgsRow = pgsCard.locator("tr.row").first();
    test.skip((await pgsRow.count()) === 0, "no PG&S rows on this job");
    await pgsRow.click();

    const drawer = page.locator("aside.nz-drawer");
    await expect(drawer.locator(".nz-collapsible-h", { hasText: "Spend detail (PG&S)" })).toBeVisible();
  });

  test("item 3 — the category kind-note is an ⓘ, not a standing paragraph", async ({ page }) => {
    const { accordion } = await openAccordion(page);
    const headers = accordion.locator("button.nz-acc-h");
    for (let i = 0; i < (await headers.count()); i += 1) {
      const header = headers.nth(i);
      if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    }
    // The always-visible instruction strip is gone everywhere...
    await expect(accordion.locator(".nz-acc-kindnote")).toHaveCount(0);
    // ...and at least one category foot now carries the ⓘ instead.
    await expect(accordion.locator(".nz-acc-foot .nz-infotip button.nz-infotip-btn").first()).toBeVisible();
  });
});
