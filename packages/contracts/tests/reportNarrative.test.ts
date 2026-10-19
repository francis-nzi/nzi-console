import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  crpReportSectionCatalogue, defaultReportSectionPlan, isMoneyShaped, REPORT_NARRATIVE_NUMBER_ALLOWLIST, REPORT_RENDERER_LATEST, reportIssuerLineIssues,
  reportNarrativeBodyIssues, reportNarrativeDrawnKeys, reportRendererFor, reportTokenCatalogue, setReportSectionIncluded,
  commandDefinitions, commandGrantForRole, validateCommand,
} from "../src/index";

// B2-4 (RULING-report-studio-B2-4): the narrative's integrity rule, the catalogue's wording, what a plan draws, and the renderer stamp.
const codes = (bodyHtml: string) => reportNarrativeBodyIssues(bodyHtml).map((issue) => issue.code);
const p = (text: string) => `<p>${text}</p>`;
const tok = (key: string) => `<span data-token="${key}"></span>`;

describe("the strict digit rule (b): no digit outside a token, but the published allowlist", () => {
  it("refuses a hand-typed figure of any kind — an emission, a year, a share, a count", () => {
    for (const typed of ["Emissions were 13157 tCO₂e.", "Net zero by 2050.", "Scope 3 is 64.2% of the total.", "We have 3 sites.", "The 13,157.0 figure.", "A cut of -50% by 2030."]) {
      assert.deepEqual(codes(p(typed)), ["TYPED_FIGURE"], typed);
    }
    assert.match(reportNarrativeBodyIssues(p("Emissions were 13157 tonnes."))[0]!.message, /"13157" is a typed figure\. Every figure in the report is a locked token/);
  });

  it("lets every figure through as a token, whatever the token holds", () => {
    assert.deepEqual(codes(p(`Emissions were ${tok("total")} in ${tok("reportingYear")}, net zero by ${tok("netZeroYear")}.`)), []);
    // A token's own contents (a stale rendered chip) are not prose — they are collapsed to the key before saving.
    assert.deepEqual(codes(p(`<span data-token="total">13,157.0 tCO₂e</span> in total.`)), []);
  });

  it("allows exactly the published list — each pattern, and nothing beside it", () => {
    assert.deepEqual(REPORT_NARRATIVE_NUMBER_ALLOWLIST.map((entry) => entry.name), ["a scope label", "an ISO standard", "PAS 2060", "a temperature goal"]);
    for (const allowed of ["Scope 1", "Scope 2", "Scope 3", "ISO 14064", "ISO 14064-1", "ISO 14001", "ISO 50001", "ISO 14064-1:2018", "PAS 2060", "1.5°C", "2°C", "1.5 °C"]) {
      assert.deepEqual(codes(p(`Reported against ${allowed} throughout.`)), [], allowed);
    }
    for (const near of ["Scope 4", "Scope 12", "ISO 9", "PAS 2050", "3°C", "1.5 degrees", "2 °F"]) assert.deepEqual(codes(p(`Against ${near}.`)), ["TYPED_FIGURE"], near);
  });

  it("refuses money outright (NZC-120), through the issuer line's own check", () => {
    for (const money of ["It cost £40k.", "A budget of GBP 25,000.", "Savings of 500 USD.", "A €12 saving.", "Priced in £ sterling."]) {
      assert.ok(codes(p(money)).includes("MONEY"), money);
    }
    // One check, shared: the issuer line refuses exactly what it always did.
    assert.equal(isMoneyShaped("Prepared for the Board of Acme"), false);
    assert.deepEqual(reportIssuerLineIssues("Fee GBP 5,000").map((issue) => issue.code), ["MONEY_SHAPED"]);
    assert.deepEqual(reportIssuerLineIssues("Prepared for the Board of Acme"), []);
  });

  it("refuses a token the palette does not hold, and reads entities as the reader sees them", () => {
    assert.deepEqual(codes(p(`Total ${tok("madeUp")}.`)), ["UNKNOWN_TOKEN"]);
    assert.deepEqual(codes(p("Twelve&#49;&#50; tonnes.")), ["TYPED_FIGURE"], "an entity-encoded digit is still a digit");
    assert.deepEqual(codes(p("Client &amp; partners.")), []);
  });
});

