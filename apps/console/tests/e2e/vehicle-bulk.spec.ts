import { mkdirSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors } from "./lib/screen";

// S1.2 gate — rendered a11y + responsive of the Company Vehicles bulk-paste grid
// (docs/ACCEPTANCE_S1_SOURCE_REGISTER.md, S1.2). Skips until a staff account is
// provided AND `vehicle` is enabled on the target.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);
const OUT = "test-results/axe";
const SAMPLE =
  "Registration\tMake\tModel\tFuel\tActivity / year\tUnit\n" +
  "AB12CDE\tFord\tTransit\tDiesel\t3200\tlitres\n" +
  "FG34HIJ\tNissan\tLeaf\tBattery electric\t9800\tkWh";

test.describe("S1.2 — company vehicles bulk grid rendered acceptance", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

  test("the parsed vehicle grid has no serious/critical axe violations and holds the column", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");

    const errors = collectPageErrors(page);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    const panel = page.locator("#vehicle-bulk");
    test.skip((await panel.count()) === 0, "vehicle not enabled on target (NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 has no 'vehicle')");
    await panel.getByLabel("Vehicle rows").fill(SAMPLE);
    await panel.getByRole("button", { name: "Parse rows" }).click();
    await expect(panel.locator("table.nz-tbl")).toBeVisible();
    await expect(panel.getByRole("combobox", { name: /Fuel for/ }).first()).toBeVisible();

    const results = await new AxeBuilder({ page }).include("#vehicle-bulk").withTags(WCAG).analyze();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/vehicle-bulk.json`, JSON.stringify(results.violations, null, 2));

    const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
    const summary = blocking
      .map((v) => `  ${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`)
      .join("\n");
    expect(blocking, `serious/critical axe violations on the vehicle grid:\n${summary}`).toEqual([]);

    for (const width of [390, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `vehicle grid @ ${width}px has ${overflow}px overflow`).toBeLessThanOrEqual(1);
    }
    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
