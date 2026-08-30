import { defineConfig, devices } from "@playwright/test";

// Rendered acceptance runs against the deployed isolated staging service by default.
// Override with STAGING_BASE_URL to point at another isolated (never production) target.
const baseURL = process.env.STAGING_BASE_URL ?? "https://nzi-pro-api-prod.onrender.com";

export const STAFF_STATE = "test-results/state.staff.json";
export const PORTAL_STATE = "test-results/state.portal.json";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ["json", { outputFile: "test-results/e2e-results.json" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "staff",
      testMatch: /\.(spec)\.ts$/,
      testIgnore: /portal\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: STAFF_STATE },
    },
    {
      name: "portal",
      testMatch: /portal\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: PORTAL_STATE },
    },
  ],
});
