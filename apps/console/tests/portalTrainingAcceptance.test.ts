import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * The client-portal Training tab and the public verify page. The rules worth holding: the
 * client is the session's own client and sees only its own slice of a person's history;
 * nothing is recomputed; nothing on either surface writes; and public verification cannot
 * be widened into a people-search.
 */
describe("client portal · training", () => {
  const view = read("apps/console/app/portal/training/PortalTraining.tsx");
  const route = read("apps/console/app/api/portal/training/route.ts");
  const model = read("packages/isolated-backend/src/portalTraining.ts");

  it("takes the client from the session, never from the URL", () => {
    assert.match(route, /currentPortalUserForData\(request\)/);
    assert.match(route, /clientId: user\.clientId/);
    assert.match(route, /withTenantRead\(isolatedPool\(\), user\.organisationId/);
    // No dynamic segment and no query parameter — there is no client in the URL to change.
    assert.doesNotMatch(route, /params/);
    assert.doesNotMatch(route, /searchParams/);
  });

  it("shows the client its own slice, never a person's cross-employer history", () => {
    assert.match(model, /entry\.employerClientId !== input\.clientId\) continue/);
    // And the page says so, so the client understands what they are not seeing.
    assert.match(view, /full training history — including anything taken\s*\n?\s*with a previous employer/);
  });

  it("reads the reviewed snapshot rather than recomputing the register", () => {
    assert.match(model, /FROM nzi_console\.training_run_snapshots/);
    assert.match(model, /DISTINCT ON \(s\.course_run_id\)[\s\S]*?snapshot_version DESC/);
    // An unreviewed run is absent, not provisional.
    assert.match(view, /confirmed its\s*\n?\s*attendance register/);
  });

  it("is read-only — the portal never books, records or issues", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.doesNotMatch(route, new RegExp(`export async function ${method}\\b`), method);
    }
    assert.doesNotMatch(view, /postBrowserCommand|putBrowserCommand|patchBrowserCommand/);
    assert.match(view, /booked with your NZI consultant/);
  });

  it("speaks the client's words over the same arithmetic as the staff register", () => {
    // Same function, different wording — so the two surfaces cannot quote different numbers.
    assert.match(model, /trainingPlaceGroups/);
    assert.match(view, /Expired \{formatDate\(expiry\.expiresAt\)\}/);
    assert.match(view, /went unused/);
    assert.match(view, /Yet to be taken/);
    // The staff register's mechanism wording must not leak into what the client reads.
    // Comments are stripped first: the file explains the split on purpose, and the check
    // is about the copy, not the commentary.
    const copy = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(copy, /Lapsed ·/);
    assert.doesNotMatch(copy, /Used or booked[\s\S]{0,40}consumed/i);
    // The legend says what a dot means in the client's terms, not the register's.
    assert.match(copy, /Booked, not yet delivered/);
    assert.match(copy, /Available to book/);
  });

  it("shows a headline that is the sum of the rows beneath it", () => {
    assert.match(view, /places\.reduce\(\(sum, group\) => \(\{/);
    assert.match(view, /sum\.available \+ group\.summary\.available/);
  });

  it("never invents a refresher date", () => {
    assert.match(read("packages/isolated-backend/migrations/0072_trainees_and_training_spine.sql"), /certificate_valid_months integer CHECK/);
    assert.match(model, /validMonths !== null && completedOn !== null/);
    assert.match(view, /only shown for courses that carry a renewal period/);
  });
});

describe("public certificate verification", () => {
  const migration = read("packages/isolated-backend/migrations/0072_trainees_and_training_spine.sql");
  const backend = read("packages/isolated-backend/src/certificateVerification.ts");
  const page = read("apps/console/app/verify/[verifyCode]/page.tsx");

  it("bounds what a stranger can read in the function, not in the caller", () => {
    assert.match(migration, /CREATE FUNCTION nzi_console\.verify_training_certificate\(p_verify_code text\)/);
    assert.match(migration, /SECURITY DEFINER SET search_path = nzi_console, pg_temp/);
    const returns = /RETURNS TABLE \(([\s\S]*?)\) LANGUAGE sql/.exec(migration)?.[1] ?? "";
    assert.ok(returns.length > 0, "the function must declare its return list");
    for (const field of ["email", "client_id", "employer", "phone", "address", "trainee_id"]) {
      assert.ok(!returns.includes(field), `verification must not return ${field}`);
    }
    assert.match(backend, /SELECT \* FROM nzi_console\.verify_training_certificate\(\$1\)/);
  });

  it("is reachable without a session, and only that path is", () => {
    const middleware = read("apps/console/middleware.ts");
    assert.match(middleware, /path\.startsWith\("\/verify\/"\)/);
    assert.doesNotMatch(middleware, /startsWith\("\/verify"\)[^/]/, "the prefix must include the slash");
  });

  it("cannot be used to enumerate certificates or confirm a guess", () => {
    // One answer for every miss, whatever the reason.
    assert.match(backend, /if \(trimmed === ""\) return \{ state: "not-found" \};/);
    assert.match(backend, /if \(!row\) return \{ state: "not-found" \};/);
    assert.match(page, /No certificate matches this code/);
    assert.doesNotMatch(page, /revoked and deleted|was deleted|no longer exists/i);
  });

  it("says a withdrawn certificate was withdrawn rather than hiding it", () => {
    assert.match(backend, /state: row\.status === "issued" \? "valid" : "revoked"/);
    assert.match(page, /This certificate was withdrawn/);
    assert.match(page, /a copy still in circulation can be recognised/);
  });

  it("distinguishes a failed lookup from an invalid certificate", () => {
    assert.match(page, /Verification is temporarily unavailable/);
    assert.match(page, /not a statement about the certificate/);
  });

  it("rate-limits the endpoint, because the function bounds reads and not requests", () => {
    // A 40-bit code on an unauthenticated page: no single hit discloses anything it
    // shouldn't, but an unlimited caller can discover which codes are real — which is
    // precisely what holding one is meant to prove.
    assert.match(page, /claimVerifyAttempt\(pool, address, salt\)/);
    assert.match(page, /claimVerifyMiss\(pool, address, salt\)/);
    // The overall budget is claimed BEFORE the lookup, so it is spent on asking.
    assert.match(page, /if \(!await claimVerifyAttempt[\s\S]{0,200}verifyTrainingCertificate/);
    // The refusal says nothing about the code that was tried.
    assert.match(page, /this says nothing about the certificate you were checking/i);
    assert.doesNotMatch(page, /that code was (wrong|invalid)/i);
  });

  it("derives the caller from the proxy's view, not the client's claim", () => {
    assert.match(page, /clientAddressFrom\(\(await headers\(\)\)\.get\("x-forwarded-for"\)/);
    assert.match(page, /NZI_TRUSTED_PROXY_HOPS/);
  });
});
