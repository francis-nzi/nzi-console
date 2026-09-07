import { test, expect } from "@playwright/test";
import { portalAccount } from "./lib/accounts";
import { totpCode } from "./lib/totp";
import { collectPageErrors } from "./lib/screen";

// Client portal Phase 2 — security precondition P1: idle auto-logout.
// Server-side enforcement (`resolvePortalPrincipal` rejects a stale session) is
// unit-tested in packages/isolated-backend/tests/portalSessionIdle.test.ts; this
// exercises the full path against deployed staging with Playwright's clock.
// Hard precondition once the portal is live — the only skip is "no portal
// account on the target".

const ORIGIN = new URL(process.env.STAGING_BASE_URL ?? "https://nzi-pro-api-prod.onrender.com").origin;

test.describe("P1 — portal inactivity auto-logout", () => {
  test.skip(!portalAccount(), "ACCEPTANCE_PORTAL_* not set");

  test("a warning dialog appears before the cut, and 'Stay signed in' keeps the session", async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.clock.install();
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();

    // Read the target's configured idle limit from the guard's own source.
    const me = await page.request.get("/api/portal/auth/me");
    const idleMinutes = ((await me.json()) as { idleLimitMinutes?: number }).idleLimitMinutes ?? 30;

    // Sit idle to just inside the 2-minute warning window.
    await page.clock.fastForward((idleMinutes * 60 - 60) * 1000);

    const dialog = page.getByRole("alertdialog", { name: /Session about to end/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/signed out after/i);
    await expect(dialog).toContainText(/\d:\d\d/); // the countdown

    await dialog.getByRole("button", { name: "Stay signed in" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/portal(\/)?$/);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("idle past the limit ends the session server-side and returns to sign-in", async ({ browser }) => {
    const account = portalAccount()!;
    // A throwaway session so revoking it does not disturb the shared portal state.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto("/portal/login", { waitUntil: "domcontentloaded" });
      const login = await page.request.post("/api/portal/auth/login", { data: { email: account.email, password: account.password }, headers: { origin: ORIGIN } });
      const challengeToken = ((await login.json()) as { challengeToken?: string }).challengeToken;
      expect(challengeToken, "portal password step should issue an MFA challenge").toBeTruthy();
      const mfa = await page.request.post("/api/portal/auth/mfa", { data: { challengeToken, code: totpCode(account.totp) }, headers: { origin: ORIGIN } });
      expect(((await mfa.json()) as { authenticated?: boolean }).authenticated, "portal MFA should authenticate").toBe(true);

      await page.clock.install();
      await page.goto("/portal", { waitUntil: "domcontentloaded" });
      await expect(page.locator("main")).toBeVisible();
      const idleMinutes = ((await (await page.request.get("/api/portal/auth/me")).json()) as { idleLimitMinutes?: number }).idleLimitMinutes ?? 30;

      await page.clock.fastForward((idleMinutes * 60 + 60) * 1000);

      await expect(page).toHaveURL(/\/portal\/login\?.*reason=idle/, { timeout: 15_000 });
      // The session is gone server-side, not just client-redirected.
      const after = await page.request.get("/api/portal/auth/me");
      expect(after.status(), "the timed-out session must be invalid on the next request").toBe(401);
    } finally {
      await context.close();
    }
  });
});
