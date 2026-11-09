import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SRS_READINESS_TOUR, TOURS } from "../app/help/tours";

/**
 * BRIEF-srs-readiness-copy-and-modal-declutter: less cluttered, simpler, clearer. The dashboard's two cards carry an (i)
 * instead of a subtitle, the reasons read plainly, the assessment modal drops its helper lines, Owner is chosen from the
 * client's contacts, and the shortcuts and lifecycle are said once, in a walk-through.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const area = read("app/clients/[clientId]/SrsArea.tsx");
const forms = read("app/clients/[clientId]/SrsAssessmentForms.tsx");
const cardHead = (title: string) => new RegExp(`<CardHead title="${title}"[^\\n]*`).exec(area)?.[0] ?? "";

describe("the dashboard", () => {
  it("renames the record card Auto allocation, drops both subtitles, and gives each card its (i)", () => {
    assert.match(cardHead("Auto allocation"), /<InfoTip label="auto allocation">Climate metrics scored automatically from the client&apos;s verified data\. Override any row if the disclosure needs something different\.<\/InfoTip>/);
    assert.match(cardHead("Path to SRS-ready"), /<InfoTip label="Path to SRS-ready">Your open gaps, highest priority first — turn each into a dated action to close it\.<\/InfoTip>/);
    for (const gone of ["From the verified NZI record", "read-through · not re-keyed", "by priority · gaps → actions"]) assert.ok(!area.includes(gone), gone);
  });

  it("puts no (i) on By pillar, The readiness web or Readiness over time", () => {
    for (const title of ["By pillar", "The readiness web", "Readiness over time"]) assert.doesNotMatch(cardHead(title), /InfoTip/, title);
  });

  it("reads each auto-allocated reason through the current wording, never the stored note's", () => {
    assert.match(area, /srsAutoReason\(sourceKeys\.get\(requirement\.id\) \?\? null, requirement\.evidence\?\.note \?\? ""\)/);
    assert.match(area, /requirement\.source === "auto" \? srsAutoReason\(/);
    for (const jargon of [/unverified/, /reviewed snapshot/, /gap engine/, /forward target model/]) assert.doesNotMatch(area, jargon);
  });
});

describe("the assessment modal", () => {
  it("tightens the green box, and drops the at-or-above-target line and the inline shortcuts", () => {
    assert.match(forms, /"Scored automatically from the client's verified data\. Override if the disclosure needs something different\."/);
    for (const gone of ["At or above target", "Keys 0–4 score", "This one reads the client", "How soon this gap is closed", "Orders the Path to SRS-ready", "Context for this assessment", "Who closes this"]) {
      assert.ok(!forms.includes(gone), gone);
    }
    assert.match(forms, /"Not a gap at this score\."/, "the gap → action line still says it");
  });

  it("labels Notes and Priority with their (i), with Notes full width and no placeholder", () => {
    assert.match(forms, /<div className="nz-sect">Notes <InfoTip label="notes">One note for the whole assessment — your team only\.<\/InfoTip><\/div>/);
    assert.match(forms, /<div className="nz-sect">Priority <InfoTip label="priority">Internal only — sets the order of Path to SRS-ready\. The client doesn&apos;t see it\.<\/InfoTip><\/div>/);
    // The whole element, to its self-close — an arrow's `=>` inside it is not its end.
    const notes = /<textarea[\s\S]*?\/>/.exec(forms)?.[0] ?? "";
    assert.match(notes, /aria-label="Notes"/);
    assert.match(notes, /width: "100%"/);
    assert.doesNotMatch(notes, /placeholder/);
  });

  it("chooses Owner from this client's active contacts, with no placeholder, and still saves a name (the item command is unchanged)", () => {
    assert.match(area, /contacts=\{workspace\.contacts\}/, "the workspace's own client contacts");
    assert.match(forms, /<SrsOwnerPicker contacts=\{contacts\}/);
    assert.match(forms, /contacts\.filter\(\(contact\) => contact\.status === "active"\)/);
    const picker = /<SmartSearch id="srs-owner"[^/]*\/>/.exec(forms)?.[0] ?? "";
    assert.ok(picker, "a SmartSearch");
    assert.doesNotMatch(picker, /placeholder/);
    assert.match(forms, /onChange=\{\(_id, option\) => onChange\(option\?\.label \?\? ""\)\}/);
    assert.match(forms, /owner: current\.owner\.trim\(\)/, "the write still sends the owner string");
  });
});

describe("the walk-through", () => {
  it("chains the cards in page order and says the shortcuts and the lifecycle once", () => {
    assert.deepEqual(SRS_READINESS_TOUR.steps.map((step) => step.title),
      ["Where the client stands", "By pillar", "The readiness web", "Readiness over time", "Auto allocation", "Path to SRS-ready", "Requirement register"]);
    const all = SRS_READINESS_TOUR.steps.map((step) => `${step.body} ${step.action ?? ""}`).join(" ");
    assert.match(all, /keys 0–4 score a question and Enter moves on/);
    assert.match(all, /dated as assessed when you complete it/);
    assert.match(all, /Bridge this gap/);
    for (const step of SRS_READINESS_TOUR.steps) {
      const hook = /^\[data-tour="([a-z-]+)"\]$/.exec(step.anchor)?.[1];
      if (hook) assert.ok(area.includes(`data-tour="${hook}"`), `${step.title} has its anchor on the page`);
      else assert.ok(area.includes(step.anchor.replace(/^\./, "")), step.anchor);
    }
  });

  it("is started from the area's own button, not auto-run with the workspace tour", () => {
    assert.ok(!TOURS.includes(SRS_READINESS_TOUR));
    assert.match(area, /onClick=\{\(\) => setTouring\(true\)\}>Walk-through<\/button>/);
    assert.match(area, /<CoachMarks tour=\{SRS_READINESS_TOUR\} rememberable=\{false\}/);
  });
});
