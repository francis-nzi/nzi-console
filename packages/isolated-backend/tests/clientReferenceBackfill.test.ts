import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { backfillClientReferences } from "../src/clientReferenceBackfill";
import { importReferenceValues, importTeamMembers } from "../src/referenceData";

/**
 * Carrying the free-text client fields onto the curated references (NZC-090).
 *
 * The property that matters most is a negative one: **nothing a client already holds is lost or
 * changed**. A value this cannot place stays exactly where it is and is reported, and an owner
 * that disagrees with its name is never re-pointed — that column decides who can see the client.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const DATABASE_URL = process.env.NZI_TEST_DATABASE_URL;
const ORG = "ci-backfill-org";
const ACTOR = "ci-backfill-staff";

function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(ci|test|tmp|throwaway)([_-]|$)/i.test(name)) throw new Error(`Refusing: '${name}' is not disposable.`);
  if (process.env.NZI_ISOLATED_DATABASE_URL === url) throw new Error("Refusing: that is the isolated database.");
}

describe("the client reference backfill", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let pool: pg.Pool;

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
    for (const user of ["maya", "aisha", ACTOR]) {
      await admin.query(
        `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1,$2,'consultant','active')`,
        [ORG, user]);
    }

    // Four clients: one that matches cleanly; one whose industry nobody curated; one whose owner
    // is already set to somebody other than the name it shows; one with nothing to match.
    const clients = [
      ["c-match", "Matcher Ltd", "Manufacturing", "Website", "Maya Osei", "Aisha Shaw", null],
      ["c-unknown", "Unknown Industry Ltd", "Interpretive Dance", "Word of mouth", "Maya Osei", null, null],
      ["c-owned", "Already Owned Ltd", "Manufacturing", null, "Maya Osei", null, "aisha"],
      ["c-empty", "Empty Ltd", null, null, null, null, null],
    ] as const;
    for (const [id, name, sector, referral, owner, manager, ownerUserId] of clients) {
      await admin.query(
        `INSERT INTO nzi_console.clients
           (organisation_id, client_id, name, status, sector, referral, owner_name, client_manager, owner_user_id, location)
         VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,'London')`,
        [ORG, id, name, sector, referral, owner, manager, ownerUserId]);
    }
    await admin.end();

    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3, application_name: "nzi-backfill-ci" });
    await importReferenceValues(pool, { organisationId: ORG, actorId: ACTOR, categoryKey: "industries", values: [{ label: "Manufacturing" }] });
    await importReferenceValues(pool, { organisationId: ORG, actorId: ACTOR, categoryKey: "referrals", values: [{ label: "Website" }] });
    await importTeamMembers(pool, {
      organisationId: ORG, actorId: ACTOR,
      members: [{ userId: "maya", displayName: "Maya Osei" }, { userId: "aisha", displayName: "Aisha Shaw" }],
    });
  });

  after(async () => { await pool?.end(); });

  const row = async (clientId: string) => (await pool.query(
    `SELECT sector, sector_value_id, referral, referral_value_id, owner_name, owner_user_id,
            client_manager, client_manager_user_id
       FROM nzi_console.clients WHERE organisation_id=$1 AND client_id=$2`, [ORG, clientId])).rows[0];

  it("changes nothing on a dry run, and still reports", async () => {
    const outcome = await backfillClientReferences(pool, { organisationId: ORG, actorId: ACTOR, dryRun: true });
    assert.ok(outcome.matched.sector > 0, "it found matches to report");
    assert.equal((await row("c-match")).sector_value_id, null, "and wrote none of them");
  });

  it("places what it can", async () => {
    await backfillClientReferences(pool, { organisationId: ORG, actorId: ACTOR });
    const matched = await row("c-match");
    assert.match(matched.sector_value_id, /^industries:/);
    assert.match(matched.referral_value_id, /^referrals:/);
    assert.equal(matched.client_manager_user_id, "aisha");
    assert.equal(matched.owner_user_id, "maya", "a null owner is filled in from an unambiguous name");
  });

  it("leaves an unmatched value exactly where it is, and names it", async () => {
    // A client's recorded industry is something the firm typed about a real relationship. A script
    // that cannot place it reports it; it does not get to decide the firm was wrong.
    const outcome = await backfillClientReferences(pool, { organisationId: ORG, actorId: ACTOR });
    const unknown = await row("c-unknown");
    assert.equal(unknown.sector, "Interpretive Dance", "the text is untouched");
    assert.equal(unknown.sector_value_id, null, "and no id was invented for it");
    assert.ok(outcome.unmatched.some((u) => u.clientId === "c-unknown" && u.field === "sector" && u.reason === "no match"));
    assert.ok(outcome.unmatched.some((u) => u.clientId === "c-unknown" && u.field === "referral"));
  });

  it("never re-points an owner that is already set", async () => {
    // owner_user_id is what own_clients resolves against, so changing it changes who can see the
    // client. That is a person's decision, audited as such — not a name match's.
    const outcome = await backfillClientReferences(pool, { organisationId: ORG, actorId: ACTOR });
    const owned = await row("c-owned");
    assert.equal(owned.owner_user_id, "aisha", "left as it was, though the name reads Maya Osei");
    assert.ok(outcome.unmatched.some((u) => u.clientId === "c-owned" && u.reason === "owner already set to someone else"),
      "and the disagreement is reported for a person to settle");
  });

  it("re-runs without writing anything", async () => {
    // §14, over state the first run left behind.
    const before = await row("c-match");
    const outcome = await backfillClientReferences(pool, { organisationId: ORG, actorId: ACTOR });
    assert.equal(outcome.matched.sector, 0, "nothing left to match");
    assert.ok(outcome.alreadySet.sector > 0);
    assert.deepEqual(await row("c-match"), before);
  });

  it("counts a blank as blank, not as a failure", async () => {
    const outcome = await backfillClientReferences(pool, { organisationId: ORG, actorId: ACTOR });
    assert.ok(outcome.blank.sector >= 1, "the empty client is blank, not unmatched");
    assert.ok(!outcome.unmatched.some((u) => u.clientId === "c-empty"));
  });
});
