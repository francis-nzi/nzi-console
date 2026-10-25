import { NziMark } from "@nzi/ui";
import { ForgotPasswordForm, PORTAL_RESET } from "../../login/PasswordReset";

/**
 * Client portal forgot password (email programme phase 4-1). Public; says the same whatever address is typed, so it cannot
 * be used to learn who has a portal account. A lost authenticator is not this page's: that is account recovery.
 */
export const dynamic = "force-dynamic";
export default function PortalForgotPasswordPage() {
  return <main className="nz-auth-shell">
    <section className="nz-auth-story"><div className="nz-auth-brand"><NziMark /><div><b>NZ Insights Pro</b><small>Client portal</small></div></div><div className="nz-auth-promise"><span className="nz-eyebrow light">Account recovery</span><h1>Back in with a new password.</h1><p>We email a single-use link to the address on your portal account. Your authenticator is not changed, so signing in still needs both.</p></div><small className="nz-auth-foot">Authorised client access · Protected by password and MFA</small></section>
    <section className="nz-auth-entry"><ForgotPasswordForm realm={PORTAL_RESET} /><a className="nz-auth-secondary" href="/portal/recover" style={{ marginTop: 18, textAlign: "center" }}>Lost your authenticator? Start account recovery</a></section>
  </main>;
}
