import { StaffEnrolment } from "./StaffEnrolment";

/**
 * Staff enrolment (0129). Public, because the person has no session yet; the invitation token is the only key, and it
 * travels in the URL fragment — which the browser never sends to a server — so it cannot land in a request log.
 */
export const dynamic = "force-dynamic";
export default function StaffEnrolmentPage() {
  return <main className="nz-invite-shell">
    <header className="nz-account-header"><a href="/login" className="nz-portal-brand"><span>N</span><div><b>NZ Insights Pro</b><small>Staff console</small></div></a><span className="nz-invite-secure">Secure staff enrolment</span></header>
    <section className="nz-invite-layout">
      <aside className="nz-invite-story"><span className="nz-eyebrow light">Welcome to NZ Insights Pro</span><h1>Set up your own sign-in.</h1><p>Your password and your authenticator are yours alone: nobody at NZI sees either, and nothing can sign in until you confirm a code.</p><ol><li><b>1</b><span><strong>Create password</strong><small>At least 12 characters, not used anywhere else</small></span></li><li><b>2</b><span><strong>Connect authenticator</strong><small>Confirm it with a six-digit code</small></span></li><li><b>3</b><span><strong>Sign in</strong><small>With your email, password and a code</small></span></li></ol></aside>
      <StaffEnrolment />
    </section>
  </main>;
}
