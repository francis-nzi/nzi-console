import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createJob, updateClient, VersionConflictError } from "../src/index";
import { AuthorizationError } from "../src/auth";

/**
 * What the command runner promises, asked of a real database (NZC-099, Tier 1).
 *
 * The existing `postgresCommands` suite asserts 21 refusals against a fake pool, and those
 * assertions are about the decision the code reached. Four of the runner's promises are not
 * decisions at all — they are statements about **what is in the database afterwards**, and a fake
 * that records SQL without executing it cannot observe any of them:
 *
 *   - a refused command leaves **nothing behind** — no row, no audit event, no outbox message;
 *   - a version conflict is decided against the row's **actual** version, not a remembered one;
 *   - an idempotency key replays the first outcome instead of writing twice;
 *   - the write, its audit event and its outbox message land in **one** transaction, or none do.
 *
 * The last is the one worth the most: every refusal test in this repo asserts that an error was
 * thrown, and an error thrown *after* a partial write is indistinguishable from one thrown before
 * it — unless something looks at the rows.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const ADMIN = "admin-a";
const CONSULTANT = "consultant-a";
const COLLEAGUE = "consultant-b";
const VIEWER = "viewer-a";
const OWNED = "client-owned";
const COLLEAGUES = "client-colleague";

const context = (actor: string, role: StaffRole, key: string) => ({
  organisationId: ORG, actorId: actor, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole(role, ORG, actor),
});

/** The minimum a client.update needs; the profile fields are all optional. */
const clientUpdate = (clientId: string, expectedVersion: number, name: string) => ({
  clientId, expectedVersion, name, status: "active" as const,
  sector: "Services", location: "London", owner: "A", contactName: "", contactRole: "", contactEmail: "",
});

describe("a refused command leaves nothing behind", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("commandguarantees"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org A')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    for (const [user, role] of [[ADMIN, "admin"], [CONSULTANT, "consultant"], [COLLEAGUE, "consultant"], [VIEWER, "viewer"]]) {
      await db.query(
        `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,$3,'active')
         ON CONFLICT (organisation_id,user_id) DO UPDATE SET role_id=EXCLUDED.role_id`, [ORG, user, role]);
    }
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,owner_user_id)
       VALUES ($1,$2,'Owned Client','active',$3)`, [ORG, OWNED, CONSULTANT]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,owner_user_id)
       VALUES ($1,$2,'Colleague Client','active',$3)`, [ORG, COLLEAGUES, COLLEAGUE]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  const counts = async () => {
    const one = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0]!.n);
    return {
      audits: await one(`SELECT count(*)::text AS n FROM nzi_console.audit_events`),
      outbox: await one(`SELECT count(*)::text AS n FROM nzi_console.transactional_outbox`),
      idempotency: await one(`SELECT count(*)::text AS n FROM nzi_console.command_idempotency`),
      jobs: await one(`SELECT count(*)::text AS n FROM nzi_console.jobs`),
    };
  };
  const clientVersion = async (clientId: string) =>
    Number((await db.query<{ version: number }>(
      `SELECT version FROM nzi_console.clients WHERE client_id=$1`, [clientId])).rows[0]!.version);

  it("writes no audit, no outbox and no idempotency row when the capability is missing", async () => {
    // "Refuses before anything is written" is the claim the fake suite makes and cannot check.
    // A runner that authorised late would still throw — and would leave an audit event behind
    // describing a command that never happened.
    const before = await counts();
    await assert.rejects(
      () => createJob(pool, {
        clientId: OWNED, family: "crp", title: "Denied", workflowStage: "Setup", owner: "A",
        startDate: "2026-01-01", dueDate: "2026-06-30",
        reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31",
      }, context(VIEWER, "viewer", "denied-1")),
      AuthorizationError);
    assert.deepEqual(await counts(), before, "nothing at all was written");
  });

  it("writes nothing when the input is invalid", async () => {
    const before = await counts();
    await assert.rejects(() => createJob(pool, {
      clientId: OWNED, family: "crp", title: "", workflowStage: "Setup", owner: "A",
      startDate: "2026-01-01", dueDate: "2026-06-30",
      reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31",
    }, context(ADMIN, "admin", "invalid-1")));
    assert.deepEqual(await counts(), before, "a validation failure is not a partial write");
  });

  it("rolls the whole command back when a later statement fails", async () => {
    // Atomicity, which is the promise most easily broken by adding a step. The job insert succeeds
    // and the foreign key on the client manager then refuses, so the failure happens *after* the
    // first write — exactly the case a fake cannot produce.
    const before = await counts();
    await assert.rejects(() => createJob(pool, {
      clientId: OWNED, family: "crp", title: "Half written", workflowStage: "Setup", owner: "A",
      clientManagerUserId: "not-a-member",
      startDate: "2026-01-01", dueDate: "2026-06-30",
      reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31",
    }, context(ADMIN, "admin", "rollback-1")));
    assert.deepEqual(await counts(), before, "no job, no audit, no outbox, no idempotency row");
  });
});

