import type { TourDefinition } from "@nzi/contracts";

/**
 * The authored tours. **Content, not code** — each is a list of anchors and words, and the
 * engine that renders them knows nothing about any page.
 *
 * One exemplar ships with the engine (the client workspace) so the auto-run → replay →
 * seen-state loop is exercised end to end by something real. The rest are authored per page
 * as each page is finished, which is the point of keeping them declarative: adding a tour is
 * an edit to this file and a review of its wording, not a change to a component.
 *
 * **On bumping `version`:** it re-surfaces the tour for everyone who saw an earlier one, so
 * it means "this changed enough to be worth showing again". Fixing a typo does not warrant
 * it; a step that now describes a different workflow does.
 *
 * **On anchors:** prefer a class the page already has for its own reasons over a selector
 * invented for the tour — an anchor that exists because the layout needs it will not quietly
 * disappear in a refactor the way a decorative hook would. A step whose anchor is missing is
 * skipped rather than guessed at.
 */
export const TOURS: TourDefinition[] = [
  {
    id: "client-workspace",
    version: 1,
    path: "/clients",
    title: "The client workspace",
    summary: "Where a client's record, their areas, and the evidence behind every figure live.",
    steps: [
      {
        anchor: ".nz-client-head",
        title: "The client, at a glance",
        body: "Who they are, who owns the relationship, and where they are in their reporting year. Everything else on this page hangs off this record.",
      },
      {
        anchor: ".nz-subnav",
        title: "Areas, not pages",
        body: "A client's work is split into areas — contacts, sites, targets, analytics, reduction strategies, readiness. You stay on the client and move between areas rather than navigating away.",
        action: "Pick an area to see how the main panel changes while the client stays put.",
      },
      {
        anchor: ".nz-client-signals",
        title: "What needs attention",
        body: "Signals are derived at read time from the client's own record — never stored, never invented. An empty signal means there is genuinely nothing to raise.",
      },
      {
        anchor: ".nz-help-btn",
        title: "Help, wherever you are",
        body: "This is always here. It knows which page you are on, replays this tour whenever you want it, and opens the knowledge library — the answers the team has already written down.",
      },
    ],
  },
];

/**
 * The SRS Readiness walk-through (BRIEF-srs-readiness-copy-and-modal-declutter). It lives on a client's `?area=srs`, which
 * the path-matched tours above cannot tell apart from the rest of the workspace, so it is not in `TOURS`: the area starts
 * it from its own Walk-through button. It chains the cards in page order and says the keyboard shortcuts and the
 * assessment lifecycle once, here, rather than on every question.
 */
export const SRS_READINESS_TOUR: TourDefinition = {
  id: "srs-readiness",
  version: 1,
  path: "/clients",
  title: "SRS Readiness",
  summary: "How ready the client is against UK SRS, and the path to close the gaps.",
  steps: [
    { anchor: ".nz-srs-headline", title: "Where the client stands", body: "Overall maturity on the 0–4 ladder, then each pillar against its target." },
    { anchor: "[data-tour=\"srs-pillars\"]", title: "By pillar", body: "Each pillar as a dial or a meter. Table shows the same numbers." },
    { anchor: "[data-tour=\"srs-web\"]", title: "The readiness web", body: "The four pillars and their targets in one shape." },
    { anchor: "[data-tour=\"srs-trend\"]", title: "Readiness over time", body: "One point per completed assessment. Reassess to draw the line." },
    { anchor: "[data-tour=\"srs-auto\"]", title: "Auto allocation", body: "Climate metrics scored automatically from the client's verified data. Override any row if the disclosure needs something different." },
    { anchor: "[data-tour=\"srs-path\"]", title: "Path to SRS-ready", body: "Your open gaps, highest priority first — turn each into a dated action to close it." },
    {
      anchor: "[data-tour=\"srs-register\"]",
      title: "Requirement register",
      body: "Every requirement with its score and evidence. Score every requirement; the assessment is dated as assessed when you complete it. A gap below target becomes an action through Bridge this gap.",
      action: "In the assessment, keys 0–4 score a question and Enter moves on.",
    },
  ],
};
