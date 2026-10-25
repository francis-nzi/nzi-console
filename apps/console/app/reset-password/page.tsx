import { NziMark } from "@nzi/ui";
import { ResetPasswordForm, STAFF_RESET } from "../login/PasswordReset";

/**
 * Staff set-a-new-password (email programme phase 4-1). Public: the reset link's token is the only key, and it travels in
 * the URL fragment — which the browser never sends to a server — so it cannot land in a request log.
 */
export const dynamic = "force-dynamic";
export default function StaffResetPasswordPage() {
  return <main className="nz-auth-shell">
    <section className="nz-auth-story"><div className="nz-auth-brand"><NziMark /><div><b>NZ Insights Pro</b><small>Staff console</small></div></div><div className="nz-auth-promise"><span className="nz-eyebrow light">Account recovery</span><h1>Choose a new password.</h1><p>Setting it signs your account out everywhere, so whoever might have had the old one is out too.</p></div><small className="nz-auth-foot">NZI staff access · Protected by password and MFA</small></section>
    <section className="nz-auth-entry"><ResetPasswordForm realm={STAFF_RESET} /></section>
  </main>;
}
