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

async function signIn(page: Page, account: Account, loginPath: string, landingPath: string): Promise<void> {
  await page.goto(loginPath);
  await page.fill('input[name="email"]', account.email);
  await page.fill('input[name="password"]', account.password);
  await page.getByRole("button", { name: /continue securely/i }).click();

  const code = page.locator('input[name="code"]');
  await expect(code, "MFA step should appear after a valid password").toBeVisible({ timeout: 15_000 });
  await code.fill(totpCode(account.totp));
  await page.getByRole("button", { name: /verify and continue/i }).click();

  await page.waitForURL((url) => url.pathname === landingPath || url.pathname.startsWith(landingPath), { timeout: 20_000 });
  await expect(page.locator("main")).toBeVisible();
}

setup("authenticate staff", async ({ page }) => {
  const account = staffAccount();
  if (!account) {
    setup.info().annotations.push({ type: "skip", description: "ACCEPTANCE_STAFF_* not set — staff journeys will be skipped." });
    writeEmpty(STAFF_STATE);
    return;
  }
  await signIn(page, account, "/login", "/");
  await page.context().storageState({ path: STAFF_STATE });
});

setup("authenticate portal", async ({ page }) => {
  const account = portalAccount();
  if (!account) {
    setup.info().annotations.push({ type: "skip", description: "ACCEPTANCE_PORTAL_* not set — portal journeys will be skipped." });
    writeEmpty(PORTAL_STATE);
    return;
  }
  await signIn(page, account, "/portal/login", "/portal");
  await page.context().storageState({ path: PORTAL_STATE });
});
