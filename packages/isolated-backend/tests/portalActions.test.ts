import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createPortalTrackerAction, deletePortalTrackerAction, getPortalActionTracker, updatePortalTrackerAction } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(here, "../migrations/0059_portal_action_tracker.sql"), "utf8");
const principal = { principal: "portal" as const, organisationId: "org", userId: "portal-1", clientId: "client-1", displayName: "Client", email: "c@example.test", issuedAt: 0, expiresAt: 1, sessionId: "s", idleLimitMinutes: 30, termsVersion: "v1", mustAcceptTerms: false };

function pool() {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = { async query(sql: string, values?: readonly unknown[]) {
    calls.push({ sql, values });
    if (sql.includes("portal_access_grants")) return { rows: [{ ok: 1 }] };
    if (sql.includes("SELECT action_id")) return { rows: [] };
    if (sql.includes("INSERT INTO nzi_console.portal_tracker_actions")) return { rows: [{ action_id: "a-1", lever_code: "C2.4", title: "Publish guidance", notes: "", progress_percent: 20, version: 1, updated_at: "2026-09-08T00:00:00.000Z" }] };
    if (sql.includes("UPDATE nzi_console.portal_tracker_actions")) return { rows: [{ action_id: "a-1", lever_code: "C2.4", title: "Publish guidance", notes: "", progress_percent: 60, version: 2, updated_at: "2026-09-08T01:00:00.000Z" }] };
    if (sql.includes("DELETE FROM nzi_console.portal_tracker_actions")) return { rows: [{ action_id: "a-1" }] };
    return { rows: [] };
  }, release() {} };
  return { calls, pool: { async connect() { return client; } } };
}

describe("portal A2-lite action tracker", () => {
  it("is an isolated, tenant-RLS engagement store without emissions fields", () => {
    assert.match(migration, /CREATE TABLE nzi_console\.portal_tracker_actions/);
    assert.match(migration, /FORCE ROW LEVEL SECURITY/);
    assert.match(migration, /CREATE POLICY tenant_isolation/);
    assert.doesNotMatch(migration, /tco2e|emission_factor|projected_reduction/i);
  });

  it("returns all 24 levers independently of the action rows", async () => {
    const fake = pool();
    const result = await getPortalActionTracker(fake.pool as never, principal, "job-1");
    assert.equal(result.levers.length, 24);
    assert.deepEqual(result.actions, []);
  });

  it("creates and version-updates qualitative progress with an audit trail", async () => {
    const createdDb = pool();
    const created = await createPortalTrackerAction(createdDb.pool as never, principal, "job-1", { leverCode: "C2.4", title: "Publish guidance", notes: "", progressPercent: 20 });
    assert.equal(created.progressPercent, 20);
    assert.equal(createdDb.calls.some((call) => call.sql.includes("portal.tracker.action.create")), true);
    const updatedDb = pool();
    const updated = await updatePortalTrackerAction(updatedDb.pool as never, principal, "job-1", "a-1", 1, { leverCode: "C2.4", title: "Publish guidance", notes: "", progressPercent: 60 });
    assert.equal(updated.version, 2);
    assert.equal(updated.progressPercent, 60);
    const deletedDb = pool();
    assert.deepEqual(await deletePortalTrackerAction(deletedDb.pool as never, principal, "job-1", "a-1", 2), { actionId: "a-1", deleted: true });
    assert.equal(deletedDb.calls.some((call) => call.sql.includes("portal.tracker.action.delete")), true);
  });
});
