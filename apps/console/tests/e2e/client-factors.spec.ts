import { mkdirSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverClient } from "./lib/discover";
import { collectPageErrors } from "./lib/screen";

// S2 gate 9 — rendered a11y + responsive of the client-level client-factor
// manager (docs/ACCEPTANCE_S2_CLIENT_FACTORS.md). Skips until a staff account is
// provided AND `client-factors` is enabled on the target. The human screen-reader
// pass is tracked separately.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);
const OUT = "test-results/axe";

test.describe("S2 — client factors manager rendered acceptance (gate 9)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

  test("the client factors manager has no serious/critical axe violations and holds the column", async ({ page }) => {
    const client = await discoverClient(page.request);
    test.skip(!client, "no client on target");

    const errors = collectPageErrors(page);
    await page.goto(`/clients/${client!.id}`, { waitUntil: "domcontentloaded" });

    const panel = page.locator("#client-factors-manager");
    test.skip((await panel.count()) === 0, "client-factors not enabled on target (NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 has no 'client-factors')");
    await expect(panel.getByRole("heading", { name: "Client emission factors" })).toBeVisible();

    const results = await new AxeBuilder({ page }).include("#client-factors-manager").withTags(WCAG).analyze();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/client-factors.json`, JSON.stringify(results.violations, null, 2));

    const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
    const summary = blocking
      .map((v) => `  ${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`)
      .join("\n");
    expect(blocking, `serious/critical axe violations on the client factors manager:\n${summary}`).toEqual([]);

    for (const width of [390, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `client factors @ ${width}px has ${overflow}px overflow`).toBeLessThanOrEqual(1);
    }
    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
