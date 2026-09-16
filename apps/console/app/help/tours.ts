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
