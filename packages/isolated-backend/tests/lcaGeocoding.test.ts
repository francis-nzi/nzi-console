import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateRoutedDistanceKm, geocodeFreeText, geocodeTransportLeg, haversineDistanceKm, MODE_DETOUR_FACTOR } from "../src/index";

describe("geocodeFreeText", () => {
  it("rejects a too-short query before any network call", async () => {
    let called = false;
    const result = await geocodeFreeText("X", { fetchImpl: (async () => { called = true; return new Response("[]"); }) as typeof fetch });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 400);
    assert.equal(called, false);
  });

  it("returns a deterministic stub on staging — same query, same point, no network call", async () => {
    let called = false;
    const a = await geocodeFreeText("Ningbo plant, CN", { allowStub: true, fetchImpl: (async () => { called = true; return new Response("[]"); }) as typeof fetch });
    const b = await geocodeFreeText("Ningbo plant, CN", { allowStub: true });
    assert.equal(a.ok, true);
    assert.equal(a.ok && a.source, "stub");
    assert.deepEqual(a.ok && a.point, b.ok && b.point);
    assert.equal(called, false, "the stub never calls fetch");
  });

  it("stub points stay within valid lat/lng ranges", async () => {
    for (const query of ["Felixstowe port, UK", "Leeds pack site, UK", "Ningbo plant, CN"]) {
      const result = await geocodeFreeText(query, { allowStub: true });
      assert.ok(result.ok);
      if (result.ok) {
        assert.ok(result.point.lat >= -90 && result.point.lat <= 90);
        assert.ok(result.point.lng >= -180 && result.point.lng <= 180);
      }
    }
  });

  it("calls Nominatim and parses the first result", async () => {
    let sentUrl = "";
    const fetchImpl = (async (url: string) => {
      sentUrl = String(url);
      return new Response(JSON.stringify([{ lat: "51.96", lon: "1.35", display_name: "Felixstowe, Suffolk, England" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await geocodeFreeText("Felixstowe port, UK", { fetchImpl });
    assert.ok(sentUrl.includes("nominatim.openstreetmap.org/search"));
    assert.ok(sentUrl.includes(encodeURIComponent("Felixstowe port, UK")));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.source, "nominatim");
    assert.equal(result.ok && result.point.lat, 51.96);
    assert.equal(result.ok && result.point.displayName, "Felixstowe, Suffolk, England");
  });

  it("404s when Nominatim returns no results", async () => {
    const result = await geocodeFreeText("a place that does not exist", { fetchImpl: (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch });
    assert.equal(result.ok === false && result.status, 404);
  });

  it("maps a 429 through and degrades to 503 on network error", async () => {
    const throttled = await geocodeFreeText("somewhere", { fetchImpl: (async () => new Response("[]", { status: 429 })) as unknown as typeof fetch });
    assert.equal(throttled.ok === false && throttled.status, 429);
    const failed = await geocodeFreeText("somewhere", { fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    assert.equal(failed.ok === false && failed.status, 503);
  });
});

describe("haversineDistanceKm / estimateRoutedDistanceKm", () => {
  it("is zero for the same point", () => assert.equal(haversineDistanceKm({ lat: 51.5, lng: -0.1 }, { lat: 51.5, lng: -0.1 }), 0));

  it("matches a known great-circle distance within a small tolerance (London <-> Paris, ~344km)", () => {
    const km = haversineDistanceKm({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
    assert.ok(Math.abs(km - 344) < 5, `expected ~344km, got ${km}`);
  });

  it("applies the per-mode detour factor on top of the great-circle distance", () => {
    const a = { lat: 51.5074, lng: -0.1278 };
    const b = { lat: 48.8566, lng: 2.3522 };
    const straight = haversineDistanceKm(a, b);
    for (const mode of Object.keys(MODE_DETOUR_FACTOR) as (keyof typeof MODE_DETOUR_FACTOR)[]) {
      const routed = estimateRoutedDistanceKm(a, b, mode);
      assert.ok(Math.abs(routed - straight * MODE_DETOUR_FACTOR[mode]) < 1e-9);
    }
  });
});

describe("geocodeTransportLeg", () => {
  it("geocodes both ends and estimates a routed distance", async () => {
    const result = await geocodeTransportLeg("Ningbo plant, CN", "Felixstowe port, UK", "sea", { allowStub: true });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.source, "stub");
      assert.ok(result.distanceKm >= 0);
      assert.equal(result.from.displayName, "Ningbo plant, CN");
      assert.equal(result.to.displayName, "Felixstowe port, UK");
    }
  });

  it("stops at the first failure without geocoding the second point", async () => {
    let toCalls = 0;
    const result = await geocodeTransportLeg("X", "Felixstowe port, UK", "sea", {
      fetchImpl: (async () => { toCalls += 1; return new Response("[]"); }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(toCalls, 0, "the origin's own validation failure never reaches a network call for either point");
  });
});
