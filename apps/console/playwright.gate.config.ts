import { defineConfig, devices } from "@playwright/test";

/**
 * The capture gate: browser tests that run against **this commit's own build** (NZC-147).
 *
 * ## Why this is a second config rather than a flag on the first
 *
 * `playwright.config.ts` is *rendered acceptance*: it points at the deployed staging service and signs in
 * with real credentials. That is a useful thing and it is not a gate, for two reasons.
 *
 *   1. **It tests what is deployed, not what is proposed.** A pull request's build is not on staging when
 *      its checks run, so a suite pointed at staging cannot fail on the change under review. The drawer
 *      defect would have passed it — the bug was not deployed yet.
 *   2. **Without credentials it skips itself and reports green.** `auth.setup.ts` writes an empty storage
 *      state and annotates a skip when `ACCEPTANCE_STAFF_*` is unset, so wiring that suite into CI without
 *      secrets produces a check that passes having executed nothing. That is the same shape of defect as a
 *      command with no capability check and a fallback that reopened a closed drawer: a thing that looks
 *      like a guard and cannot fail.
 *
 * So this config stands the whole stack up locally — Postgres, migrations, seeds, `next start` — and browses
 * it over loopback. No network, no credentials, no deployed environment. What it asserts is true of the
 * commit it runs on.
 *
 * ## No retries, on purpose
 *
 * The acceptance config retries twice in CI, which is right for a suite crossing a network to a shared
 * environment. Here a retry would hide the only thing this gate is bad at: flake. A test that passes on the
 * second attempt is a test whose waits are wrong, and the fix is a deterministic wait, not another attempt.
 * `forbidOnly` keeps a stray `test.only` from silently shrinking the gate to one case.
 */

const PORT = Number(process.env.GATE_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

/** The gate's own database, stood up by CI. Never a shared one, and never the acceptance target. */
const databaseUrl = process.env.NZI_ISOLATED_DATABASE_URL ?? "";

/**
 * A signing secret for this run only. The session the gate browses with is minted against it in
 * `global-setup`, so no login form is driven and no real account exists. 32 bytes is what the verifier
 * requires; a short one is refused rather than silently treated as unauthenticated.
 */
const sessionSecret = process.env.NZI_CONSOLE_SESSION_SECRET ?? "";

export const GATE_STATE = "test-results/state.gate.json";

export default defineConfig({
  testDir: "./tests/e2e-gate",
  outputDir: "./test-results/e2e-gate",
  globalSetup: "./tests/e2e-gate/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/gate-results.json" }]],
  use: {
    baseURL,
    storageState: GATE_STATE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "capture-gate", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `next start`, not `next dev`: the gate should exercise the build that would ship, including the
    // server-rendered first paint where the at-rest drawer state is decided.
    command: `npx next start -p ${PORT}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NZI_DATABASE_BOUNDARY: "isolated-non-production",
      NEXT_PUBLIC_APP_ENV: "staging",
      NZI_DATA_MODE: "isolated-api",
      NZI_ISOLATED_API_URL: baseURL,
      NZI_DEMO_ORGANISATION_ID: "demo-nzi-console",
      NZI_ISOLATED_DATABASE_URL: databaseUrl,
      // Capture is a write surface. A gate that could only read would prove the drawer opens and never
      // that saving keeps it open on the new row, which is half of what the lifecycle is.
      NZI_WRITE_API_ENABLED: "true",
      NZI_AUTH_ENABLED: "true",
      NZI_AUTH_REQUIRED: "true",
      NZI_CONSOLE_SESSION_SECRET: sessionSecret,
    },
  },
});
