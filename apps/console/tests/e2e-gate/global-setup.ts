import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";
// The auth module directly rather than the package barrel: the barrel reaches modules that use
// `import.meta`, which Playwright's CommonJS transform cannot load. This is still the application's own
// issuer — the same function the login route signs with — not a second implementation of it.
import { issueStaffSession } from "../../../../packages/isolated-backend/src/auth";
import { provisionStaffCredential } from "../../../../packages/isolated-backend/src/login";
import { GATE_STATE } from "../../playwright.gate.config";

/**
 * Mint the session the gate browses with (NZC-147).
 *
 * The console's write routes ask `currentStaff(request)`, so the gate needs a staff session. It is minted
 * here with the application's **own** issuer rather than by driving the login form, for two reasons: a
 * login form is a second thing that can fail and make every capture test red for a reason that has nothing
 * to do with capture, and there is no account to log into — the gate's database is created empty and seeded
 * from files.
 *
 * The signing secret exists for the length of one run and is minted by CI beside the sealing keys. Using
 * the real issuer rather than hand-rolling the token is the point: if the session format changes, this
 * breaks loudly instead of quietly producing a token the middleware rejects, which would look like every
 * page redirecting to `/login` and nothing explaining why.
 *
 * `demo-admin` is the actor the seeds give an active `admin` membership, so capability checks resolve
 * against a real row rather than an assumption.
 *
 * **A signed cookie is not by itself a session.** `resolveStaffPrincipal` joins `staff_sessions` to
 * `memberships` and refuses when there is no live, unrevoked row — so a valid signature alone gets a page
 * (the middleware only verifies the token) and a 401 from every API route behind it. That asymmetry is
 * worth stating because of how it presents: the surface renders, and then every panel on it is empty for
 * reasons that look like missing data. So the row and the token are minted here together, from the same
 * values, because two places deciding what the session id is would be one place too many.
 */
export default async function globalSetup(): Promise<void> {
  const secret = process.env.NZI_CONSOLE_SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("NZI_CONSOLE_SESSION_SECRET must be set to at least 32 bytes for the capture gate.");
  }
  const databaseUrl = process.env.NZI_ISOLATED_DATABASE_URL;
  if (!databaseUrl) throw new Error("NZI_ISOLATED_DATABASE_URL is required for the capture gate.");
  const mfaKey = process.env.NZI_CONSOLE_MFA_ENCRYPTION_KEY;
  if (!mfaKey) throw new Error("NZI_CONSOLE_MFA_ENCRYPTION_KEY is required for the capture gate.");

  const issuedAt = Math.floor(Date.now() / 1000);
  const session = {
    sessionId: "gate-session",
    userId: "demo-admin",
    organisationId: "demo-nzi-console",
    issuedAt,
    // An hour is far longer than the gate takes and short enough that a leaked token is worthless.
    expiresAt: issuedAt + 3_600,
  };
  const token = issueStaffSession(session, secret);

  // A pool, not a client: the backend helpers take a pool and call `connect()` themselves so they can
  // run each statement inside its own transaction with the right role set.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    // A session row is only allowed to exist for somebody who could have logged in: `staff_sessions`
    // has a foreign key to `staff_credentials`. That is the right constraint — a session for an account
    // that does not exist is exactly what should be impossible — so the gate provisions an account
    // rather than working around it, using the application's own provisioner so the password hash and
    // the encrypted TOTP secret are whatever the login path expects them to be. The password is never
    // used: nothing here drives the login form. What matters is that the row is well-formed.
    await provisionStaffCredential(pool, {
      organisationId: session.organisationId,
      userId: session.userId,
      email: "capture-gate@synthetic.invalid",
      password: `gate-${randomBytes(18).toString("hex")}`,
      totpSecret: randomBytes(20).toString("base64"),
    }, mfaKey);

    // The row the principal resolver joins against. `ON CONFLICT` so a re-run of the gate against a
    // surviving database refreshes the window rather than failing on the second attempt.
    await pool.query(
      `INSERT INTO nzi_console.staff_sessions (organisation_id, session_id, user_id, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4))
       ON CONFLICT (organisation_id, session_id)
       DO UPDATE SET expires_at = to_timestamp($4), revoked_at = NULL, last_seen_at = now()`,
      [session.organisationId, session.sessionId, session.userId, session.expiresAt]);

    // A membership is what makes the role resolve. The seeds give `demo-admin` one; asserting it here
    // means a seed that stopped doing so fails in setup with the reason, rather than as a wall of 401s.
    const membership = await pool.query<{ role_id: string }>(
      `SELECT role_id FROM nzi_console.memberships
        WHERE organisation_id = $1 AND user_id = $2 AND status = 'active'`,
      [session.organisationId, session.userId]);
    if (!membership.rows[0]) {
      throw new Error(`${session.userId} has no active membership in ${session.organisationId} — `
        + "the seeds did not run, or no longer create one. Every API route would answer 401.");
    }
  } finally {
    await pool.end();
  }

  const state = {
    cookies: [{
      name: "nzi_console_session",
      value: token,
      domain: "127.0.0.1",
      path: "/",
      expires: issuedAt + 3_600,
      httpOnly: true,
      // The application sets this cookie `Secure`, which is right for it and wrong here: the gate speaks
      // plain HTTP to loopback, and a Secure cookie would simply not be sent. What is under test is the
      // capture surface, not the cookie flags — those belong to the auth suite.
      secure: false,
      sameSite: "Lax" as const,
    }],
    origins: [],
  };

  const path = resolve(__dirname, "../../", GATE_STATE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}
