import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * The trainee portal — the third identity realm.
 *
 * The rules worth holding: it is a realm of its own and cannot be reached with another
 * realm's session; the person is the session, never a parameter; a person sees all of
 * themselves where a client sees only its slice; a change of job never rewrites history;
 * and changing the sign-in email needs the new address verified first.
 */
describe("trainee portal", () => {
  const middleware = read("apps/console/middleware.ts");
  const session = read("apps/console/app/lib/traineeSession.ts");
  const model = read("packages/isolated-backend/src/traineePortal.ts");
  const workspace = read("apps/console/app/trainee/TraineeWorkspace.tsx");
  const trainingRoute = read("apps/console/app/api/trainee/training/route.ts");
  const detailsRoute = read("apps/console/app/api/trainee/details/route.ts");
  const emailRoute = read("apps/console/app/api/trainee/email-change/route.ts");

  it("is a realm of its own — own cookie, own secret, own discriminator", () => {
    assert.match(session, /TRAINEE_SESSION_COOKIE = "nzi_trainee_session"/);
    assert.match(session, /NZI_TRAINEE_SESSION_SECRET/);
    // The middleware verifies the principal, so a portal token cannot be replayed here
    // even if both secrets were ever set to the same value.
    assert.match(middleware, /session\.principal==="trainee"/);
    assert.match(middleware, /session\.principal==="portal"/);
    assert.match(middleware, /nzi_trainee_session/);
    // Each realm keeps its own failure shape, so no route clears the wrong cookie.
    const auth = read("apps/console/app/lib/authResponse.ts");
    assert.match(auth, /export function traineeAuthFailure/);
    assert.match(auth, /TRAINEE_SESSION_ENDED[\s\S]{0,200}clearTraineeSessionCookie\(\)/);
  });

  it("takes the person from the session, never from the URL", () => {
    assert.match(trainingRoute, /currentTrainee\(request\)/);
    assert.match(trainingRoute, /traineeId: trainee\.traineeId/);
    assert.doesNotMatch(trainingRoute, /params|searchParams/);
    assert.match(model, /WHERE b\.trainee_id=\$1/);
    // And the page holds no identity of its own either.
    assert.doesNotMatch(read("apps/console/app/trainee/page.tsx"), /params/);
  });

  it("lets the sign-in page and the verification link through, and nothing else", () => {
    assert.match(middleware, /path==="\/trainee\/login"\|\|path==="\/trainee\/verify-email"\|\|path\.startsWith\("\/api\/trainee\/auth\/"\)/);
    // Confirming is part of that link, so the PUT is allowed unsigned — and only the PUT.
    assert.match(middleware, /path==="\/api\/trainee\/email-change"&&request\.method==="PUT"/);
    assert.match(emailRoute, /export async function POST[\s\S]{0,400}currentTrainee\(request\)/, "requesting a change needs a session");
  });

  it("shows a person all of themselves, where a client sees only its slice", () => {
    // The client-portal model filters on the employer; this one deliberately does not.
    assert.match(read("packages/isolated-backend/src/portalTraining.ts"), /employerClientId !== input\.clientId/);
    assert.doesNotMatch(model, /employerClientId !== |client_id=\$/);
    assert.match(workspace, /across every employer/);
  });

  it("keeps past training attributed to whoever arranged it", () => {
    assert.match(model, /never re-read from the person's\s*\n?\s*\*? ?current employer/);
    assert.match(model, /employerIsCurrent/);
    // Naming a new employer clears the stale client link rather than leaving it attached.
    const auth = read("packages/isolated-backend/src/traineeAuth.ts");
    assert.match(auth, /current_employer_client_id = CASE WHEN \$5::text IS NULL THEN current_employer_client_id ELSE NULL END/);
    assert.match(workspace, /Updating this never changes who arranged your past training/);
  });

  it("cannot restate a training fact from the person's own routes", () => {
    // The grant is the boundary: the self-serve realm may write who you are, never what
    // you attended, who paid, or which employer arranged it.
    const migration = read("packages/isolated-backend/migrations/0072_trainees_and_training_spine.sql");
    const grant = /GRANT UPDATE \(([\s\S]*?)\) ON nzi_console\.trainees TO nzi_console_auth;/.exec(migration)?.[1] ?? "";
    assert.ok(grant.includes("full_name") && grant.includes("marketing_consent"), "the person maintains their own record");
    for (const field of ["attendance", "certificate", "entitlement", "booking"]) {
      assert.ok(!grant.includes(field), `the self-serve grant must not reach ${field}`);
    }
    assert.doesNotMatch(detailsRoute, /attendance|certificate|entitlement/i);
  });

  it("changes the sign-in email only once the new address is confirmed", () => {
    const auth = read("packages/isolated-backend/src/traineeAuth.ts");
    // The row is written as a pending change; the trainee's own email is untouched until PUT.
    assert.match(auth, /INSERT INTO nzi_console\.trainee_email_changes/);
    assert.match(auth, /confirmTraineeEmailChange[\s\S]*?UPDATE nzi_console\.trainees SET personal_email=\$3/);
    assert.match(auth, /confirmTraineeEmailChange[\s\S]*?UPDATE nzi_console\.trainee_sessions SET revoked_at=now\(\)/, "confirming signs them out everywhere");
    // The details route cannot touch the email at all — there is one path, and it verifies.
    assert.doesNotMatch(detailsRoute, /personalEmail|newEmail|email:/);
    assert.match(workspace, /becomes your sign-in only once you confirm it/);
  });

  it("never treats an unanswered consent as a decision", () => {
    assert.match(model, /Three states, not a checkbox/);
    assert.match(workspace, /marketingConsent: consent === "unknown" \? undefined : consent/);
    assert.match(detailsRoute, /body\.marketingConsent === "granted" \|\| body\.marketingConsent === "declined"/);
  });

  it("does not hand out a joining link days early", () => {
    assert.match(model, /hasJoiningLink/);
    assert.doesNotMatch(model, /onlineMeetingUrl:/, "the URL itself never reaches the page");
    assert.match(workspace, /joining link available shortly before/);
  });

  it("exports exactly what the person can already read", () => {
    const exportRoute = read("apps/console/app/api/trainee/export/route.ts");
    assert.match(exportRoute, /getTraineePortal\(db, \{ traineeId: trainee\.traineeId/);
    assert.match(exportRoute, /Content-Disposition/);
    assert.match(exportRoute, /the same read model the page renders/);
  });
});
