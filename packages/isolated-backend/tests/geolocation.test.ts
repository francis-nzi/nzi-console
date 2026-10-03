import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDefinitions, isIsoCountryCode, isoCountryName, ISO_3166 } from "@nzi/contracts";
import { geocodePostcode, geocodingConfig } from "../src/geolocation";
import { ISO_3166 as BACKEND_ISO } from "../src/iso3166";

/**
 * Geolocation (CLIENT-04, CLIENT-11; ruled PR 3): a postcode and a country are all the geocoder is ever sent; the switch
 * is off unless explicitly on, and off means no lookup at all (no stub, no invented coordinates); a miss or a failure is
 * an outcome, never an exception. And the site address and coordinates commands validate what they store.
 */
const answering = (body: unknown, status = 200) => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL) => { asked.push(String(url)); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  return { fetchImpl, asked };
};
const on = (fetchImpl: typeof fetch) => ({ enabled: true, fetchImpl });

describe("the geocoder", () => {
  it("is off unless NZI_SITE_GEOCODING_ENABLED is exactly true — and off means no lookup, no stub", async () => {
    assert.equal(geocodingConfig({}).enabled, false);
    assert.equal(geocodingConfig({ NZI_SITE_GEOCODING_ENABLED: "1" }).enabled, false);
    assert.equal(geocodingConfig({ NZI_SITE_GEOCODING_ENABLED: "true" }).enabled, true);
    const { fetchImpl, asked } = answering([{ lat: "51.5", lon: "-0.1" }]);
    assert.deepEqual(await geocodePostcode("SW1A 1AA", "GB", { enabled: false, fetchImpl }), { state: "disabled" });
    assert.deepEqual(asked, [], "nothing is looked up while the switch is off");
  });

  it("sends a postcode and a country only — a structured query, never free text or an address line", async () => {
    const { fetchImpl, asked } = answering([{ lat: "53.80", lon: "-1.55", display_name: "Leeds" }]);
    const outcome = await geocodePostcode(" LS1 4AP ", "GB", on(fetchImpl));
    assert.deepEqual(outcome, { state: "located", point: { latitude: 53.8, longitude: -1.55, source: "nominatim", precision: "postcode" } });
    const url = new URL(asked[0]!);
    assert.equal(url.origin + url.pathname, "https://nominatim.openstreetmap.org/search");
    assert.deepEqual([...url.searchParams.keys()].sort(), ["countrycodes", "format", "limit", "postalcode"]);
    assert.equal(url.searchParams.get("postalcode"), "LS1 4AP");
    assert.equal(url.searchParams.get("countrycodes"), "gb");
  });

  it("reads a country held as a name (v7's free text) as its code, and refuses to look up without both parts", async () => {
    const { fetchImpl, asked } = answering([{ lat: "1", lon: "2" }]);
    assert.equal((await geocodePostcode("LS1 4AP", "United Kingdom", on(fetchImpl))).state, "located");
    assert.equal(new URL(asked[0]!).searchParams.get("countrycodes"), "gb");
    for (const [postcode, country] of [[null, "GB"], ["", "GB"], ["LS1 4AP", null], ["LS1 4AP", "Atlantis"], ["LS1 4AP", "GLOBAL"]] as const) {
      assert.deepEqual(await geocodePostcode(postcode, country, on(fetchImpl)), { state: "no-address" }, `${postcode} / ${country}`);
    }
    assert.equal(asked.length, 1, "no lookup without a postcode and a real country");
  });

  it("reports a miss and a failure as outcomes, never as errors", async () => {
    assert.deepEqual(await geocodePostcode("ZZ9 9ZZ", "GB", on(answering([]).fetchImpl)), { state: "not-found" });
    assert.deepEqual(await geocodePostcode("ZZ9 9ZZ", "GB", on(answering([{ lat: "x", lon: "y" }]).fetchImpl)), { state: "not-found" });
    assert.deepEqual(await geocodePostcode("LS1 4AP", "GB", on(answering({}, 429).fetchImpl)), { state: "failed" });
    assert.deepEqual(await geocodePostcode("LS1 4AP", "GB", on((async () => { throw new Error("offline"); }) as typeof fetch)), { state: "failed" });
  });
});

describe("one ISO 3166 list (CLIENT-03), in contracts", () => {
  it("is the backend's list too, and answers codes and names", () => {
    assert.equal(BACKEND_ISO, ISO_3166, "the backend re-exports the contracts list");
    assert.equal(ISO_3166.length, 250, "the committed list, unchanged by the move");
    assert.ok(isIsoCountryCode("GB") && isIsoCountryCode("AE"));
    assert.ok(!isIsoCountryCode("UK") && !isIsoCountryCode("gb") && !isIsoCountryCode("GLOBAL") && !isIsoCountryCode(null));
    assert.equal(isoCountryName("AE"), "United Arab Emirates");
    assert.equal(isoCountryName("XX"), null);
  });
});

describe("the site address and location commands validate what they store", () => {
  const context = { actorId: "ada", organisationId: "org-a", idempotencyKey: "k", correlationId: "c" } as never;
  const fields = (key: "site.create" | "site.edit" | "site.location.set" | "client.location.set", input: Record<string, unknown>) =>
    commandDefinitions[key].validate(input as never, context).map((issue) => issue.field);

  it("takes up to four address lines, a short postcode and an ISO country — and keeps an omitted one", () => {
    const base = { clientId: "c1", name: "Depot", inServiceFrom: null };
    assert.deepEqual(fields("site.create", { ...base, addressLines: ["1 High St", "Leeds"], postcode: "LS1 4AP", country: "GB" }), []);
    assert.deepEqual(fields("site.create", base), [], "no address at all is fine");
    assert.deepEqual(fields("site.create", { ...base, addressLines: ["1", "2", "3", "4", "5"] }), ["addressLines"]);
    assert.deepEqual(fields("site.create", { ...base, postcode: "x".repeat(21) }), ["postcode"]);
    assert.deepEqual(fields("site.create", { ...base, country: "United Kingdom" }), ["country"]);
    assert.deepEqual(fields("site.edit", { siteId: "s1", name: "Depot", inServiceFrom: null, expectedVersion: 1, country: "UK" }), ["country"]);
  });

  it("takes coordinates in range, from the geocoder at postcode precision, against a version", () => {
    const point = { latitude: 53.8, longitude: -1.55, source: "nominatim", precision: "postcode", expectedVersion: 2 };
    assert.deepEqual(fields("site.location.set", { siteId: "s1", ...point }), []);
    assert.deepEqual(fields("client.location.set", { clientId: "c1", ...point }), []);
    assert.deepEqual(fields("site.location.set", { siteId: "s1", ...point, latitude: 91, longitude: -181 }), ["latitude", "longitude"]);
    assert.deepEqual(fields("site.location.set", { siteId: "s1", ...point, source: "stub", precision: "street" }), ["source", "precision"]);
    assert.deepEqual(fields("client.location.set", { clientId: "c1", ...point, expectedVersion: 0 }), ["expectedVersion"]);
  });
});
