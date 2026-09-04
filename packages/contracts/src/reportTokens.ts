// R3 — data-bound figure tokens (NZC-049). A figure inside report narrative is
// never free text: it is a token resolved from the reviewed snapshot at render
// time, so a client can rewrite the prose around it and the number still equals
// the canonical value. The same catalogue feeds the AI drafter (R4), so AI text
// is data-bound by construction.
//
// A token is stored in the section body as `<span data-token="KEY"></span>` and
// rendered as a locked chip carrying the resolved value.

import type { ReviewedCrpSnapshotReadModel } from "./commands";
import type { ReportSectionReadModel } from "./reportSections";

export type ReportTokenGroup = "totals" | "shares" | "targets" | "intensity" | "dates";

export type ReportTokenKey =
  | "total"
  | "scope1" | "scope2" | "scope3"
  | "scope1Pct" | "scope2Pct" | "scope3Pct"
  | "reportingYear"
  | "baselineYear" | "baselineTotal"
  | "interimYear" | "interimReductionPct" | "netZeroYear"
  | "intensityValue" | "intensityUnit";

export type ReportTokenDefinition = { key: ReportTokenKey; label: string; group: ReportTokenGroup };

/** Palette shown to the consultant / drawn on by the AI drafter. */
export const reportTokenCatalogue: readonly ReportTokenDefinition[] = [
  { key: "total", label: "Total emissions", group: "totals" },
  { key: "scope1", label: "Scope 1 subtotal", group: "totals" },
  { key: "scope2", label: "Scope 2 subtotal", group: "totals" },
  { key: "scope3", label: "Scope 3 subtotal", group: "totals" },
  { key: "scope1Pct", label: "Scope 1 share", group: "shares" },
  { key: "scope2Pct", label: "Scope 2 share", group: "shares" },
  { key: "scope3Pct", label: "Scope 3 share", group: "shares" },
  { key: "reportingYear", label: "Reporting year", group: "dates" },
  { key: "baselineYear", label: "Baseline year", group: "dates" },
  { key: "baselineTotal", label: "Baseline emissions", group: "targets" },
  { key: "interimYear", label: "Interim target year", group: "dates" },
  { key: "interimReductionPct", label: "Interim reduction target", group: "targets" },
  { key: "netZeroYear", label: "Net zero year", group: "dates" },
  { key: "intensityValue", label: "Emissions intensity", group: "intensity" },
  { key: "intensityUnit", label: "Intensity unit", group: "intensity" },
] as const;

const catalogueByKey = new Map(reportTokenCatalogue.map((token) => [token.key, token]));
export const isReportTokenKey = (key: string): key is ReportTokenKey => catalogueByKey.has(key as ReportTokenKey);

export type ResolvedReportToken = {
  key: string;
  label: string;
  /** Rendered text, e.g. "108.15 tCO₂e" or "96.4%". "—" when unresolved. */
  value: string;
  /** false when the snapshot does not carry the data this token needs. */
  ok: boolean;
  /** Human explanation for the chip tooltip. */
  detail: string;
};

type TokenSnapshot = Pick<ReviewedCrpSnapshotReadModel, "measurements" | "target" | "intensityTarget" | "reportingYear">;

