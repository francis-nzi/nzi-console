"use client";

import type { JobEmissions } from "@nzi/isolated-backend";

/**
 * The site tabs: All sites, then one per site, each with its entry count (NZC-144).
 *
 * Selecting a tab narrows the whole capture surface — the summary strip above and the category cards
 * below — so a consultant working through one building sees that building's totals rather than the job's.
 * It is a filter over one page rather than a separate per-site surface, which is what keeps "All sites"
 * a roll-up of the same rows instead of a seventh thing to reconcile.
 *
 * The counts come from the aggregation read's own site breakdown, which is deliberately **not** narrowed
 * by the current tab: a tab has to show its count while another one is selected, or choosing a site
 * would hide the reason to choose a different one.
 *
 * A site with no entries is still offered. "Nothing here yet" is a place to start entering, and hiding
 * empty sites would make the tabs a record of where work has happened rather than a way to do it.
 */

export type JobSite = { id: string; name: string };

export function JobSiteTabs(
  { sites, emissions, selected, onSelect }:
  { sites: readonly JobSite[]; emissions: JobEmissions; selected: string | null; onSelect: (siteId: string | null) => void },
) {
  const countFor = (siteId: string | null): number =>
    emissions.bySite
      .filter((site) => site.siteId === siteId)
      .reduce((total, site) => total + site.entries, 0);

  const allEntries = emissions.bySite.reduce((total, site) => total + site.entries, 0);
  // Rows with no site of their own. Named rather than hidden, because they are in the job total and a
  // consultant looking for a missing entry should be able to find where it went.
  const unplaced = countFor(null);

  const tab = (
    key: string,
    siteId: string | null,
    label: string,
    entries: number,
  ) => {
    const active = selected === siteId;
    return (
      <button
        key={key}
        type="button"
        role="tab"
        aria-selected={active}
        className={`nz-site-tab${active ? " on" : ""}`}
        onClick={() => onSelect(siteId)}
      >
        <span className="nz-site-tab-name">{label}</span>
        <span className="nz-site-tab-count tnum" aria-label={`${entries} ${entries === 1 ? "entry" : "entries"}`}>
          {entries}
        </span>
      </button>
    );
  };

  return (
    <div className="nz-site-tabs" role="tablist" aria-label="Sites">
      {tab("all", null, "All sites", allEntries)}
      {sites.map((site) => tab(site.id, site.id, site.name, countFor(site.id)))}
      {/* Only when there are any: an empty "Unassigned" tab would be a category of nothing. */}
      {unplaced > 0 && selected !== null
        ? tab("unplaced-note", null, "Unassigned", unplaced)
        : null}
    </div>
  );
}

/** The label for the strip's eyebrow, so the strip and the tabs never name the selection differently. */
export const siteLabelFor = (sites: readonly JobSite[], selected: string | null): string =>
  selected === null ? "All sites" : sites.find((site) => site.id === selected)?.name ?? "Selected site";
