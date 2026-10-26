import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The member's own email signature (email programme phase 5-2) on the staff account page, and its route. The route is the
 * security-relevant part: a member edits only their own, so the member must come from the session and nothing in the body.
 */
const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, "../app/api/account/signature/route.ts"), "utf8");
const card = readFileSync(join(here, "../app/account/StaffSignature.tsx"), "utf8");
const account = readFileSync(join(here, "../app/account/StaffAccount.tsx"), "utf8");

describe("the signature route (R2: only their own)", () => {
  it("takes the member from the session, and never a user id from the request", () => {
    assert.match(route, /updateOwnStaffSignature\(isolatedPool\(\), \{ organisationId: staff\.organisationId, userId: staff\.userId \}/);
    assert.match(route, /readStaffSignature\(db, staff\.userId\)/);
    assert.doesNotMatch(route, /body\.userId|body\.organisationId|searchParams/, "nothing in the request names a member");
  });

  it("checks the origin before a save, and keeps every answer out of caches", () => {
    assert.match(route, /export async function PUT[\s\S]*?requireAuthOrigin\(request\);[\s\S]*?currentStaff\(request\)/);
    assert.equal((route.match(/headers: noStore/g) ?? []).length >= 4, true);
  });

  it("answers a refused value, a stale version and a missing record distinctly", () => {
    assert.match(route, /StaffSignatureError\) return Response\.json\(\{ code: "INVALID"[^}]*issues: error\.issues \}, \{ status: 422/);
    assert.match(route, /VersionConflictError\) return Response\.json\(\{ code: "VERSION_CONFLICT"[\s\S]*?status: 409/);
    assert.match(route, /code: "NOT_FOUND"[\s\S]*?status: 404/);
  });

  it("reports its own failure as the signature's, not as a failed sign-in", () => {
    assert.match(route, /response\.status === 500 \? Response\.json\(\{ code: "SIGNATURE_UNAVAILABLE", message \}/);
    assert.match(route, /failure\(error, "Your signature could not be saved just now — nothing was changed\."\)/);
    assert.doesNotMatch(route, /return authFailure\(error\)/, "every catch goes through the signature's own failure");
  });
});

describe("the Signature card on the account page", () => {
  it("is on the staff account page", () => {
    assert.match(account, /<StaffSignature\/>/);
  });

  it("previews the lines in the house chrome, in a frame with no permissions, as a send draws them", () => {
    assert.match(card, /<iframe className="nz-signature-preview" title="Preview of your email signature" sandbox="" srcDoc=\{emailSignatureDocument\(\{ \.\.\.loaded\.brand, person \}\)\} \/>/);
    assert.match(card, /const person = emailPersonFor\(loaded\.defaults, normaliseStaffSignature\(fields\)\)/);
    assert.doesNotMatch(card, /dangerouslySetInnerHTML/);
  });

  it("offers the four fields with their defaults as placeholders, and the name as read-only from the record", () => {
    for (const [key, label] of [["signOff", "Sign-off"], ["title", "Title"], ["displayEmail", "Email"], ["mobile", "Mobile UK"]]) {
      assert.match(card, new RegExp(`input\\("${key}", "${label}"`), key);
    }
    assert.match(card, /input\("signOff", "Sign-off", DEFAULT_SIGN_OFF\)/);
    assert.match(card, /input\("title", "Title", loaded\.defaults\.positionTitle/);
    assert.match(card, /Name: <b>\{loaded\.defaults\.name \?\? "—"\}<\/b> — from your Team &amp; access record\./);
  });

  it("shows loading and an unreadable signature as states, never as an empty form", () => {
    assert.match(card, /if \(loaded === null\) return <section className="nz-account-card" aria-busy="true">/);
    assert.match(card, /if \(loaded === "failed"\) return <section className="nz-account-card" role="alert">/);
  });
});
