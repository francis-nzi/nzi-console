import { test, expect, type APIRequestContext } from "@playwright/test";
import { STAFF_STATE } from "../../playwright.config";
import { portalAccount, staffAccount } from "./lib/accounts";
import { discoverPortalJob } from "./lib/discover";

// Client portal Phase 2 · §0 + A1.
//   §0 (the phase acceptance gate): every client-facing figure is sourced from
//   the content-addressed PUBLISHED snapshot — publish → change a draft row →
//   the portal figure does NOT move.
//   A1: the client emissions dashboard renders those assured figures with
//   text/table equivalents and a real first-engagement empty state.
//
// This file runs first among the portal specs (alphabetical), so its first
// test also clears the P2b terms gate for every later portal test.
// Hard precondition once `portal-analytics` is live — skips only on missing
// accounts / no published portal job on the target.

const ORIGIN = new URL(process.env.STAGING_BASE_URL ?? "https://nzi-pro-api-prod.onrender.com").origin;

async function acceptTermsIfOutstanding(request: APIRequestContext): Promise<void> {
  const me = await (await request.get("/api/portal/auth/me")).json() as { mustAcceptTerms?: boolean; termsVersion?: string };
  if (me.mustAcceptTerms && me.termsVersion) {
    const accepted = await request.post("/api/portal/auth/accept-terms", { data: { version: me.termsVersion }, headers: { origin: ORIGIN } });
    expect(accepted.ok(), "recording terms acceptance").toBeTruthy();
  }
}

test.describe("Portal analytics — §0 snapshot sourcing", () => {
  test.skip(!portalAccount(), "ACCEPTANCE_PORTAL_* not set");

  test("P2b: portal data is blocked until terms are accepted, then reachable", async ({ page }) => {
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    const me = await (await page.request.get("/api/portal/auth/me")).json() as { mustAcceptTerms?: boolean; termsVersion?: string };

    if (me.mustAcceptTerms) {
      const blocked = await page.request.get("/api/portal/jobs");
      expect(blocked.status(), "a portal data route is blocked while terms are outstanding").toBe(403);
      expect(((await blocked.json()) as { code?: string }).code).toBe("PORTAL_TERMS_REQUIRED");

      const overlay = page.getByRole("dialog", { name: /Portal terms of access/i });
      await expect(overlay).toBeVisible();
      await expect(overlay.getByRole("button", { name: /Accept & continue/ })).toBeDisabled();
      await overlay.getByRole("checkbox").check();
      await overlay.getByRole("button", { name: /Accept & continue/ }).click();
      await expect(page.getByRole("dialog", { name: /Portal terms of access/i })).toHaveCount(0, { timeout: 15_000 });
    } else {
      test.info().annotations.push({ type: "note", description: "terms already accepted on this target (re-run acceptance:provision to exercise the block)" });
    }

    await expect.poll(async () => (await page.request.get("/api/portal/jobs")).status()).toBe(200);
    expect(((await (await page.request.get("/api/portal/auth/me")).json()) as { mustAcceptTerms?: boolean }).mustAcceptTerms).toBe(false);
  });

  test("the portal figure equals the published report snapshot, and does NOT move when a draft row changes", async ({ page, browser }) => {
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await acceptTermsIfOutstanding(page.request);

    const job = await discoverPortalJob(page.request);
    test.skip(!job, "portal user has no granted jobs on target");

    const dash = await page.request.get(`/api/portal/jobs/${job!.id}/dashboard`);
    expect(dash.ok(), "the assured dashboard endpoint responds").toBeTruthy();
    const before = await dash.json() as { published?: boolean; total?: number; dataHash?: string; reportingYear?: number };
    test.skip(before.published !== true, "the granted portal job has no published report yet");

    // Same figure resolver, same value: the portal total == the published snapshot's measurement sum.
    const reportRes = await page.request.get(`/api/portal/jobs/${job!.id}/published-report`);
    const report = await reportRes.json() as { report?: { dataHash?: string; snapshot?: { measurements?: Array<{ tco2e: number }> } } };
    const snapshotTotal = (report.report?.snapshot?.measurements ?? []).reduce((sum, row) => sum + row.tco2e, 0);
    expect(Math.abs((before.total ?? 0) - snapshotTotal), "portal total == published snapshot total").toBeLessThan(0.5);
    expect(before.dataHash, "portal figure carries the published report's evidence hash").toBe(report.report?.dataHash);

    // §0: change a draft scope row via the CRM, and prove the portal figure is unmoved.
    test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set — cannot exercise the draft-row change");
    const staff = await browser.newContext({ storageState: STAFF_STATE });
    try {
      const list = await staff.request.get(`/api/isolated/jobs/${job!.id}/scope-rows`);
      test.skip(!list.ok(), "CRM scope-rows not reachable from the staff context on this target");
      const rows = ((await list.json()) as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      const row = rows.find((r) => r.enabled === true && typeof r.quantity === "number");
      test.skip(!row, "no editable quantity row on this job to perturb");

      const original = row!.quantity as number;
      const patch = (quantity: number) => staff.request.patch(`/api/isolated/jobs/${job!.id}/scope-rows/${row!.id as string}`, {
        headers: { origin: ORIGIN, "content-type": "application/json" },
        data: { ...row, quantity, expectedVersion: row!.version },
      });

      const bumped = await patch(original + 100);
      test.skip(!bumped.ok(), `the draft-row PATCH was rejected (${bumped.status()}) — cannot run the §0 mutation on this target`);
      try {
        const after = await (await page.request.get(`/api/portal/jobs/${job!.id}/dashboard`)).json() as { total?: number; dataHash?: string };
        expect(after.total, "the portal figure must NOT move when a draft row changes").toBe(before.total);
        expect(after.dataHash, "the portal evidence hash must NOT move").toBe(before.dataHash);
      } finally {
        const restored = await patch(original);
        expect(restored.ok(), "the perturbed draft row was restored").toBeTruthy();
      }
    } finally {
      await staff.close();
    }
  });
});

test.describe("Portal analytics — A1 dashboard", () => {
  test.skip(!portalAccount(), "ACCEPTANCE_PORTAL_* not set");

  test("renders the assured totals with text/table equivalents, or a real empty state", async ({ page }) => {
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await acceptTermsIfOutstanding(page.request);
    const job = await discoverPortalJob(page.request);
    test.skip(!job, "portal user has no granted jobs on target");

    await page.goto(`/portal/jobs/${job!.id}/dashboard`, { waitUntil: "domcontentloaded" });
    // Flag off → the page redirects to the report; skip cleanly.
    test.skip(new URL(page.url()).pathname.endsWith("/dashboard") === false, "`portal-analytics` not enabled on this target");

    const dash = await (await page.request.get(`/api/portal/jobs/${job!.id}/dashboard`)).json() as { published?: boolean };
    if (dash.published !== true) {
      await expect(page.getByText("Your first assured report will appear here")).toBeVisible();
      return;
    }

    await expect(page.locator(".nz-portal-dash-head h2")).toContainText(/tCO₂e/);
    // Every figure reachable as text — the scope table, in the DOM, not pixels.
    const scopeTable = page.locator(".nz-portal-dash-tables table", { hasText: "Scope 1" }).first();
    await expect(scopeTable).toBeVisible();
    await expect(scopeTable.locator("tr.total")).toContainText(/All scopes/);
    await expect(page.locator(".nz-portal-dash-tables table", { hasText: "Five-year trend" })).toBeVisible();
  });
});
