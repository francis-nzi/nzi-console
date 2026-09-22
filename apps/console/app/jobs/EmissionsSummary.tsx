"use client";

import { useEffect, useState } from "react";
import type { JobEmissions } from "@nzi/isolated-backend";

/**
 * The emissions summary strip: the headline, the scope split and the three scope tiles (NZC-144).
 *
 * Everything here comes from **one read** — `readJobEmissions`. The tiles, the bar and the percentages are
 * the same call's figures, so a tile cannot disagree with the bar beside it. Nothing is recomputed from
 * rows on this side; a client-side sum over whatever the page happened to have loaded is precisely what
 * this replaces.
 *
 * ## Location-based, and it says so
 *
 * The headline is location-based and the label says that out loud, with the market figure reported beside
 * it rather than folded in. A total that silently excluded a quarter of somebody's Scope 2 would be worse
 * than one that included it: the number would be defensible and the page would not say why.
 *
 * ## Dataviz: identity is never colour-alone
 *
 * Scope colours are brand-locked and categorical — Scope 1 coral, Scope 2 amber, Scope 3 emerald — taken
 * from the design system's `--s1/--s2/--s3`, which hold the same hexes as `@nzi/charts` tokens. The
 * stylesheet is the source for a DOM surface and the explicit hexes are the source for an SVG that has to
 * print deterministically; using both here would be two sources for one decision. Never reordered by size.
 * The palette note in those tokens is explicit that amber is light on white and therefore **requires**
 * secondary encoding, so every segment and tile carries its own text label and value, the bar has 2px
 * surface gaps between segments, and the bar is `role="img"` with its whole split written out for anyone
 * who cannot see it at all. One scale throughout: tCO₂e, never a second axis.
 */

const SCOPE_LABEL: Record<string, string> = { "1": "Scope 1", "2": "Scope 2", "3": "Scope 3" };
const SCOPE_MEANING: Record<string, string> = {
  "1": "Direct emissions",
  "2": "Purchased energy",
  "3": "Value chain",
};
const SCOPE_ORDER = ["1", "2", "3"] as const;

/** Sub-scopes roll up to their leading digit, the way the scope colours do. */
const bandOf = (scope: string): string => scope.trim().charAt(0);

const figure = (value: number): string =>
  value.toLocaleString("en-GB", { maximumFractionDigits: value >= 100 ? 0 : 2 });

type Band = { band: string; tco2e: number; marketTco2e: number; entries: number };

const bands = (emissions: JobEmissions): Band[] =>
  SCOPE_ORDER.map((band) => {
    const rows = emissions.byScope.filter((scope) => bandOf(scope.scope) === band);
    return {
      band,
      tco2e: rows.reduce((total, scope) => total + scope.tco2e, 0),
      marketTco2e: rows.reduce((total, scope) => total + scope.marketTco2e, 0),
      entries: rows.reduce((total, scope) => total + scope.entries, 0),
    };
  });

