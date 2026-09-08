import { expect, test, type APIRequestContext } from "@playwright/test";
import { portalAccount } from "./lib/accounts";
import { discoverPortalJob } from "./lib/discover";
import { expectNoHorizontalOverflow, scanWithBaseline } from "./lib/axe";

const ORIGIN = new URL(process.env.STAGING_BASE_URL ?? "https://nzi-pro-api-prod.onrender.com").origin;
async function acceptTerms(request: APIRequestContext) {
  const me = await (await request.get("/api/portal/auth/me")).json() as { mustAcceptTerms?: boolean; termsVersion?: string };
  if (me.mustAcceptTerms && me.termsVersion) expect((await request.post("/api/portal/auth/accept-terms", { data: { version: me.termsVersion }, headers: { origin: ORIGIN } })).ok()).toBeTruthy();
}

test.describe("Portal A2-lite — qualitative action tracker", () => {
  test.skip(!portalAccount(), "ACCEPTANCE_PORTAL_* not set");

  test("shows the assured baseline beside all 24 levers and persists a client-managed action without moving emissions", async ({ page }) => {
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await acceptTerms(page.request);
    const job = await discoverPortalJob(page.request);
    test.skip(!job, "portal user has no granted jobs on target");
    await page.goto(`/portal/jobs/${job!.id}/dashboard`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".nz-action-tracker"), "portal-actions must be enabled on the staging target").toBeVisible();

    const baselineBefore = await (await page.request.get(`/api/portal/jobs/${job!.id}/dashboard`)).json() as { published?: boolean; total?: number; dataHash?: string };
    expect(baselineBefore.published, "A2 staging job must have an assured published baseline").toBe(true);
    await expect(page.locator(".nz-portal-dash-head")).toContainText("Assured emissions");
    await expect(page.locator(".nz-action-tracker")).toContainText("Engagement data · not assured emissions");
    await expect(page.locator(".nz-action-tracker details.nz-lever")).toHaveCount(24);
    await expect(page.locator(".nz-spheres > section")).toHaveCount(3);

    const title = `Acceptance action ${Date.now()}`;
    const createdResponse = await page.request.post(`/api/portal/jobs/${job!.id}/actions`, { headers: { origin: ORIGIN }, data: { leverCode: "C2.4", title, notes: "Temporary A2-lite staging proof", progressPercent: 20 } });
    const createdBody = await createdResponse.json() as { id?: string; version?: number; code?: string; message?: string };
    expect(createdResponse.status(), `action create failed: ${createdBody.code ?? "UNKNOWN"} · ${createdBody.message ?? "no message"}`).toBe(201);
    expect(createdBody.id).toBeTruthy();
    const created = { id: createdBody.id!, version: createdBody.version! };
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      const row = page.locator(".nz-lever li", { hasText: title });
      await expect(row).toContainText("20% complete");
      await row.getByRole("button", { name: "Edit action" }).click();
      await row.getByLabel("Action title").fill(`${title} edited`);
      await row.getByLabel("Notes").fill("Edited by the client; still engagement data only");
      await row.getByLabel("Completion").fill("60");
      await row.getByRole("button", { name: "Save action" }).click();
      await expect(page.getByRole("status")).toContainText("Action saved.");
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".nz-lever li", { hasText: `${title} edited` })).toContainText("60% complete");

      const baselineAfter = await (await page.request.get(`/api/portal/jobs/${job!.id}/dashboard`)).json() as { total?: number; dataHash?: string };
      expect(baselineAfter.total, "tracker writes cannot move assured emissions").toBe(baselineBefore.total);
      expect(baselineAfter.dataHash, "tracker writes cannot move assured evidence identity").toBe(baselineBefore.dataHash);
      expect((await page.request.get(`/api/portal/jobs/not-this-job/actions`)).ok(), "another job is outside the active grant").toBe(false);
    } finally {
      const latest = await (await page.request.get(`/api/portal/jobs/${job!.id}/actions`)).json() as { actions?: Array<{ id: string; version: number }> };
      const action = latest.actions?.find((candidate) => candidate.id === created.id);
      if (action) await page.request.delete(`/api/portal/jobs/${job!.id}/actions`, { headers: { origin: ORIGIN }, data: { actionId: action.id, expectedVersion: action.version } });
    }
  });

  test("passes the accessibility baseline and responsive widths", async ({ page }) => {
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await acceptTerms(page.request);
    const job = await discoverPortalJob(page.request);
    test.skip(!job, "portal user has no granted jobs on target");
    await page.goto(`/portal/jobs/${job!.id}/dashboard`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".nz-action-tracker"), "portal-actions must be enabled on the staging target").toBeVisible();
    await scanWithBaseline(page, "portal-actions", ".nz-action-tracker");
    await expectNoHorizontalOverflow(page, "portal A2-lite tracker");
  });
});
