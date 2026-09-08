import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthenticationError, resolvePortalPrincipal, type PortalSession } from "../src/index";

// P1 (Portal Phase 2) — idle-session enforcement is at `resolvePortalPrincipal`,
// the single request-time resolve every portal API route goes through.
const session: PortalSession = {
  principal: "portal", sessionId: "sess-a", userId: "portal-a", clientId: "client-a",
  organisationId: "org-a", issuedAt: 1, expiresAt: 2,
};

function pool(sessionRows: unknown[]) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("FROM nzi_console.portal_sessions s") && sql.includes("JOIN nzi_console.portal_users u")) return { rows: sessionRows };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, calls };
}

describe("portal idle-session enforcement (P1)", () => {
  it("resolves a fresh session, carries the idle limit, and slides the window (throttled)", async () => {
    const t = pool([{ display_name: "Client User", email_normalized: "client@example.invalid" }]);
    const principal = await resolvePortalPrincipal(t.pool, session, { idleLimitMinutes: 20 });
    assert.equal(principal.idleLimitMinutes, 20);
    assert.equal(principal.email, "client@example.invalid");

    const select = t.calls.find((c) => c.sql.includes("FROM nzi_console.portal_sessions s") && c.sql.includes("JOIN nzi_console.portal_users u"));
    assert.ok(select?.sql.includes("s.last_seen_at > now() - ($5 || ' minutes')::interval"), "the resolve SELECT enforces the idle window");
    assert.equal(select?.values?.[4], "20");
    assert.ok(
      t.calls.some((c) => c.sql.includes("SET last_seen_at=now()") && c.sql.includes("last_seen_at < now() - interval '30 seconds'")),
      "activity slides the window forward, throttled to one write per 30s",
    );
  });

  it("rejects a session the idle-window SELECT no longer returns (stale / revoked / expired)", async () => {
    const t = pool([]);
    await assert.rejects(() => resolvePortalPrincipal(t.pool, session, { idleLimitMinutes: 30 }), AuthenticationError);
    assert.equal(t.calls.some((c) => c.sql.includes("SET last_seen_at=now()")), false, "a rejected session is not bumped");
  });

  it("defaults to a 30-minute idle limit", async () => {
    const t = pool([{ display_name: "C", email_normalized: "c@example.invalid" }]);
    const principal = await resolvePortalPrincipal(t.pool, session);
    assert.equal(principal.idleLimitMinutes, 30);
    const select = t.calls.find((c) => c.sql.includes("FROM nzi_console.portal_sessions s"));
    assert.equal(select?.values?.[4], "30");
  });
});
