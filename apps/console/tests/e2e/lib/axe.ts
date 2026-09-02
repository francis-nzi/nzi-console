import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Shared axe scan + baseline matcher, so `accordion.spec.ts` tolerates the same
// catalogued design-system contrast decisions as `accessibility.spec.ts` and
// only fails on NEW serious/critical violations. See docs/RENDERED_ACCEPTANCE_CHECKLIST.md.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);
const OUT = "test-results/axe";

// An entry matches a violation by rule id and EITHER a target selector (substring
// either way) OR a foreground colour (`fg`). `_shell` entries apply to every
// authenticated screen.
type BaselineEntry = {
  id: string;
  target?: string;
  fg?: string;
  status: "fixed-pending-deploy" | "catalogued-contrast";
  note: string;
};

const KNOWN = JSON.parse(
  readFileSync(join(__dirname, "..", "axe-baseline.json"), "utf8"),
) as Record<string, BaselineEntry[]>;

type AxeViolation = {
  id: string;
  impact?: string;
  help: string;
  nodes: Array<{ target: unknown[]; any?: Array<{ data?: { fgColor?: string } }> }>;
};

function match(pageKey: string, violation: AxeViolation): BaselineEntry | undefined {
  const candidates = [...(KNOWN._shell ?? []), ...(KNOWN[pageKey] ?? [])];
  const targets = violation.nodes.flatMap((n) => n.target.map(String));
  const fgColors = new Set(
    violation.nodes.flatMap((n) =>
      (n.any ?? []).map((check) => check.data?.fgColor?.toLowerCase()).filter(Boolean),
    ),
  );
  return candidates.find(
    (entry) =>
      entry.id === violation.id &&
      ((entry.target !== undefined &&
        targets.some((t) => t.includes(entry.target!) || entry.target!.includes(t))) ||
        (entry.fg !== undefined && fgColors.has(entry.fg.toLowerCase()))),
  );
}

/**
 * Scan `include` (a selector) — or the whole page — for WCAG 2.1 A/AA violations,
 * write the full list to test-results/axe/<name>.json, and fail only on
 * uncatalogued serious/critical ones.
 */
export async function scanWithBaseline(page: Page, name: string, include?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(WCAG);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name.replace(/[^a-z0-9]+/gi, "_")}.json`,
    JSON.stringify(results.violations, null, 2),
  );

  const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? "")) as AxeViolation[];
  const uncatalogued = blocking.filter((v) => {
    const entry = match(name, v);
    if (!entry) return true;
    if (v.impact === "critical" && entry.status !== "fixed-pending-deploy") return true;
    test.info().annotations.push({
      type: `axe-${entry.status}`,
      description: `${name} · ${v.id} @ ${entry.target ?? entry.fg} — ${entry.note}`,
    });
    return false;
  });

  const summary = uncatalogued
    .map(
      (v) =>
        `  ${v.impact} ${v.id}: ${v.help}\n    ${v.nodes
          .map((n) => n.target.join(" "))
          .join("\n    ")}`,
    )
    .join("\n");
  expect(uncatalogued, `uncatalogued serious/critical axe violations on ${name}:\n${summary}`).toEqual(
    [],
  );
}

/** No horizontal overflow at the four acceptance breakpoints. */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  for (const width of [390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${label} @ ${width}px has ${overflow}px overflow`).toBeLessThanOrEqual(1);
  }
}
