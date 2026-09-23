import { expect, test, type Page } from "@playwright/test";

/**
 * The capture lifecycle, in a browser, against this commit's build (NZC-147).
 *
 * ## Why these six and not others
 *
 * Every case here is something the function tests cannot reach. `resolveCaptureDrawer` is unit-tested and
 * those tests are good; they passed throughout the period when the surface put a drawer on screen that
 * nobody had asked for, because the defect was not in the decision — it was in a caller that seeded the
 * selection before the decision ran. What decides whether the drawer is open is the DOM after a render, and
 * the only thing that can read that is a browser.
 *
 * So the six are the transitions: the state at rest, and each way the surface changes it. A seventh test
 * asserting a colour or a label would not be part of a *lifecycle*, and this file is meant to stay small
 * enough that everyone keeps running it.
 *
 * ## Deterministic waits only
 *
 * There is no `waitForTimeout` in this file, and there should never be one. The gate runs with `retries: 0`
 * precisely so that a wrong wait fails instead of passing on the second attempt, and a sleep is a wrong
 * wait that usually works — which is the worst kind. Every wait here is on a condition: an element's
 * presence, an attribute's value, a count. Where something is genuinely asynchronous (a save crossing to
 * Postgres and back) the wait is on the thing that proves it finished, which is the drawer changing
 * identity, not on a duration somebody guessed.
 */

/** The synthetic CRP demonstrator. Created by `seeds/0001`, populated by `0002`, sited by `0012`. */
const JOB = "/jobs/712";

const drawer = (page: Page) => page.locator("aside.nz-drawer");

/** Open a category card by its visible name. Cards start collapsed, which is itself the at-rest rule. */
async function openCard(page: Page, name: string) {
  const header = page.locator("button.nz-acc-h").filter({ hasText: name }).first();
  await expect(header).toBeVisible();
  // Only act if it is closed: clicking an open card would collapse it, and a test that toggles twice
  // depending on the order it ran in is a flaky test with extra steps.
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  return header;
}

test.beforeEach(async ({ page }) => {
  await page.goto(JOB, { waitUntil: "domcontentloaded" });
  // The accordion is the surface under test; waiting for it means every test below starts from the same
  // point rather than racing the category view's own load.
  await expect(page.locator("#data-entry-accordion")).toBeVisible();
});

test("the drawer is closed at rest, and the shell knows it", async ({ page }) => {
  // The defect this replaces: the surface opened a detail drawer for whichever row happened to be first,
  // describing a row nobody had chosen. It survived because the unit test for the decision was right and
  // nothing rendered the page.
  await expect(drawer(page)).toHaveCount(0);
  // Not only absent — the shell lays out as a page without one. A drawer that is present and empty would
  // satisfy a count of zero on its contents while still taking the column.
  await expect(page.locator(".nz-app.no-drawer")).toHaveCount(1);

  // And every card is collapsed, which is the same rule one level down.
  const expanded = page.locator("button.nz-acc-h[aria-expanded='true']");
  await expect(expanded).toHaveCount(0);
});

test("asking to add an entry opens the drawer on that category", async ({ page }) => {
  await openCard(page, "Natural Gas");
  await page.getByRole("button", { name: /Add entry/ }).first().click();

  // The drawer names the category it will write to. This is the assertion that the *right* drawer opened:
  // a quick-add pointed at another category would be indistinguishable from this one without it.
  await expect(drawer(page)).toHaveAttribute("aria-label", /1\.natural-gas · Natural Gas: Add entry/);
  await expect(drawer(page).getByRole("button", { name: "Save entry" })).toBeVisible();
});