const tco2e = (value: number): string => `${value.toLocaleString("en-GB", { maximumFractionDigits: 2 })} tCO₂e`;
const percent = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%` : "0%");

export function resolveReportToken(key: string, snapshot: TokenSnapshot): ResolvedReportToken {
  const definition = catalogueByKey.get(key as ReportTokenKey);
  const label = definition?.label ?? key;
  const unresolved = (detail: string): ResolvedReportToken => ({ key, label, value: "—", ok: false, detail });
  if (!definition) return unresolved(`"${key}" is not a known report figure token.`);

  const rows = snapshot.measurements;
  const total = rows.reduce((sum, row) => sum + row.tco2e, 0);
  const scopeTotal = (scope: "1" | "2" | "3"): number => rows.filter((row) => row.scope === scope).reduce((sum, row) => sum + row.tco2e, 0);
  const bound = (value: string, detail: string): ResolvedReportToken => ({ key, label, value, ok: true, detail: `${detail} Bound to Outputs — updates automatically, cannot be mistyped.` });

  switch (definition.key) {
    case "total": return bound(tco2e(total), "Reviewed total across every included row.");
    case "scope1": return bound(tco2e(scopeTotal("1")), "Reviewed Scope 1 subtotal.");
    case "scope2": return bound(tco2e(scopeTotal("2")), "Reviewed Scope 2 subtotal.");
    case "scope3": return bound(tco2e(scopeTotal("3")), "Reviewed Scope 3 subtotal.");
    case "scope1Pct": return bound(percent(scopeTotal("1"), total), "Scope 1 share of the reviewed total.");
    case "scope2Pct": return bound(percent(scopeTotal("2"), total), "Scope 2 share of the reviewed total.");
    case "scope3Pct": return bound(percent(scopeTotal("3"), total), "Scope 3 share of the reviewed total.");
    case "reportingYear": return bound(String(snapshot.reportingYear), "Reporting year of this assessment.");
    case "baselineYear": return snapshot.target ? bound(String(snapshot.target.baselineYear), "Baseline year of the reduction target.") : unresolved("No reduction target is set for this job.");
    case "baselineTotal": return snapshot.target ? bound(tco2e(snapshot.target.baselineTco2e), "Baseline-year emissions the target reduces from.") : unresolved("No reduction target is set for this job.");
    case "interimYear": return snapshot.target ? bound(String(snapshot.target.interimYear), "Interim milestone year.") : unresolved("No reduction target is set for this job.");
    case "interimReductionPct": return snapshot.target ? bound(`${snapshot.target.interimReductionPercent.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`, "Interim reduction against the baseline.") : unresolved("No reduction target is set for this job.");
    case "netZeroYear": return snapshot.target ? bound(String(snapshot.target.netZeroYear), "Net zero target year.") : unresolved("No reduction target is set for this job.");
    case "intensityValue": {
      const it = snapshot.intensityTarget;
      if (!it || !(it.reportingDenominator > 0)) return unresolved("No intensity target / reporting denominator is set for this job.");
      return bound((total / it.reportingDenominator).toLocaleString("en-GB", { maximumFractionDigits: 2 }), "Reviewed total divided by the reporting denominator.");
    }
    case "intensityUnit": {
      const it = snapshot.intensityTarget;
      return it ? bound(`tCO₂e / ${it.denominatorUnit}`, "Unit of the emissions intensity metric.") : unresolved("No intensity target is set for this job.");
    }
    default: return unresolved("Unhandled token.");
  }
}

const TOKEN_SPAN = /<span\s+data-token="([a-zA-Z0-9]+)"\s*>(.*?)<\/span>/g;
const escapeAttr = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Replace every `<span data-token="KEY"></span>` in a section body with a locked
 * figure chip carrying the resolved value. The prose around it is untouched.
 * `locked` adds `contenteditable="false"` for the in-place editor (R4).
 */
export function renderReportSectionBody(bodyHtml: string, snapshot: TokenSnapshot, options: { locked?: boolean } = {}): string {
  return bodyHtml.replace(TOKEN_SPAN, (_match, key: string) => {
    const resolved = resolveReportToken(key, snapshot);
    const cls = resolved.ok ? "nz-fig-token" : "nz-fig-token unresolved";
    const editable = options.locked ? ' contenteditable="false"' : "";
    return `<span class="${cls}" data-token="${escapeAttr(key)}" title="${escapeAttr(resolved.detail)}"${editable}>${escapeAttr(resolved.value)}</span>`;
  });
}

export type SectionTokenVerification = {
  ok: boolean;
  tokens: Array<ResolvedReportToken & { sectionKey: string }>;
};

/** Every figure token in every section must resolve against the snapshot. */
export function verifyReportSectionTokens(sections: readonly ReportSectionReadModel[], snapshot: TokenSnapshot): SectionTokenVerification {
  const tokens: SectionTokenVerification["tokens"] = [];
  for (const section of sections) {
    for (const match of section.bodyHtml.matchAll(TOKEN_SPAN)) {
      tokens.push({ sectionKey: section.key, ...resolveReportToken(match[1]!, snapshot) });
    }
  }
  return { ok: tokens.every((token) => token.ok), tokens };
}
