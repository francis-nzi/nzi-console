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

/**
 * The readiness radar in section 06. Wiring only: the chart is the one `@nzi/charts`
 * already ships, and the data is what the composition froze.
 */
describe("the report's readiness radar", () => {
  const view = read("apps/console/app/reports/[versionId]/ReportComposedView.tsx");
  const css = read("apps/console/app/reports/[versionId]/report-composed.css");
  const compositions = read("packages/isolated-backend/src/reportCompositions.ts");

  it("reuses the shipped chart rather than drawing its own", () => {
    assert.match(view, /import \{[^}]*SrsPillarRadar[^}]*\} from "@nzi\/charts"/);
    assert.match(view, /reportSrsRadarChart\(srs\)/, "and the payload the contract assembles");
  });

  it("draws it from the frozen composition and resolves nothing", () => {
    const radar = /function SrsRadar[\s\S]*?^\}/m.exec(view)?.[0] ?? "";
    assert.ok(radar, "the radar component exists");
    assert.doesNotMatch(radar, /fetch\(|useEffect|pillarReadiness|overallReadiness/, "no live read, no recompute");
    assert.match(radar, /srs\.assessedOn/, "it is keyed to the frozen assessment");
  });

  it("renders the table alone when the composition froze no radar", () => {
    assert.match(view, /srs\.radar \? <SrsRadar/, "the chart is conditional on what was frozen");
    assert.match(view, /<thead><tr><th>Pillar<\/th><th>Maturity<\/th><\/tr><\/thead>/, "the table is not");
  });

  it("freezes what the radar needs at issue, because a level alone cannot draw one", () => {
    const composeSrs = /async function composeSrs[\s\S]*?^\}/m.exec(compositions)?.[0] ?? "";
    assert.match(composeSrs, /maxLevel:/, "the ladder's height");
    assert.match(composeSrs, /target: pillars\.map/, "and the target profile to read a shape against");
    assert.match(composeSrs, /climateLed/, "with the climate standard painted over the top, as the workspace draws it");
  });

  it("never attributes readiness to the footprint's provenance", () => {
    // Readiness comes from the client's own answers, not from the assured measurement.
    const radar = /function SrsRadar[\s\S]*?^\}/m.exec(view)?.[0] ?? "";
    assert.match(radar, /factorSets: \[\]/, "readiness has no factor set");
    assert.match(radar, /generatedAt: srs\.assessedOn/, "it is as at the assessment, not the snapshot");
  });

  it("keeps the radar on one sheet when printed", () => {
    assert.match(css, /\.nzr-srs,\.nzr-chart\{break-inside:avoid\}/);
  });
});

/**
 * The readiness roadmap in section 06. Composed at issue and frozen, like everything else
 * the report quotes.
 */
describe("the report's readiness roadmap", () => {
  const view = read("apps/console/app/reports/[versionId]/ReportComposedView.tsx");
  const css = read("apps/console/app/reports/[versionId]/report-composed.css");
  const compositions = read("packages/isolated-backend/src/reportCompositions.ts");
  const contract = read("packages/contracts/src/reportComposition.ts");

  it("reuses the existing gap ordering rather than inventing a second one", () => {
    assert.match(contract, /gaps as resolveGaps/);
    assert.match(contract, /for \(const gap of resolveGaps\(framework, items\)\)/);
    // No re-sort after the builder has spoken.
    const composer = /export function composeSrsRoadmap[\s\S]*?\n\}/.exec(contract)?.[0] ?? "";
    assert.ok(composer.length > 0, "the composer exists");
    assert.doesNotMatch(composer, /\.sort\(/, "gaps() already ordered them");
  });

  it("answers gaps from the plan the same report froze, never the live one", () => {
    // A second read could straddle an edit and leave one report disagreeing with its own
    // plan section about what the client is doing.
    assert.match(compositions, /const planned = listClientStrategies\(db, input\.clientId\)/);
    assert.match(compositions, /composeSrs\(db, input\.clientId, planned\)/);
    const composeSrs = /async function composeSrs[\s\S]*?^\}/m.exec(compositions)?.[0] ?? "";
    assert.match(composeSrs, /composeSrsRoadmap\(/);
    assert.match(composeSrs, /\(await planned\)\.filter\(\(strategy\) => strategy\.includeInReport\)/,
      "the same population the plan section prints");
    // And exactly one read of the strategies, shared by both sections.
    assert.equal((compositions.match(/listClientStrategies\(db, input\.clientId\)/g) ?? []).length, 1);
  });

  it("excludes withdrawn strategies through the shared inversion", () => {
    assert.match(contract, /strategiesBySrsRequirement/);
    // The exclusion lives in that helper and is asserted where it is defined; here we hold
    // that the roadmap goes through it rather than re-deriving the mapping.
    const composer = /export function composeSrsRoadmap[\s\S]*?\n\}/.exec(contract)?.[0] ?? "";
    assert.match(composer, /strategiesBySrsRequirement\(plan\)/);
    assert.doesNotMatch(composer, /srsRequirementIds/, "no second mapping of its own");
  });

  it("stays optional, so an older report renders without one", () => {
    assert.match(contract, /roadmap\?: ReportSrsRoadmap/);
    assert.match(view, /srs\.roadmap \? <SrsRoadmap/);
    // Absent and empty are different facts and must not collapse into one another.
    assert.match(view, /roadmap\.pillars\.length === 0/);
    assert.match(view, /No requirement sits below the maturity the framework expects/);
  });

  it("renders after the maturity table and the radar", () => {
    const section = /<SectionHead n="06"[\s\S]*?<\/Page>/.exec(view)?.[0] ?? "";
    assert.ok(section.length > 0, "section 06 exists");
    assert.ok(section.indexOf("nzr-srs") < section.indexOf("SrsRoadmap"), "roadmap follows maturity + radar");
  });

  it("reads only the frozen composition", () => {
    const roadmap = /function SrsRoadmap[\s\S]*?^\}/m.exec(view)?.[0] ?? "";
    assert.ok(roadmap.length > 0);
    assert.doesNotMatch(roadmap, /fetch\(|useEffect|resolveGaps|listClientStrategies/, "nothing live, nothing recomputed");
  });

  it("says honestly when a gap has nothing aimed at it", () => {
    assert.match(view, /No strategy aligned yet\./);
    assert.match(view, /no strategy aligned yet\./, "and counts them in the lede");
  });

  it("keeps a gap and its strategies on one printed sheet", () => {
    assert.match(css, /\.nzr-roadmap-gap\{break-inside:avoid\}/);
    assert.match(css, /\.nzr-roadmap-pillar h4\{break-after:avoid\}/);
  });
});
