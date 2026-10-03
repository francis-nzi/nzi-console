// Where a client and its sites are (CLIENT-04, CLIENT-11; ruled `CLIENT-round1-RULINGS.md` PR 3).
//
// - **A postcode and a country only** are sent to the geocoder (ruling 2a) — never an address line, a name or an id.
// - **Behind its own switch, off by default** (`NZI_SITE_GEOCODING_ENABLED=true` to turn on). Off, nothing is looked up
//   and coordinates stay empty, with the screen saying geocoding is not enabled. There is **no stub**: the LCA tools'
//   staging stub invents coordinates from a hash, and those are never stored against a client or a site.
// - **Best effort and non-blocking**: the save has already committed when the lookup runs; a failure, a miss or a
//   timeout leaves the coordinates empty and is reported back, retryable — never an error on the save.
// - **Against the version it was made for**: a record edited meanwhile refuses the coordinates as a conflict, so a
//   result for an old postcode is never stored against a new one.
import { countryCodeFor } from "./v7Countries";
import { isIsoCountryCode, type CommandContext, type CommandInputMap, type GeocodePrecision, type GeocodeSource } from "@nzi/contracts";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";
import { runPostgresCommand } from "./postgresCommands";
import { setSiteLocation } from "./siteLifecycle";
import { VersionConflictError } from "./errors";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
export const GEOCODE_TIMEOUT_MS = 8_000;

export type SiteGeocodeConfig = { enabled: boolean; fetchImpl?: typeof fetch; userAgent?: string };
export type PostcodePoint = { latitude: number; longitude: number; source: GeocodeSource; precision: GeocodePrecision };
export type GeocodeOutcome =
  | { state: "located"; point: PostcodePoint }
  | { state: "disabled" }          // the switch is off
  | { state: "no-address" }        // no postcode, or no country it can be read as
  | { state: "not-found" }         // the geocoder knows no such postcode in that country
  | { state: "failed" };           // unreachable, refused, rate-limited or too slow — retryable

/** The switch: geocoding happens only when it is explicitly on. */
export const geocodingConfig = (env: Record<string, string | undefined> = process.env): SiteGeocodeConfig => ({ enabled: env.NZI_SITE_GEOCODING_ENABLED === "true" });

/** A postcode and a country → one point, at postcode precision. Nothing else is sent. */
export async function geocodePostcode(postcode: string | null, country: string | null, config: SiteGeocodeConfig): Promise<GeocodeOutcome> {
  if (!config.enabled) return { state: "disabled" };
  const code = country ? (isIsoCountryCode(country) ? country : countryCodeFor(country)) : null;
  const pc = postcode?.trim();
  if (!pc || !code || !isIsoCountryCode(code)) return { state: "no-address" };
  const url = `${NOMINATIM_URL}?format=json&limit=1&postalcode=${encodeURIComponent(pc)}&countrycodes=${code.toLowerCase()}`;
  try {
    const response = await (config.fetchImpl ?? fetch)(url, {
      headers: { "User-Agent": config.userAgent ?? "nzi-console/1.0 (site geolocation; +https://nzi-pro-api-prod.onrender.com)", Accept: "application/json" },
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
    if (!response.ok) return { state: "failed" };
    const [first] = (await response.json()) as Array<{ lat?: string; lon?: string }>;
    const latitude = Number(first?.lat), longitude = Number(first?.lon);
    if (!first || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return { state: "not-found" };
    return { state: "located", point: { latitude, longitude, source: "nominatim", precision: "postcode" } };
  } catch {
    return { state: "failed" };
  }
}

/** CLIENT-04 — the client's coordinates, from its registered postcode and country; kept out of the audit with them. */
export function setClientLocation(pool: PoolLike, input: CommandInputMap["client.location.set"], context: CommandContext) {
  return runPostgresCommand(pool, "client.location.set", input, context, async (db) => {
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.clients SET latitude=$4, longitude=$5, geocode_source=$6, geocode_precision=$7, version=version+1, updated_at=now()
        WHERE organisation_id=$1 AND client_id=$2 AND version=$3 RETURNING version`,
      [context.organisationId, input.clientId, input.expectedVersion, input.latitude, input.longitude, input.source, input.precision]);
    if (!saved) throw new VersionConflictError();
    return { data: { clientId: input.clientId, version: saved.version, located: true, source: input.source, precision: input.precision }, entityType: "client", entityId: input.clientId, topic: "client.located" };
  });
}

/** A follow-on command's context: its own idempotency key, derived from the save's, so a retried save retries this too. */
const followOn = (context: CommandContext, suffix: string): CommandContext => ({ ...context, idempotencyKey: `${context.idempotencyKey}:${suffix}` });

/**
 * After a site is saved: locate it if it has a postcode and a country and no coordinates. Returns what happened, for the
 * screen; never throws for the lookup's sake.
 */
export async function locateSite(pool: PoolLike, siteId: string, context: CommandContext, config: SiteGeocodeConfig): Promise<GeocodeOutcome | { state: "already" } | { state: "stale" }> {
  if (!config.enabled) return { state: "disabled" };
  const site = await withTenantRead(pool, context.organisationId, async (db: Queryable) => (await db.query<{ version: number; postcode: string | null; country: string | null; latitude: string | null }>(
    `SELECT version, postcode, country, latitude::text FROM nzi_console.client_sites WHERE site_id = $1 AND archived = false`, [siteId])).rows[0]);
  if (!site) return { state: "no-address" };
  if (site.latitude !== null) return { state: "already" };
  const outcome = await geocodePostcode(site.postcode, site.country, config);
  if (outcome.state !== "located") return outcome;
  try {
    await setSiteLocation(pool, { siteId, expectedVersion: site.version, ...outcome.point }, followOn(context, `locate-${site.version}`));
    return outcome;
  } catch (error) {
    if (error instanceof VersionConflictError) return { state: "stale" };
    throw error;
  }
}

/** After a client is saved: locate it from its registered postcode and country, as `locateSite`. */
export async function locateClient(pool: PoolLike, clientId: string, context: CommandContext, config: SiteGeocodeConfig): Promise<GeocodeOutcome | { state: "already" } | { state: "stale" }> {
  if (!config.enabled) return { state: "disabled" };
  const client = await withTenantRead(pool, context.organisationId, async (db: Queryable) => (await db.query<{ version: number; registered_postcode: string | null; registered_country: string | null; latitude: string | null }>(
    `SELECT version, registered_postcode, registered_country, latitude::text FROM nzi_console.clients WHERE client_id = $1`, [clientId])).rows[0]);
  if (!client) return { state: "no-address" };
  if (client.latitude !== null) return { state: "already" };
  const outcome = await geocodePostcode(client.registered_postcode, client.registered_country, config);
  if (outcome.state !== "located") return outcome;
  try {
    await setClientLocation(pool, { clientId, expectedVersion: client.version, ...outcome.point }, followOn(context, `locate-${client.version}`));
    return outcome;
  } catch (error) {
    if (error instanceof VersionConflictError) return { state: "stale" };
    throw error;
  }
}
