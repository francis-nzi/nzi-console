import React from "react";
import type { PortalBoundary } from "@nzi/isolated-backend";
import { formatDate } from "../lib/formatDate";

/** More included sites than this: the count shows, with the names behind a disclosure. */
export const BOUNDARY_SITES_INLINE_MAX = 5;

/**
 * The portal job header's boundary summary (RULING-portal-setup-replacement): the job's reporting period and the sites in its boundary,
 * by name — a read-only mirror of what staff set in the CRM. No edit, no addresses or ids, no excluded sites, no totals.
 */
export function PortalBoundaryStrip({ boundary }: { boundary: PortalBoundary }) {
  const { reportingFrom, reportingTo, siteNames } = boundary;
  const period = reportingFrom && reportingTo ? `${formatDate(reportingFrom)} – ${formatDate(reportingTo)}` : "Not set yet";
  return (
    <dl className="nz-pd-boundary" aria-label="Job boundary">
      <div><dt>Reporting period</dt><dd>{period}</dd></div>
      <div>
        <dt>Sites in boundary</dt>
        <dd>
          {siteNames.length === 0 ? "None set yet" : siteNames.length <= BOUNDARY_SITES_INLINE_MAX ? (
            <ul>{siteNames.map((name, index) => <li key={`${index}-${name}`}>{name}</li>)}</ul>
          ) : (
            <details>
              <summary>{siteNames.length} sites</summary>
              <ul>{siteNames.map((name, index) => <li key={`${index}-${name}`}>{name}</li>)}</ul>
            </details>
          )}
        </dd>
      </div>
    </dl>
  );
}