export function EmissionsSummary(
  { jobId, siteId, siteLabel, initial }:
  { jobId: string; siteId: string | null; siteLabel: string; initial: JobEmissions },
) {
  const [emissions, setEmissions] = useState(initial);
  const [stale, setStale] = useState(false);

  // Re-read when the site changes. The figures are always this one read's, narrowed server-side, rather
  // than this component slicing a wider payload — so the narrowed total is computed by the same rule as
  // the unnarrowed one instead of by a second implementation.
  useEffect(() => {
    let live = true;
    setStale(true);
    const query = siteId === null ? "" : `?siteId=${encodeURIComponent(siteId)}`;
    fetch(`/api/isolated/jobs/${encodeURIComponent(jobId)}/emissions${query}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() as Promise<JobEmissions> : null))
      .then((next) => { if (live && next) { setEmissions(next); setStale(false); } })
      // A failed refresh leaves the last good figures on screen and says they may be behind, rather than
      // showing a zero or an empty strip — a wrong number is worse than a stale one that admits it.
      .catch(() => { if (live) setStale(true); });
    return () => { live = false; };
  }, [jobId, siteId]);

  const split = bands(emissions);
  const headline = emissions.headline;
  const shown = split.filter((band) => band.tco2e > 0);

  return (
    <section className="nz-emissions-summary" aria-label="Emissions summary">
      <div className="nz-es-head">
        <span className="nz-eyebrow">{siteLabel} · total emissions</span>
        <span className="nz-es-live" aria-live="polite">
          {stale ? "Refreshing…" : "Updates as you enter data"}
        </span>
      </div>

      <p className="nz-es-total">
        <span className="nz-es-figure tnum">{figure(headline.tco2e)}</span>
        <span className="nz-es-unit">tCO₂e</span>
        {/* The qualifier travels with the figure, not with the market rows.
            It reads the same whether or not this job has any market-based entries, because the basis of
            the number is a property of how it was computed rather than of what happens to be in it —
            and a reader who sees the total on a job with none should still know which basis it is on. */}
        <span className="nz-es-basis">location-based · market-based reported separately</span>
      </p>

      {headline.marketTco2e > 0 ? (
        <p className="nz-es-market">
          Market-based reported separately: <b className="tnum">{figure(headline.marketTco2e)}</b> tCO₂e
          across {headline.marketEntries} {headline.marketEntries === 1 ? "entry" : "entries"} — not
          included in the total above.
        </p>
      ) : null}

      {/* role="img" with the whole split written out, because the bar is the one element here that is
          otherwise only readable by eye. */}
      <div
        className="nz-es-bar"
        role="img"
        aria-label={shown.length === 0
          ? "No emissions entered yet, so there is no split to show."
          : `Split by scope: ${shown.map((band) =>
              `${SCOPE_LABEL[band.band]} ${figure(band.tco2e)} tCO₂e, ${Math.round(
                headline.tco2e === 0 ? 0 : (band.tco2e / headline.tco2e) * 100)} per cent`).join("; ")}.`}
      >
        {shown.map((band) => (
          <span
            key={band.band}
            className={`nz-es-seg s${band.band}`}
            style={{ width: `${headline.tco2e === 0 ? 0 : (band.tco2e / headline.tco2e) * 100}%` }}
          />
        ))}
      </div>

      <div className="nz-es-tiles">
        {split.map((band) => (
          <div key={band.band} className={`nz-es-tile s${band.band}`}>
            <span className="nz-es-tile-label">
              <i aria-hidden="true" />
              {SCOPE_LABEL[band.band]}
              <span className="nz-es-tile-meaning">{SCOPE_MEANING[band.band]}</span>
            </span>
            <span className="nz-es-tile-value tnum">{figure(band.tco2e)}<span className="nz-es-tile-unit">tCO₂e</span></span>
            <span className="nz-es-tile-share">
              {headline.tco2e === 0 ? "—" : `${Math.round((band.tco2e / headline.tco2e) * 100)}% of emissions`}
              {" · "}
              {band.entries} {band.entries === 1 ? "entry" : "entries"}
              {band.marketTco2e > 0 ? ` · (${figure(band.marketTco2e)} market, not in total)` : ""}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A scope band's running total, for the band header.
 *
 * Takes the same read rather than a row list, so the band and the strip above it are the same arithmetic.
 */
export function ScopeBandTotal({ emissions, band }: { emissions: JobEmissions; band: string }) {
  const totals = bands(emissions).find((candidate) => candidate.band === band);
  if (!totals) return null;
  return (
    <span className="nz-band-total">
      <b className="tnum">{figure(totals.tco2e)}</b> tCO₂e
      <span className="nz-band-entries">
        {totals.entries} {totals.entries === 1 ? "entry" : "entries"}
      </span>
      {totals.marketTco2e > 0 ? (
        <span className="nz-band-market">({figure(totals.marketTco2e)} market, not in total)</span>
      ) : null}
    </span>
  );
}

/**
 * A category title bar's running total.
 *
 * Keyed on the inventory's category code, and silent when the category holds nothing — an empty category
 * shows its own "no entries yet" wording rather than a zero, which reads as a measured nought.
 */
export function CategoryTotal({ emissions, categoryCode }: { emissions: JobEmissions; categoryCode: string | null }) {
  const totals = emissions.byCategory.filter((category) => category.categoryCode === categoryCode);
  if (totals.length === 0) return null;
  const tco2e = totals.reduce((total, category) => total + category.tco2e, 0);
  const market = totals.reduce((total, category) => total + category.marketTco2e, 0);
  const entries = totals.reduce((total, category) => total + category.entries, 0);
  return (
    <span className="nz-category-total">
      <span className="nz-category-entries">{entries}</span>
      <b className="tnum">{figure(tco2e)}</b> tCO₂e
      {market > 0 ? <span className="nz-category-market">({figure(market)} market)</span> : null}
    </span>
  );
}
