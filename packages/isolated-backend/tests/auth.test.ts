import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSameOrigin, AuthenticationError, AuthorizationError, authorizeCommand, issueStaffSession, rolePermissions, verifyStaffSession, type StaffPrincipal } from "../src/index";

const secret = "a-dedicated-test-session-secret-that-is-long-enough";
const session = { userId: "staff-a", organisationId: "org-a", issuedAt: 1_700_000_000, expiresAt: 1_700_003_600 };
const principal = (role: StaffPrincipal["role"]): StaffPrincipal => ({ ...session, role, permissions: rolePermissions[role] });

describe("staff authentication and authorization", () => {
  it("verifies an untampered, unexpired signed session", () => {
    const token = issueStaffSession(session, secret);
    assert.deepEqual(verifyStaffSession(token, secret, 1_700_000_100), session);
  });

  it("rejects forged, expired and weak-secret sessions", () => {
    const token = issueStaffSession(session, secret);
    assert.throws(() => verifyStaffSession(`${token}x`, secret, 1_700_000_100), AuthenticationError);
    assert.throws(() => verifyStaffSession(token, secret, session.expiresAt), AuthenticationError);
    assert.throws(() => issueStaffSession(session, "weak"), AuthenticationError);
  });

  it("allows only named role permissions and keeps read-only mutation-free", () => {
    assert.doesNotThrow(() => authorizeCommand(principal("consultant"), "job.create"));
    assert.throws(() => authorizeCommand(principal("consultant"), "report.publish"), AuthorizationError);
    assert.throws(() => authorizeCommand(principal("read-only"), "client.create"), AuthorizationError);
    assert.doesNotThrow(() => authorizeCommand(principal("methodology-data-admin"), "dataset.override.add"));
  });

  it("requires the exact configured origin", () => {
    assert.doesNotThrow(() => assertSameOrigin("https://console.example", "https://console.example/path"));
    assert.throws(() => assertSameOrigin("https://evil.example", "https://console.example"), AuthenticationError);
    assert.throws(() => assertSameOrigin(null, "https://console.example"), AuthenticationError);
  });
});
