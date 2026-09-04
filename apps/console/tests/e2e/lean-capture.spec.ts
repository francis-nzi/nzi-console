import { test, expect, type Locator, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJobAtStage } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// DA4 — lean capture + drawer refine (NZC-058; docs/ACCEPTANCE_DA4_LEAN_CAPTURE.md).
// Behind `entry-lean-capture`. A new CRM entry captures core fields only —
// registration/activity, quantity + unit, site-context, save — with the factor
// auto-matched and shown read-only, and quality tier / data confidence /
// evidence notes / supporting documents deferred to the row's existing detail
// drawer (`.nz-drawer`, unforked — it already carries these fields). Once the
// lean shape is present every assertion is a HARD precondition (fail loud,
// never a silent skip — stage-sections.spec.ts / data-assurance.spec.ts
// discipline). The ONE conditional skip below is for the flag not yet being
// live on the target — delete just that `test.skip` call to harden this spec
// the moment `entry-lean-capture` flips, same one-line change as every other
// flag-gated spec in this suite.

/** Expand a category card by its taxonomy name; null if the job doesn't include it. */
async function expandCategory(accordion: Locator, name: string): Promise<Locator | null> {
  const header = accordion.locator("button.nz-acc-h", { hasText: name }).first();
  if ((await header.count()) === 0) return null;
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  return header.locator("xpath=following-sibling::div[contains(@class,'nz-acc-body')]").first();
}

/** Hard precondition — the lean-capture form shape must actually be rendered. */
async function openLeanCapture(page: Page): Promise<{ form: Locator; body: Locator; errors: string[] }> {
  const job = await discoverCrpJobAtStage(page.request, "Data entry");
  expect(job, "staging must expose a CRP job at Data entry (seed J000712)").toBeTruthy();

  const errors = collectPageErrors(page);
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);

  const accordion = page.locator("section#data-entry-accordion");
  await accordion.locator("button.nz-acc-h").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);

  let body: Locator | null = null;
  for (const name of ["Natural Gas", "Fuel & Energy Related", "Waste in Operations", "Purchased Goods and Services"]) {
    body = await expandCategory(accordion, name);
    if (body) break;
  }
  expect(body, "no manual/spend category available on this job to add an entry to").toBeTruthy();

  await body!.getByRole("button", { name: /Add entry/ }).click();
  const form = body!.locator("form.nz-ef");
  await expect(form).toBeVisible();

  test.skip(
    (await form.locator(".nz-ef-factor-review").count()) === 0,
    "entry-lean-capture not live on the target — harden this spec (remove the skip) as part of the flip PR",
  );

  return { form, body: body!, errors };
}

test.describe("DA4 — lean capture + drawer refine", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("a new CRM entry shows core fields only, with the factor read-only and unmatched", async ({ page }) => {
    const { form, errors } = await openLeanCapture(page);

    await expect(form.getByText(/smart search/i).first()).toBeVisible();
    await expect(form.locator("input.nz-inp").first()).toBeVisible();

    // Factor is shown for confirmation, not a required pick — unmatched until
    // the typed activity exactly hits a listed factor.
    const factorReview = form.locator(".nz-ef-factor-review");
    await expect(factorReview).toBeVisible();
    await expect(factorReview.locator(".nz-banner.warn")).toContainText(/No factor matched/i);

    // The refine fields moved out of capture entirely.
    await expect(form.getByLabel("Quality tier")).toHaveCount(0);
    await expect(form.getByLabel("Data confidence")).toHaveCount(0);
    await expect(form.locator("textarea.nz-notes")).toHaveCount(0);
    await expect(form.getByText("Supporting documents")).toHaveCount(0);
    await expect(form.getByText(/set in the row's evidence panel after saving/i)).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("picking a listed activity auto-matches its factor for confirmation", async ({ page }) => {
    const { form } = await openLeanCapture(page);

    const activityInput = form.locator("input.nz-inp").first();
    const options = form.locator("datalist option");
    test.skip((await options.count()) === 0, "no factors scoped to this category on this job");

    const label = await options.first().getAttribute("value");
    expect(label).toBeTruthy();
    await activityInput.fill(label!);

    const factorReview = form.locator(".nz-ef-factor-review");
    await expect(factorReview.locator(".nz-banner.ok")).toContainText(label!, { timeout: 10_000 });
  });

  test("accept match → qty → save creates the row; quality tier and evidence notes are then set in its drawer", async ({ page }) => {
    const { form, body, errors } = await openLeanCapture(page);

    const marker = `e2e lean capture ${Date.now()}`;
    await form.locator("input.nz-inp").first().fill(marker);
    const quantity = form.locator(".nz-ef-two input.nz-inp").first();
    await quantity.fill("42");

    await form.getByRole("button", { name: "Save entry" }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });

    const row = body.locator("tr.row", { hasText: marker }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    // The existing row-detail drawer is unforked and already carries the
    // refine fields — DA4 only removed them from capture, not from the row.
    const drawer = page.locator("aside.nz-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel("Quality")).toBeVisible();
    await expect(drawer.getByLabel("Data confidence")).toBeVisible();
    await expect(drawer.getByText("Evidence notes")).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("passes the axe baseline and holds the column at every breakpoint", async ({ page }) => {
    const { body } = await openLeanCapture(page);
    await scanWithBaseline(page, "lean-capture", "#data-entry-accordion");
    await expectNoHorizontalOverflow(page, "lean capture form");
    await expect(body).toBeVisible();
  });
});
