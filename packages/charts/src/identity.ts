import type { AnyChartData, Provenance } from "./types";

/** What a chart's "Source" line names: the stamped summary when its surface set one (R3/R6), else its factor sets as always. */
export const sourceText = (provenance: Provenance): string => provenance.sourceSummary ?? provenance.factorSets.join(" · ");
/** The summary's closing words — and nothing (no text node) without one, so an unset chart's markup is unchanged. */
export const sourceTail = (provenance: Provenance): string | null => provenance.sourceSummary ? " — derived, not captured" : null;

/** The same charts, each naming `sourceSummary` as its source; null leaves them exactly as they were. */
export function withSourceSummary<T extends AnyChartData>(charts: T[], sourceSummary: string | null | undefined): T[] {
  return sourceSummary ? charts.map((chart) => ({ ...chart, provenance: { ...chart.provenance, sourceSummary } })) : charts;
}

export const RENDERER_VERSION = 1;
export type RenderTarget = "screen" | "print" | "portal" | "png";

export function chartAssetKey(data: AnyChartData, target: RenderTarget): string {
  const { provenance, spec } = data;
  return [spec.id, `data-${provenance.dataHash}`, `spec-${spec.specVersion}`,
    `resolver-${provenance.resolverVersion}`, `tokens-${provenance.tokensVersion}`,
    `renderer-${provenance.rendererVersion}`, target].join(":");
}