describe("the catalogue (c): composed@5's wording, every figure a token", () => {
  it("every default and every AI redraft passes the rule — Reset and Generate never write a refused body", () => {
    for (const section of crpReportSectionCatalogue) {
      assert.deepEqual(reportNarrativeBodyIssues(section.defaultBodyHtml), [], `${section.key} default`);
      assert.deepEqual(reportNarrativeBodyIssues(section.aiBodyHtml), [], `${section.key} AI`);
    }
  });

  it("uses only palette tokens, phrases among them for composed@5's conditional clauses", () => {
    const keys = new Set(reportTokenCatalogue.map((token) => token.key as string));
    for (const section of crpReportSectionCatalogue) {
      for (const match of `${section.defaultBodyHtml}${section.aiBodyHtml}`.matchAll(/data-token="([^"]+)"/g)) assert.ok(keys.has(match[1]!), `${section.key}: ${match[1]}`);
    }
    const phrases = reportTokenCatalogue.filter((token) => token.kind === "phrase").map((token) => token.key);
    for (const phrase of ["baselineAnchor", "siteClause", "actionsTarget", "progressReview"]) assert.ok(phrases.includes(phrase as never), phrase);
  });

  it("is composed@5's wording, sentence for sentence (the draw test proves it word for word against the renderer)", () => {
    const body = (key: string) => crpReportSectionCatalogue.find((section) => section.key === key)!.defaultBodyHtml;
    assert.match(body("executive-summary"), /recorded total greenhouse gas emissions of <span data-token="total"><\/span> for the <span data-token="reportingYear"><\/span> reporting year/);
    assert.match(body("net-zero-commitment"), /is committed to achieving net zero greenhouse gas emissions across all scopes by <span data-token="netZeroYear"><\/span>, supported by a credible, evidence-led reduction pathway<span data-token="baselineAnchor"><\/span>\./);
    assert.match(body("reduction-actions"), /<p><span data-token="progressReview"><\/span><\/p>$/);
  });
});

describe("what a plan draws, and the renderer it is stamped with (a)", () => {
  it("draws the four riding narratives with their hosts and the two standalone ones when included — the default plan draws all six", () => {
    assert.deepEqual([...reportNarrativeDrawnKeys(defaultReportSectionPlan)].sort(),
      ["background", "category-analysis", "executive-summary", "intensity-analysis", "net-zero-commitment", "reduction-actions"]);
    const firstYear = setReportSectionIncluded(setReportSectionIncluded(defaultReportSectionPlan, "intensity", false, { allowExclusion: true }), "narrative:background", false, { allowExclusion: true });
    const drawn = reportNarrativeDrawnKeys(firstYear);
    assert.equal(drawn.has("intensity-analysis"), false, "its host is left out");
    assert.equal(drawn.has("background"), false, "a standalone narrative left out");
    assert.equal(drawn.has("executive-summary"), true);
  });

  it("stamps composed@6 exactly when a narrative is carried — a composed@6 without one cannot be made", () => {
    assert.equal(REPORT_RENDERER_LATEST, "composed@6");
    assert.equal(reportRendererFor({ narrative: [] }), "composed@6", "an empty narrative is still a frozen narrative");
    assert.equal(reportRendererFor({ narrative: [{ key: "executive-summary", bodyHtml: "<p>x</p>", contentSource: "default", sectionVersion: 0 }] }), "composed@6");
    assert.equal(reportRendererFor({ narrative: null }), "composed@5", "validated before B2-4");
    assert.equal(reportRendererFor({}), "composed@5");
  });
});

describe("report.narrative.update (B2-4 (d)(ii)): a validated version's narrative, changed in place", () => {
  const context = { organisationId: "o", actorId: "a", principal: "staff" as const, idempotencyKey: "k", correlationId: "c", grant: commandGrantForRole("admin", "o", "a") };
  const issues = (input: Record<string, unknown>) => validateCommand("report.narrative.update",
    { reportVersionId: "r", expectedVersion: 1, sectionKey: "executive-summary", change: "edit", ...input } as never, context).map((issue) => `${issue.field}:${issue.code}`);

  it("is preparer work: report.edit, as the section edits are — never report.publish", () => {
    assert.equal(commandDefinitions["report.narrative.update"].permission, "report.edit");
    assert.equal(commandDefinitions["report.narrative.update"].permission, commandDefinitions["report.section.edit"].permission);
  });

  it("an edit carries a body held to the narrative's strict rule — tokens for figures, the allowlist, no money", () => {
    assert.deepEqual(issues({ bodyHtml: p(`Our footprint was ${tok("total")} under the GHG Protocol and ISO 14064-1.`) }), []);
    assert.deepEqual(issues({ bodyHtml: p("We emitted 13157 tonnes.") }), ["bodyHtml:TYPED_FIGURE"]);
    assert.ok(issues({ bodyHtml: p("It cost £40,000.") }).includes("bodyHtml:MONEY"));
    assert.deepEqual(issues({ bodyHtml: p(tok("turnover")) }), ["bodyHtml:UNKNOWN_TOKEN"]);
    assert.deepEqual(issues({}), ["bodyHtml:REQUIRED"]);
  });

  it("Generate and Reset take the catalogue's wording and carry no body; the change, version and section are checked", () => {
    assert.deepEqual(issues({ change: "regenerate" }), []);
    assert.deepEqual(issues({ change: "reset" }), []);
    assert.deepEqual(issues({ change: "reset", bodyHtml: p("x") }), ["bodyHtml:INVALID"]);
    assert.deepEqual(issues({ change: "rewrite" }), ["change:INVALID"]);
    assert.deepEqual(issues({ change: "reset", expectedVersion: 0 }), ["expectedVersion:INVALID"], "a validated version is at version 1 or later");
    assert.deepEqual(issues({ change: "reset", sectionKey: "no-such-section" }), ["sectionKey:INVALID"]);
  });
});
