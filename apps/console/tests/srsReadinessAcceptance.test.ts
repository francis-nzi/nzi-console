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
