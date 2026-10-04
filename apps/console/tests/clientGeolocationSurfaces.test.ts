import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * Geolocation on the console (CLIENT-04, CLIENT-11, ruled PR 3): the site form's structured address with a country
 * chosen by name and stored as its code; locating after a save, never failing it; the switch read from the server.
 */
describe("client and site geolocation surfaces", () => {
  it("captures the site's address lines, postcode and an ISO country in the site form", () => {
    const sites = read("apps/console/app/clients/[clientId]/ClientSites.tsx");
    assert.match(sites, /aria-label=\{`Address line \$\{index \+ 1\}`\}/);
    assert.match(sites, /Postcode \/ zip/);
    assert.match(sites, /<CountrySelect label="Country" value=\{country\} onChange=\{setCountry\} \/>/);
    assert.match(sites, /only those two are sent to the geocoder/);
    const country = read("apps/console/app/lib/CountrySelect.tsx");
    assert.match(country, /ISO_3166\.map\(\(\[code, name\]\) => \(\{ id: code, label: name/, "searched by name, stored as the code");
  });

  it("locates after the save has committed, and the save stands whatever the lookup does", () => {
    for (const route of ["apps/console/app/api/isolated/clients/[clientId]/sites/route.ts", "apps/console/app/api/isolated/sites/[siteId]/[action]/route.ts",
      "apps/console/app/api/isolated/commands/clients/route.ts", "apps/console/app/api/isolated/commands/clients/[clientId]/route.ts", "apps/console/app/api/isolated/clients/[clientId]/locate/route.ts"]) {
      assert.match(read(route), /afterSaveLocate\(/, route);
    }
    const locate = read("apps/console/app/lib/geolocate.ts");
    assert.match(locate, /catch \{\n    return "failed";/, "a lookup error never fails the save");
  });

  it("says quietly where a site or client is — and that geocoding is off when it is", () => {
    assert.match(read("apps/console/app/clients/[clientId]/page.tsx"), /geocodingEnabled=\{process\.env\.NZI_SITE_GEOCODING_ENABLED === "true"\}/);
    const sites = read("apps/console/app/clients/[clientId]/ClientSites.tsx");
    for (const text of ["Not located — geocoding is not enabled", "add a postcode and country to locate it", "locate`"]) assert.ok(sites.includes(text), text);
    assert.match(read("apps/console/app/clients/[clientId]/ClientLocation.tsx"), /No — geocoding is not enabled/);
  });
});
