import { mkdirSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { portalAccount } from "./lib/accounts";
import { discoverPortalJob } from "./lib/discover";
import { collectPageErrors } from "./lib/screen";

// B5 gate 10 — rendered a11y + responsive of the client-portal spend surface
// (docs/ACCEPTANCE_B5_PORTAL_SPEND.md). Skips until a portal account is provided
// AND `portal-spend` is enabled on the target — the surface only renders for a
// spend-kind bucket in an open entry window. The human screen-reader pass and the
// live cross-client / CSRF / rate-limit checks are gate 5a, tracked separately.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);
const OUT = "test-results/axe";
const SAMPLE =
  "Description\tNet\tVAT %\tGL code\tDate\n" +
  "Office paper and stationery\t1240.00\t20\t7504\t14/03/2025\n" +
  "Courier and postage\t880.50\t20\t7501\t02/04/2025";

test.describe("B5 — portal spend surface rendered acceptance (gate 10)", () => {
  test.skip(!portalAccount(), "ACCEPTANCE_PORTAL_* not set");

  test("the portal spend entry surface has no serious/critical axe violations and holds the column", async ({ page }) => {
    const job = await discoverPortalJob(page.request);
    test.skip(!job, "portal user has no granted jobs on target");

    const errors = collectPageErrors(page);
    await page.goto(`/portal/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Data entry" }).click().catch(() => undefined);

    const panel = page.locator("#portal-spend-entry");
    test.skip((await panel.count()) === 0, "portal-spend not enabled, or no open spend bucket for this portal user");

    await panel.getByLabel("Paste ledger lines", { exact: false }).fill(SAMPLE);
    await panel.getByRole("button", { name: "Add pasted lines" }).click();
    await expect(panel.locator("table.nz-tbl").first()).toBeVisible();
    await expect(panel.getByRole("combobox", { name: /Purchased-goods category/ }).first()).toBeVisible();

    const results = await new AxeBuilder({ page }).include("#portal-spend-entry").withTags(WCAG).analyze();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/portal-spend.json`, JSON.stringify(results.violations, null, 2));

    const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
    const summary = blocking
      .map((v) => `  ${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`)
      .join("\n");
    expect(blocking, `serious/critical axe violations on the portal spend surface:\n${summary}`).toEqual([]);

    for (const width of [390, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `portal spend @ ${width}px has ${overflow}px overflow`).toBeLessThanOrEqual(1);
    }
    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
