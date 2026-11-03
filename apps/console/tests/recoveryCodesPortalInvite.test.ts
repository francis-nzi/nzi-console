import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  it("the portal enrolment shows the recovery codes once and holds the way on until kept; staff enrolment shows none (RULING-remove-staff-recovery-codes)", () => {
    const staffEnrolment = read("app/enrol/StaffEnrolment.tsx");
    assert.doesNotMatch(staffEnrolment, /RecoveryCodes|recoveryCodes|saved these codes/i);
    assert.match(staffEnrolment, /<a className="nz-btn pri nz-auth-submit" href="\/login">Sign in<\/a>/, "completion enables Sign in directly");
    assert.match(staffEnrolment, /This link no longer works/, "the single-use confirmation stays");
    assert.match(read("app/portal/invite/PortalInviteSetup.tsx"), /<RecoveryCodesPanel codes=\{codes\} continueHref="\/portal\/login" continueLabel="Sign in securely" \/>/);
    const panel = read("app/login/RecoveryCodes.tsx");
    assert.match(panel, /I have saved these codes somewhere safe/);
    assert.match(panel, /href=\{kept \? continueHref : undefined\}/);
  });

  it("the portal sign-in accepts a recovery code at the MFA step and says how many are left; the staff sign-in offers none", () => {
    const portal = read("app/portal/login/PortalLoginForm.tsx");
    assert.match(portal, /<MfaCodeField pending=\{pending\} recovery=\{recovery\}/);
    assert.match(portal, /if\(typeof body\.recoveryCodesRemaining==="number"\)\{setRecovered\(body\.recoveryCodesRemaining\);return\}/);
    assert.ok(portal.includes('accountHref="/portal/account"'));
    assert.match(read("app/api/portal/auth/mfa/route.ts"), /onRecoveryCode/);
    assert.doesNotMatch(read("app/login/LoginForm.tsx"), /recovery|RecoveredNotice|MfaCodeField/i, "the staff MFA step has no recovery-code option");
    assert.doesNotMatch(read("app/api/auth/mfa/route.ts"), /recovery/i);
  });

  it("the portal account page makes a new set, and the route behind it sits on the signed-in session; the staff account page and route are gone", () => {
    assert.doesNotMatch(read("app/account/StaffAccount.tsx"), /AccountRecoveryCodes|recovery-codes/);
    assert.ok(!existsSync(join(here, "..", "app/api/auth/recovery-codes/route.ts")), "the staff recovery-codes route still exists");
    assert.match(read("app/portal/account/PortalAccount.tsx"), /<AccountRecoveryCodes endpoint="\/api\/portal\/auth\/recovery-codes" \/>/);
    const routes = read("app/lib/recoveryCodeRoutes.ts");
    assert.doesNotMatch(routes, /currentStaff/, "no staff realm");
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
