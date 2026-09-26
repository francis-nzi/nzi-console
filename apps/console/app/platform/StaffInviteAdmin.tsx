"use client";
import { FormEvent, useEffect, useState } from "react";

type Member = { userId: string; displayName: string; email: string | null; role: string; invitation: { state: "open" | "enrolled" | "revoked" | "expired"; at: string } | null };
type Invitation = { delivery: "link"; link: string; expiresAt: string } | { delivery: "email"; sentTo: string; expiresAt: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const stateLabel = (member: Member) => !member.invitation ? "no invitation on record"
  : member.invitation.state === "open" ? `invited — link valid until ${when(member.invitation.at)}`
  : member.invitation.state === "enrolled" ? `enrolled ${when(member.invitation.at)}`
  : member.invitation.state === "expired" ? "last link expired" : "last link withdrawn";

/**
 * Invite a member of the team to set up their own sign-in (matrix v8, `staff.invite`). Issues through the one enrolment
 * path (0129): the link is single-use and expires, the person sets their own password and authenticator, and nobody
 * here ever sees either. While mail is suppressed the link is shown once, to be delivered privately.
 */
export function StaffInviteAdmin() {
  const [members, setMembers] = useState<Member[] | null>(null), [loadError, setLoadError] = useState(""), [forbidden, setForbidden] = useState(false);
  const [userId, setUserId] = useState(""), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null), [copied, setCopied] = useState(false);

  const load = () => fetch("/api/isolated/staff-invitations", { cache: "no-store" })
    .then((response) => response.json().then((body) => ({ response, body })))
    .then(({ response, body }) => {
      if (response.status === 403) { setForbidden(true); return; }
      if (!response.ok || !Array.isArray(body.members)) throw new Error("The team roster is unavailable.");
      setMembers(body.members);
    })
    .catch((cause) => setLoadError(cause instanceof Error ? cause.message : "The team roster is unavailable."));
  useEffect(() => { void load(); }, []);

  const member = members?.find((item) => item.userId === userId) ?? null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending || !member) return;
    setPending(true); setError(""); setInvitation(null); setCopied(false);
    try {
      const response = await fetch("/api/isolated/staff-invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: member.userId }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The invitation could not be issued.");
      const issued = body.invitation;
      if (issued?.delivery === "link" && typeof issued.link === "string") setInvitation({ delivery: "link", link: issued.link, expiresAt: issued.expiresAt });
      else if (issued?.delivery === "email" && typeof issued.sentTo === "string") setInvitation({ delivery: "email", sentTo: issued.sentTo, expiresAt: issued.expiresAt });
      else throw new Error("The invitation service returned an invalid response.");
      void load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The invitation could not be issued."); }
    finally { setPending(false); }
  }
  async function copy() { if (invitation?.delivery !== "link") return; try { await navigator.clipboard.writeText(invitation.link); setCopied(true); } catch { setError("The link could not be copied automatically. Select and copy it manually."); } }

  return <section className="nz-panel nz-portal-invite-admin">
    <div className="nz-portal-invite-head"><div><span className="nz-eyebrow">Staff identity</span><h2>Invite a member of the team</h2><p className="sub">Choose someone on the roster. Creates a single-use enrolment link valid for 72 hours; they choose their own password and connect their own authenticator. Issuing again withdraws any earlier link.</p></div><span className="nz-st done">Admin only</span></div>
    {forbidden ? <div className="nz-table-empty">Inviting staff needs the <b>staff.invite</b> permission, which the Admin role holds.</div> : <>
      <form className="nz-portal-invite-form" onSubmit={submit}>
        <label className="nz-fl">Team member<select className="nz-inp" value={userId} onChange={(event) => { setUserId(event.target.value); setInvitation(null); setError(""); }} disabled={members === null || pending}>
          <option value="">{members === null ? (loadError || "Loading the roster…") : members.length === 0 ? "Nobody on the roster" : "Choose a member"}</option>
          {members?.map((item) => <option key={item.userId} value={item.userId}>{item.displayName} — {item.role} · {stateLabel(item)}</option>)}
        </select></label>
        <label className="nz-fl">Work address<input className="nz-inp" type="email" readOnly value={member?.email ?? ""} placeholder="From the roster" /></label>
        <button className="nz-btn pri" disabled={pending || !member?.email}>{pending ? "Issuing…" : member?.invitation?.state === "open" ? "Issue a new link" : "Issue enrolment link"}</button>
      </form>
      {member && !member.email ? <div className="nz-table-empty">{member.displayName} has no work address on the roster, so they cannot be invited yet.</div> : null}
      {loadError ? <div className="nz-banner warn" role="alert">{loadError}</div> : null}
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      {invitation?.delivery === "link" ? <div className="nz-invite-result" role="status"><div><span className="nz-eyebrow">Single-use link · shown once</span><b>Copy this link now and send it to them privately</b><p>Not in a shared channel. It works once, until {when(invitation.expiresAt)}; if it may have gone astray, issue a new one. It never reveals their password or authenticator.</p></div><output className="num">{invitation.link}</output><button type="button" className="nz-btn" onClick={copy}>{copied ? "Copied" : "Copy enrolment link"}</button></div> : null}
      {invitation?.delivery === "email" ? <div className="nz-invite-result" role="status"><div><span className="nz-eyebrow">Sent</span><b>The enrolment link went to {invitation.sentTo}</b><p>It works once, until {when(invitation.expiresAt)}. You do not hold the link.</p></div></div> : null}
    </>}
  </section>;
}
