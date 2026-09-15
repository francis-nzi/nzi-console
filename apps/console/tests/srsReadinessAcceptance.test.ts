import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const app = (name: string) => read(`apps/console/app/clients/[clientId]/${name}`);

/**
 * SRS Readiness. The rules worth holding: the framework is data and versioned, an
 * assessment records the version it used, maturity never borrows the scope palette, the
 * benchmark stays a truthful Future state, and nothing is fabricated.
 */
describe("SRS readiness", () => {
  const migration = read("packages/isolated-backend/migrations/0070_srs_readiness.sql");
  const area = app("SrsArea.tsx");
  const forms = app("SrsAssessmentForms.tsx");

  it("keeps the framework as versioned data, not code", () => {
    for (const table of ["srs_frameworks", "srs_standards", "srs_pillars", "srs_maturity_levels", "srs_requirements"]) {
      assert.match(migration, new RegExp(`CREATE TABLE nzi_console\\.${table}`), table);
    }
    // Only one framework version is in force at a time, and the others stay readable.
    assert.match(migration, /srs_frameworks_one_active[\s\S]*?WHERE status = 'active'/);
    assert.match(migration, /REVOKE DELETE ON nzi_console\.srs_frameworks/, "a framework version is never deleted");
    assert.match(migration, /S1.*general|general.*S1/i);
    assert.match(migration, /climate_led/, "the climate standard is marked as the one that leads");
  });

  it("stamps an assessment with the framework version it was measured against", () => {
    assert.match(migration, /framework_version integer NOT NULL/);
    assert.match(read("packages/isolated-backend/src/srsReadiness.ts"), /framework_version[\s\S]*?framework\.version/, "the handler copies the version in force");
    assert.match(area, /version \{assessment\.frameworkVersion\}/, "the screen says which version it was measured against");
  });

  it("carries the future benchmark slot without inventing peer data", () => {
    assert.match(migration, /sector_key text/);
    assert.match(migration, /benchmark_percentile/);
    // A percentile is only meaningful if it says where it came from.
    assert.match(migration, /srs_assessments_benchmark_sourced CHECK \(benchmark_percentile IS NULL OR benchmark_source IS NOT NULL\)/);
    assert.match(area, /no invented comparisons/);
    assert.doesNotMatch(area, /\b(62nd|75th|median) percentile\b/, "no fabricated peer figure");
  });

  it("never encodes maturity with the scope palette", () => {
    const styles = read("packages/ui/src/styles.css");
    const srsStyles = /\.nz-srs-mtag[\s\S]*?\.nz-srs-gap/.exec(styles)?.[0] ?? "";
    for (const scopeColour of ["#FF5C48", "#FFC24B", "#0BA75E"]) {
      assert.ok(!srsStyles.includes(scopeColour), `maturity must not use ${scopeColour}`);
      assert.ok(!area.includes(scopeColour), `the area must not use ${scopeColour}`);
    }
    assert.match(srsStyles, /#0B6B41/, "maturity uses its own sequential ramp");
  });

  it("gates assessing on srs.manage and audits every answer", () => {
    assert.match(read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx"), /useEditAccess\("srs\.manage"/);
    const commands = read("packages/contracts/src/commands.ts");
    for (const key of ["srs.assessment.start", "srs.assessment.item.set", "srs.assessment.complete"]) {
      assert.match(commands, new RegExp(`"${key}": \\{ key: "${key}"[^}]*permission: "srs\\.manage"`), key);
    }
    assert.match(forms, /GatedButton/);
  });

  it("pre-fills the metrics pillar from the client's own record rather than asking again", () => {
    assert.match(migration, /'nzi-data'/);
    assert.match(migration, /footprint\.scope1/);
    assert.match(migration, /targets\.model/);
    assert.match(forms, /reads the client&apos;s own record|reads the client's own record/);
    // Pre-filled answers are marked, so a reader can tell them from a consultant's judgement.
    assert.match(read("packages/isolated-backend/src/srsReadiness.ts"), /'auto'/);
  });

  it("draws every graphic from the assessment, with nothing seeded", () => {
    for (const chart of ["SrsPillarRadar", "SrsMaturityBullets", "SrsGapHeatmap", "SrsReadinessTrend"]) {
      assert.ok(area.includes(chart), chart);
    }
    assert.doesNotMatch(area, /values: \[\s*\d+\s*,/, "no hard-coded series");
    assert.doesNotMatch(area, /@nzi\/mock-data/, "no mock data");
    assert.match(area, /overallReadiness|pillarReadiness/, "figures come from the shared resolver");
  });

  it("says plainly when there is no framework or no assessment", () => {
    assert.match(area, /No SRS framework is published/);
    assert.match(area, /has not been assessed/);
  });

  it("holds the report readiness statement back with the R-track", () => {
    // The report section is not built here: the R-track design is not ready, and a
    // half-built statement would set an expectation the report cannot meet yet.
    assert.doesNotMatch(area, /Readiness statement/, "the report statement is not shipped in this PR");
  });
});

/**
 * The reverse of the strategy → SRS alignment: a requirement says which of this client's
 * strategies advance it. Read-side only — the link is already stored on the strategy.
 */
describe("what a requirement is being addressed by", () => {
  const area = app("SrsArea.tsx");

  it("names the client's strategies rather than reporting that a link exists", () => {
    assert.match(area, /strategiesBySrsRequirement/, "the reverse is derived from the plan already loaded");
    assert.match(area, /workspace\.strategies\.plan/, "and from the same plan the strategies area shows");
    assert.match(area, /strategyStatusLabels\[strategy\.status\]/, "each strategy is named with its status");
  });

  it("retires the linked_action_id decoy from the view", () => {
    // It said a row had been filled in, not that the requirement was addressed, and the
    // column it points at has no foreign key behind it.
    assert.doesNotMatch(area, /linkedActionId/, "the view no longer reads the decoy column");
    // The rendered literals, not the word — the comment above the replacement still explains
    // what these said and why naming the strategies is not the same claim.
    assert.doesNotMatch(area, /" · linked action"/, "nor renders the roadmap string");
    assert.doesNotMatch(area, /" · no action yet"/, "nor its negative");
    assert.doesNotMatch(area, /"Linked action"/, "nor the register's version");
  });

  it("says honestly when nothing addresses a requirement", () => {
    assert.match(area, /No strategy yet/, "an unaddressed requirement says so");
    assert.match(area, /no strategy yet/, "and so does an unaddressed gap in the register");
  });

  it("leaves the column in place — dropping it is a separate migration", () => {
    assert.match(read("packages/isolated-backend/migrations/0070_srs_readiness.sql"), /linked_action_id text/);
  });
});

/**
 * The client-facing readiness statement on the portal: live, read-only, and carrying
 * nothing from the consultant's working record.
 */
describe("the portal readiness statement", () => {
  const portal = read("apps/console/app/portal/PortalReadiness.tsx");
  const model = read("packages/isolated-backend/src/portalReadiness.ts");
  const route = read("apps/console/app/api/portal/readiness/route.ts");
  const home = read("apps/console/app/portal/PortalHome.tsx");

  it("resolves live, and never from a frozen composition", () => {
    // The live twin of the report's frozen section. A stale readiness on the page telling a
    // client where they stand today would be worse than no page.
    assert.match(model, /listSrsAssessments\(db, input\.clientId\)/);
    assert.ok(!model.includes("getReportComposition"), "never reads a composition");
    assert.doesNotMatch(model, /FROM nzi_console\.report_compositions/);
    assert.match(portal, /cache:"no-store"/);
  });

  it("shows only a completed assessment, never a draft's provisional scoring", () => {
    assert.match(model, /entry\.status === "complete"/);
    assert.match(model, /Your readiness assessment is in progress/);
  });

  it("states an absent assessment rather than rendering it as zero", () => {
    assert.match(portal, /model\.state==="none"/);
    assert.match(portal, /Your readiness assessment is in progress/);
    // A 0% would read as a score the client had been given.
    assert.doesNotMatch(model, /overallPct: 0\b/);
  });

  it("reuses the shared gap ordering and the shared reverse link", () => {
    assert.match(model, /composeSrsRoadmap\(framework, assessment\.items/);
    assert.doesNotMatch(model, /\.sort\(\(/, "no second ordering of its own");
    // The builder's own inversion excludes withdrawn strategies; the portal adds the
    // client-facing gate so a held-back strategy cannot appear as what closes a gap.
    assert.match(model, /plan\.filter\(\(strategy\) => strategy\.includeInReport\)/);
  });

  it("projects field by field, so nothing internal rides along", () => {
    // The assessment's notes and each item's owner/evidence/linked action are consultant
    // working records. Built explicitly rather than spread, so a new internal column cannot
    // arrive on the client's page by default.
    assert.doesNotMatch(model, /\.\.\.assessment/, "no spread of the assessment");
    assert.doesNotMatch(model, /\.\.\.item/, "no spread of an item");
    // Exact accessors, not substrings: `evidenced` is a client-facing count of how many
    // requirements have evidence recorded, and carries none of the evidence itself.
    for (const internal of ["notes", "linkedActionId", "dueDate", "evidenceRef", "evidenceNote", "assessedBy"]) {
      assert.doesNotMatch(portal, new RegExp(`\\.${internal}\\b`), `the view never reaches for ${internal}`);
      assert.doesNotMatch(model, new RegExp(`${internal}:`), `nor does the read model project ${internal}`);
    }
    assert.match(model, /evidenced: \{ count:/, "only the count of what is evidenced crosses");
  });

  it("is read-only — no mutation path and no control implying one", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.doesNotMatch(route, new RegExp(`export async function ${method}\b`), method);
    }
    assert.match(route, /withTenantRead/);
    assert.match(route, /user\.clientId/);
    assert.doesNotMatch(route, /params|searchParams/, "the client is the session's own");
    assert.ok(!portal.includes("<button"), "and the view offers nothing to press");
    for (const verb of ["postBrowserCommand", "patchBrowserCommand", "INSERT", "UPDATE "]) {
      assert.ok(!model.includes(verb), `the read model must not write (${verb})`);
    }
  });

  it("reuses the proven readiness charts rather than drawing its own", () => {
    assert.match(portal, /SrsPillarRadar/);
    assert.match(portal, /SrsMaturityBullets/);
    assert.match(portal, /from "@nzi\/charts"/);
  });

  it("sits with the plan, so the page reads as one story", () => {
    assert.match(home, /<PortalReadiness\/>/);
    assert.match(home, /<PortalReductionPlan\/>/);
  });

  it("is theme-aware — the portal follows the viewer, unlike the report", () => {
    const css = read("packages/ui/src/styles.css");
    const block = /\.nz-portal-readiness-charts\{[\s\S]*?\.nz-portal-gap \.none\{[^}]*\}/.exec(css)?.[0] ?? "";
    assert.ok(block.length > 0, "the readiness styles exist");
    assert.doesNotMatch(block, /#[0-9A-Fa-f]{6}/, "no hard-coded colour — tokens only");
  });
});
