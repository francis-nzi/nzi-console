import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { staffAccount } from "./lib/accounts";
import { discoverCrpJob } from "./lib/discover";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);
const OUT = "test-results/axe";
// An entry matches a violation by rule id and EITHER a target selector (substring
// either way) OR a foreground colour (`fg`, matched against the axe node's
// reported foreground — used for a systemic colour like emerald-as-text that
// appears under many selectors).
type BaselineEntry = { id: string; target?: string; fg?: string; status: "fixed-pending-deploy" | "catalogued-contrast"; note: string };
const KNOWN = JSON.parse(readFileSync(join(__dirname, "axe-baseline.json"), "utf8")) as Record<string, BaselineEntry[]>;

function match(page: string, violation: { id: string; nodes: Array<{ target: unknown[]; any?: Array<{ data?: { fgColor?: string } }> }> }): BaselineEntry | undefined {
  const candidates = [...(KNOWN._shell ?? []), ...(KNOWN[page] ?? [])];
  const targets = violation.nodes.flatMap((n) => n.target.map(String));
  const fgColors = new Set(violation.nodes.flatMap((n) => (n.any ?? []).map((check) => check.data?.fgColor?.toLowerCase()).filter(Boolean)));
  return candidates.find(
    (entry) =>
      entry.id === violation.id &&
      ((entry.target !== undefined && targets.some((t) => t.includes(entry.target!) || entry.target!.includes(t))) ||
        (entry.fg !== undefined && fgColors.has(entry.fg.toLowerCase()))),
  );
}

async function scan(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name.replace(/[^a-z0-9]+/gi, "_")}.json`, JSON.stringify(results.violations, null, 2));

  const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
  const uncatalogued = blocking.filter((v) => {
    const entry = match(name, v);
    if (!entry) return true;
    if (v.impact === "critical" && entry.status !== "fixed-pending-deploy") return true;
    test.info().annotations.push({ type: `axe-${entry.status}`, description: `${name} · ${v.id} @ ${entry.target ?? entry.fg} — ${entry.note}` });
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

  test.describe("authenticated staff screens", () => {
    test.skip(!staffAccount(), "ACCEPTANCE_STAFF_* not set");

    for (const route of ["/", "/clients", "/jobs", "/datasets", "/reports", "/platform", "/charts"]) {
      test(`scan ${route}`, async ({ page }) => {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("load").catch(() => undefined);
        await scan(page, route === "/" ? "staff-control-room" : route === "/charts" ? "charts" : `staff${route.replace(/\//g, "-")}`);
      });
    }

    test("scan the CRP job workspace", async ({ page }) => {
      const job = await discoverCrpJob(page.request);
      test.skip(!job, "no CRP job on target");
      await page.goto(`/jobs/${job!.id}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("load").catch(() => undefined);
      await scan(page, "crp-job-workspace");
    });
  });
});
