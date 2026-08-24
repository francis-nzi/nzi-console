// @nzi/charts — brand tokens (the single styling source for every chart)
//
// Explicit hex, not CSS custom properties: charts must render deterministically
// when rasterised/printed server-side, where the CSS cascade is not present.
// These values mirror packages/ui/src/styles.css :root and the locked palette
// in the NZI Console README. Change a colour here and every chart on every
// surface changes with it.

export const tokens = {
  surface: "#FFFFFF",
  paper: "#F6F8F7",
  line: "#E4EAE7",
  line2: "#EDF1EF",
  ink: {
    primary: "#0B1B2B", // --t1
    secondary: "#51605A", // --t2
    muted: "#8A968F", // --t3
  },
  brand: {
    emerald: "#0BA75E",
    pine: "#0B7A4B",
    midnight: "#0B1B2B",
    amber: "#FFC24B",
    coral: "#FF5C48",
    mint: "#DFF5E9",
  },
  // GHG Protocol scope identity — brand-locked. Matches the scope swatches in the
  // job table (packages/mock-data). Categorical, fixed order, never cycled.
  scope: {
    "1": "#FF5C48", // Scope 1 — coral
    "2": "#FFC24B", // Scope 2 — amber
    "3": "#0BA75E", // Scope 3 — emerald
  } as Record<string, string>,
  font:
    "var(--font-inter, Inter), system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
} as const;

/**
 * Resolve a scope's colour from its key. A sub-scope like "3.4" resolves on its
 * leading digit ("3"). Falls back to pine for anything unrecognised.
 *
 * NOTE (dataviz palette validation, light surface #FFF):
 *   CVD separation PASS (worst adjacent emerald↔amber ΔE 15.0) · normal-vision PASS.
 *   Amber (Scope 2) is light / low-contrast on white, so scope fills REQUIRE
 *   secondary encoding — which the donut always provides: 2px surface gaps,
 *   direct labels, a legend and a table view. Identity is never colour-alone.
 */
export function scopeColor(scope: string): string {
  const key = String(scope).trim().charAt(0);
  return tokens.scope[key] ?? tokens.brand.pine;
}

/** White or ink for a label sitting inside a coloured fill, by luminance. */
export function readableInkOn(hex: string): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  // relative luminance (sRGB, quick approximation)
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return L > 0.6 ? tokens.ink.primary : "#FFFFFF";
}
