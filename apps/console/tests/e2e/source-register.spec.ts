import { mkdirSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors, expandJobStage } from "./lib/screen";

// S1 gate §9 — rendered a11y + responsive of the per-entity source register with
// the group roll-up + Company Vehicles / Employee Commuting framing
// (docs/ACCEPTANCE_S1_SOURCE_REGISTER.md). Skips until a staff account is
// provided AND `commuting` or `vehicle` is enabled on the target. The human
// screen-reader pass per domain is tracked separately.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);
const OUT = "test-results/axe";

test.describe("S1 — source register rendered acceptance (gate §9)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

  test("the source register (with the add form open) has no serious/critical axe violations and holds the column", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");

    const errors = collectPageErrors(page);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);
    // NZC-057 — the per-entity register moved from the retired Factor mapping
    // stage into Data entry (open by default; expand is a no-op if the flag is off).
    await expandJobStage(page, "stage-data-entry");

    const panel = page.locator("#emission-source-register");
    await expect(panel).toBeVisible();
    const addButton = panel.getByRole("button", { name: "Add source" });
    test.skip((await addButton.count()) === 0, "commuting/vehicle not enabled on target (NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 has neither)");
    await addButton.click();
    await expect(panel.getByRole("combobox", { name: "Type" })).toBeVisible();

    const results = await new AxeBuilder({ page }).include("#emission-source-register").withTags(WCAG).analyze();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/source-register.json`, JSON.stringify(results.violations, null, 2));

    const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
    const summary = blocking
      .map((v) => `  ${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`)
      .join("\n");
    expect(blocking, `serious/critical axe violations on the source register:\n${summary}`).toEqual([]);

    for (const width of [390, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `source register @ ${width}px has ${overflow}px overflow`).toBeLessThanOrEqual(1);
    }
    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
