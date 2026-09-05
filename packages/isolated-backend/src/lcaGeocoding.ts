// Track C — Nominatim (OpenStreetMap) free-text geocoding for LCA transport
// legs (L3; NZC-054). A REAL service: calls the public Nominatim search API —
// free-text -> lat/lng, no API key, matching the live app (`services/
// geocoding.py`, not readable this session — see docs/ACCEPTANCE_LCA_MODULE_
// SLICE3.md). Nominatim's usage policy requires a descriptive User-Agent and
// forbids hammering it; this module makes at most two calls per leg lookup.
// On isolated staging (or wherever a real lookup isn't wanted) a
// deterministic stub returns the same point for the same free-text query —
// same shape as `vehicleLookup.ts`'s DVLA-lookup pattern, so tests/staging
// never hit the live geocoder.
//
// The routed-distance estimate (haversine × a per-mode detour factor, no
// routing API — straight-line × a mode factor, matching the live app) lives
// in `lcaUnits.ts` alongside the rest of the live-parity maths
// (docs/_handoff_LCA_engine_parity.md §7). This module re-exports it and adds
// the two-point orchestration. A manual distance entry
// (`distanceSource: 'manual'`) is always available in the UI regardless of
// whether geocoding succeeds; a geocode result also carries the raw
// `straightLineKm` for display.
import type { LcaTransportMode } from "@nzi/contracts";
import { detourFactor, haversineDistanceKm } from "./lcaUnits";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export type GeocodePoint = { lat: number; lng: number; displayName: string };
export type GeocodeLookupResult =
  | { ok: true; source: "nominatim" | "stub"; point: GeocodePoint }
  | { ok: false; status: 400 | 404 | 429 | 503; message: string };
export type GeocodeConfig = {
  /** Return a deterministic stub instead of calling Nominatim (isolated staging). */
  allowStub?: boolean;
  /** Inject a fetch for tests. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
};

/** A deterministic point for a given free-text query — same input, same output, no network call. */
function stubPoint(query: string): GeocodePoint {
  const text = query.trim();
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const lat = ((Math.abs(hash) % 12_000) / 100) - 60; // -60.00 .. 59.99
  const lng = ((Math.abs(hash >> 8) % 36_000) / 100) - 180; // -180.00 .. 179.99
  return { lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)), displayName: text };
}

/** Free-text -> a single best-match point. Real Nominatim call, or a deterministic stub on staging. */
export async function geocodeFreeText(query: string, config: GeocodeConfig): Promise<GeocodeLookupResult> {
  const text = query.trim();
  if (text.length < 2) return { ok: false, status: 400, message: "Enter a place name to geocode." };
  if (config.allowStub) return { ok: true, source: "stub", point: stubPoint(text) };

  const doFetch = config.fetchImpl ?? fetch;
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(text)}`;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { "User-Agent": config.userAgent ?? "nzi-console/1.0 (isolated staging demonstrator; +https://nzi-pro-api-prod.onrender.com)", Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, status: 503, message: "Geocoding failed — please try again or enter the distance manually." };
  }
  if (response.status === 429) return { ok: false, status: 429, message: "Too many lookups right now — please try again shortly, or enter the distance manually." };
  if (!response.ok) return { ok: false, status: 503, message: "Geocoding failed — please try again or enter the distance manually." };

  const payload = (await response.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
  const first = payload[0];
  if (!first?.lat || !first?.lon) return { ok: false, status: 404, message: "No location found for that place name — try a more specific search, or enter the distance manually." };
  return { ok: true, source: "nominatim", point: { lat: Number(first.lat), lng: Number(first.lon), displayName: first.display_name ?? text } };
}

/** Great-circle → an approximate routed distance (§7): haversine × the mode's detour factor. */
export function estimateRoutedDistanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }, mode: LcaTransportMode): number {
  return haversineDistanceKm(a, b) * detourFactor(mode);
}

export type TransportLegGeocodeResult =
  | { ok: true; source: "nominatim" | "stub"; from: GeocodePoint; to: GeocodePoint; straightLineKm: number; distanceKm: number }
  | { ok: false; status: 400 | 404 | 429 | 503; message: string };

/** Geocode both ends of a leg and estimate its routed distance. Sequential (Nominatim-friendly), stops at the first failure. */
export async function geocodeTransportLeg(fromQuery: string, toQuery: string, mode: LcaTransportMode, config: GeocodeConfig): Promise<TransportLegGeocodeResult> {
  const from = await geocodeFreeText(fromQuery, config);
  if (!from.ok) return from;
  const to = await geocodeFreeText(toQuery, config);
  if (!to.ok) return to;
  const straightLineKm = Number(haversineDistanceKm(from.point, to.point).toFixed(1));
  const distanceKm = Number((straightLineKm * detourFactor(mode)).toFixed(1));
  return { ok: true, source: from.source, from: from.point, to: to.point, straightLineKm, distanceKm };
}
