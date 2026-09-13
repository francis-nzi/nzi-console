import { ConfirmEmailChange } from "./ConfirmEmailChange";

export const dynamic = "force-dynamic";

/**
 * Where the verification link lands. It takes no session: the person opening this from
 * their new inbox may well not be signed in, and requiring it would defeat the point of
 * verifying the new address at all.
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <main className="nz-auth-shell">
    <section className="nz-auth-story">
      <div className="nz-auth-brand"><span>N</span><div><b>NZI Pro</b><small>Trainee portal</small></div></div>
      <div className="nz-auth-promise">
        <span className="nz-eyebrow light">One last step</span>
        <h1>Confirm your new email.</h1>
        <p>Your current address stays your sign-in until you confirm this one, so nothing breaks if it was mistyped.</p>
      </div>
    </section>
    <section className="nz-auth-entry"><ConfirmEmailChange token={token ?? ""} /></section>
  </main>;
}
