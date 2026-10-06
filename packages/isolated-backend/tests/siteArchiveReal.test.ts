import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createClient } from "../src/postgresCommands";
import { getClientWorkspace, listJobSites } from "../src/readModels";
import { archiveSite, createClientSite, unarchiveSite } from "../src/siteLifecycle";
import { withTenantRead } from "../src/postgres";

/**
 * Phase 1a (ruled) against a real database: a client site is archived — the deactivate state beside the dated vacate —
 * with a reason; never deleted; the registered office is guarded; an archived site leaves the client's site list and
 * the pickers but is listed as archived and can be unarchived; a version conflict and a double archive are refused.
 */
const ORG = "archive-org";

describe("client site archive / unarchive, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (reason?: string, actor = "ada", role: StaffRole = "admin"): CommandContext => {
    counter += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `arc-${counter}`, correlationId: `corr-arc-${counter}`, grant: commandGrantForRole(role, ORG, actor), ...(reason ? { reason } : {}) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const refusedWith = (code: string) => (error: any) => error.issues?.some((issue: any) => issue.code === code);
  let clientId = "", officeId = "", depotId = "";

  before(async () => {
    database = (await createDisposableDatabase("sitearchive"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
    clientId = (await createClient(database.pool, { name: "Acme", status: "active", sector: "Manufacturing", location: "Leeds, UK", owner: "Ada Admin" } as never, context())).data.clientId;
    officeId = (await createClientSite(database.pool, { clientId, name: "Head Office", inServiceFrom: null, isRegisteredOffice: true } as never, context())).data.siteId;
    depotId = (await createClientSite(database.pool, { clientId, name: "Depot (duplicate)", inServiceFrom: null } as never, context())).data.siteId;
  });
  after(async () => { await database?.end(); });

  it("archives only with a reason, keeps the site, and records the reason in the audit", async () => {
    await assert.rejects(() => archiveSite(database.pool, { siteId: depotId, expectedVersion: 1 }, context()), refusedWith("REQUIRED"));
    const done = await archiveSite(database.pool, { siteId: depotId, expectedVersion: 1 }, context("entered twice"));
    assert.deepEqual([done.data.archived, done.data.version], [true, 2]);
    assert.deepEqual((await q(`SELECT archived, version FROM nzi_console.client_sites WHERE site_id = $1`, [depotId]))[0], { archived: true, version: 2 }, "kept, never deleted");
    assert.equal((await q(`SELECT reason FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'client_site_archived'`, [depotId]))[0]?.reason, "entered twice");
  });

  it("guards the registered office, refuses a double archive and a stale version", async () => {
    await assert.rejects(() => archiveSite(database.pool, { siteId: officeId, expectedVersion: 1 }, context("no")), refusedWith("REGISTERED_OFFICE"));
    await assert.rejects(() => archiveSite(database.pool, { siteId: depotId, expectedVersion: 2 }, context("again")), refusedWith("ALREADY_ARCHIVED"));
    await assert.rejects(() => unarchiveSite(database.pool, { siteId: depotId, expectedVersion: 1 }, context()), /version|conflict/i);
  });

  it("an archived site leaves the client's sites and the job pickers, and is listed as archived", async () => {
    const workspace = await withTenantRead(database.pool, ORG, (db) => getClientWorkspace(db, clientId));
    assert.deepEqual(workspace!.sites.map((site) => site.name), ["Head Office"]);
    assert.deepEqual(workspace!.archivedSites.map((site) => [site.id, site.version]), [[depotId, 2]]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage) VALUES ($1, 'j1', $2, 1, 'crp', 'CRP', 'open', 'Setup')`, [ORG, clientId]);
    const picker = await withTenantRead(database.pool, ORG, (db) => listJobSites(db, "j1"));
    assert.ok(!picker.some((site) => site.id === depotId), "not offered for new entries");
  });

  it("unarchives — back in the client's sites, out of the archived list", async () => {
    const back = await unarchiveSite(database.pool, { siteId: depotId, expectedVersion: 2 }, context());
    assert.deepEqual([back.data.archived, back.data.version], [false, 3]);
    await assert.rejects(() => unarchiveSite(database.pool, { siteId: depotId, expectedVersion: 3 }, context()), refusedWith("NOT_ARCHIVED"));
    const workspace = await withTenantRead(database.pool, ORG, (db) => getClientWorkspace(db, clientId));
    assert.deepEqual(workspace!.sites.map((site) => site.name).sort(), ["Depot (duplicate)", "Head Office"]);
    assert.deepEqual(workspace!.archivedSites, []);
  });
});
