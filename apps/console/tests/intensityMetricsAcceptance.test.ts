import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const app = (name: string) => read(`apps/console/app/clients/[clientId]/${name}`);

/**
 * Intensity metrics: the client defines the set, the job records the values, and one
 * resolver serves every surface. The rules worth holding are that nothing is hard-coded,
 * a missing value reads unavailable, and the divider travels with the number.
 */
describe("intensity metrics", () => {
  const migration = read("packages/isolated-backend/migrations/0071_intensity_metrics.sql");
  const analytics = app("AnalyticsArea.tsx");
  const drawer = app("IntensityMetricsDrawer.tsx");
  const job = read("apps/console/app/jobs/JobAnnualMetrics.tsx");

  it("defines the set on the client and the values on the job", () => {
    assert.match(migration, /CREATE TABLE nzi_console\.client_intensity_metrics/);
    assert.match(migration, /CREATE TABLE nzi_console\.job_intensity_values/);
    // Employees and Turnover are seeded for every client, as standard.
    assert.match(migration, /'employees', 'Employees'/);
    assert.match(migration, /'turnover', 'Turnover'/);
    assert.match(migration, /FROM nzi_console\.clients c,/, "seeded for every client");
    assert.match(migration, /is_standard/);
  });

  it("leaves room for the time dimension without reshaping the table", () => {
    assert.match(migration, /period_key text NOT NULL DEFAULT 'year'/);
    assert.match(migration, /period_key = 'year' OR period_key ~/, "a month or a quarter is already a legal period");
    assert.match(job, /Coming with system-wide time/, "the capture screen shows the seam honestly");
  });

  it("never hard-codes the metric set in the UI", () => {
    // The old fixed bases are gone: the screen reads whatever the client defined.
    assert.doesNotMatch(analytics, /per £M revenue|per employee \(FTE\)|per m² floor area/, "no hard-coded basis list");
    assert.match(analytics, /workspace\.intensityMetrics|intensityMetrics \}/, "the set comes from the client");
    assert.match(analytics, /activeMetrics/);
    assert.match(analytics, /All metrics \(indexed\)/, "the combined view is kept");
  });

  it("computes every surface through the one resolver", () => {
    for (const source of [analytics, job]) assert.match(source, /resolveIntensity/, "uses the shared computation");
    // No surface may do the arithmetic itself.
    for (const source of [analytics, job]) {
      assert.doesNotMatch(source, /emissionsTco2e \* \d|totalTco2e \* 1000 \//, "no local intensity arithmetic");
    }
    assert.match(read("packages/contracts/src/intensityMetrics.ts"), /emissionsTco2e \* definition\.divider\) \/ value/);
  });

  it("says unavailable rather than zero, with the reason", () => {
    assert.match(analytics, /Unavailable/);
    assert.match(analytics, /MetricReasons/, "the reason is surfaced, not swallowed");
    assert.match(job, /Unavailable/);
  });

  it("carries the divider into the unit wording", () => {
    assert.match(read("packages/contracts/src/intensityMetrics.ts"), /tCO₂e per \$\{definition\.divider\.toLocaleString/);
    assert.match(drawer, /intensityUnit\(\{ unitWording/, "the editor shows what the definition will read as");
  });

  it("stores an icon key, not artwork, so the print-safe set can be chosen later", () => {
    assert.match(migration, /icon_key text NOT NULL/);
    // DESIGN_CONVENTIONS §10: one curated inline-SVG set in @nzi/ui, never emoji.
    const icons = read("packages/ui/src/NziIcon.tsx");
    assert.match(icons, /stroke="currentColor"/, "line glyphs that tint with the tokens and print in mono");
    assert.doesNotMatch(icons, /[\u{1F300}-\u{1FAFF}]/u, "no emoji in the shipped set");
    assert.match(app("IntensityMetricIcon.tsx"), /from "@nzi\/ui"/, "the console resolves through the shared set");
    assert.match(drawer, /suggestIconKey|suggested from the name/, "suggested, and overridable");
  });

  it("deactivates a metric rather than deleting it", () => {
    assert.match(migration, /REVOKE UPDATE, DELETE ON nzi_console\.client_intensity_metrics/);
    assert.match(drawer, /deactivates<\/b> it|deactivated — historical reports keep it/);
    const commands = read("packages/contracts/src/commands.ts");
    assert.match(commands, /"client\.intensityMetric\.deactivate"/);
  });

  it("gates defining on client.edit and recording on scoperow.edit", () => {
    const commands = read("packages/contracts/src/commands.ts");
    assert.match(commands, /"client\.intensityMetric\.set": \{ key: "client\.intensityMetric\.set"[^}]*permission: "client\.edit"/);
    assert.match(commands, /"job\.intensityValue\.set": \{ key: "job\.intensityValue\.set"[^}]*permission: "scoperow\.edit"/);
    assert.match(drawer, /GatedButton/);
    assert.match(job, /GatedButton/);
  });

  it("opens only Active jobs by default on Overview (DESIGN_CONVENTIONS 3.2)", () => {
    const overview = app("OverviewArea.tsx");
    const defaults = overview.match(/defaultOpen/g) ?? [];
    assert.equal(defaults.length, 1, "exactly one Overview card opens by default");
    assert.match(overview, /defaultOpen[\s\S]{0,200}Active jobs/, "and it is the delivery card");
    for (const card of ["Emissions history", "Baseline &amp; targets", "Activity"]) {
      assert.match(overview, new RegExp(`<h2>${card}</h2>`), `${card} is still a card`);
    }
  });

  it("keeps one icon set for every surface, so a metric wears the same mark", () => {
    // §10 is settled: the report is no longer held back, and when it renders a metric it
    // resolves the same key through the same set rather than shipping its own artwork.
    const icons = read("packages/ui/src/NziIcon.tsx");
    assert.match(icons, /nziIconKeys/, "the set is keyed, so records store a key not artwork");
    assert.match(read("packages/ui/src/index.tsx"), /NziIcon/, "and it is exported for every surface");
  });
});
