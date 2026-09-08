import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthenticationError, acceptPortalTerms, PortalTermsError, portalTermsVersion,
  PortalTermsRequiredError, requirePortalTermsAccepted, resolvePortalPrincipal, type PortalSession,
} from "../src/index";

// P2b — terms-of-access gate.
const session: PortalSession = {
  principal: "portal", sessionId: "sess-a", userId: "portal-a", clientId: "client-a",
  organisationId: "org-a", issuedAt: 1, expiresAt: 2,
};

function pool(sessionRow: Record<string, unknown> | null) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("FROM nzi_console.portal_sessions s")) return { rows: sessionRow ? [sessionRow] : [] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, calls };
}

describe("portalTermsVersion", () => {
  it("defaults to 2026-v1 and trims a configured value", () => {
    assert.equal(portalTermsVersion(), "2026-v1");
    assert.equal(portalTermsVersion(""), "2026-v1");
    assert.equal(portalTermsVersion("  2027-v2 "), "2027-v2");
  });
});

describe("resolvePortalPrincipal — must_accept_tac (P2b)", () => {
  it("flags mustAcceptTerms when a version is configured and no acceptance row exists", async () => {
    const t = pool({ display_name: "C", email_normalized: "c@example.invalid", terms_ok: false });
    const principal = await resolvePortalPrincipal(t.pool, session, { idleLimitMinutes: 30, termsVersion: "2026-v1" });
    assert.equal(principal.mustAcceptTerms, true);
    assert.equal(principal.termsVersion, "2026-v1");
    const select = t.calls.find((c) => c.sql.includes("FROM nzi_console.portal_sessions s"));
    assert.ok(select?.sql.includes("portal_terms_acceptances t") && select.sql.includes("t.terms_version=$6"));
    assert.equal(select?.values?.[5], "2026-v1");
  });

  it("does not flag when the acceptance row is present", async () => {
    const t = pool({ display_name: "C", email_normalized: "c@example.invalid", terms_ok: true });
    const principal = await resolvePortalPrincipal(t.pool, session, { termsVersion: "2026-v1" });
    assert.equal(principal.mustAcceptTerms, false);
  });

  it("never flags when no terms version is configured (backwards compatible)", async () => {
    const t = pool({ display_name: "C", email_normalized: "c@example.invalid", terms_ok: true });
    const principal = await resolvePortalPrincipal(t.pool, session, {});
    assert.equal(principal.mustAcceptTerms, false);
    assert.equal(principal.termsVersion, "");
  });
});

describe("requirePortalTermsAccepted", () => {
  it("throws PortalTermsRequiredError with the version when outstanding", () => {
    assert.throws(() => requirePortalTermsAccepted({ mustAcceptTerms: true, termsVersion: "2026-v1" }), (error: unknown) => {
      assert.ok(error instanceof PortalTermsRequiredError);
      assert.equal(error.termsVersion, "2026-v1");
      return true;
    });
  });
  it("passes when not outstanding", () => {
    assert.doesNotThrow(() => requirePortalTermsAccepted({ mustAcceptTerms: false, termsVersion: "2026-v1" }));
  });
});

describe("acceptPortalTerms", () => {
  it("records the acceptance for the current version and audits nothing else destructive", async () => {
    const t = pool({ "?column?": 1 });
    const result = await acceptPortalTerms(t.pool, session, { version: "2026-v1" }, "2026-v1");
    assert.equal(result.acceptedVersion, "2026-v1");
    const insert = t.calls.find((c) => c.sql.includes("INSERT INTO nzi_console.portal_terms_acceptances"));
    assert.ok(insert?.sql.includes("ON CONFLICT") && insert.sql.includes("DO NOTHING"), "idempotent insert");
    assert.deepEqual(insert?.values, ["org-a", "portal-a", "2026-v1"]);
  });

  it("rejects a stale / empty / wrong version before touching the database", async () => {
    const t = pool({ "?column?": 1 });
    await assert.rejects(() => acceptPortalTerms(t.pool, session, { version: "2025-v0" }, "2026-v1"), PortalTermsError);
    await assert.rejects(() => acceptPortalTerms(t.pool, session, { version: "" }, "2026-v1"), PortalTermsError);
    assert.equal(t.calls.length, 0, "no DB call for an invalid version");
  });

  it("rejects when the session is not active", async () => {
    const t = pool(null);
    await assert.rejects(() => acceptPortalTerms(t.pool, session, { version: "2026-v1" }, "2026-v1"), AuthenticationError);
    assert.equal(t.calls.some((c) => c.sql.includes("INSERT INTO nzi_console.portal_terms_acceptances")), false);
  });
});
