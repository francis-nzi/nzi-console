import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultReportSectionPlan, isMovableReportSection, isOptionalReportSection, legacyReportSectionPlanV3, moveReportSection,
  normaliseReportPlanKeys, reportCompositionSectionMeta, reportReferenceSections, reportSectionMetaFor, reportSectionMetaV4,
  reportSectionPlanIssues, reportSectionPlanOf, setReportSectionIncluded, type ReportComposition, type ReportSectionPlan,
} from "../src/index";

// B2-3 (RULING-report-B2-3): composed@4's section set — five additive keys, a frozen v3 legacy default so issued composed@1/2/3
// reports never change, stored plans read complete (deterministically), and the main body ending at Methodology followed by
// the fixed reference block.
const keys = (plan: ReportSectionPlan) => plan.map((entry) => entry.key);
const newKeys = ["scope-analysis", "category-analysis", "glossary", "audit", "appendix-sites"];

describe("the frozen v3 legacy default — what composed@1/2/3 render a plan-less composition with", () => {
  it("is today's (pre-B2-3) default, exactly: none of the new sections, Methodology last", () => {
    assert.deepEqual(keys(legacyReportSectionPlanV3), [
      "cover", "executive-summary", "narrative:executive-summary", "narrative:net-zero-commitment", "narrative:background",
      "emissions", "narrative:category-analysis", "sites", "intensity", "narrative:intensity-analysis", "targets", "plan",
      "narrative:reduction-actions", "srs", "methodology",
    ]);
    assert.ok(newKeys.every((key) => !keys(legacyReportSectionPlanV3).includes(key as never)));
  });

  it("composed@1/2/3 read a composition's plan as it was issued — or, with none, the legacy default; composed@4 reads it complete", () => {
    const base = { sectionPlan: undefined } as unknown as ReportComposition;
    for (const renderer of [undefined, "composed@1", "composed@2", "composed@3"]) assert.deepEqual(reportSectionPlanOf({ ...base, renderer } as ReportComposition), legacyReportSectionPlanV3, String(renderer));
    const legacyPlan = setReportSectionIncluded(legacyReportSectionPlanV3, "srs", false, { allowExclusion: true });
    assert.deepEqual(reportSectionPlanOf({ ...base, renderer: "composed@3", sectionPlan: legacyPlan } as ReportComposition), legacyPlan, "never normalised");
    assert.deepEqual(reportSectionPlanOf({ ...base, renderer: "composed@4" } as ReportComposition), defaultReportSectionPlan);
    assert.deepEqual(reportSectionPlanOf({ ...base, renderer: "composed@4", sectionPlan: legacyPlan } as ReportComposition), normaliseReportPlanKeys(legacyPlan));
  });
});

describe("the default plan — composed@4's canonical order", () => {
  it("is the mockup's: the main body ending at Methodology, then the Glossary and the two appendices; it fits the rules", () => {
    assert.deepEqual(keys(defaultReportSectionPlan).filter((key) => !key.startsWith("narrative:")), [
      "cover", "executive-summary", "sites", "emissions", "intensity", "targets", "scope-analysis", "category-analysis", "plan", "srs",
      "methodology", "glossary", "audit", "appendix-sites",
    ]);
    assert.deepEqual(reportSectionPlanIssues(defaultReportSectionPlan), []);
    assert.ok(defaultReportSectionPlan.filter((entry) => newKeys.includes(entry.key)).every((entry) => entry.included), "the new sections are in by default");
  });
});

