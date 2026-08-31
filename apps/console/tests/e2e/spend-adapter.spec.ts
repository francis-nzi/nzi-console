import { mkdirSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";
import { collectPageErrors, expectHealthyScreen } from "./lib/screen";

// B2 gate 8 — rendered a11y + responsive review of the spend ledger grid
// (docs/ACCEPTANCE_B2_SPEND_ADAPTER.md §8). The generic-path scans already cover
// the workspace; this spec drives the flagged adapter into its parsed-grid state
// (the state that only exists after interaction) and scans that.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);
const OUT = "test-results/axe";
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "wide", width: 1920, height: 1080 },
];

// Parse the adapter's own sample ledger so the grid renders without depending on
// any particular staging data.
const SAMPLE_LEDGER =
  "Description\tNet\tVAT %\tGL code\tDate\n" +
  "Office paper and stationery\t1240.00\t20\t7504\t14/03/2025\n" +
  "Courier and postage\t880.50\t20\t7501\t02/04/2025";

async function openParsedGrid(page: Page): Promise<boolean> {
  const panel = page.locator("#spend-ledger-adapter");
  if ((await panel.count()) === 0) return false;
  await panel.getByLabel("Ledger lines").fill(SAMPLE_LEDGER);
  await panel.getByRole("button", { name: "Parse ledger" }).click();
  await expect(panel.locator("table.nz-tbl")).toBeVisible();
  await expect(panel.getByRole("combobox", { name: /Purchased-goods category/ }).first()).toBeVisible();
  return true;
}

test.describe("B2 — spend ledger grid rendered acceptance (gate 8)", () => {
  test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

  test("the parsed spend grid has no serious/critical axe violations", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");
    const errors = collectPageErrors(page);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    const present = await openParsedGrid(page);
    test.skip(!present, "spend adapter not enabled on target (NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 has no 'spend')");

    const results = await new AxeBuilder({ page }).include("#spend-ledger-adapter").withTags(WCAG).analyze();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/spend-adapter-grid.json`, JSON.stringify(results.violations, null, 2));

    const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
    const summary = blocking
      .map((v) => `  ${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`)
      .join("\n");
    expect(blocking, `serious/critical axe violations on the spend grid:\n${summary}`).toEqual([]);
    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the parsed spend grid holds the page column at every viewport", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    const present = await openParsedGrid(page);
    test.skip(!present, "spend adapter not enabled on target");

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      let overflow = 0;
      await expect
        .poll(
          async () => {
            overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            return overflow;
          },
          { timeout: 4000, intervals: [250, 500, 750] },
        )
        .toBeLessThanOrEqual(1)
        .catch(() => undefined);
      await page.screenshot({ path: `test-results/screens/spend-adapter-grid--${vp.name}.png`, fullPage: true });
      expect(overflow, `spend grid @ ${vp.name} (${vp.width}px) has ${overflow}px of horizontal overflow`).toBeLessThanOrEqual(1);
    }
    await expectHealthyScreen(page);
  });

  test("the previous-year rollforward panel has no serious/critical axe violations (B3.9)", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");
    const errors = collectPageErrors(page);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    const panel = page.locator("#spend-rollforward");
    test.skip((await panel.count()) === 0, "spend adapter not enabled on target");
    // Let the prior-year lookup settle out of its loading state.
    await expect(panel.getByText(/Looking for a prior reporting year/)).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);

    const results = await new AxeBuilder({ page }).include("#spend-rollforward").withTags(WCAG).analyze();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/spend-rollforward.json`, JSON.stringify(results.violations, null, 2));

    const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
    const summary = blocking
      .map((v) => `  ${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`)
      .join("\n");
    expect(blocking, `serious/critical axe violations on the rollforward panel:\n${summary}`).toEqual([]);
    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the spend import panel has no serious/critical axe violations and holds the column (B4.9)", async ({ page }) => {
    const job = await discoverCrpJob(page.request);
    test.skip(!job, "no CRP job on target");
    const errors = collectPageErrors(page);
    await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => undefined);

    const panel = page.locator("#spend-import");
    test.skip((await panel.count()) === 0, "spend-import not enabled on target (NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2 has no 'spend-import')");
    // Paste a couple of rows to reach the column-mapper state.
    await panel.getByLabel("…or paste the rows").fill("Description,Net value,VAT %,GL code,Invoice date,PG&S category,Emission factor\nOffice paper,1240,20,7504,14/03/2025,Paper,Paper factor");
    await panel.getByRole("button", { name: "Parse pasted rows" }).click();
    await expect(panel.getByText("Map columns", { exact: false })).toBeVisible();

    const results = await new AxeBuilder({ page }).include("#spend-import").withTags(WCAG).analyze();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/spend-import.json`, JSON.stringify(results.violations, null, 2));
    const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
    const summary = blocking.map((v) => `  ${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`).join("\n");
    expect(blocking, `serious/critical axe violations on the spend import panel:\n${summary}`).toEqual([]);

    for (const width of [390, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `spend import @ ${width}px has ${overflow}px overflow`).toBeLessThanOrEqual(1);
    }
    expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
