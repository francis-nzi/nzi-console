import type { AnyChartData } from "./types";

export const RENDERER_VERSION = 1;
export type RenderTarget = "screen" | "print" | "portal" | "png";

export function chartAssetKey(data: AnyChartData, target: RenderTarget): string {
  const { provenance, spec } = data;
  return [spec.id, `data-${provenance.dataHash}`, `spec-${spec.specVersion}`,
    `resolver-${provenance.resolverVersion}`, `tokens-${provenance.tokensVersion}`,
    `renderer-${provenance.rendererVersion}`, target].join(":");
}
