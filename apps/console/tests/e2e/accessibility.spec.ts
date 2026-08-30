import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);
const OUT = "test-results/axe";
type BaselineEntry = { id: string; target: string; status: "fixed-pending-deploy" | "catalogued-contrast"; note: string };
const KNOWN = JSON.parse(readFileSync(join(__dirname, "axe-baseline.json"), "utf8")) as Record<string, BaselineEntry[]>;

// A violation is accepted if its rule + one of its target selectors is listed in
// axe-baseline.json for this page. A 'critical' is accepted only when the entry
// is 'fixed-pending-deploy' (corrected in this branch, awaiting deploy).
function match(page: string, id: string, targets: string[]): BaselineEntry | undefined {
  return (KNOWN[page] ?? []).find((entry) => entry.id === id && targets.some((t) => t.includes(entry.target) || entry.target.includes(t)));
}

async function scan(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name.replace(/[^a-z0-9]+/gi, "_")}.json`, JSON.stringify(results.violations, null, 2));

  const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
  const uncatalogued = blocking.filter((v) => {
    const targets = v.nodes.flatMap((n) => n.target.map(String));
    const entry = match(name, v.id, targets);
    if (!entry) return true;
    if (v.impact === "critical" && entry.status !== "fixed-pending-deploy") return true;
    test.info().annotations.push({ type: `axe-${entry.status}`, description: `${name} · ${v.id} @ ${entry.target} — ${entry.note}` });
    return false;
  });

  const summary = uncatalogued.map((v) => `  ${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`).join("\n");
  expect(uncatalogued, `uncatalogued serious/critical axe violations on ${name}:\n${summary}`).toEqual([]);
}

test.describe("Accessibility — automated WCAG 2.1 A/AA scan", () => {
  test("public: staff sign-in", async ({ page }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await scan(page, "login");
  });

  test("public: client portal sign-in", async ({ page }) => {
    await page.goto("/portal/login", { waitUntil: "domcontentloaded" });
    await scan(page, "portal-login");
  });

  test("public: chart library", async ({ page }) => {
    await page.goto("/charts", { waitUntil: "domcontentloaded" });
    await scan(page, "charts");
  });

  test.describe("authenticated staff screens", () => {
    test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

    for (const route of ["/", "/clients", "/jobs", "/datasets", "/reports", "/platform"]) {
      test(`scan ${route}`, async ({ page }) => {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await scan(page, `staff${route === "/" ? "-control-room" : route.replace(/\//g, "-")}`);
      });
    }

    test("scan the CRP job workspace", async ({ page, request }) => {
      const job = await discoverCrpJob(request);
      test.skip(!job, "no CRP job on target");
      await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await scan(page, "crp-job-workspace");
    });
  });
});
