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
    // S2: through the dashboard model, which carries the assessment's own stamped version.
    assert.match(area, /version \{model\.frameworkVersion\}/, "the screen says which version it was measured against");
    assert.match(read("packages/contracts/src/srsDashboard.ts"), /frameworkVersion: assessment\.frameworkVersion/);
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
    // SRS S2: the ladder graphics, one ordinal ramp, shared with the portal.
    for (const chart of ["SrsDial", "SrsMeter", "SrsRadar", "SrsHeatmap", "SrsTrend", "SrsScaleKey", "SrsPillarTable"]) {
      assert.ok(area.includes(chart), chart);
    }
    assert.doesNotMatch(area, /values: \[\s*\d+\s*,/, "no hard-coded series");
    assert.doesNotMatch(area, /@nzi\/mock-data/, "no mock data");
    // Figures come from the shared resolver: the area reads `srsDashboard`, which reads S1's rollups.
    assert.match(area, /srsDashboard\(framework, assessment, assessments, \{ standardKey \}\)/);
    assert.match(read("packages/contracts/src/srsDashboard.ts"), /overallReadiness\(scoped[\s\S]*pillarReadiness\(scoped/);
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

  it("reads linked_action_id only as the real gap→action hook, resolved to a strategy on the plan", () => {
    // Once a decoy with no foreign key behind it; S1 (0187) gave it one, to client_strategies, as the S3 hook. The
    // register reads it only by resolving it to a strategy on this client's plan and naming it — never "a link exists".
    assert.match(read("packages/isolated-backend/migrations/0187_srs_framework_versions_and_completion.sql"), /srs_assessment_items_linked_action_fk[\s\S]*REFERENCES nzi_console\.client_strategies/);
    assert.match(area, /requirement\.linkedActionId \? actions\.get\(requirement\.linkedActionId\)/);
    assert.match(area, /On the plan: <b>\{linked\.title\}<\/b>/);
    assert.doesNotMatch(area, /" · linked action"/, "nor renders the old roadmap string");
    assert.doesNotMatch(area, /"Linked action"/, "nor the register's old version");
  });

  it("says honestly when nothing addresses a requirement", () => {
    assert.match(area, /No strategy yet/, "an unaddressed requirement says so");
    // S2: an unaddressed gap in the register offers the S3 hook by name, and creates nothing.
    assert.match(area, /Bridge this gap/);
    assert.doesNotMatch(area, /srs\.gap|createBridging|\/api\/isolated\/actions/, "no creation path in S2");
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
    // S1: one shared guard — complete and dated — used by the portal and the report alike.
    assert.match(model, /latestAssessed\(assessments\)/);
    assert.match(read("packages/contracts/src/srsReadiness.ts"), /assessment\.status === "complete" && assessment\.assessedOn !== null/);
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
    // A1: the same predicate the report's roadmap uses — marked for the report and agreed or beyond.
    assert.match(model, /plan\.filter\(strategyIsReportable\)/);
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
    assert.match(model, /evidenced: \{ count:/, "the headline carries only the count of what is evidenced");
    // SRS S2 (R9): the questions-in-drawers show each requirement's evidence and history, as the brief sets — but the
    // staff working fields (owner, due date, the action link) are taken out field by field before the model leaves
    // the contract, so the portal cannot reach them even by accident (NZC-110).
    const strip = read("packages/contracts/src/srsDashboard.ts");
    assert.match(strip, /requirements: model\.requirements\.map\(\(\{ owner: _owner, dueDate: _due, linkedActionId: _link, \.\.\.client \}\) => \(\{/);
    // The S2 review's ruling: evidence as kind + ref only — the consultant's free-text note is blanked in the same strip.
    assert.match(strip, /evidence: client\.evidence === null \? null : \{ kind: client\.evidence\.kind, ref: client\.evidence\.ref, note: "" \}/);
    assert.doesNotMatch(portal, /evidence\.note/, "the view never reaches for the note");
    assert.doesNotMatch(portal, /\.owner\b/, "the view never reaches for an owner");
  });

  it("is read-only — no mutation path and no control implying one", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.doesNotMatch(route, new RegExp(`export async function ${method}\b`), method);
    }
    assert.match(route, /withTenantRead/);
    assert.match(route, /user\.clientId/);
    assert.doesNotMatch(route, /params|searchParams/, "the client is the session's own");
    // S2: the questions open in drawers, so there are buttons — but each only opens, closes or switches a view. Nothing
    // in the view sends anything: no command helper, and its one fetch is the GET above.
    for (const write of ["postBrowserCommand", "putBrowserCommand", "patchBrowserCommand", "method:"]) {
      assert.ok(!portal.includes(write), `the view never writes (${write})`);
    }
    for (const handler of portal.match(/onClick=\{[^}]*\}/g) ?? []) {
      assert.match(handler, /setOpenId|setDialsAs|onClose|onOpen/, `a button only opens or switches a view: ${handler}`);
    }
    for (const verb of ["postBrowserCommand", "patchBrowserCommand", "INSERT", "UPDATE "]) {
      assert.ok(!model.includes(verb), `the read model must not write (${verb})`);
    }
  });

  it("reuses the CRM's readiness charts rather than drawing its own", () => {
    // SRS S2: the same dial and radar components the CRM dashboard draws, from the same model.
    for (const chart of ["SrsDial", "SrsMeter", "SrsRadar", "SrsPillarTable", "SrsScaleKey"]) assert.match(portal, new RegExp(`<${chart}\\b`), chart);
    assert.match(portal, /from "@nzi\/charts"/);
    assert.match(model, /dashboard: srsPortalDashboard\(framework, assessments\)/);
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
