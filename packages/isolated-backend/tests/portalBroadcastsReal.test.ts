import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultListQuery, portalBroadcastListSpec, type CommandContext, type PortalBroadcastEditableFields, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  createPortalBroadcast, deactivatePortalBroadcast, listLivePortalBroadcasts, listPortalBroadcastsPage, reinstatePortalBroadcast, updatePortalBroadcast,
} from "../src/portalBroadcasts";
import { withTenantRead } from "../src/postgres";

/**
 * Portal broadcasts (admin Phase F4; ruled `F4-RULINGS.md` R1–R7) against a real database: 0152's guarantees (forced RLS,
 * no DELETE, versioning, CHECK backstops for style, link and window), the four commands and their refusals (admin.settings;
 * title and body; style; the link allow-list, both or neither; the window; the target client), and the portal read —
 * live only (end exclusive), to everyone or to that client, warnings first then newest, five at most.
 */
const ORG = "broadcast-org";
const OTHER = "broadcast-other";
const HOUR = 60 * 60 * 1000;
const at = (offsetHours: number) => new Date(Date.now() + offsetHours * HOUR).toISOString();

describe("portal broadcasts, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (actor: string, role: StaffRole, org = ORG, reason?: string): CommandContext => {
    counter += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `bcast-${counter}`, correlationId: `corr-bcast-${counter}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const asApp = async (org: string, sql: string, params: unknown[] = []) => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE nzi_console_app");
      await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [org]);
      const rows = (await client.query(sql, params)).rows;
      await client.query("COMMIT");
      return rows;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  };
  const refused = (field: string, code: string) => (error: Error & { issues?: Array<{ field: string; code: string }> }) => error.issues?.some((issue) => issue.field === field && issue.code === code) === true;
  const draft = (over: Partial<PortalBroadcastEditableFields> = {}): PortalBroadcastEditableFields =>
    ({ title: "Planned maintenance", body: "The portal is offline on Saturday morning.", style: "info", linkUrl: null, linkLabel: null, startsAt: at(-1), endsAt: null, targetClientId: null, ...over });
  const create = (over: Partial<PortalBroadcastEditableFields> = {}, role: StaffRole = "admin") => createPortalBroadcast(database.pool, draft(over), context("ada", role));
  const live = (clientId: string) => withTenantRead(database.pool, ORG, (db) => listLivePortalBroadcasts(db, clientId));

  before(async () => {
    database = (await createDisposableDatabase("portalbroadcasts"))!;
    for (const org of [ORG, OTHER]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES
        ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'cal', 'consultant', 'active', 'Cal Consultant')`, [org]);
    }
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'client-a', 'Acme', 'active'), ($1, 'client-b', 'Bolt', 'active')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'client-x', 'Elsewhere', 'active')`, [OTHER]);
  });
  after(async () => { await database?.end(); });

  describe("the commands (admin.settings)", () => {
    it("writes a broadcast to everyone, and one to a single client, with a style and an allow-listed link", async () => {
      const everyone = await create();
      assert.deepEqual([everyone.data.style, everyone.data.targetClientId, everyone.data.endsAt, everyone.data.version], ["info", null, null, 1]);
      const targeted = await create({ title: "Your report is ready", style: "success", targetClientId: "client-a", linkUrl: "/portal/jobs", linkLabel: "Open your report", endsAt: at(48) });
      assert.deepEqual([targeted.data.targetClientId, targeted.data.linkUrl, targeted.data.linkLabel], ["client-a", "/portal/jobs", "Open your report"]);
      await create({ title: "Read the guide", linkUrl: "https://example.org/guide", linkLabel: "The guide" });
    });

    it("refuses a missing title or body, an unknown style, a link outside the allow-list or without its label, a bad window, another organisation's client, and a consultant", async () => {
      await assert.rejects(create({ title: " " }), refused("title", "REQUIRED"));
      await assert.rejects(create({ body: "" }), refused("body", "REQUIRED"));
      await assert.rejects(create({ style: "urgent" as never }), refused("style", "INVALID"));
      for (const linkUrl of ["http://example.org", "javascript:alert(1)", "//evil.test/x", "mailto:a@b.test"]) {
        await assert.rejects(create({ linkUrl, linkLabel: "Go" }), refused("linkUrl", "INVALID"), linkUrl);
      }
      await assert.rejects(create({ linkUrl: "https://example.org", linkLabel: null }), refused("linkLabel", "REQUIRED"));
      await assert.rejects(create({ linkUrl: null, linkLabel: "Orphan" }), refused("linkUrl", "REQUIRED"));
      await assert.rejects(create({ startsAt: "" }), refused("startsAt", "REQUIRED"));
      await assert.rejects(create({ startsAt: at(2), endsAt: at(1) }), refused("endsAt", "BEFORE_START"));
      await assert.rejects(create({ startsAt: at(1), endsAt: at(1) }), refused("endsAt", "BEFORE_START"), "the end is after the start, not at it");
      await assert.rejects(create({ targetClientId: "client-x" }), refused("targetClientId", "NOT_FOUND"));
      await assert.rejects(create({}, "consultant"), /admin\.settings|permission/i);
    });

    it("edits against the version (a stale one is a conflict), refuses an unchanged edit, takes down with a reason and puts back", async () => {
      const made = await create({ title: "Draft" });
      const edited = await updatePortalBroadcast(database.pool, { ...draft({ title: "Final", startsAt: made.data.startsAt }), broadcastId: made.data.broadcastId, expectedVersion: 1 }, context("ada", "admin"));
      assert.deepEqual([edited.data.title, edited.data.version], ["Final", 2]);
      await assert.rejects(updatePortalBroadcast(database.pool, { ...draft({ title: "Lost update", startsAt: made.data.startsAt }), broadcastId: made.data.broadcastId, expectedVersion: 1 }, context("ada", "admin")), /version/i);
      await assert.rejects(updatePortalBroadcast(database.pool, { ...draft({ title: "Final", startsAt: made.data.startsAt }), broadcastId: made.data.broadcastId, expectedVersion: 2 }, context("ada", "admin")), refused("title", "UNCHANGED"));
      await assert.rejects(deactivatePortalBroadcast(database.pool, { broadcastId: made.data.broadcastId, expectedVersion: 2 }, context("ada", "admin")), /Command validation failed/, "a reason is required");
      const down = await deactivatePortalBroadcast(database.pool, { broadcastId: made.data.broadcastId, expectedVersion: 2 }, context("ada", "admin", ORG, "Sent in error"));
      await assert.rejects(deactivatePortalBroadcast(database.pool, { broadcastId: made.data.broadcastId, expectedVersion: down.data.version }, context("ada", "admin", ORG, "Again")), refused("broadcastId", "ALREADY_INACTIVE"));
      const back = await reinstatePortalBroadcast(database.pool, { broadcastId: made.data.broadcastId, expectedVersion: down.data.version }, context("ada", "admin"));
      assert.equal(back.data.active, true);
      const [audit] = await q(`SELECT before_json, after_json, reason FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'portal_broadcast.deactivated'`, [ORG]);
      assert.deepEqual([audit.before_json.active, audit.after_json.active, audit.reason], [true, false, "Sent in error"]);
    });
  });

  describe("0152's guarantees", () => {
    it("deletes nothing, is tenant-confined, and holds style, link and window by CHECK as well as by command", async () => {
      await assert.rejects(asApp(ORG, `DELETE FROM nzi_console.portal_broadcasts`), /permission denied/);
      assert.equal((await asApp(OTHER, `SELECT count(*)::int AS n FROM nzi_console.portal_broadcasts`))[0].n, 0);
      const insert = (columns: string, values: string) => q(`INSERT INTO nzi_console.portal_broadcasts (organisation_id, broadcast_id, title, body, starts_at, created_by, updated_by${columns})
        VALUES ($1, 'raw-' || gen_random_uuid(), 'T', 'B', now(), 's', 's'${values})`, [ORG]);
      await assert.rejects(insert(", style", ", 'urgent'"), /check constraint/);
      await assert.rejects(insert(", link_url, link_label", ", 'http://example.org', 'Go'"), /check constraint/);
      await assert.rejects(insert(", link_url, link_label", ", '//evil.test', 'Go'"), /check constraint/);
      await assert.rejects(insert(", link_url", ", 'https://example.org'"), /portal_broadcasts_link_both_or_neither/);
      await assert.rejects(insert(", ends_at", ", now() - interval '1 hour'"), /portal_broadcasts_window/);
      await assert.rejects(insert(", target_client_id", ", 'client-x'"), /foreign key/);
    });

    it("lists with each broadcast's phase, filterable", async () => {
      await create({ title: "Next week", startsAt: at(24 * 7) });
      const page = await withTenantRead(database.pool, ORG, (db) => listPortalBroadcastsPage(db, { ...defaultListQuery(portalBroadcastListSpec), filters: { phase: ["scheduled"] } }));
      assert.deepEqual(page.rows.map((row) => row.title), ["Next week"]);
    });
  });

  describe("the portal read (R5)", () => {
    it("returns only live broadcasts — the end exclusive — to everyone or to that client", async () => {
      await q(`UPDATE nzi_console.portal_broadcasts SET active = false WHERE organisation_id = $1`, [ORG]);
      const everyone = await create({ title: "To everyone" });
      await create({ title: "For Acme", targetClientId: "client-a" });
      await create({ title: "For Bolt", targetClientId: "client-b" });
      await create({ title: "Not yet", startsAt: at(1) });
      const ended = await create({ title: "Over", startsAt: at(-3), endsAt: at(1) });
      await q(`UPDATE nzi_console.portal_broadcasts SET ends_at = now() WHERE broadcast_id = $1`, [ended.data.broadcastId]);
      assert.deepEqual((await live("client-a")).map((row) => row.title).sort(), ["For Acme", "To everyone"]);
      assert.deepEqual((await live("client-b")).map((row) => row.title).sort(), ["For Bolt", "To everyone"]);
      await deactivatePortalBroadcast(database.pool, { broadcastId: everyone.data.broadcastId, expectedVersion: everyone.data.version }, context("ada", "admin", ORG, "Done"));
      assert.deepEqual((await live("client-a")).map((row) => row.title), ["For Acme"], "taken down at once, whatever its window");
      const [first] = await live("client-a");
      assert.deepEqual(Object.keys(first!).sort(), ["body", "broadcastId", "endsAt", "link", "startsAt", "style", "title"], "content only — never the author or the target");
    });

    it("puts warnings first, then the newest, and returns five at most", async () => {
      await q(`UPDATE nzi_console.portal_broadcasts SET active = false WHERE organisation_id = $1`, [ORG]);
      for (let index = 0; index < 5; index += 1) await create({ title: `Info ${index}`, startsAt: at(-10 + index) });
      await create({ title: "Older warning", style: "warning", startsAt: at(-20) });
      await create({ title: "Promo", style: "promo", startsAt: at(-0.5) });
      const shown = await live("client-a");
      assert.equal(shown.length, 5, "capped at five");
      assert.deepEqual(shown.map((row) => row.title), ["Older warning", "Promo", "Info 4", "Info 3", "Info 2"]);
    });
  });
});
