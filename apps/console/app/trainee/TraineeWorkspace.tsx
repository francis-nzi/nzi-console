"use client";

/**
 * The trainee portal — one person's own view of their training.
 *
 * The mirror image of the client-portal tab, on purpose. An employer sees its own slice of
 * many people; a person sees all of themselves, across every employer. Past courses stay
 * attributed to whoever arranged them, so changing jobs updates where you work, never what
 * you did.
 *
 * Read-only on the training facts, which come from reviewed run snapshots. The only things
 * editable here are the person's own details and consent — and the sign-in email is not one
 * of them: changing that goes through verification first, so a mistyped address locks
 * nobody out.
 */

import { useCallback, useEffect, useState } from "react";
import { NziIcon } from "@nzi/ui";
import type { TraineePortalReadModel, TraineeTrainingEntry, TraineeUpcomingSession } from "@nzi/isolated-backend";
import { formatDate } from "../lib/formatDate";

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; model: TraineePortalReadModel };

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";

export function TraineeWorkspace() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/trainee/training", { cache: "no-store" });
      if (response.status === 401) { window.location.assign("/trainee/login?reason=session-ended"); return; }
      if (!response.ok) { setState({ kind: "failed", message: "Your training record could not be loaded." }); return; }
      setState({ kind: "ready", model: await response.json() as TraineePortalReadModel });
    } catch (cause) {
      setState({ kind: "failed", message: cause instanceof Error ? cause.message : "Your training record could not be loaded." });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state.kind === "loading") {
    return <div className="nz-portal-state loading" role="status"><i>↻</i><div>
      <b>Loading your training record</b><span>Reading everything you have trained on with NZI…</span>
    </div></div>;
  }
  if (state.kind === "failed") {
    return <div className="nz-portal-state failed" role="alert"><i>!</i><div>
      <b>Your training record is temporarily unavailable</b>
      <span>{state.message} Nothing has been estimated or filled in.</span>
      <button className="nz-btn" onClick={() => void load()}>Try again</button>
    </div></div>;
  }

  const { details, completed, inProgress, upcoming } = state.model;

  return <>
    <header className="nz-portal-header"><div className="nz-portal-header-inner">
      <a className="nz-portal-brand" href="/trainee"><span>N</span><div><b>NZ Insights Pro</b><small>Trainee portal</small></div></a>
      <div className="nz-portal-user">
        <div><b>{details.fullName}</b><small>{details.email}</small></div>
        <button onClick={async () => { await fetch("/api/trainee/auth/logout", { method: "POST" }); window.location.assign("/trainee/login"); }}>Sign out</button>
      </div>
    </div></header>

    <section className="nz-portal-shell" id="trainee-main-content" tabIndex={-1}>
      <div className="nz-tr-head">
        <div className="nz-tr-avatar" aria-hidden="true">{initials(details.fullName)}</div>
        <div>
          <h1>Your training</h1>
          <p className="sub">{details.fullName} · everything you have trained on, in one place</p>
        </div>
      </div>

      {notice ? <div className="nz-banner ok" role="status">{notice}</div> : null}

      {/* The load-bearing promise of a person-centric record, said plainly. */}
      <div className="nz-tr-portable">
        <NziIcon name="shield" size={18} />
        <span>
          <b>This training is yours to keep.</b> If you change jobs, your certificates and history stay with
          you — update your details here and they move with you. Past courses stay recorded against the
          employer who arranged them.
        </span>
      </div>

      {completed.length === 0 && inProgress.length === 0
        ? <div className="nz-portal-state" role="status"><i>◈</i><div>
          <b>Nothing recorded yet</b>
          <span>Once you have been booked onto a course, it will appear here — and your certificate with it.</span>
        </div></div>
        : null}

      {completed.length > 0 ? <>
        <h2 className="nz-pt-section"><NziIcon name="award" size={15} /> Completed</h2>
        {completed.map((entry) => <TrainingCard entry={entry} key={entry.courseRunId} />)}
      </> : null}

      {inProgress.length > 0 ? <>
        <h2 className="nz-pt-section"><NziIcon name="calendar" size={15} /> In progress</h2>
        {inProgress.map((entry) => <TrainingCard entry={entry} key={entry.courseRunId} />)}
      </> : null}

      {upcoming.length > 0 ? <>
        <h2 className="nz-pt-section"><NziIcon name="calendar" size={15} /> Upcoming schedule</h2>
        <div className="nz-panel">{upcoming.map((session) => <UpcomingRow session={session} key={session.sessionId} />)}</div>
      </> : null}

      <MyDetails details={details} onSaved={(message) => { setNotice(message); void load(); }} />
    </section>
  </>;
}

function TrainingCard({ entry }: { entry: TraineeTrainingEntry }) {
  return <article className="nz-tr-card">
    <span className="nz-tr-card-icon"><NziIcon name="award" size={20} /></span>
    <div className="nz-tr-card-body">
      <h3>{entry.courseName}</h3>
      <div className="sub">
        {entry.completedOn ? <>Completed {formatDate(entry.completedOn)} · </> : null}
        {entry.sessionsTotal} session{entry.sessionsTotal === 1 ? "" : "s"}
        {entry.standing === "confirmed" ? <> · {entry.attendancePct}% attendance</> : <> · {entry.sessionsAttended} attended</>}
        {entry.cpdHours !== null ? <> · {entry.cpdHours} CPD hours</> : null}
      </div>
      <div className="nz-tr-card-emp">
        Arranged by <b>{entry.employerName ?? "an employer"}</b>
        {/* A previous employer is a fact about the training, not a caveat about the person. */}
        {entry.employerName !== null && !entry.employerIsCurrent ? <span className="muted"> (previous employer)</span> : null}
        {" · delivered by NZI"}
      </div>
    </div>
    <div className="nz-tr-card-act">
      {entry.certificate
        ? <>
          <span className="nz-tr-pill ok"><NziIcon name="check" size={12} /> Certificate issued</span>
          <a className="nz-editlink" href={`/verify/${encodeURIComponent(entry.certificate.verifyCode)}`}>
            <NziIcon name="award" size={13} /> View &amp; verify
          </a>
        </>
        : <span className={entry.standing === "confirmed" ? "nz-tr-pill" : "nz-tr-pill warn"}>{entry.remaining}</span>}
    </div>
  </article>;
}

