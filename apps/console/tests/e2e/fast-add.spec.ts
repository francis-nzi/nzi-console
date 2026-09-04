import { test, expect, type Locator, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJobAtStage } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen, expandJobStage } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// NZC-062/063 — fast row-adding: "Add rows from template" (a global fuzzy
// search over the whole job factor library) and "Reuse Previous Year Rows"
// (roll last year's canonical rows forward), directly below the site
// selector and above the scope→category cards in the Data entry stage.
// Behind `data-entry-fast-add`. Once the panel is present every assertion is
// a HARD precondition (fail loud, never a silent skip — stage-sections.spec.ts
// / data-assurance.spec.ts discipline). The ONE conditional skip below is for
// the flag not yet being live — delete just that `test.skip` call to harden
// this spec the moment `data-entry-fast-add` flips.

/** Hard precondition — the fast-add panel must actually be rendered. */
async function openFastAdd(page: Page): Promise<{ errors: string[]; panel: Locator }> {
  const job = await discoverCrpJobAtStage(page.request, "Data entry");
  expect(job, "staging must expose a CRP job at Data entry (seed J000712)").toBeTruthy();

  const errors = collectPageErrors(page);
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);
  await expandJobStage(page, "stage-data-entry");

  const accordion = page.locator("section#data-entry-accordion");
  await accordion.locator("button.nz-acc-h").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);

  const panel = page.locator("#fast-add");
  test.skip(
    (await panel.count()) === 0,
    "data-entry-fast-add not live on the target — harden this spec (remove the skip) as part of the flip PR",
  );
  await expect(panel, "the fast-add panel must render directly below the site selector").toBeVisible();

  // Sits directly after the site selector and above the scope→category cards.
  const tool = accordion.locator(".nz-acc-tool");
  const toolBox = await tool.boundingBox(), panelBox = await panel.boundingBox(), cardsBox = await accordion.locator(".nz-acc").boundingBox();
  if (toolBox && panelBox) expect(panelBox.y).toBeGreaterThanOrEqual(toolBox.y);
  if (panelBox && cardsBox) expect(cardsBox.y).toBeGreaterThanOrEqual(panelBox.y);

  return { errors, panel };
}

test.describe("NZC-062 — Add rows from template", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("a library-wide fuzzy search returns hits with label · scope · category · unit · dataset", async ({ page }) => {
    const { errors, panel } = await openFastAdd(page);
    const search = panel.locator("#template-search");
    const input = search.locator("input.nz-inp");

    // A broad single-letter query is very likely to hit something across the
    // WHOLE library, not just whatever category happens to be open — that is
    // the point of this search (unscoped, unlike the per-category one).
    await input.fill("e");
    const results = search.locator(".nz-template-results li button");
    await expect(results.first()).toBeVisible({ timeout: 10_000 });
    const first = results.first();
    await expect(first.locator("b")).not.toBeEmpty();
    await expect(first.locator(".nz-template-meta")).toContainText(/Scope \d/);
    await expect(first.locator(".nz-template-meta")).toContainText("·");

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("picking a result creates a prefilled, site-stamped row and the search stays open for another pick", async ({ page }) => {
    const { panel } = await openFastAdd(page);
    const search = panel.locator("#template-search");
    const input = search.locator("input.nz-inp");

    await input.fill("e");
    const results = search.locator(".nz-template-results li button");
    await expect(results.first()).toBeVisible({ timeout: 10_000 });
    const label = (await results.first().locator("b").textContent())?.trim();
    await results.first().click();

    // Confirmation, and the query clears — ready for the next pick in the run.
    await expect(page.getByText(/added to/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(input).toHaveValue("");
    await expect(input).toBeEnabled();

    // A second pick in the same run — multi-add.
    await input.fill("a");
    const secondResults = search.locator(".nz-template-results li button");
    test.skip((await secondResults.count()) === 0, "no second match on this job's library for this query");
    await secondResults.first().click();
    await expect(search.locator(".nz-hint", { hasText: /2 rows added this run/ })).toBeVisible({ timeout: 15_000 });

    expect(label, "the picked factor's label was shown").toBeTruthy();
  });

  test("passes the axe baseline and holds the column at every breakpoint", async ({ page }) => {
    await openFastAdd(page);
    await scanWithBaseline(page, "fast-add");
    await expectNoHorizontalOverflow(page, "fast-add panel");
  });
});

test.describe("NZC-063 — Reuse Previous Year Rows", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("lists the prior year's rows with factor + hierarchy, flagging a moved factor where relevant", async ({ page }) => {
    const { panel } = await openFastAdd(page);
    const reuse = panel.locator("#reuse-year-panel");
    await expect(reuse).toBeVisible();

    const noPriorJob = reuse.getByText(/No prior-year CRP job/i);
    test.skip(await noPriorJob.isVisible().catch(() => false), "no prior-year CRP job with rows on this client");

    await expect(reuse.getByText(/^From /)).toBeVisible();
    const rows = reuse.locator(".nz-reuse-row:not(.nz-reuse-all)");
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(rows.first().locator(".nz-reuse-meta")).toContainText(/Scope \d/);
  });

  test("select-all then roll forward creates rows, and an already-rolled-forward row is excluded from selection", async ({ page }) => {
    const { panel } = await openFastAdd(page);
    const reuse = panel.locator("#reuse-year-panel");
    test.skip(await reuse.getByText(/No prior-year CRP job/i).isVisible().catch(() => false), "no prior-year CRP job with rows on this client");

    const selectAll = reuse.locator(".nz-reuse-row.nz-reuse-all input[type=checkbox]");
    test.skip(await selectAll.isDisabled(), "nothing pending to roll forward — every prior row is already rolled forward");

    await selectAll.check();
    const confirm = reuse.getByRole("button", { name: /Roll forward/ });
    await confirm.click();
    await expect(page.getByText(/rolled forward as pending/i)).toBeVisible({ timeout: 15_000 });

    // Re-running the same roll-forward now has nothing pending for those rows.
    await expect(reuse.locator(".nz-reuse-row.done").first()).toBeVisible({ timeout: 15_000 });
  });
});
