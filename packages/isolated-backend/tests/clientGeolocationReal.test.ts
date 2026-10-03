import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { VersionConflictError } from "../src/errors";
import { locateClient, locateSite } from "../src/geolocation";
import { createClient, updateClient } from "../src/postgresCommands";
import { createClientSite, editSite, setSiteLocation } from "../src/siteLifecycle";

/**
 * Client and site geolocation (CLIENT-04, CLIENT-11; 0154) against a real database: a site's structured address stored,
 * and kept out of the audit; coordinates cleared only when the postcode or country changes (the v7 import's are kept
 * otherwise); located through the geocoder against the version it looked up, so a stale result is refused; nothing
 * looked up or stored while the switch is off; the client located from its registered postcode and country; and 0154's
 * CHECKs.
 */
const ORG = "geo-org";

describe("client and site geolocation, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (actor = "ada", role: StaffRole = "admin"): CommandContext => {
    counter += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `geo-${counter}`, correlationId: `corr-geo-${counter}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const lookups: string[] = [];
  const geocoder = (lat: string, lon: string) => ({ enabled: true, fetchImpl: (async (url: string | URL) => { lookups.push(String(url)); return new Response(JSON.stringify([{ lat, lon }])); }) as typeof fetch });
  const site = async (siteId: string) => (await q(`SELECT address_lines_json, postcode, country, latitude::float AS lat, longitude::float AS lon, geocode_source, geocode_precision, version FROM nzi_console.client_sites WHERE site_id = $1`, [siteId]))[0];
  let clientId = "";

  before(async () => {
    database = (await createDisposableDatabase("clientgeolocation"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
    clientId = (await createClient(database.pool, { name: "Acme", status: "active", sector: "Manufacturing", location: "Leeds, UK", owner: "Ada Admin",
      registeredPostcode: "LS1 4AP", registeredCountry: "GB" } as never, context())).data.clientId;
  });
  after(async () => { await database?.end(); });

  it("stores a site's address lines, postcode and country — and keeps them out of the audit and the outbox", async () => {
    const made = await createClientSite(database.pool, { clientId, name: "Leeds depot", inServiceFrom: null, addressLines: [" 1 High Street ", "", "Leeds"], postcode: " ls1  4ap ", country: "GB" }, context());
    assert.deepEqual(await site(made.data.siteId), { address_lines_json: ["1 High Street", "Leeds"], postcode: "LS1 4AP", country: "GB", lat: null, lon: null, geocode_source: null, geocode_precision: null, version: 1 });
    const trail = JSON.stringify(await q(`SELECT after_json, before_json FROM nzi_console.audit_events WHERE entity_id = $1`, [made.data.siteId]))
      + JSON.stringify(await q(`SELECT payload_json FROM nzi_console.transactional_outbox WHERE organisation_id = $1`, [ORG]));
    for (const part of ["High Street", "LS1 4AP", "ls1"]) assert.ok(!trail.includes(part), `the address is not in the audit or outbox (${part})`);
  });

  it("locates a site through the geocoder (postcode and country only), against the version it looked up", async () => {
    const siteId = (await q(`SELECT site_id FROM nzi_console.client_sites WHERE name = 'Leeds depot'`))[0].site_id;
    lookups.length = 0;
    assert.equal((await locateSite(database.pool, siteId, context(), geocoder("53.7997", "-1.5492"))).state, "located");
    const located = await site(siteId);
    assert.deepEqual([located.lat, located.lon, located.geocode_source, located.geocode_precision, located.version], [53.7997, -1.5492, "nominatim", "postcode", 2]);
    assert.equal(lookups.length, 1);
    assert.ok(!lookups[0]!.includes("High") && lookups[0]!.includes("postalcode=LS1%204AP"), "only the postcode and country are sent");
    assert.equal((await locateSite(database.pool, siteId, context(), geocoder("0", "0"))).state, "already", "a located site is not looked up again");
    await assert.rejects(setSiteLocation(database.pool, { siteId, expectedVersion: 1, latitude: 1, longitude: 1, source: "nominatim", precision: "postcode" }, context()),
      (error: unknown) => error instanceof VersionConflictError, "a result for an older version is refused");
  });

  it("keeps coordinates through an edit that leaves the postcode and country alone — the v7 import's included — and clears them when either changes", async () => {
    // A site as the v7 import leaves it: coordinates, no source.
    const imported = (await createClientSite(database.pool, { clientId, name: "Imported site", inServiceFrom: null, postcode: "M1 1AA", country: "GB" }, context())).data.siteId;
    await q(`UPDATE nzi_console.client_sites SET latitude = 53.48, longitude = -2.24 WHERE site_id = $1`, [imported]);
    await editSite(database.pool, { siteId: imported, name: "Imported site (Manchester)", inServiceFrom: null, expectedVersion: 1 }, context());
    let row = await site(imported);
    assert.deepEqual([row.lat, row.lon, row.postcode, row.country], [53.48, -2.24, "M1 1AA", "GB"], "an omitted address keeps it, and its coordinates");
    await editSite(database.pool, { siteId: imported, name: "Imported site (Manchester)", inServiceFrom: null, expectedVersion: 2, addressLines: ["Piccadilly"], postcode: "M1 1AA", country: "GB" }, context());
    assert.equal((await site(imported)).lat, 53.48, "a new address line with the same postcode and country keeps the coordinates");
    const moved = await editSite(database.pool, { siteId: imported, name: "Imported site (Manchester)", inServiceFrom: null, expectedVersion: 3, postcode: "M2 2BB" }, context());
    assert.equal(moved.data.coordinatesCleared, true);
    row = await site(imported);
    assert.deepEqual([row.lat, row.lon, row.geocode_source, row.postcode, row.country], [null, null, null, "M2 2BB", "GB"], "a new postcode clears what belonged to the old one");
  });

  it("looks nothing up and stores nothing while the switch is off", async () => {
    const siteId = (await createClientSite(database.pool, { clientId, name: "Unlocated", inServiceFrom: null, postcode: "EH1 1AA", country: "GB" }, context())).data.siteId;
    let called = false;
    const off = { enabled: false, fetchImpl: (async () => { called = true; return new Response("[]"); }) as typeof fetch };
    assert.equal((await locateSite(database.pool, siteId, context(), off)).state, "disabled");
    assert.equal(called, false);
    assert.equal((await site(siteId)).lat, null);
  });

  it("locates the client from its registered postcode and country, and clears that when the registered address moves", async () => {
    assert.equal((await locateClient(database.pool, clientId, context(), geocoder("53.80", "-1.55"))).state, "located");
    const client = async () => (await q(`SELECT latitude::float AS lat, geocode_source, version, name, status, sector, location, owner_name FROM nzi_console.clients WHERE client_id = $1`, [clientId]))[0];
    let row = await client();
    assert.deepEqual([row.lat, row.geocode_source], [53.8, "nominatim"]);
    const save = (registeredPostcode: string) => updateClient(database.pool, { clientId, expectedVersion: row.version, name: row.name, status: row.status, sector: row.sector,
      location: row.location, owner: row.owner_name, registeredPostcode, registeredCountry: "GB" } as never, context());
    await save("LS1 4AP");
    row = await client();
    assert.equal(row.lat, 53.8, "a save that leaves the registered postcode alone keeps the coordinates");
    await save("LS2 9JT");
    row = await client();
    assert.deepEqual([row.lat, row.geocode_source], [null, null], "a new registered postcode clears them");
  });

  it("holds 0154's CHECKs: both coordinates or neither, in range, sourced; a site country is an ISO code", async () => {
    const set = (sql: string) => q(`UPDATE nzi_console.clients SET ${sql} WHERE client_id = $1`, [clientId]);
    await assert.rejects(set(`latitude = 10, longitude = NULL, geocode_source = 'nominatim', geocode_precision = 'postcode'`), /clients_coordinates_paired/);
    await assert.rejects(set(`latitude = 10, longitude = 10, geocode_source = NULL, geocode_precision = NULL`), /clients_coordinates_sourced/);
    await assert.rejects(set(`latitude = 95, longitude = 10, geocode_source = 'nominatim', geocode_precision = 'postcode'`), /latitude_check/);
    await assert.rejects(set(`latitude = 10, longitude = 10, geocode_source = 'stub', geocode_precision = 'postcode'`), /geocode_source_check/);
    await assert.rejects(q(`UPDATE nzi_console.client_sites SET country = 'United Kingdom' WHERE client_id = $1`, [clientId]), /country_check/);
  });
});