function UpcomingRow({ session }: { session: TraineeUpcomingSession }) {
  return <div className="nz-session">
    <div className="nz-session-date">
      <b>{formatDate(session.sessionDate).slice(0, 2)}</b>
      <span>{new Date(`${session.sessionDate}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}</span>
    </div>
    <div className="nz-session-main">
      <div className="nm">{session.courseName}{session.sessionTitle ? ` — ${session.sessionTitle}` : ""}</div>
      <div className="sub">
        {session.startTime && session.endTime ? `${session.startTime.slice(0, 5)}–${session.endTime.slice(0, 5)} · ` : null}
        {session.deliveryMode === "online"
          // The link is issued near the session, so the page says whether one exists rather
          // than handing it over days early.
          ? <>Online{session.hasJoiningLink ? " · joining link available shortly before" : " · joining link to follow"}</>
          : session.venueName ?? "In person"}
      </div>
    </div>
  </div>;
}

function MyDetails({ details, onSaved }: { details: TraineePortalReadModel["details"]; onSaved: (message: string) => void }) {
  const [fullName, setFullName] = useState(details.fullName);
  const [phone, setPhone] = useState(details.phone ?? "");
  const [employer, setEmployer] = useState(details.currentEmployerName ?? "");
  const [consent, setConsent] = useState(details.marketingConsent);
  const [newEmail, setNewEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return <>
    <h2 className="nz-pt-section"><NziIcon name="person" size={15} /> My details</h2>
    <div className="nz-panel"><div className="nz-card-b nz-tr-form">
      <label className="nz-fl"><span>Full name</span><input className="nz-inp" value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
      <label className="nz-fl"><span>Phone</span><input className="nz-inp" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
      <label className="nz-fl">
        <span>Where you work now</span>
        <input className="nz-inp" value={employer} onChange={(event) => setEmployer(event.target.value)} placeholder="Your current employer" />
        <small className="hint">Updating this never changes who arranged your past training.</small>
      </label>
      <label className="nz-fl">
        <span>Course-related messages</span>
        <select className="nz-sel" value={consent} onChange={(event) => setConsent(event.target.value as typeof consent)}>
          {/* "Not answered" stays selectable-in-appearance but is never a choice you can
              save: an unanswered question is not the same as a no. */}
          <option value="unknown" disabled>Not answered yet</option>
          <option value="granted">Yes, keep me posted</option>
          <option value="declined">No, course essentials only</option>
        </select>
      </label>

      <div className="nz-fl nz-tr-email">
        <span>Sign-in email</span>
        <div className="nz-tr-email-current">{details.email}</div>
        {details.pendingEmail
          ? <div className="nz-banner warn" role="status">
            A change to <b>{details.pendingEmail}</b> is waiting to be verified. Your current address stays your
            sign-in until you confirm the new one.
          </div>
          : <>
            <input className="nz-inp" type="email" value={newEmail} placeholder="New email address" onChange={(event) => setNewEmail(event.target.value)} />
            <small className="hint">Changing this needs verification — we send a link to the new address, and it becomes your sign-in only once you confirm it.</small>
          </>}
      </div>
    </div>

      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}

      <div className="nz-card-b nz-run-actions">
        <a className="nz-btn" href="/api/trainee/export" download>
          <NziIcon name="download" size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />Export my data
        </a>
        <span className="sp" style={{ flex: 1 }} />
        {!details.pendingEmail && newEmail.trim() ? <button className="nz-btn" disabled={pending} onClick={async () => {
          setPending(true); setError(null);
          try {
            const response = await fetch("/api/trainee/email-change", {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newEmail }),
            });
            const body = await response.json() as { message?: string };
            if (!response.ok) { setError(body.message ?? "That change could not be requested."); return; }
            setNewEmail("");
            onSaved("Check your new address — your sign-in changes only once you confirm it there.");
          } finally { setPending(false); }
        }}>Verify new email</button> : null}
        <button className="nz-btn pri" disabled={pending} onClick={async () => {
          setPending(true); setError(null);
          try {
            const response = await fetch("/api/trainee/details", {
              method: "PATCH", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                fullName, phone, currentEmployerName: employer,
                // An unanswered consent is left unanswered rather than saved as a decision.
                marketingConsent: consent === "unknown" ? undefined : consent,
              }),
            });
            const body = await response.json() as { message?: string };
            if (!response.ok) { setError(body.message ?? "Your details could not be saved."); return; }
            onSaved("Your details are saved.");
          } finally { setPending(false); }
        }}>Save changes</button>
      </div>
    </div>
    <p className="hint nz-pt-note">
      Export my data gives you a copy of everything held about you — your details, bookings, attendance and
      certificates — which is your right under UK GDPR.
    </p>
  </>;
}