describe("a version conflict is decided against the row, not against a memory", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("commandversion"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org A')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ADMIN]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, OWNED]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("accepts the current version and moves it on", async () => {
    const before = Number((await db.query<{ version: number }>(
      `SELECT version FROM nzi_console.clients WHERE client_id=$1`, [OWNED])).rows[0]!.version);
    await updateClient(pool, clientUpdate(OWNED, before, "Renamed once"), context(ADMIN, "admin", "version-ok"));
    const after = Number((await db.query<{ version: number; name: string }>(
      `SELECT version FROM nzi_console.clients WHERE client_id=$1`, [OWNED])).rows[0]!.version);
    assert.equal(after, before + 1, "a successful write advances the version");
  });

  it("refuses the version it has just superseded", async () => {
    // The lost-update case, with two writers racing over one row. The second caller holds a
    // version that was real when it read and is stale by the time it writes — which is the only
    // situation optimistic concurrency exists for, and cannot be staged without a real row.
    const current = Number((await db.query<{ version: number }>(
      `SELECT version FROM nzi_console.clients WHERE client_id=$1`, [OWNED])).rows[0]!.version);
    await updateClient(pool, clientUpdate(OWNED, current, "First writer"), context(ADMIN, "admin", "race-first"));
    await assert.rejects(
      () => updateClient(pool, clientUpdate(OWNED, current, "Second writer"), context(ADMIN, "admin", "race-second")),
      VersionConflictError);
    const { rows } = await db.query<{ name: string }>(`SELECT name FROM nzi_console.clients WHERE client_id=$1`, [OWNED]);
    assert.equal(rows[0]!.name, "First writer", "the loser's write did not land");
  });

  it("refuses a version that never existed", async () => {
    await assert.rejects(
      () => updateClient(pool, clientUpdate(OWNED, 9999, "From the future"), context(ADMIN, "admin", "version-future")),
      VersionConflictError);
  });
});

describe("an idempotency key replays rather than repeats", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("commandidempotency"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org A')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ADMIN]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, OWNED]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  const job = (title: string) => ({
    clientId: OWNED, family: "crp" as const, title, workflowStage: "Setup", owner: "A",
    startDate: "2026-01-01", dueDate: "2026-06-30",
    reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31",
  });

  it("creates one job for a key used twice, and returns the same number", async () => {
    // A double submit, or a retry after a response was lost. The job number is gapless and
    // assigned on commit (NZC-025), so a second allocation would burn a number and produce a
    // second job the consultant never asked for.
    const first = await createJob(pool, job("Submitted once"), context(ADMIN, "admin", "idem-1"));
    const second = await createJob(pool, job("Submitted once"), context(ADMIN, "admin", "idem-1"));
    assert.equal(second.data.jobNumber, first.data.jobNumber, "the same number comes back");
    assert.equal(second.data.jobId, first.data.jobId, "and the same job");
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM nzi_console.jobs WHERE client_id=$1`, [OWNED]);
    assert.equal(Number(rows[0]!.n), 1, "one job exists, not two");
  });

  it("writes one audit event for the replayed command, not two", async () => {
    // The replay must not re-audit: an audit trail that records a command twice because the
    // network dropped a response is a trail that cannot be counted on.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM nzi_console.audit_events WHERE action='job_created'`);
    assert.equal(Number(rows[0]!.n), 1);
  });

  it("allocates a fresh number for a different key", async () => {
    const other = await createJob(pool, job("A second, deliberate job"), context(ADMIN, "admin", "idem-2"));
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM nzi_console.jobs WHERE client_id=$1`, [OWNED]);
    assert.equal(Number(rows[0]!.n), 2);
    assert.ok(other.data.jobNumber, "and it has its own number");
  });
});

describe("a successful command writes its audit and its outbox message with it", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("commandaudit"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org A')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ADMIN]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, OWNED]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("lands the row, the audit event and the outbox message together", async () => {
    await createJob(pool, {
      clientId: OWNED, family: "crp", title: "Audited", workflowStage: "Setup", owner: "A",
      startDate: "2026-01-01", dueDate: "2026-06-30",
      reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31",
    }, context(ADMIN, "admin", "audit-1"));

    const audit = await db.query<{ actor_id: string; organisation_id: string; correlation_id: string }>(
      `SELECT actor_id, organisation_id, correlation_id FROM nzi_console.audit_events WHERE action='job_created'`);
    assert.equal(audit.rowCount, 1, "exactly one audit event");
    assert.equal(audit.rows[0]!.actor_id, ADMIN, "attributed to the actor who ran it");
    assert.equal(audit.rows[0]!.organisation_id, ORG);
    assert.equal(audit.rows[0]!.correlation_id, "corr-audit-1", "carrying the correlation id it was given");

    const outbox = await db.query(`SELECT 1 FROM nzi_console.transactional_outbox`);
    assert.ok((outbox.rowCount ?? 0) > 0, "and an outbox message, in the same transaction");
  });
});
