import { readFileSync } from "node:fs";
import { composeReportAudit, composeScopedEmissions, type ReportComposition } from "@nzi/contracts";

/**
 * Dedup slice 2 (0171): the usage-grouping case, built from the composed@6 golden pin.
 *
 * The Regional Depot's one "Fleet diesel" line (620 tCO₂e) becomes the same diesel at three usages — HGV, Van, Car — as the
 * snapshot would carry them. Its activities and its audit rows are re-composed through the real composer (`composeScopedEmissions`,
 * `composeReportAudit`), never written by hand, so the pin proves what composition makes of usage-labelled measurements, and what
 * composed@6 draws from that. Everything else is the composed@6 pin unchanged.
 */
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

export const USAGE_SITE = "c5-site-c";

export function usageGroupingComposition(): ReportComposition {
  const composition = JSON.parse(fixture("composition-composed6-whole.json")) as ReportComposition;
  const emissions = composition.emissions as unknown as { sites: Array<{ siteId: string; label: string; activities: Array<{ label: string; scope: string; tco2e: number }> }> };
  const site = emissions.sites.find((entry) => entry.siteId === USAGE_SITE)!;
  const label = site.label;
  // The depot's rows, as the snapshot holds them: its non-diesel activities as they were, and the diesel at three usages.
  const measurements = [
    ...site.activities.filter((activity) => activity.label !== "Fleet diesel").map((activity) => ({ scope: activity.scope, tco2e: activity.tco2e, siteId: USAGE_SITE, siteLabel: label, reportLabel: activity.label })),
    { scope: "1", tco2e: 300, siteId: USAGE_SITE, siteLabel: label, reportLabel: "Fleet diesel", usageLabel: "HGV" },
    { scope: "1", tco2e: 200, siteId: USAGE_SITE, siteLabel: label, reportLabel: "Fleet diesel", usageLabel: "Van" },
    { scope: "1", tco2e: 120, siteId: USAGE_SITE, siteLabel: label, reportLabel: "Fleet diesel", usageLabel: "Car" },
  ];
  const scoped = composeScopedEmissions(measurements, { kind: "whole" }, new Map([[USAGE_SITE, label]]));
  site.activities = scoped.sites.find((entry) => entry.siteId === USAGE_SITE)!.activities;

  // The audit: the depot's diesel row replaced by its three usage rows, composed as composition composes them.
  const audit = composition.audit!;
  const dieselRow = audit.rows.find((row) => row.site === label && row.activity === "Fleet diesel")!;
  const usageRows = composeReportAudit({
    measurements: measurements.filter((row) => row.reportLabel === "Fleet diesel").map((row) => ({ ...row, scopeCode: "1", factorSet: "Fleet diesel · DESNZ GB 2025", factorSource: "dataset", qualityTier: dieselRow.qualityTier })),
    scope: { kind: "whole" },
  }).rows.map((row) => ({ ...row, source: dieselRow.source, factor: dieselRow.factor }));
  const rest = audit.rows.filter((row) => row !== dieselRow);
  audit.rows = [...rest, ...usageRows].sort((a, b) => a.scopeCode.localeCompare(b.scopeCode, "en", { numeric: true }) || b.tco2e - a.tco2e || a.activity.localeCompare(b.activity));
  return composition;
}
