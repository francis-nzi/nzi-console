import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, roleCapabilityGrants, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { AuthorizationError } from "../src/auth";
import { clientHistoryFor } from "../src/clientHistory";
import { withTenantRead } from "../src/postgres";
import { createClient, updateClient } from "../src/postgresCommands";
import { createClientSite } from "../src/siteLifecycle";

/**
 * A client's history (CLIENT-12) against a real database: the audit events stamped with the client (its own record, its
 * sites), newest first, with the actor's name, before, after and the reason; never another client's or another
 * organisation's; and audit.view decides who may read it — none refused, own_clients only for the owner, all for any.
 */
const ORG = "history-org";
const OTHER = "history-other";

describe("a client's history, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (actor: string, role: StaffRole, org = ORG, reason?: string): CommandContext => {
    counter += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `hist-${counter}`, correlationId: `corr-hist-${counter}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const holder = (role: StaffRole, userId: string) => ({ userId, capabilities: roleCapabilityGrants(role) });
  const read = (clientId: string, role: StaffRole, userId: string, org = ORG) => withTenantRead(database.pool, org, (db) => clientHistoryFor(db, holder(role, userId), clientId));
  const refused = (error: unknown) => error instanceof AuthorizationError && error.permission === "audit.view";
  let mine = "", theirs = "", elsewhere = "";

  before(async () => {
    database = (await createDisposableDatabase("clienthistory"))!;
    for (const org of [ORG, OTHER]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES
        ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'cal', 'consultant', 'active', 'Cal Consultant'), ($1, 'val', 'viewer', 'active', 'Val Viewer')`, [org]);
    }
    const make = async (name: string, ownerUserId: string, org = ORG) => (await createClient(database.pool,
      { name, status: "active", sector: "Manufacturing", location: "Leeds, UK", owner: ownerUserId, ownerUserId } as never, context("ada", "admin", org))).data.clientId;
    mine = await make("Cal's Client", "cal");
    theirs = await make("Ada's Client", "ada");
    elsewhere = await make("Other Org Client", "ada", OTHER);
    const [row] = await q(`SELECT version, name, status, sector, location, owner_name FROM nzi_console.clients WHERE client_id = $1`, [mine]);
    await updateClient(database.pool, { clientId: mine, expectedVersion: row.version, name: "Cal's Client Ltd", status: row.status, sector: row.sector, location: row.location,
      owner: row.owner_name ?? "cal", ownerUserId: "cal" } as never, context("ada", "admin", ORG, "Renamed after the merger"));
    await createClientSite(database.pool, { clientId: mine, name: "Leeds depot", inServiceFrom: null }, context("ada", "admin"));
  });
  after(async () => { await database?.end(); });

  it("holds the client's own events — its record and its sites — newest first, with the actor's name, before, after and reason", async () => {
    const history = (await read(mine, "admin", "ada"))!;
    assert.deepEqual(history.map((entry) => entry.action), ["client_site_created", "client_updated", "client_created"]);
    assert.ok(history.every((entry) => entry.actorLabel === "Ada Admin"));
    const update = history.find((entry) => entry.action === "client_updated")!;
    assert.equal(update.reason, "Renamed after the merger");
    assert.equal(update.entity, "client");
    assert.ok(update.after !== null, "the after-state is carried");
    assert.ok(history.every((entry) => entry.id && entry.correlationId && !Number.isNaN(Date.parse(entry.at))));
  });

  it("never carries another client's events, or another organisation's", async () => {
    assert.deepEqual((await read(theirs, "admin", "ada"))!.map((entry) => entry.action), ["client_created"]);
    assert.equal(await read(elsewhere, "admin", "ada"), null, "another organisation's client is not here");
    assert.equal(await read("no-such-client", "admin", "ada"), null);
  });

  it("is read under audit.view: all for Admin and Reviewer, own clients only for a Consultant, refused for a Viewer", async () => {
    assert.equal((await read(theirs, "reviewer", "rex"))!.length, 1, "a Reviewer reads any client's");
    assert.equal((await read(mine, "consultant", "cal"))!.length, 3, "a Consultant reads their own client's");
    await assert.rejects(read(theirs, "consultant", "cal"), refused, "…and not another's");
    await assert.rejects(read(mine, "viewer", "val"), refused, "a Viewer holds no audit.view");
    await assert.rejects(read(mine, "finance", "fin"), refused, "Finance is own-clients too, and owns none");
  });
});