test("saving keeps the drawer open on the row just created", async ({ page }) => {
  // v2 closed the drawer on save. It should not: the quantity and the factor are in, the evidence and the
  // monthly split usually are not, and closing at that moment asks somebody to find the row again.
  await openCard(page, "Natural Gas");
  await page.getByRole("button", { name: /Add entry/ }).first().click();
  await expect(drawer(page)).toHaveAttribute("aria-label", /Add entry/);

  // A label unique to this run, so the assertion cannot pass on a row left behind by an earlier one.
  const label = `Gate gas ${Date.now()}`;
  await drawer(page).getByPlaceholder(/Search this category/).fill(label);
  await drawer(page).getByLabel("Quantity", { exact: true }).fill("4242");

  await page.getByRole("button", { name: "Save entry" }).click();

  // The drawer did not close, and it is now the *detail* drawer for the new row — a different kicker and
  // the label just typed. Waiting on this is what makes the save's completion observable without a sleep.
  await expect(drawer(page)).toHaveAttribute("aria-label", new RegExp(`Scope row · version \\d+: ${label}`));
});

test("clicking a row opens that row's drawer", async ({ page }) => {
  await openCard(page, "Waste in Operations");
  const row = page.locator("tr.row").filter({ hasText: "Waste — landfill" }).first();
  await expect(row).toBeVisible();
  await row.click();

  await expect(drawer(page)).toHaveAttribute("aria-label", /Scope row · version \d+: Waste — landfill/);
  // The row is marked as the chosen one, so the register and the drawer agree about what is being edited.
  await expect(row).toHaveClass(/sel/);
});

test("a row the lens no longer shows keeps its drawer", async ({ page }) => {
  // The rule: the drawer follows what somebody chose, not what the current view happens to list. Switching
  // lens is a change of view, and closing the drawer on it would throw away an edit in progress because a
  // filter moved.
  await openCard(page, "Waste in Operations");
  await page.locator("tr.row").filter({ hasText: "Waste — landfill" }).first().click();
  await expect(drawer(page)).toHaveAttribute("aria-label", /Waste — landfill/);

  await page.getByRole("tab", { name: /Needs attention/ }).click();
  // Anti-vacuity: this only proves anything if the lens actually stops listing the row. An approved,
  // complete row is not something needing attention — if that ever changes, this must fail rather than
  // quietly assert nothing.
  await expect(page.locator("tr.row").filter({ hasText: "Waste — landfill" })).toHaveCount(0);
  await expect(drawer(page)).toHaveAttribute("aria-label", /Waste — landfill/);
});

test("a site tab re-scopes the register, and never invents an allocation", async ({ page }) => {
  const tab = (name: string) => page.locator("button.nz-site-tab").filter({ hasText: name }).first();

  // The seeded split: four rows at Bristol, four at Leeds, and one deliberately unallocated.
  //
  // The per-site counts are asserted literally and the total is asserted as an inequality, on purpose.
  // An earlier test in this file saves a new entry, and a saved entry has no site — so a literal total
  // here would make this test's result depend on whether the save test ran before it, which is a coupling
  // that would present as intermittent failure rather than as the ordering bug it is. What this test is
  // about is scoping, and the invariant that says scoping works does not care how many rows exist: the
  // site counts are unchanged by unallocated rows, and the total exceeds their sum because at least one
  // row belongs to no site.
  await expect(tab("Bristol depot")).toContainText("4");
  await expect(tab("Leeds office")).toContainText("4");
  const total = Number((await tab("All sites").textContent())?.replace(/\D/g, "") ?? "0");
  expect(total, "an unallocated row must still be counted under All sites").toBeGreaterThan(8);

  await tab("Bristol depot").click();
  await expect(tab("Bristol depot")).toHaveClass(/on/);

  // The unallocated spend row must not appear under a site. This is the honest-data rule: a row whose
  // site nobody recorded is shown under "All sites" and claimed for no depot. Reading it the other way —
  // "show it everywhere so it isn't lost" — would put a number on a site's report that nobody asserted.
  await openCard(page, "Purchased Goods and Services");
  await expect(page.locator("tr.row").filter({ hasText: "Purchased goods — spend" })).toHaveCount(0);

  // And it comes back when the scope widens again, so the row is filtered rather than dropped.
  await tab("All sites").click();
  await openCard(page, "Purchased Goods and Services");
  await expect(page.locator("tr.row").filter({ hasText: "Purchased goods — spend" })).toHaveCount(1);
});