describe("a stored plan read complete — deterministic, never reordering what it held", () => {
  it("a legacy plan gains each new key at its default place, after the nearest key before it that it holds", () => {
    const complete = normaliseReportPlanKeys(legacyReportSectionPlanV3);
    assert.deepEqual(reportSectionPlanIssues(complete), []);
    assert.deepEqual(keys(complete).filter((key) => keys(legacyReportSectionPlanV3).includes(key as never)), keys(legacyReportSectionPlanV3), "nothing it held moved");
    assert.equal(keys(complete).indexOf("scope-analysis"), keys(complete).indexOf("targets") + 1, "after targets, its default predecessor");
    assert.equal(keys(complete).indexOf("category-analysis"), keys(complete).indexOf("scope-analysis") + 1);
    assert.deepEqual(keys(complete).slice(-4), ["methodology", ...reportReferenceSections]);
  });

  it("keeps what the plan chose: a left-out section stays out, a reordered one stays where it was put", () => {
    const chosen = moveReportSection(setReportSectionIncluded(legacyReportSectionPlanV3, "intensity", false, { allowExclusion: true }), "srs", "earlier");
    const complete = normaliseReportPlanKeys(chosen);
    assert.equal(complete.find((entry) => entry.key === "intensity")!.included, false);
    assert.deepEqual(keys(complete).filter((key) => keys(chosen).includes(key as never)), keys(chosen));
  });

  it("is deterministic and idempotent; a complete plan comes back as it is", () => {
    assert.deepEqual(normaliseReportPlanKeys(legacyReportSectionPlanV3), normaliseReportPlanKeys([...legacyReportSectionPlanV3]));
    const once = normaliseReportPlanKeys(legacyReportSectionPlanV3);
    assert.deepEqual(normaliseReportPlanKeys(once), once);
    assert.equal(normaliseReportPlanKeys(defaultReportSectionPlan), defaultReportSectionPlan);
  });
});

describe("the rules: Methodology ends the main body, then exactly the reference block", () => {
  const move = (plan: ReportSectionPlan, key: string, to: number) => { const rest = plan.filter((entry) => entry.key !== key); return [...rest.slice(0, to), plan.find((entry) => entry.key === key)!, ...rest.slice(to)]; };

  it("a section after Methodology other than the reference block is refused", () => {
    const srsLast = move(defaultReportSectionPlan, "srs", defaultReportSectionPlan.length - 1);
    assert.deepEqual(reportSectionPlanIssues(srsLast).map((issue) => issue.code), ["METHODOLOGY_LAST"]);
  });

  it("the reference block in another order, or one of it before Methodology, is refused", () => {
    const swapped = defaultReportSectionPlan.map((entry) => entry.key === "audit" ? { ...entry, key: "glossary" as const } : entry.key === "glossary" ? { ...entry, key: "audit" as const } : entry);
    assert.deepEqual(reportSectionPlanIssues(swapped).map((issue) => issue.code), ["REFERENCE_BLOCK"]);
    const glossaryEarly = move(defaultReportSectionPlan, "glossary", 3);
    assert.deepEqual(reportSectionPlanIssues(glossaryEarly).map((issue) => issue.code), ["REFERENCE_BLOCK"]);
  });

  it("a legacy plan unread-complete is missing the new sections — commands read every plan complete first", () => {
    assert.deepEqual([...new Set(reportSectionPlanIssues(legacyReportSectionPlanV3).map((issue) => issue.code))], ["MISSING_SECTION"]);
  });

  it("the reference sections never move but may each be left out; the mandatory set is unchanged", () => {
    for (const key of reportReferenceSections) {
      assert.equal(isMovableReportSection(key), false, key);
      assert.equal(isOptionalReportSection(key), true, key);
      assert.deepEqual(reportSectionPlanIssues(setReportSectionIncluded(defaultReportSectionPlan, key, false, { allowExclusion: true })), [], key);
    }
    for (const key of ["scope-analysis", "category-analysis"] as const) assert.deepEqual([isMovableReportSection(key), isOptionalReportSection(key)], [true, true]);
    for (const key of ["cover", "executive-summary", "emissions", "methodology"] as const) assert.equal(isOptionalReportSection(key), false, key);
  });
});

describe("titles by renderer", () => {
  it("composed@4 prints the mockup's titles; composed@1/2/3 keep theirs, byte for byte", () => {
    assert.equal(reportSectionMetaFor({ renderer: "composed@4" }).emissions.title, "Carbon Emissions Overview");
    assert.equal(reportSectionMetaV4.methodology.title, "Standards, Methodology & Sign-off");
    for (const renderer of [undefined, "composed@1", "composed@2", "composed@3"]) assert.equal(reportSectionMetaFor({ renderer }), reportCompositionSectionMeta);
    assert.equal(reportCompositionSectionMeta.emissions.title, "Emissions by scope");
  });
});
