import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test as setup, expect, type Page } from "@playwright/test";
import { PORTAL_STATE, STAFF_STATE } from "../../playwright.config";
import { portalAccount, staffAccount, type Account } from "./lib/accounts";
import { totpCode } from "./lib/totp";

const EMPTY_STATE = JSON.stringify({ cookies: [], origins: [] });

function writeEmpty(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, EMPTY_STATE);
}

async function signIn(page: Page, account: Account, kind: "staff" | "portal"): Promise<void> {
  const prefix = kind === "staff" ? "/api/auth" : "/api/portal/auth";
  const landing = kind === "staff" ? "/" : "/portal";
  const headers = { origin: new URL(process.env.STAGING_BASE_URL ?? "https://nzi-pro-api-prod.onrender.com").origin };

  // Prime the origin so page.request shares the browser cookie jar.
  await page.goto(kind === "staff" ? "/login" : "/portal/login", { waitUntil: "domcontentloaded" });

  const login = await page.request.post(`${prefix}/login`, { data: { email: account.email, password: account.password }, headers });
  const loginBody = (await login.json()) as { mfaRequired?: boolean; challengeToken?: string; message?: string };
  if (!login.ok() || loginBody.mfaRequired !== true || !loginBody.challengeToken) {
    throw new Error(`${kind} login failed (${login.status()}): ${loginBody.message ?? JSON.stringify(loginBody)}`);
  }

  const mfa = await page.request.post(`${prefix}/mfa`, { data: { challengeToken: loginBody.challengeToken, code: totpCode(account.totp) }, headers });
  const mfaBody = (await mfa.json()) as { authenticated?: boolean; message?: string };
  if (!mfa.ok() || mfaBody.authenticated !== true) {
    throw new Error(`${kind} MFA failed (${mfa.status()}): ${mfaBody.message ?? JSON.stringify(mfaBody)}`);
  }

  // Confirm the session actually works against a gated screen.
  await page.goto(landing, { waitUntil: "domcontentloaded" });
  await expect(page, `${kind} session should not bounce back to sign-in`).not.toHaveURL(/\/login/);
  await expect(page.locator("main")).toBeVisible();
}

setup("authenticate staff", async ({ page }) => {
  const account = staffAccount();
  if (!account) {
    setup.info().annotations.push({ type: "skip", description: "ACCEPTANCE_STAFF_* not set — staff journeys will be skipped." });
    writeEmpty(STAFF_STATE);
    return;
  }
  await signIn(page, account, "staff");
  await page.context().storageState({ path: STAFF_STATE });
});

setup("authenticate portal", async ({ page }) => {
  const account = portalAccount();
  if (!account) {
    setup.info().annotations.push({ type: "skip", description: "ACCEPTANCE_PORTAL_* not set — portal journeys will be skipped." });
    writeEmpty(PORTAL_STATE);
    return;
  }
  await signIn(page, account, "portal");
  await page.context().storageState({ path: PORTAL_STATE });
});
