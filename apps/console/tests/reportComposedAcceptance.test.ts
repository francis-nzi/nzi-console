import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * The composed report (report_v1). The rules worth holding: it renders a frozen composition
 * and resolves nothing; it never implies assurance it does not have; a gap is stated rather
 * than zeroed; and it is one document across screen, portal and print.
 */
describe("the composed report", () => {
  const view = read("apps/console/app/reports/[versionId]/ReportComposedView.tsx");
  const css = read("apps/console/app/reports/[versionId]/report-composed.css");
  const page = read("apps/console/app/reports/[versionId]/page.tsx");
  const route = read("apps/console/app/api/isolated/report-versions/[versionId]/composition/route.ts");

  it("renders the frozen composition and resolves nothing of its own", () => {
    assert.match(view, /composition: ReportComposition/);
    // No live reads: if a figure is not in the composition it is not in the report.
    for (const call of ["loadScreen", "resolveIntensity", "overallReadiness", "listClientActions", "fetch("]) {
      assert.ok(!view.includes(call), `the view must not call ${call}`);
    }
    assert.match(route, /getReportComposition/);
    // Reading only: a composition is evidence of what the client was sent.
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.doesNotMatch(route, new RegExp(`export async function ${method}\\b`), method);
    }
  });

  it("ships behind report-sections, leaving the existing report path untouched", () => {
    assert.match(page, /reportFeatureEnabled\("report-sections"\)/);
    assert.match(page, /ReportComposedView/);
  });

  it("says an unissued version is unissued rather than rendering a blank document", () => {
    assert.match(page, /This report version has not been issued/);
    assert.match(read("packages/contracts/src/index.ts"), /reportComposition: \{ key: "reportComposition"[^}]*isEmpty: \(\) => false/);
  });

  it("states the assurance basis on the cover as well as the methodology page", () => {
    // Whoever reads only the first page should still know what this document is and is not.
    assert.match(view, /nzr-cover-basis">\{composition\.assurance\.statement\}/);
    assert.match(view, /reportMethodologyRows\(composition\)/);
    // Nothing anywhere may imply an assurance the platform cannot evidence.
    assert.doesNotMatch(view, /independently assured|third-party assured by|externally verified/i);
  });

  it("states a gap instead of rendering it as zero", () => {
    // "0 tCO2e" and "we could not read your footprint" look identical on a page and mean
    // opposite things.
    assert.match(view, /function Gap\(\{ section \}: \{ section: ReportSectionGap \}\)/);
    assert.match(view, /\{section\.reason\}/);
    assert.match(view, /metric\.value === null[\s\S]{0,120}metric\.unavailableReason/);
    assert.match(css, /\.nzr-gap\{/);
  });

  it("does not draw a net-zero pathway to a flat zero", () => {
    // The residual is read from the trajectory the client actually set, never assumed.
    assert.match(view, /reportResidualTco2e\(targets\)/);
    assert.match(view, /residual !== null && residual > 0/);
    assert.match(view, /addressed through removals\s*\n?\s*rather than reduced to nothing/);
  });

  it("freezes targets from the client target model, not the snapshot", () => {
    // Targets are their own versioned record and a client edits them between reports —
    // exactly the drift this store exists to close. Reading them from the snapshot would
    // freeze them at REVIEW time, missing a target restated before issue.
    const backend = read("packages/isolated-backend/src/reportCompositions.ts");
    assert.match(backend, /getClientTargets\(db, input\.clientId/);
    assert.match(backend, /getBenchmarkInForce\(db, input\.clientId\)/);
    // The superseded job-level target on the snapshot is not read, and is no longer even
    // declared on the composition's input type.
    assert.doesNotMatch(backend, /snapshot\.target\b/);
    assert.doesNotMatch(backend, /baselineTco2e|milestones/);
  });

  it("says when targets are held against a moved baseline", () => {
    // NZC-068 — a re-baseline holds targets rather than restating them. A report issued in
    // that state must not present the pathway as though nothing had moved.
    assert.match(view, /targets\.benchmarkStale/);
    assert.match(view, /have not been recalculated against the new baseline/);
  });

  it("says the plan's percentages are progress, not carbon", () => {
    assert.match(view, /not a modelled carbon reduction/);
    // Grouped by lever — the theme a strategy sits under (phase 2).
    assert.match(view, /group\.leverId/);
    assert.doesNotMatch(view, /sphere/i);
  });

  it("shows only included strategies, and says how many it left out", () => {
    // A plan section showing four of a client's nine strategies must not read as the whole
    // plan. `include_in_report` is read when the composition is frozen, never afterwards.
    assert.match(view, /plan\.excludedCount > 0/);
    assert.match(view, /not included in this report/);
    const contract = read("packages/contracts/src/reportComposition.ts");
    assert.match(contract, /strategy\.includeInReport/);
    assert.match(contract, /read HERE, at issue, and frozen with everything else/);
  });

  it("shows what each strategy advances, by requirement code", () => {
    assert.match(view, /strategy\.srsRequirementCodes\.map/);
    // Codes, not generated ids — "S2 M2" means something to a reader.
    assert.match(read("packages/contracts/src/reportComposition.ts"), /"S2 M2" rather than an id/);
  });

  it("carries provenance beside the figures, not only on a back page", () => {
    assert.match(view, /function Provenance\(\{ provenance \}/);
    assert.match(view, /Evidence hash \{provenance\.dataHash\}/);
    // Every data section that has provenance renders it.
    const uses = (view.match(/<Provenance provenance=/g) ?? []).length;
    assert.equal(uses, 3, "emissions, intensity and targets each carry their own basis");
  });

  it("is one document on screen, in the portal and in print", () => {
    // A report that renders dark on screen and light in the PDF is two documents, and only
    // one of them is the one the client was sent.
    assert.doesNotMatch(css, /prefers-color-scheme|data-theme/);
    assert.match(css, /@media print\{/);
    assert.match(css, /break-inside:avoid/);
    // Icons are the curated print-safe set, never emoji.
    assert.match(view, /NziIcon/);
    assert.doesNotMatch(view, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("keeps scope colour for scopes only", () => {
    // Status and maturity marks must not borrow the scope palette.
    const nonScope = /\.nzr-(gap|plan-summary|action|prov|metric)\b[\s\S]*?\}/g;
    for (const block of css.match(nonScope) ?? []) {
      for (const scopeColour of ["#FF5C48", "#FFC24B", "#0BA75E"]) {
        assert.ok(!block.includes(scopeColour), `${scopeColour} must not appear on a non-scope mark`);
      }
    }
  });
});

describe("publishing freezes the composition", () => {
  const handler = readFileSync(new URL("../../../packages/isolated-backend/src/postgresCommands.ts", import.meta.url), "utf8");
  const commands = readFileSync(new URL("../../../packages/contracts/src/commands.ts", import.meta.url), "utf8");

  it("composes and freezes inside the publish transaction", () => {
    // A published report without its composition is a document nobody can reproduce, so the
    // freeze cannot be a follow-up step that might not run.
    const publish = /export async function publishCrpReport[\s\S]*?^\}\);\}/m.exec(handler)?.[0] ?? "";
    assert.ok(publish.length > 0, "the publish handler is found");
    assert.match(publish, /composeForReportVersion\(db\s*,\s*\{/);
    assert.match(publish, /freezeReportComposition\(db\s*,\s*\{/);
    assert.match(publish, /compositionId:\s*frozen\.compositionId/);
  });

  it("pins the version it is publishing", () => {
    // Two publishes racing on one report must not both proceed.
    assert.match(commands, /"report\.publish": \{ reportVersionId: string;[^}]*expectedVersion: number \}/);
    const publish = /export async function publishCrpReport[\s\S]*?^\}\);\}/m.exec(handler)?.[0] ?? "";
    assert.match(publish, /report\.version!==input\.expectedVersion.*VersionConflictError/);
  });

  it("keeps separation of duties at publish, not only at validation", () => {
    const publish = /export async function publishCrpReport[\s\S]*?^\}\);\}/m.exec(handler)?.[0] ?? "";
    assert.match(publish, /requireReleasableSnapshot\(context,source\)/);
    assert.match(handler, /You prepared this snapshot, so someone else must validate and publish it/);
  });

  it("supersedes the previous published version rather than editing it", () => {
    // Re-publishing is a new version; the one the client already has stays as it was.
    const publish = /export async function publishCrpReport[\s\S]*?^\}\);\}/m.exec(handler)?.[0] ?? "";
    assert.match(publish, /SET status='superseded'/);
    assert.doesNotMatch(publish, /UPDATE nzi_console\.report_compositions/);
  });
});
