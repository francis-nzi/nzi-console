-- 0154 Client and site geolocation (CLIENT-04, CLIENT-11; ruled `CLIENT-round1-RULINGS.md` PR 3): where a client and
-- each of its sites are, derived from a postcode and a country.
--
-- ## What it adds
--
-- - **`clients.latitude` / `longitude` / `geocode_source` / `geocode_precision`** — the client's coordinates, from its
--   registered postcode and country. Both coordinates or neither, in range; a source and a precision whenever they are
--   set. The only source written is the geocoder (`nominatim`), at postcode precision: geocoding sends a postcode and a
--   country, never an address line (ruling 2a).
-- - **`client_sites.country`** — an ISO 3166-1 alpha-2 code, beside 0035's `address_lines_json` and `postcode`, so a
--   site's address is structured and can be geocoded.
--
-- ## What it does not change
--
-- - **Site coordinates** stay in 0035's columns. The v7 import fills some of them with no recorded source; they are left
--   exactly as they are (an existing site's coordinates are only cleared when its postcode or country changes).
-- - **Site addresses stay plaintext** (ruling 1a): `postcode` and `address_lines_json` are in the PII inventory with
--   sealed storage deferred, and the console becoming a writer of them does not change that.
-- - No row is rewritten; no grant changes (the columns ride on the tables' existing grants).

BEGIN;

ALTER TABLE nzi_console.clients
  ADD COLUMN latitude numeric CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude numeric CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN geocode_source text CHECK (geocode_source IN ('nominatim')),
  ADD COLUMN geocode_precision text CHECK (geocode_precision IN ('postcode')),
  ADD CONSTRAINT clients_coordinates_paired CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT clients_coordinates_sourced CHECK ((latitude IS NULL) = (geocode_source IS NULL) AND (latitude IS NULL) = (geocode_precision IS NULL));

ALTER TABLE nzi_console.client_sites
  ADD COLUMN country text CHECK (country ~ '^[A-Z]{2}$');

COMMENT ON COLUMN nzi_console.clients.latitude IS 'CLIENT-04: from the registered postcode and country by the geocoder, best effort; null when not located.';
COMMENT ON COLUMN nzi_console.client_sites.country IS 'CLIENT-11: ISO 3166-1 alpha-2; with the postcode, what the site is geocoded from.';

COMMIT;
