import { TraineeLoginForm } from "./TraineeLoginForm";

const REASON_MESSAGE: Record<string, string> = {
  "session-ended": "Your session ended. Sign in again to continue.",
  idle: "You were signed out after a period of inactivity. Sign in again to continue.",
  "email-changed": "Your sign-in address has been updated. Sign in with your new email.",
};

export default async function TraineeLoginPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  const message = reason ? REASON_MESSAGE[reason] : undefined;
  return <main className="nz-auth-shell">
    <section className="nz-auth-story">
      <div className="nz-auth-brand"><span>N</span><div><b>NZI Pro</b><small>Trainee portal</small></div></div>
      <div className="nz-auth-promise">
        <span className="nz-eyebrow light">Your training, your record</span>
        <h1>Training you keep, wherever you go next.</h1>
        <p>Everything you have trained on with NZI, in one place — across every employer, with certificates anyone can verify.</p>
      </div>
      <small className="nz-auth-foot">Your personal account · Protected by password and MFA</small>
    </section>
    <section className="nz-auth-entry">
      {message ? <div className="nz-banner warn" role="status" style={{ marginBottom: 14 }}>{message}</div> : null}
      <TraineeLoginForm />
    </section>
  </main>;
}
