import { NziMark } from "@nzi/ui";
import { PORTAL_RESET, ResetPasswordForm } from "../../login/PasswordReset";

/**
 * Client portal set-a-new-password (email programme phase 4-1). Public: the reset link's token is the only key, carried in
 * the URL fragment so it never reaches a server log.
 */
export const dynamic = "force-dynamic";
export default function PortalResetPasswordPage() {
  return <main className="nz-auth-shell">
    <section className="nz-auth-story"><div className="nz-auth-brand"><NziMark /><div><b>NZ Insights Pro</b><small>Client portal</small></div></div><div className="nz-auth-promise"><span className="nz-eyebrow light">Account recovery</span><h1>Choose a new password.</h1><p>Setting it signs your account out everywhere, so whoever might have had the old one is out too.</p></div><small className="nz-auth-foot">Authorised client access · Protected by password and MFA</small></section>
    <section className="nz-auth-entry"><ResetPasswordForm realm={PORTAL_RESET} /></section>
  </main>;
}
