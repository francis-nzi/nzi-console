import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { expectHealthyScreen } from "./lib/screen";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "wide", width: 1920, height: 1080 },
];

async function checkAt(page: import("@playwright/test").Page, route: string, label: string): Promise<void> {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.screenshot({ path: `test-results/screens/${label}--${vp.name}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${label} @ ${vp.name} (${vp.width}px) has ${overflow}px of horizontal overflow`).toBeLessThanOrEqual(1);
  }
}

test.describe("Responsive — no horizontal overflow at phone/tablet/laptop/wide", () => {
  test("public: staff sign-in", async ({ page }) => {
    await checkAt(page, "/login", "login");
  });
  test("public: client portal sign-in", async ({ page }) => {
    await checkAt(page, "/portal/login", "portal-login");
  });

  test.describe("authenticated staff screens", () => {
    test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

    for (const route of ["/", "/clients", "/jobs", "/datasets", "/reports", "/platform", "/charts"]) {
      test(`${route} across viewports`, async ({ page }) => {
        await checkAt(page, route, route === "/" ? "staff-control-room" : `staff${route.replace(/\//g, "-")}`);
        await expectHealthyScreen(page);
      });
    }

    test("CRP job workspace across viewports", async ({ page, request }) => {
      const job = await discoverCrpJob(request);
      test.skip(!job, "no CRP job on target");
      await checkAt(page, `/jobs/${job!.id}`, "crp-job-workspace");
      await expectHealthyScreen(page);
    });
  });
});
