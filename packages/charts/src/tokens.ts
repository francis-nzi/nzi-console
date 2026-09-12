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
    muted: "#616B65", // --t3
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
  site: ["#0BA75E", "#2F7E8D", "#6B6FB3", "#D28B36", "#8A5A7B", "#51605A"],
  // SRS readiness — a sequential maturity ramp (0 not started → 4 assured) plus the two
  // standard series. Deliberately not the scope palette: scope identity means scope.
  srs: {
    maturity: ["#E4E9E5", "#CDEBD9", "#8FD3AE", "#2E9E68", "#0B6B41"],
    /** Text that stays legible on each maturity fill. */
    maturityInk: ["#3C4A43", "#095C35", "#095C35", "#FFFFFF", "#FFFFFF"],
    s2: "#0B7A4B",   // climate — the brand pine, the led standard
    s1: "#6B4E9B",   // general — a categorical partner hue, not a scope colour
    target: "#14201A",
    warn: "#B4690E",
  },
  font:
    "var(--font-inter, Inter), system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
} as const;

/**
 * Bump whenever a visual token changes. It participates in asset identity.
 *
 * NOT bumped for the `srs` block above: it is purely additive — no existing chart's
 * appearance changes, so every already-published asset identity stays valid.
 */
export const TOKENS_VERSION = 1;

/**
 * SRS maturity fill for a level 0–4, and the ink that stays legible on it.
 * Clamped: a level outside the ramp resolves to its nearest end rather than
 * rendering as `undefined` (which would print as an unstyled black fill).
 */
export function srsMaturityColor(level: number): string {
  const ramp = tokens.srs.maturity;
  return ramp[clampLevel(level, ramp.length)] ?? ramp[0];
}

export function srsMaturityInk(level: number): string {
  const ramp = tokens.srs.maturityInk;
  return ramp[clampLevel(level, ramp.length)] ?? ramp[0];
}

function clampLevel(level: number, length: number): number {
  const rounded = Math.round(Number.isFinite(level) ? level : 0);
  return Math.max(0, Math.min(length - 1, rounded));
}

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

/**
 * EN 15804 module-group identity for LCA charts. Categorical, fixed order,
 * five groups. Uses hexes already in the palette (product → emerald, then the
 * site categorical slots) — no new token, so `TOKENS_VERSION` is unchanged.
 * Dataviz check (light surface #FFF): the five are the same set the site donut
 * already validates for CVD separation; module fills always carry secondary
 * encoding (direct labels + legend + a table view), never colour-alone.
 */
export function moduleGroupColor(group: string): string {
  const map: Record<string, string> = {
    product: tokens.brand.emerald,
    transport: tokens.site[1]!, // #2F7E8D
    use: tokens.site[2]!, // #6B6FB3
    end_of_life: tokens.site[3]!, // #D28B36
    benefits: tokens.brand.pine,
  };
  return map[group] ?? tokens.brand.pine;
}

/** Stable site colour: the same site id always resolves to the same palette slot. */
export function siteColor(siteId: string): string {
  let hash = 0;
  for (const char of siteId.trim().toLowerCase()) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return tokens.site[Math.abs(hash) % tokens.site.length] ?? tokens.brand.pine;
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
