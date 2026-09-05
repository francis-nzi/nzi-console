// Track C — LCA unit normalisation, mirroring the live engine exactly
// (docs/_handoff_LCA_engine_parity.md §1–§3, from NZI Live
// services/lca_engine.py + services/lca_transport.py). Pure + unit-tested.
//
// Convention in this codebase: `lca_line_items.calculated_kgco2e` and
// `.transport_kgco2e` are stored in KILOGRAMS (matching their names); the
// assessment `total_tco2e` is their sum ÷ 1000. So every helper here returns
// KILOGRAMS — the live engine returns tonnes directly, but "raw × kg-mult"
// then "÷1000 at the total" is arithmetically identical and keeps each column
// true to its name. A line's `quantity` is ALWAYS entered in kg (live policy).

export const MILES_PER_KM = 0.621371;
export const EARTH_RADIUS_KM = 6371.0088;

/** The activity denominator of a factor unit — the part after the first "/", else the whole string. */
function denominatorOf(unit: string): string {
  return (unit.includes("/") ? unit.slice(unit.indexOf("/") + 1) : unit).toLowerCase();
}
/** The CO2e numerator of a factor unit — the part before the first "/", else the whole string. */
function numeratorOf(unit: string): string {
  return (unit.includes("/") ? unit.slice(0, unit.indexOf("/")) : unit).toLowerCase();
}

/**
 * §3 — only the NUMERATOR decides kg vs tonne vs gram CO2e. Returns the
 * multiplier that converts the factor's CO2e numerator to KILOGRAMS.
 * ("kgCO2e/tonne-km" is still kg-denominated → 1.)
 */
export function ghgNumeratorToKgMultiplier(unit: string | null | undefined): number {
  const numerator = numeratorOf(unit ?? "");
  if (numerator.includes("tco2e") || numerator.includes("tonne")) return 1000;
  if (numerator.includes("gco2e") && !numerator.includes("kg")) return 0.001; // 1e-6 tonnes = 1e-3 kg
  return 1; // kg-style, and the fallback
}

/**
 * §2 — the material basis: if the factor's activity denominator is per tonne
 * (but line quantity is kg), scale by 0.001; otherwise 1.0. Non-mass activity
 * units (volume/count) are left at 1.0 — no density is available.
 */
export function materialBasisMultiplier(unit: string | null | undefined): number {
  return denominatorOf(unit ?? "").includes("tonne") ? 0.001 : 1.0;
}

/** §1 — classify a freight factor's denominator. Anything odd falls to the mass-independent km branch (never 0). */
export type FreightDenominator = "tonne_km" | "tonne_mile" | "mile" | "km";
export function classifyFreightDenominator(unit: string | null | undefined): FreightDenominator {
  const denominator = denominatorOf(unit ?? "");
  const hasTonne = denominator.includes("tonne");
  const hasMile = denominator.includes("mile");
  const hasKm = denominator.includes("km");
  if (hasTonne && hasKm) return "tonne_km";
  if (hasTonne && hasMile) return "tonne_mile";
  if (hasMile) return "mile";
  return "km";
}

/** §2 — a non-transport line's emissions in KILOGRAMS CO2e. `quantityKg` is always kg. */
export function lineItemKgco2e(quantityKg: number, factorValue: number, factorUnit: string | null | undefined): number {
  const raw = Math.max(quantityKg, 0) * Math.max(factorValue, 0) * materialBasisMultiplier(factorUnit);
  return raw * ghgNumeratorToKgMultiplier(factorUnit);
}

/**
 * §1 — a transport leg's emissions in KILOGRAMS CO2e. `massKg` is the parent
 * line item's quantity (kg). A per-km / per-mile factor is a per-vehicle-trip
 * factor: distance-only, mass-independent.
 */
export function transportLegKgco2e(opts: { massKg: number; distanceKm: number; factorValue: number; factorUnit: string | null | undefined }): number {
  const massTonnes = Math.max(opts.massKg, 0) / 1000;
  const distanceMiles = opts.distanceKm * MILES_PER_KM;
  const ghgMult = ghgNumeratorToKgMultiplier(opts.factorUnit);
  const f = Math.max(opts.factorValue, 0);
  switch (classifyFreightDenominator(opts.factorUnit)) {
    case "tonne_km": return massTonnes * opts.distanceKm * f * ghgMult;
    case "tonne_mile": return massTonnes * distanceMiles * f * ghgMult;
    case "mile": return distanceMiles * f * ghgMult;
    case "km": return opts.distanceKm * f * ghgMult;
  }
}

/** Great-circle distance between two points, in kilometres (live EARTH_RADIUS_KM). */
export function haversineDistanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, h)));
}

/**
 * §7 — detour factors (great-circle → an approximate routed distance). Live
 * values: road 1.25 · rail 1.2 · sea 1.0 · air 1.05; 1.0 for anything else.
 * Sea is deliberately 1.0 (lane length dwarfs local detour).
 */
export const MODE_DETOUR_FACTOR: Record<string, number> = {
  road_hgv: 1.25, road_van: 1.25, rail: 1.2, sea: 1.0, air: 1.05, inland_water: 1.0, other: 1.0,
};
export function detourFactor(mode: string): number {
  return MODE_DETOUR_FACTOR[mode] ?? 1.0;
}
