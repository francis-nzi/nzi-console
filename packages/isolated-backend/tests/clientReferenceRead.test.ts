import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { listClients } from "../src/readModels";
import { importReferenceValues } from "../src/referenceData";
import { withTenantRead } from "../src/postgres";

/**
 * Reading a client's references against a real database (NZC-090).
 *
 * The fixture is the **actual** dry-run population, not an invented one: the six sectors, the
 * referral and the placeholder owners the first run reported as unmatched on the demo org. Tests
 * written against imagined data would have agreed with themselves; these agree with what is in the
 * database.
 *
 * Two cases are here because they are ordinary, not because they are edges:
 *
 * - **A never-matched legacy string.** Five of the six sectors are naming variants nobody curated
 *   ("Food & beverage", "Transport & logistics") and one is junk from a test client. All of them
 *   must render exactly as the firm typed them.
 * - **An archived value.** Archive is deactivation, so a client keeps pointing at a value that has
 *   left the search, and its label must still resolve — otherwise archiving an industry would
 *   silently blank every client that had chosen it. The resolution deliberately does not filter on
 *   `active`, and that is asserted here rather than left as a property of a missing WHERE clause.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const DATABASE_URL = process.env.NZI_TEST_DATABASE_URL;
const ORG = "ci-refread-org";
const ACTOR = "ci-refread-staff";

function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(ci|test|tmp|throwaway)([_-]|$)/i.test(name)) throw new Error(`Refusing: '${name}' is not disposable.`);
  if (process.env.NZI_ISOLATED_DATABASE_URL === url) throw new Error("Refusing: that is the isolated database.");
}

/** The demo org's real unmatched values, as the dry run reported them. */
const UNMATCHED = [
  ["c-bushy", "Bushy Tails Ltd", "Consumer goods"],
  ["c-cedar", "Cedar & Crane", "Professional services"],
  ["c-verdant", "Verdant Foods", "Food & beverage"],
  ["c-quaymed", "Quaymed Devices", "Medical devices"],
  ["c-harbour", "Harbourline", "Transport & logistics"],
  ["c-whizzy", "Whizzy Whizz", "Sweeties"],
] as const;

describe("a client's references, read from the database", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let pool: pg.Pool;
  let archivedValueId: string;

  before(async () => {
    assertDisposable(DATABASE_URL!);
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS nzi_console CASCADE`);
    for (const role of ["nzi_console_app", "nzi_console_worker", "nzi_console_auth"]) {
      await admin.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }
    for (const filename of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, filename), "utf8"));
      if (filename.startsWith("0001_")) {
        await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1,$2)`, [ORG, "CI"]);
      }
    }
    await admin.query(
      `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name)
       VALUES ($1,'david','consultant','active','David Hawes')`, [ORG]);

    for (const [id, name, sector] of UNMATCHED) {
      await admin.query(
        `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, sector, location, owner_name, client_manager)
         VALUES ($1,$2,$3,'active',$4,'London','A. Shaw','M. Osei')`, [ORG, id, name, sector]);
    }
    // The seventh: a client that did match, whose industry is then archived out of the list.
    await admin.query(
      `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, sector, location, owner_name, owner_user_id)
       VALUES ($1,'c-matched','Matched Ltd','active','Retail','London','David Hawes','david')`, [ORG]);
    await admin.end();

    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3, application_name: "nzi-refread-ci" });
    await importReferenceValues(pool, {
      organisationId: ORG, actorId: ACTOR, categoryKey: "industries",
      values: [{ label: "Retail" }, { label: "Food and Drink" }, { label: "Transport" }, { label: "Business Services" }],
    });

    const retail = (await pool.query<{ value_id: string }>(
      `SELECT value_id FROM nzi_console.reference_values WHERE organisation_id=$1 AND label='Retail'`, [ORG])).rows[0]!;
    archivedValueId = retail.value_id;
    await pool.query(
      `UPDATE nzi_console.clients SET sector_value_id=$2 WHERE organisation_id=$1 AND client_id='c-matched'`,
      [ORG, archivedValueId]);
    // Archived after the client chose it — the ordinary way a value leaves the list.
    await pool.query(
      `UPDATE nzi_console.reference_values SET active=false WHERE organisation_id=$1 AND value_id=$2`,
      [ORG, archivedValueId]);
  });

  after(async () => { await pool?.end(); });

  const clients = () => withTenantRead(pool, ORG, (db) => listClients(db));
  const find = async (id: string) => (await clients()).find((client) => client.id === id)!;

  it("renders every never-matched sector exactly as the firm typed it", async () => {
    for (const [id, , sector] of UNMATCHED) {
      const client = await find(id);
      assert.equal(client.sector, sector, `${id} must still read "${sector}"`);
      assert.equal(client.references.sector.source, "legacy");
      assert.equal(client.references.sector.id, null);
    }
  });

  it("still resolves a value that has been archived out of the list", async () => {
    // Archiving an industry must not blank the clients that chose it. The subselect deliberately
    // does not filter on `active`, and this is what says so.
    const client = await find("c-matched");
    assert.equal(client.sector, "Retail");
    assert.equal(client.references.sector.source, "reference");
    assert.equal(client.references.sector.id, archivedValueId);
  });

  it("prefers the roster's name over the name on the record", async () => {
    const client = await find("c-matched");
    assert.equal(client.owner, "David Hawes");
    assert.equal(client.references.owner.source, "reference");
  });

  it("keeps a placeholder owner as text rather than inventing a person", async () => {
    // "A. Shaw" and "M. Osei" are demo placeholders and match nobody. The backfill refused to
    // guess; the read must not guess either.
    const client = await find("c-bushy");
    assert.equal(client.owner, "A. Shaw");
    assert.equal(client.references.owner.source, "legacy");
    assert.equal(client.references.clientManager.label, "M. Osei");
  });

  it("never shows an id where a person reads a name", async () => {
    // The failure this conversion would be judged by, asserted across every client and field.
    for (const client of await clients()) {
      for (const reference of Object.values(client.references)) {
        assert.doesNotMatch(reference.label, /^(industries|referrals):/, `${client.id} leaked an id`);
      }
      assert.doesNotMatch(client.sector ?? "", /^industries:/);
      assert.doesNotMatch(client.owner ?? "", /:/);
    }
  });
});
