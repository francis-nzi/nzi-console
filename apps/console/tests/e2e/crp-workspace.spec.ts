import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors, expandJobStage, expectHealthyScreen } from "./lib/screen";

test.describe("M2 — CRP job workspace renders end to end", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

  test("the CRP workspace, per-entity register and client-factor panel all render", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");

    const errors = collectPageErrors(page);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });

    await expectHealthyScreen(page);

    // The governed workflow control heads the workspace in both the command-hero
    // and the `job-stage-sections` layout (NZC-038) — a flag-stable anchor.
    await expect(page.getByText("Workflow stage", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Carbon Reduction Plan/i)).toBeVisible();

    // Regression guard: the client-factor UNION query (fix in PR #2) and the
    // per-entity register (0036) must resolve — a 503 here is what broke the
    // workspace when the fidelity schema first landed. ("Client methodology" is
    // the panel eyebrow in both the plain and the `client-factors`-managed view.)
    // Under `job-stage-sections` the client-factor panel is re-homed into the
    // collapsed Setup section and the register into Factor mapping — expand both.
    await expandJobStage(page, "stage-setup");
    await expandJobStage(page, "stage-factor-mapping");
    await expect(page.getByText("Client methodology", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Per-entity register", { exact: false })).toBeVisible();

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
