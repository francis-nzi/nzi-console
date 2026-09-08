import type { PoolLike } from "./postgres";
import { withAuthTransaction } from "./postgres";
import { AuthenticationError, type PortalSession } from "./auth";

// Client portal Phase 2, precondition P2b — terms-of-access acceptance.
// The current terms version is configuration (env, resolved by the route);
// `resolvePortalPrincipal` flags `mustAcceptTerms` until an acceptance row for
// that version exists. This records the acceptance.

export const PORTAL_TERMS_VERSION_DEFAULT = "2026-v1";

export function portalTermsVersion(configured?: string | null): string {
  const value = (configured ?? "").trim();
  return value || PORTAL_TERMS_VERSION_DEFAULT;
}

export class PortalTermsError extends Error {
  constructor(message = "The terms could not be accepted.") { super(message); this.name = "PortalTermsError"; }
}

/** Thrown by `requirePortalTermsAccepted` — mapped to 403 PORTAL_TERMS_REQUIRED. */
export class PortalTermsRequiredError extends Error {
  readonly termsVersion: string;
  constructor(termsVersion: string) {
    super("Portal terms of access must be accepted before continuing.");
    this.name = "PortalTermsRequiredError";
    this.termsVersion = termsVersion;
  }
}

export function requirePortalTermsAccepted(principal: { mustAcceptTerms: boolean; termsVersion: string }): void {
  if (principal.mustAcceptTerms) throw new PortalTermsRequiredError(principal.termsVersion);
}

export async function acceptPortalTerms(
  pool: PoolLike,
  session: PortalSession,
  input: { version: string },
  currentVersion: string,
): Promise<{ acceptedVersion: string }> {
  const version = (input.version ?? "").trim();
  if (!version || version !== currentVersion) {
    throw new PortalTermsError("These terms are out of date. Reload the portal and accept the current terms.");
  }
  return withAuthTransaction(pool, "write", async (db) => {
    // The session/user must be real and active — mirrors resolvePortalPrincipal's
    // gate (minus the idle window, so a session inside its warning countdown can
    // still accept and continue).
    const ok = await db.query(
      `SELECT 1 FROM nzi_console.portal_sessions s
       JOIN nzi_console.portal_users u ON (u.organisation_id,u.portal_user_id,u.client_id)=(s.organisation_id,s.portal_user_id,s.client_id)
       WHERE s.organisation_id=$1 AND s.session_id=$2 AND s.portal_user_id=$3 AND s.client_id=$4
         AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'`,
      [session.organisationId, session.sessionId, session.userId, session.clientId],
    );
    if (!ok.rows[0]) throw new AuthenticationError("No active client portal session exists.");
    await db.query(
      `INSERT INTO nzi_console.portal_terms_acceptances (organisation_id,portal_user_id,terms_version)
       VALUES ($1,$2,$3) ON CONFLICT (organisation_id,portal_user_id,terms_version) DO NOTHING`,
      [session.organisationId, session.userId, version],
    );
    return { acceptedVersion: version };
  });
}
