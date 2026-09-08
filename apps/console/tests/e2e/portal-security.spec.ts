import { test, expect } from "@playwright/test";
import { portalAccount } from "./lib/accounts";
import { totpCode } from "./lib/totp";
import { collectPageErrors } from "./lib/screen";

// Client portal Phase 2 — security preconditions.
//   P2b (terms-of-access gate) — runs FIRST: the acceptance run is provisioned
//     terms-outstanding, this asserts the block then records acceptance, which
//     clears it for every later portal test. Backend logic:
//     packages/isolated-backend/tests/portalTerms.test.ts.
//   P1 (idle auto-logout) — server enforcement in portalSessionIdle.test.ts;
//     this exercises the full path with Playwright's clock.
// Hard precondition once the portal is live — the only skip is "no portal
// account on the target" (+ a re-run-without-provision skip on P2b's block leg).

const ORIGIN = new URL(process.env.STAGING_BASE_URL ?? "https://nzi-pro-api-prod.onrender.com").origin;

test.describe("P2b — portal terms-of-access gate", () => {
  test.skip(!portalAccount(), "ACCEPTANCE_PORTAL_* not set");

  test("a user with terms outstanding is blocked from portal data until acceptance is recorded", async ({ page }) => {
    await page.goto("/portal", { waitUntil: "domcontentloaded" });

    const me = await (await page.request.get("/api/portal/auth/me")).json() as { mustAcceptTerms?: boolean; termsVersion?: string };
    expect(typeof me.termsVersion, "/me exposes the current terms version").toBe("string");

    // Endpoint guard: only the current version is acceptable.
    const stale = await page.request.post("/api/portal/auth/accept-terms", { data: { version: "0000-stale" }, headers: { origin: ORIGIN } });
    expect(stale.status(), "a stale terms version is refused").toBe(409);
    const empty = await page.request.post("/api/portal/auth/accept-terms", { data: {}, headers: { origin: ORIGIN } });
    expect(empty.status(), "an empty terms version is refused").toBe(422);

    test.skip(me.mustAcceptTerms !== true, "terms already accepted on this target — re-run `acceptance:provision` to exercise the block");

    // Blocked: a data route 403s while terms are outstanding.
    const blocked = await page.request.get("/api/portal/jobs");
    expect(blocked.status(), "portal data is blocked until terms are accepted").toBe(403);
    expect(((await blocked.json()) as { code?: string }).code).toBe("PORTAL_TERMS_REQUIRED");

    // The blocking overlay is present and dialog-shaped.
    const overlay = page.getByRole("dialog", { name: /Portal terms of access/i });
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole("button", { name: /Accept & continue/ })).toBeDisabled();

    // Accept.
    await overlay.getByRole("checkbox").check();
    await overlay.getByRole("button", { name: /Accept & continue/ }).click();
    await expect(page.getByRole("dialog", { name: /Portal terms of access/i })).toHaveCount(0, { timeout: 15_000 });

    // Unblocked: the same data route now succeeds, and /me clears the flag.
    await expect.poll(async () => (await page.request.get("/api/portal/jobs")).status()).toBe(200);
    expect(((await (await page.request.get("/api/portal/auth/me")).json()) as { mustAcceptTerms?: boolean }).mustAcceptTerms).toBe(false);
  });
});

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

    const dialog = page.getByRole("dialog", { name: /Session about to end/i });
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
