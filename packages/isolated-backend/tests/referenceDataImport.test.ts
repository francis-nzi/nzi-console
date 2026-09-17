import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  importReferenceValues, importTeamMembers, listReferenceCategories,
  readReferenceValues, readTeamMembers,
} from "../src/referenceData";
import { withTenantRead } from "../src/postgres";

/**
 * The reference-data import, against a real Postgres (NZC-089).
 *
 * Held to §14: run twice, and once over a dirtied database. The lists come from the live system's
 * admin export, so a second import is not hypothetical — a corrected export, an edited list, a
 * later version of this loader. Every one of those arrives as state the first run left behind,
 * which is where replay bugs live and where a fresh-database run cannot reach.
 *
 * Skips without a throwaway database; CI always provides one.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const DATABASE_URL = process.env.NZI_TEST_DATABASE_URL;
const ORG = "ci-reference-org";
const ACTOR = "ci-reference-staff";

function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(ci|test|tmp|throwaway)([_-]|$)/i.test(name)) {
    throw new Error(`Refusing to run: '${name}' is not named as a disposable database.`);
  }
  if (process.env.NZI_ISOLATED_DATABASE_URL === url) {
    throw new Error("Refusing to run: NZI_TEST_DATABASE_URL is the same database as NZI_ISOLATED_DATABASE_URL.");
  }
}

/** Stands in for the live export until Francis's real one lands. */
const INDUSTRIES = [
  { sourceRef: "live-42", label: "Manufacturing — food & drink", code: "10.71" },
  { sourceRef: "live-77", label: "Logistics & haulage", code: "49.41" },
  { sourceRef: "live-91", label: "Professional services", code: "70.22" },
];
const REFERRALS = [
  { sourceRef: "ref-1", label: "Existing client" },
  { sourceRef: "ref-2", label: "Website enquiry" },
];
const TEAM = [
  { userId: "m.osei", displayName: "Maya Osei", email: "M.Osei@example.invalid" },
  { userId: "a.shaw", displayName: "Aisha Shaw", email: "a.shaw@example.invalid" },
];

describe("the reference-data import", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let pool: pg.Pool;

  before(async () => {
    assertDisposable(DATABASE_URL!);
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS nzi_console CASCADE`);
    for (const role of ["nzi_console_app", "nzi_console_worker", "nzi_console_auth"]) {
      await admin.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }
    for (const filename of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, filename), "utf8"));
      if (filename.startsWith("0001_")) {
        await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1,$2)`, [ORG, "CI"]);
      }
    }
    for (const member of [...TEAM, { userId: ACTOR, displayName: "", email: null }]) {
      await admin.query(
        `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status)
         VALUES ($1,$2,'consultant','active') ON CONFLICT DO NOTHING`, [ORG, member.userId]);
    }
    await admin.end();
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, application_name: "nzi-reference-ci" });
  });

  after(async () => { await pool?.end(); });

  const industries = () => readReferenceValues(pool, ORG, "industries");
  const importIndustries = (values = INDUSTRIES, archiveMissing = false) =>
    importReferenceValues(pool, { organisationId: ORG, actorId: ACTOR, categoryKey: "industries", values, archiveMissing });

  it("declares the categories the first slice needs", async () => {
    const categories = await withTenantRead(pool, ORG, listReferenceCategories);
    const byKey = new Map(categories.map((c) => [c.categoryKey, c]));
    assert.equal(byKey.get("industries")?.scope, "shared");
    assert.equal(byKey.get("industries")?.carriesCode, true, "an industry carries its SIC");
    assert.equal(byKey.get("referrals")?.scope, "organisation", "how a client found NZI is firm config");
    assert.equal(byKey.get("referrals")?.carriesCode, false);
  });

  it("loads an exported list", async () => {
    const outcome = await importIndustries();
    assert.equal(outcome.created, 3);
    assert.equal(outcome.updated, 0);
    const values = await industries();
    assert.equal(values.length, 3);
    assert.equal(values.find((v) => v.sourceRef === "live-42")?.code, "10.71", "the SIC came with it");
    assert.ok(values.every((v) => v.source === "import"));
  });

  it("re-runs without creating or changing anything", async () => {
    // §14. A version that moves on a re-import is not idempotence — it is the same write done
    // twice, and it would make every import look like an edit in the audit trail.
    const before = await industries();
    const outcome = await importIndustries();
    assert.equal(outcome.created, 0);
    assert.equal(outcome.updated, 0);
    assert.equal(outcome.unchanged, 3);
    const after = await industries();
    assert.deepEqual(after.map((v) => v.version), before.map((v) => v.version), "no version churn");
    assert.equal(after.length, 3, "counted, not just checked for presence");
  });

  it("converges over a dirtied database", async () => {
    // §14's second half. The dirt is what an earlier loader or a person would leave: a value
    // added by hand with no source_ref, one archived, and one renamed in the export.
    await importReferenceValues(pool, {
      organisationId: ORG, actorId: ACTOR, categoryKey: "industries",
      values: [{ label: "Professional services" }], // no sourceRef — matches on label
    });
    await pool.query(
      `UPDATE nzi_console.reference_values SET active=false WHERE category_key='industries' AND source_ref='live-77'`);

    const renamed = INDUSTRIES.map((v) => v.sourceRef === "live-42" ? { ...v, label: "Manufacturing — food and drink" } : v);
    const outcome = await importIndustries(renamed);

    const values = await industries();
    assert.equal(values.length, 3, "no duplicate of the hand-added or archived value");
    assert.equal(outcome.reinstated, 1, "the archived value came back rather than being inserted again");
    assert.equal(values.find((v) => v.sourceRef === "live-42")?.label, "Manufacturing — food and drink",
      "a rename is an update, so records pointing at it stay pointed at it");
  });

  it("archives what the export dropped, but only when told to", async () => {
    // Off by default: a partial export would otherwise archive the firm's entire list, and the
    // destructive reading of an ambiguous file must never be the default.
    const quiet = await importIndustries(INDUSTRIES.slice(0, 2));
    assert.equal(quiet.archived, 0, "a short export archives nothing unless asked");
    assert.equal((await industries()).length, 3);

    const authoritative = await importIndustries(INDUSTRIES.slice(0, 2), true);
    assert.equal(authoritative.archived, 1);
    const live = await industries();
    assert.equal(live.length, 2, "archived, and no longer offered");
    assert.equal((await readReferenceValues(pool, ORG, "industries", { includeArchived: true })).length, 3,
      "still there — archive is deactivation, never deletion");
  });

  it("keeps referrals separate from industries", async () => {
    await importReferenceValues(pool, { organisationId: ORG, actorId: ACTOR, categoryKey: "referrals", values: REFERRALS });
    const referrals = await readReferenceValues(pool, ORG, "referrals");
    assert.equal(referrals.length, 2);
    assert.ok(referrals.every((v) => v.code === null), "a category that carries no code stores none");
  });

  it("refuses a category it does not know", async () => {
    await assert.rejects(
      () => importReferenceValues(pool, { organisationId: ORG, actorId: ACTOR, categoryKey: "invented", values: [] }),
      /Unknown reference category/);
  });
});

