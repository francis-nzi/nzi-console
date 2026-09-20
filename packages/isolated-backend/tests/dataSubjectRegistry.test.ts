import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  CommandValidationError, decideSubjectReview, listOpenSubjectReviews, runSubjectLinker,
} from "../src/index";

/**
 * The subject registry, end to end (NZC-116).
 *
 * The population mirrors the one the linkage probe found: mostly singletons, one person across
 * tables, a shared mailbox, a repeated name, a row with no address — plus the history-only case,
 * which the probe could not exercise because `trainees` was empty. Two organisations, because the
 * review queue crosses tenants on purpose and everything else must not.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const OTHER_ORG = "org-b";
const CLIENT = "client-a";
const ACTOR = "admin-a";

const context = (key: string, organisationId = ORG) => ({
  organisationId, actorId: ACTOR, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole("admin", organisationId, ACTOR),
});

describe("the subject registry (NZC-116)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  const contact = (org: string, id: string, name: string, email: string) => db.query(
    `INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,email,created_by,updated_by)
     VALUES ($1,$2,$3,$4,$5,'seed','seed')`, [org, id, CLIENT, name, email]);

  const trainee = (org: string, id: string, name: string, email: string) => db.query(
    `INSERT INTO nzi_console.trainees (organisation_id,trainee_id,full_name,personal_email,created_by)
     VALUES ($1,$2,$3,$4,'seed')`, [org, id, name, email]);

  before(async () => {
    database = (await createDisposableDatabase("subjects"))!;
    pool = database.pool;
    db = await database.admin();
    for (const org of [ORG, OTHER_ORG]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
      await db.query(
        `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,email,display_name)
         VALUES ($1,$2,'admin','active','admin@firm.test','An Admin')`, [org, ACTOR]);
      await db.query(
        `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
        [org, CLIENT]);
    }

    // One person across two tables, with casing and padding differing.
    await trainee(ORG, "t-1", "Ada Lovelace", "ada@example.test");
    await contact(ORG, "c-1", "Ada Lovelace", " Ada@Example.test ");
    // A shared mailbox behind two people.
    await contact(ORG, "c-2", "Reception One", "info@example.test");
    await contact(ORG, "c-3", "Reception Two", "info@example.test");
    // One name, two addresses.
    await trainee(ORG, "t-2", "Grace Hopper", "grace@home.test");
    await contact(ORG, "c-4", "Grace Hopper", "grace@work.test");
    // A row with no address at all.
    await contact(ORG, "c-6", "No Address", "");
    // The other tenant has its own person, on the same address as nobody here.
    await contact(OTHER_ORG, "c-x", "Somebody Else", "else@example.test");
  });

  after(async () => { await db?.end(); await database?.end(); });

  const linksFor = async (org: string) => (await db.query<{ source_table: string; source_id: string; subject_id: string; link_method: string }>(
    `SELECT source_table, source_id, subject_id, link_method FROM nzi_console.data_subject_links
      WHERE organisation_id=$1 ORDER BY source_table, source_id`, [org])).rows;

  it("links one person across tables, and asks about everything else", async () => {
    const outcome = await runSubjectLinker(db, ORG, ACTOR);
    const links = await linksFor(ORG);

    // Ada is one subject across two tables despite the casing difference.
    const ada = links.filter((link) => ["t-1", "c-1"].includes(link.source_id));
    assert.equal(ada.length, 2);
    assert.equal(new Set(ada.map((link) => link.subject_id)).size, 1, "one subject, two rows");
    assert.ok(ada.every((link) => link.link_method === "deterministic-email"));

    // The shared mailbox linked nothing and asked instead.
    assert.ok(!links.some((link) => ["c-2", "c-3"].includes(link.source_id)), "a mailbox is not a person");
    assert.ok(outcome.reviewsRaised >= 3, `expected questions, saw ${outcome.reviewsRaised}`);
  });

  it("gives the address-less row a subject immediately, so it is erasable at all", async () => {
    const links = await linksFor(ORG);
    const orphan = links.find((link) => link.source_id === "c-6");
    assert.ok(orphan, "a person with no address still has a subject");
    assert.equal(orphan!.link_method, "unlinked-no-key");
    // And it is raised, so a human may merge it later.
    const reviews = await db.query<{ reason: string }>(
      `SELECT reason FROM nzi_console.data_subject_reviews WHERE organisation_id=$1`, [ORG]);
    assert.ok(reviews.rows.some((row) => row.reason === "no-key"));
  });

  it("stores no personal data of its own", async () => {
    // The property the whole design rests on: the registry must not become one more place to erase
    // from. Serialised and searched, so a column added later cannot quietly start holding a name.
    const dump = await db.query(
      `SELECT to_jsonb(s.*) AS subject FROM nzi_console.data_subjects s WHERE organisation_id=$1`, [ORG]);
    const serialised = JSON.stringify(dump.rows).toLowerCase();
    for (const personal of ["ada", "lovelace", "example.test", "grace", "hopper", "info@"]) {
      assert.ok(!serialised.includes(personal), `the registry must not hold "${personal}"`);
    }
    const links = JSON.stringify(await linksFor(ORG)).toLowerCase();
    for (const personal of ["ada@", "lovelace", "grace"]) {
      assert.ok(!links.includes(personal), `links must not hold "${personal}"`);
    }
  });

  it("re-running changes nothing", async () => {
    const before = await linksFor(ORG);
    const reviewsBefore = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.data_subject_reviews WHERE organisation_id=$1`, [ORG]);

    const second = await runSubjectLinker(db, ORG, ACTOR);

    assert.equal(second.subjectsCreated, 0, "no new subjects");
    assert.equal(second.rowsLinked, 0, "no rows relinked");
    assert.equal(second.reviewsRaised, 0, "no question asked twice");
    assert.ok(second.reviewsSkipped > 0, "and it recognised the ones it had already asked");
    assert.deepEqual(await linksFor(ORG), before);
    const reviewsAfter = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.data_subject_reviews WHERE organisation_id=$1`, [ORG]);
    assert.equal(reviewsAfter.rows[0]!.count, reviewsBefore.rows[0]!.count);
  });

  it("keeps one tenant's people out of another's", async () => {
    await runSubjectLinker(db, OTHER_ORG, ACTOR);
    const theirs = await linksFor(OTHER_ORG);
    assert.equal(theirs.length, 2, "their contact and their admin membership");
    assert.ok(theirs.every((link) => link.source_id !== "c-1"));
    const ours = await linksFor(ORG);
    assert.ok(ours.every((link) => link.source_id !== "c-x"));
  });

  it("shows open questions across organisations, carrying no names", async () => {
    // The one tenant-crossing read, and the reason it is a function: its return list is the whole
    // contract — pointers, reasons and counts.
    const open = await listOpenSubjectReviews(db);
    assert.ok(open.some((review) => review.organisationId === ORG), "this tenant has questions");
    assert.ok(open.every((review) => review.memberCount >= 1));
    const serialised = JSON.stringify(open).toLowerCase();
    for (const personal of ["ada", "grace", "info@", "example.test"]) {
      assert.ok(!serialised.includes(personal), `the queue must not carry "${personal}"`);
    }
  });

  it("records a ruling with its basis, and joins the people it says are one", async () => {
    const open = await listOpenSubjectReviews(db);
    const nameQuestion = open.find((review) => review.reason === "name-suggestion" && review.organisationId === ORG)!;
    assert.ok(nameQuestion, "the repeated name is a question");

    await decideSubjectReview(pool, {
      reviewId: nameQuestion.reviewId, decision: "linked",
      basis: "Confirmed with the client: one person, work and personal addresses.",
    }, context("d-1"));

    const links = await linksFor(ORG);
    const grace = links.filter((link) => ["t-2", "c-4"].includes(link.source_id));
    assert.equal(new Set(grace.map((link) => link.subject_id)).size, 1, "now one person");

    // `link_method` describes how *that row* came to be attached, not how the pairing was settled.
    // The row that moved attached by review; the row that was already there attached by
    // deterministic match, and that remains true — overwriting it would erase a fact rather than
    // record one. Why the two are one person is the review's business, and the review says so with
    // its basis, which is what the next assertions check.
    assert.ok(grace.some((link) => link.link_method === "reviewed"), "the row that moved says a human moved it");

    const stored = await db.query<{ status: string; decision: string; basis: string; decided_by: string }>(
      `SELECT status, decision, basis, decided_by FROM nzi_console.data_subject_reviews WHERE review_id=$1`,
      [nameQuestion.reviewId]);
    assert.equal(stored.rows[0]!.status, "decided");
    assert.equal(stored.rows[0]!.decision, "linked");
    assert.match(stored.rows[0]!.basis, /one person/);
    assert.equal(stored.rows[0]!.decided_by, ACTOR);
  });

  it("remembers that two people are different, so the question is not asked again", async () => {
    const open = await listOpenSubjectReviews(db);
    const mailbox = open.find((review) => review.reason === "shared-key")!;
    await decideSubjectReview(pool, {
      reviewId: mailbox.reviewId, decision: "distinct",
      basis: "A shared reception mailbox; the two contacts are different people.",
    }, context("d-2"));

    const stillOpen = await listOpenSubjectReviews(db);
    assert.ok(!stillOpen.some((review) => review.reviewId === mailbox.reviewId));
    // And the linker does not raise it again.
    const after = await runSubjectLinker(db, ORG, ACTOR);
    assert.equal(after.reviewsRaised, 0);
  });

  it("refuses a decision nobody could explain later", async () => {
    const open = await listOpenSubjectReviews(db);
    const question = open.find((review) => review.organisationId === ORG && review.reason === "no-key");
    assert.ok(question, "the address-less row's question is still open");
    await assert.rejects(() => decideSubjectReview(pool, {
      reviewId: question!.reviewId, decision: "linked", basis: "   ",
    }, context("d-3")), CommandValidationError);
  });

  it("refuses to answer the same question twice", async () => {
    const decided = await db.query<{ review_id: string }>(
      `SELECT review_id FROM nzi_console.data_subject_reviews
        WHERE organisation_id=$1 AND status='decided' AND reason='shared-key'`, [ORG]);
    assert.equal(decided.rows.length, 1, "the mailbox question, answered above");
    await assert.rejects(() => decideSubjectReview(pool, {
      reviewId: decided.rows[0]!.review_id, decision: "distinct", basis: "Changed my mind.",
    }, context("d-4")), CommandValidationError);
  });

  it("cannot be deleted, only superseded", async () => {
    const app = new pg.Client({ connectionString: database.url.replace(/\/\/[^@]*@/, "//nzi_console_app@") });
    await assert.rejects(async () => {
      await app.connect();
      await app.query(`DELETE FROM nzi_console.data_subject_links`);
    });
    await app.end().catch(() => {});
  });
});
