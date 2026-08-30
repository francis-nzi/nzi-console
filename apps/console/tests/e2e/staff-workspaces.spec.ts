import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverClient, discoverCrpJob, discoverReportVersion } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";

test.describe("M3 — staff workspaces render", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

  const staticRoutes = ["/", "/clients", "/jobs", "/datasets", "/reports", "/platform", "/charts", "/lca", "/sales"];

  for (const route of staticRoutes) {
    test(`renders ${route}`, async ({ page }) => {
      const errors = collectPageErrors(page);
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expectHealthyScreen(page);
      expect(errors, `page errors on ${route}:\n${errors.join("\n")}`).toEqual([]);
    });
  }

  test("renders a client detail page", async ({ page }) => {
    const client = await discoverClient(page.request);
    test.skip(!client, "no clients on target");
    const errors = collectPageErrors(page);
    await page.goto(`/clients/${client!.id}`, { waitUntil: "domcontentloaded" });
    await expectHealthyScreen(page);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("renders a report detail page", async ({ page }) => {
    const report = await discoverReportVersion(page.request);
    test.skip(!report, "no report versions on target");
    const errors = collectPageErrors(page);
    await page.goto(`/reports/${report!.id}`, { waitUntil: "domcontentloaded" });
    await expectHealthyScreen(page);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("Jobs index lists at least one job and links into its workspace", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no jobs on target");
    await page.goto("/jobs", { waitUntil: "domcontentloaded" });
    await expectHealthyScreen(page);
    await expect(page.getByText(job!.number, { exact: false }).first()).toBeVisible();
  });
});
