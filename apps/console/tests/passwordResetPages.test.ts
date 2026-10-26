import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Forgot password on both sign-ins (email programme phase 4-1): the routes say the same thing whatever the address and take
 * at least the same time doing it; the pages are reachable without a session; and both sign-in forms point to them, while
 * a lost authenticator still goes to the governed recovery path.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const routes = read("app/lib/passwordResetRoutes.ts");
const middleware = read("middleware.ts");

describe("forgot password (phase 4-1)", () => {
  it("answers every request alike: one body, 202, after a common floor — on the account path and the no-account path", () => {
    assert.match(routes, /const REQUESTED = \{ requested: true, message: "If that address has an account, a link to reset its password is on its way\. It works once, for an hour\." \};/);
    assert.equal((routes.match(/return Response\.json\(REQUESTED, \{ status: 202, headers: noStore \}\);/g) ?? []).length, 1, "one success answer, not one per outcome");
    // The floor is awaited before the success answer and before every failure answer.
    const request = routes.slice(routes.indexOf("export function resetRequestRoute"), routes.indexOf("export function resetCompleteRoute"));
    assert.equal((request.match(/await floor\(startedAt\);/g) ?? []).length, 2);
    assert.ok(request.indexOf("await floor(startedAt);") < request.indexOf("return Response.json(REQUESTED"));
    assert.match(routes, /export const RESPONSE_FLOOR_MS = 700;/);
  });

  it("puts each realm's routes behind its own sign-in switch and origin check, as each login does", () => {
    assert.match(routes, /staff: \{ enabled: requireAuthEnabled, origin: requireAuthOrigin, failure: authFailure \}/);
    assert.match(routes, /portal: \{ enabled: requirePortalAuthEnabled, origin: requirePortalOrigin, failure: portalAuthFailure \}/);
    for (const [path, call] of [
      ["app/api/auth/password-reset/request/route.ts", `resetRequestRoute("staff")`], ["app/api/auth/password-reset/complete/route.ts", `resetCompleteRoute("staff")`],
      ["app/api/portal/auth/password-reset/request/route.ts", `resetRequestRoute("portal")`], ["app/api/portal/auth/password-reset/complete/route.ts", `resetCompleteRoute("portal")`],
    ]) assert.ok(read(path!).includes(`export const POST = ${call};`), path);
  });

  it("serves the four pages to someone with no session — and the portal's account-recovery page, which the sign-in links to", () => {
    for (const page of ["app/forgot-password/page.tsx", "app/reset-password/page.tsx", "app/portal/forgot-password/page.tsx", "app/portal/reset-password/page.tsx"]) {
      assert.ok(existsSync(join(here, "..", page)), page);
    }
    assert.match(middleware, /path === "\/forgot-password" \|\| path === "\/reset-password"/);
    assert.match(middleware, /path==="\/portal\/recover"\|\|path==="\/portal\/forgot-password"\|\|path==="\/portal\/reset-password"/);
  });

  it("links Forgot password from both sign-in forms; a lost authenticator still goes to the governed process", () => {
    const staff = read("app/login/LoginForm.tsx"), portal = read("app/portal/login/PortalLoginForm.tsx");
    assert.match(staff, /<a href="\/forgot-password">Reset it by email<\/a>/);
    assert.match(portal, /<a href="\/portal\/forgot-password">Reset it by email<\/a>/);
    // 4-2 puts recovery codes first at the MFA step; the governed process stays as the way when there is no code.
    for (const form of [staff, portal]) assert.match(form, /Use one of the recovery codes you saved[^<]*an authenticator can only be replaced through the governed/);
  });

  it("takes the reset token from the URL fragment and clears it from the address bar", () => {
    const forms = read("app/login/PasswordReset.tsx");
    assert.match(forms, /window\.history\.replaceState\(null, "", window\.location\.pathname\)/);
    assert.match(forms, /new URLSearchParams\(window\.location\.hash\.replace\(\/\^#\/, ""\)\)\.get\("token"\)/);
  });
});
