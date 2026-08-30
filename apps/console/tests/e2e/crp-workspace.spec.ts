import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";

test.describe("M2 — CRP job workspace renders end to end", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

  test("the CRP workspace, per-entity register and client-factor panel all render", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");

    const errors = collectPageErrors(page);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });

    await expectHealthyScreen(page);

    // The command centre and stage sections (NZC-038).
    await expect(page.getByText("Engagement command centre", { exact: false })).toBeVisible();
    await expect(page.getByText(/Carbon Reduction Plan/i)).toBeVisible();

    // Regression guard: the client-factor UNION query (fix in PR #2) and the
    // per-entity register (0036) must resolve — a 503 here is what broke the
    // workspace when the fidelity schema first landed.
    await expect(page.getByText("Client-specific emission factors", { exact: false })).toBeVisible();
    await expect(page.getByText("Assets, vehicles, employees and spend sources", { exact: false })).toBeVisible();

    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the factor options endpoint returns dataset and client branches without error", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");
    const response = await page.request.get(`/api/isolated/jobs/${job!.id}/factors`);
    expect(response.status(), "factors endpoint must not 503 (numeric/text UNION regression)").toBe(200);
    const body = (await response.json()) as { factors?: unknown[]; datasets?: unknown[] };
    expect(Array.isArray(body.factors)).toBe(true);
    expect(Array.isArray(body.datasets)).toBe(true);
  });
});
