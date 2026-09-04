import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJobAtStage } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen, expandJobStage } from "./lib/screen";
import { scanWithBaseline } from "./lib/axe";

// R4 — in-place report section editor (NZC-048; docs/ACCEPTANCE_R4_SECTION_EDITOR.md).
// Runs only when a staff account is provided AND `report-edit` is live on the
// target. Harden (remove the flag skip) as part of the flip PR.

async function openReportPublishStage(page: Page): Promise<{ errors: string[] }> {
  const job = await discoverCrpJobAtStage(page.request, "Data entry");
  expect(job, "staging must expose a CRP job (seed J000712)").toBeTruthy();
  const errors = collectPageErrors(page);
  await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => undefined);
  await expectHealthyScreen(page);
  await expandJobStage(page, "stage-report-publish");
  return { errors };
}

test.describe("R4 — in-place report section editor", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set (public smoke run)");

  test("the Report & publish stage shows the editable narrative with locked figure chips", async ({ page }) => {
    const { errors } = await openReportPublishStage(page);

    const editor = page.locator(".nz-report-editor");
    test.skip((await editor.count()) === 0, "report-edit not enabled on target (no .nz-report-editor)");

    // Six sections, each with a source pill and Edit / Regenerate / Reset actions.
    const rows = editor.locator(".nz-report-section-row");
    expect(await rows.count()).toBe(6);
    await expect(rows.first().getByRole("button", { name: "Edit text" })).toBeVisible();
    await expect(rows.first().getByRole("button", { name: "Regenerate" })).toBeVisible();

    // Figure chips are present and resolved (no unresolved marker for a job that
    // has a target + intensity denominator).
    expect(await editor.locator(".nz-fig-token").count()).toBeGreaterThan(4);

    // Enter edit mode on the executive summary: a textbox appears, the tokens
    // inside it are not editable.
    const first = page.locator("#edit-section-executive-summary");
    await first.getByRole("button", { name: "Edit text" }).click();
    const box = first.getByRole("textbox");
    await expect(box).toBeVisible();
    await expect(box.locator('.nz-fig-token[contenteditable="false"]').first()).toBeVisible();
    await first.getByRole("button", { name: "Cancel" }).click();
    await expect(first.getByRole("textbox")).toHaveCount(0);

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the editor passes the axe baseline", async ({ page }) => {
    await openReportPublishStage(page);
    test.skip((await page.locator(".nz-report-editor").count()) === 0, "report-edit not enabled on target");
    await scanWithBaseline(page, "report-section-editor");
  });
});
