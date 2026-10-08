import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { commandReason, commandReasonHeaders, postBrowserCommandWithReason } from "@nzi/api-client";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { archiveSite, createClientSite, unarchiveSite } from "../src/siteLifecycle";

/**
 * RULING-command-reason-encoding (8 Oct 2026), end to end against a real database: a command's reason goes from the
 * browser helper, through the headers it builds, through the server's one reader (`commandReason`, which the console's
 * `commandContext` calls), into a real command's audit row — byte for byte, whatever its characters. And a plain-ASCII
 * reason lands in the audit exactly as the old raw reader would have stored it.
 *
 * `commandContext` itself is server-only (it cannot be imported outside Next), so the test pins that it reads the reason
 * through `commandReason` and nothing else, and drives `commandReason` with the headers the browser helper really sends.
 */
const ORG = "org-reason";
const CLIENT = "client-reason";
const ACTOR = "ada-reason";
const here = dirname(fileURLToPath(import.meta.url));

describe("a command reason reaches the audit byte for byte (RULING-command-reason-encoding)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `reason-${keys}`, correlationId: `corr-reason-${keys}`,
      grant: commandGrantForRole("admin", ORG, ACTOR), ...(reason ? { reason } : {}) };
  };
  /** What the browser sends for this reason, as the server receives it: the helper's real headers. */
  const sentHeaders = async (reason: string): Promise<Headers> => {
    let sent: Headers | null = null;
    await postBrowserCommandWithReason("/x", {}, "idem", reason, async (_path, init) => { sent = new Headers(init?.headers); return Response.json({ data: {} }, { status: 201 }); });
    return sent!;
  };
  const archiveWith = async (siteId: string, reason: string | undefined) => {
    const { rows: [site] } = await db.query<{ version: number }>(`SELECT version FROM nzi_console.client_sites WHERE site_id=$1`, [siteId]);
    const done = await archiveSite(database.pool, { siteId, expectedVersion: site!.version }, context(reason));
    const { rows: [audit] } = await db.query<{ reason: string | null }>(`SELECT reason FROM nzi_console.audit_events WHERE audit_event_id=$1`, [done.auditEventId]);
    return audit!.reason;
  };
  const site = async (name: string) => (await createClientSite(database.pool, { clientId: CLIENT, name, inServiceFrom: null } as never, context())).data.siteId;

  before(async () => {
    database = (await createDisposableDatabase("commandreason"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada')`, [ORG, ACTOR]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the console's commandContext reads the reason through commandReason, and only through it", () => {
    const source = readFileSync(resolve(here, "../../../apps/console/app/lib/commandResponse.ts"), "utf8");
    assert.match(source, /reason: commandReason\(request\.headers\),/);
    assert.doesNotMatch(source, /headers\.get\("x-command-reason"\)/, "no second, raw reader");
  });

  it("a reason with curly quotes, dashes, accents, € and an emoji reaches the audit byte for byte", async () => {
    const reason = "Client’s site closed — “moved” to Zürich, café & bureau; €12k lease; ✅ agreed";
    const headers = await sentHeaders(reason);
    const stored = await archiveWith(await site("Unicode site"), commandReason(headers));
    assert.equal(stored, reason);
    assert.deepEqual(Buffer.from(stored!, "utf8"), Buffer.from(reason, "utf8"), "byte for byte");
  });

  it("a plain-ASCII reason produces the identical audit value it does today", async () => {
    const reason = "  Closed for refit; 50% of floor area let - see note  ";
    // Today: the browser sent the trimmed reason raw, and the server read it raw and trimmed it.
    const today = new Headers({ "x-command-reason": reason.trim() }).get("x-command-reason")?.trim() || undefined;
    const now = commandReason(await sentHeaders(reason));
    assert.equal(now, today);
    const siteId = await site("Ascii site");
    const stored = await archiveWith(siteId, now);
    assert.equal(stored, "Closed for refit; 50% of floor area let - see note");
    // And a caller still sending the old raw header (no encoding marker) stores the same value.
    await unarchiveSite(database.pool, { siteId, expectedVersion: (await db.query<{ version: number }>(`SELECT version FROM nzi_console.client_sites WHERE site_id=$1`, [siteId])).rows[0]!.version }, context());
    assert.equal(await archiveWith(siteId, commandReason(new Headers({ "x-command-reason": reason.trim() }))), stored);
  });

  it("the headers the helper sends are all ISO-8859-1 — so fetch can send them", async () => {
    const headers = commandReasonHeaders("naïve — “quoted” ✅");
    for (const value of Object.values(headers)) assert.ok([...value].every((char) => char.charCodeAt(0) <= 0xff), value);
  });
});
