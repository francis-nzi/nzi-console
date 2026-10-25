import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Email programme phase 4-2 on screen: recovery codes shown once at both enrolments and made again on both account pages,
 * accepted at both sign-ins' MFA step; the portal accept page held to staff enrolment's standard; and the portal invitation
 * emailed by default, with links that carry their token in the fragment.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");

describe("MFA recovery codes and the portal invitation (phase 4-2)", () => {
  it("both enrolments show the recovery codes once, and hold the way on until the person says they kept them", () => {
    assert.match(read("app/enrol/StaffEnrolment.tsx"), /<RecoveryCodesPanel codes=\{codes\} continueHref="\/login" \/>/);
    assert.match(read("app/portal/invite/PortalInviteSetup.tsx"), /<RecoveryCodesPanel codes=\{codes\} continueHref="\/portal\/login" continueLabel="Sign in securely" \/>/);
    const panel = read("app/login/RecoveryCodes.tsx");
    assert.match(panel, /I have saved these codes somewhere safe/);
    assert.match(panel, /href=\{kept \? continueHref : undefined\}/);
  });

  it("both sign-ins accept a recovery code at the MFA step, and say how many are left after one is used", () => {
    for (const [form, account] of [["app/login/LoginForm.tsx", "/account"], ["app/portal/login/PortalLoginForm.tsx", "/portal/account"]] as const) {
      const source = read(form);
      assert.match(source, /<MfaCodeField pending=\{pending\} recovery=\{recovery\}/, form);
      assert.match(source, /if\(typeof body\.recoveryCodesRemaining==="number"\)\{setRecovered\(body\.recoveryCodesRemaining\);return\}/, form);
      assert.ok(source.includes(`accountHref="${account}"`), form);
    }
    for (const route of ["app/api/auth/mfa/route.ts", "app/api/portal/auth/mfa/route.ts"]) assert.match(read(route), /onRecoveryCode/, route);
  });

  it("both account pages make a new set, and the routes behind them sit on the signed-in session", () => {
    assert.match(read("app/account/StaffAccount.tsx"), /<AccountRecoveryCodes endpoint="\/api\/auth\/recovery-codes"\/>/);
    assert.match(read("app/portal/account/PortalAccount.tsx"), /<AccountRecoveryCodes endpoint="\/api\/portal\/auth\/recovery-codes" \/>/);
    const routes = read("app/lib/recoveryCodeRoutes.ts");
    assert.match(routes, /const staff = await currentStaff\(request\)/);
    assert.match(routes, /const user = await currentPortalUser\(request\)/);
  });

  it("the portal accept page reads its token from the fragment, accepts an older query link, and shows a QR code", () => {
    const setup = read("app/portal/invite/PortalInviteSetup.tsx");
    assert.match(setup, /setToken\(takeTokenFromFragment\(\) \|\| queryToken\)/);
    assert.match(setup, /window\.history\.replaceState\(null, "", window\.location\.pathname\)/);
    assert.match(setup, /<QRCodeSVG value=\{setup\.otpauthUri\}/);
    assert.match(setup, /name="confirmPassword"/);
  });

  it("the portal invitation is emailed by default, and no admin screen builds a query-string token link", () => {
    const invite = read("app/platform/PortalInviteAdmin.tsx"), access = read("app/platform/PortalAccessAdmin.tsx");
    assert.match(invite, /void invite\("email"\)/);
    assert.match(invite, /issue a link to copy instead/);
    for (const source of [invite, access]) assert.doesNotMatch(source, /portal\/invite\?token=/);
    assert.match(access, /setRecoveryLink\(link\)/);
  });
});
