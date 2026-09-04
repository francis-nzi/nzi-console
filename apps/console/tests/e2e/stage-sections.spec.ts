import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJobAtStage } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

// UX1e-1 acceptance — the stage-as-section CRP workspace layout
// (docs/ACCEPTANCE_UX1E_STAGE_SECTIONS.md, docs/STAGING_ACCEPTANCE_UX1E.md;
// NZC-038 / NZC-024). `job-stage-sections` is live on deployed staging.
//
// These tests DO NOT skip when the shell is missing. A conditional skip here is
// exactly why the flag flip went unverified for days — the spec silently opted
// out while the flag was off and nobody saw it. The only skip is the suite-wide
// "no staff account" gate (which turns the whole run into a public smoke run).
// Everything about the stage shell is a HARD precondition: absent => fail loudly.

// The five stage sections in workflow order, with the state a CRP job at the
// "Data entry" stage presents — the exact markers verified on /jobs/712:
// prior stage done + collapsed, current stage active + open, later stages
// to-do + collapsed.
const STAGE_SHELL = [
  { id: "stage-setup", heading: "1 · Setup", status: "done", open: false },
  { id: "stage-data-entry", heading: "2 · Data entry", status: "active", open: true },
  { id: "stage-factor-mapping", heading: "3 · Factor mapping", status: "todo", open: false },
  { id: "stage-review-qa", heading: "4 · Review & QA", status: "todo", open: false },
  { id: "stage-report-publish", heading: "5 · Report & publish", status: "todo", open: false },
] as const;

/** Hard precondition — the stage-as-section shell must actually be rendered. */
async function assertStageShell(page: Page): Promise<void> {
  const sections = page.locator("section.nz-stage-sec");
  await expect(
    sections,
    "job-stage-sections shell absent — the flag must be live on the target (NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 must include 'job-stage-sections')",
  ).toHaveCount(5);
  await expect(page.locator(".nz-focus-strip"), "focus strip replaces the command hero").toBeVisible();
  await expect(page.locator(".nz-command-hero"), "legacy command hero must be gone under the shell").toHaveCount(0);

  for (let index = 0; index < STAGE_SHELL.length; index++) {
    const { id, heading, status, open } = STAGE_SHELL[index]!;
    const section = page.locator(`section#${id}`);
    await expect(section, `${id} present`).toHaveCount(1);
    await expect(sections.nth(index), `${id} is section ${index + 1} in order`).toHaveAttribute("id", id);
    await expect(section, `${id} status is "${status}"`).toHaveClass(new RegExp(`(^|\\s)${status}(\\s|$)`));
    if (open) await expect(section, `${id} is expanded`).toHaveClass(/(^|\s)open(\s|$)/);
    else await expect(section, `${id} is collapsed`).not.toHaveClass(/(^|\s)open(\s|$)/);
    await expect(section.locator("button.nz-stage-sec-h b"), `${id} heading`).toContainText(heading);
  }
}

/** Discover the seeded CRP job at "Data entry", open it, assert the shell. */
async function openStageShell(page: Page): Promise<{ jobId: string; errors: string[] }> {
  const job = await discoverCrpJobAtStage(page.request, "Data entry");
  expect(job, "staging must expose a CRP job at the 'Data entry' stage (seed J000712)").toBeTruthy();

  const errors = collectPageErrors(page);
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);
  await assertStageShell(page);
  return { jobId: job!.id, errors };
}

test.describe("UX1e-1 — CRP stage-as-section layout", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("renders the five workflow stages as sections, Data entry expanded", async ({ page }) => {
    const { errors } = await openStageShell(page);

    // Data Entry holds the accordion (or the legacy adapters) and nothing else.
    const dataEntry = page.locator("section#stage-data-entry");
    await expect(dataEntry.locator("#data-entry-accordion, .nz-config-panel").first()).toBeVisible();

    // A collapsed later stage expands on click and shows its panel.
    const mapping = page.locator("section#stage-factor-mapping");
    await mapping.locator("button.nz-stage-sec-h").click();
    await expect(mapping).toHaveClass(/(^|\s)open(\s|$)/);
    await expect(mapping.locator(".nz-panel").first()).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the focus strip jumps to and opens the relevant stage", async ({ page }) => {
    await openStageShell(page);

    const review = page.locator("section#stage-review-qa");
    await expect(review).not.toHaveClass(/(^|\s)open(\s|$)/);
    await page.locator(".nz-focus-strip").getByRole("button", { name: /QA decisions/ }).click();
    await expect(review).toHaveClass(/(^|\s)open(\s|$)/);
  });

  test("the stage layout passes the axe baseline and holds the column", async ({ page }) => {
    await openStageShell(page);
    await scanWithBaseline(page, "stage-sections");
    await expectNoHorizontalOverflow(page, "stage sections");
  });
});