describe("the team roster", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let pool: pg.Pool;
  before(() => { pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2, application_name: "nzi-team-ci" }); });
  after(async () => { await pool?.end(); });

  it("gives the smart-search real names, and says when it cannot", async () => {
    const before = await readTeamMembers(pool, ORG);
    const unnamed = before.find((m) => m.userId === ACTOR);
    assert.ok(unnamed, "the actor is on the roster");
    assert.equal(unnamed.named, false, "no name yet");
    assert.equal(unnamed.displayName, ACTOR, "falls back to the handle rather than inventing a name");

    const outcome = await importTeamMembers(pool, { organisationId: ORG, actorId: ACTOR, members: TEAM });
    assert.equal(outcome.updated, 2);

    const after = await readTeamMembers(pool, ORG);
    const maya = after.find((m) => m.userId === "m.osei")!;
    assert.equal(maya.displayName, "Maya Osei");
    assert.equal(maya.named, true);
    assert.equal(maya.email, "m.osei@example.invalid", "normalised, so a search is case-insensitive");
  });

  it("re-runs without churn", async () => {
    const outcome = await importTeamMembers(pool, { organisationId: ORG, actorId: ACTOR, members: TEAM });
    assert.equal(outcome.updated, 0);
    assert.equal(outcome.unchanged, 2);
  });

  it("reports a person it has no membership for, rather than creating one", async () => {
    // Creating access is not an import's job: a reference-data file must never be a permission grant.
    const outcome = await importTeamMembers(pool, {
      organisationId: ORG, actorId: ACTOR,
      members: [...TEAM, { userId: "not.a.member", displayName: "Someone Else" }],
    });
    assert.deepEqual(outcome.unknown, ["not.a.member"]);
    const roster = await readTeamMembers(pool, ORG);
    assert.ok(!roster.some((m) => m.userId === "not.a.member"), "no membership was created");
  });

  it("never changes a role or a status", async () => {
    const before = await pool.query<{ role_id: string; status: string }>(
      `SELECT role_id, status FROM nzi_console.memberships WHERE organisation_id=$1 AND user_id='m.osei'`, [ORG]);
    await importTeamMembers(pool, {
      organisationId: ORG, actorId: ACTOR,
      members: [{ userId: "m.osei", displayName: "Maya Osei", email: "m.osei@example.invalid" }],
    });
    const after = await pool.query<{ role_id: string; status: string }>(
      `SELECT role_id, status FROM nzi_console.memberships WHERE organisation_id=$1 AND user_id='m.osei'`, [ORG]);
    assert.deepEqual(after.rows[0], before.rows[0], "names and emails only");
  });
});
