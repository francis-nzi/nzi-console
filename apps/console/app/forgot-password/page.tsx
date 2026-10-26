import { NziMark } from "@nzi/ui";
import { ForgotPasswordForm, STAFF_RESET } from "../login/PasswordReset";

/**
 * Staff forgot password (email programme phase 4-1). Public, as the sign-in page is: the person has no session. It says
 * the same whatever address is typed, so it cannot be used to learn who has a staff account.
 */
export const dynamic = "force-dynamic";
export default function StaffForgotPasswordPage() {
  return <main className="nz-auth-shell">
    <section className="nz-auth-story"><div className="nz-auth-brand"><NziMark /><div><b>NZ Insights Pro</b><small>Staff console</small></div></div><div className="nz-auth-promise"><span className="nz-eyebrow light">Account recovery</span><h1>Back in with a new password.</h1><p>We email a single-use link to the address on your staff account. Your authenticator is not changed, so signing in still needs both.</p></div><small className="nz-auth-foot">NZI staff access · Protected by password and MFA</small></section>
    <section className="nz-auth-entry"><ForgotPasswordForm realm={STAFF_RESET} /></section>
  </main>;
}
