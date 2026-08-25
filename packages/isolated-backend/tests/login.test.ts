import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeStaffMfa, encryptTotpSecret, hashPassword, InvalidLoginError, startStaffLogin, totpCode } from "../src/index";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const secret = "JBSWY3DPEHPK3PXP";
const now = new Date("2026-08-25T12:00:00.000Z");

async function loginPool() {
  const password = await hashPassword("correct horse battery staple");
  const encrypted = encryptTotpSecret(secret, encryptionKey);
  const credential = { organisation_id: "demo-nzi-console", user_id: "demo-admin", password_salt: password.salt, password_hash: password.hash, totp_ciphertext: encrypted.ciphertext, totp_iv: encrypted.iv, totp_tag: encrypted.tag, enabled: true, failed_attempts: 0, locked_until: null };
  let challenge: { challenge_id: string; token_hash: string; attempts: number; expires_at: string; consumed_at: null } | undefined;
  let sessionCount = 0;
  let failedAttempts = 0;
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      if (sql.includes("FROM nzi_console.staff_credentials c") && sql.includes("FOR UPDATE OF c")) return { rows: [credential] };
      if (sql.includes("SET failed_attempts=$3")) failedAttempts = Number(values?.[2]);
      if (sql.includes("INSERT INTO nzi_console.staff_login_challenges")) challenge = { challenge_id: String(values?.[1]), token_hash: String(values?.[3]), attempts: 0, expires_at: new Date(now.getTime() + 300_000).toISOString(), consumed_at: null };
      if (sql.includes("FROM nzi_console.staff_login_challenges ch")) return { rows: challenge ? [{ ...credential, ...challenge }] : [] };
      if (sql.includes("INSERT INTO nzi_console.staff_sessions")) sessionCount += 1;
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, state: () => ({ challenge, sessionCount, failedAttempts }) };
}

describe("staff login service", () => {
  it("creates a one-time MFA challenge and a revocable session", async () => {
    const test = await loginPool();
    const started = await startStaffLogin(test.pool, { organisationId: "demo-nzi-console", email: "staff@example.invalid", password: "correct horse battery staple" }, now);
    const session = await completeStaffMfa(test.pool, { organisationId: "demo-nzi-console", challengeToken: started.challengeToken, code: totpCode(secret, now.getTime()) }, encryptionKey, now);
    assert.equal(session.userId, "demo-admin");
    assert.equal(session.expiresAt - session.issuedAt, 8 * 60 * 60);
    assert.equal(test.state().sessionCount, 1);
  });

  it("persists a failed password attempt without issuing a challenge", async () => {
    const test = await loginPool();
    await assert.rejects(() => startStaffLogin(test.pool, { organisationId: "demo-nzi-console", email: "staff@example.invalid", password: "incorrect password value" }, now), InvalidLoginError);
    assert.equal(test.state().failedAttempts, 1);
    assert.equal(test.state().challenge, undefined);
  });
});
