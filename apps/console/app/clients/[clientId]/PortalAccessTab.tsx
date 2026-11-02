"use client";

import { useCallback, useEffect, useState } from "react";
import { putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  instantFromPlatformDateTimeLocal, PORTAL_PAYMENT_STATUSES, PORTAL_PAYMENT_STATUS_LABELS, platformDateTimeLocal,
  type PortalAccessDecision, type PortalClientAccess, type PortalClientAccessChanges, type PortalClientAccessView, type PortalLoginEventRecord, type PortalPaymentStatus,
} from "@nzi/contracts";
import { formatDateTime } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { PmSwitch } from "./PmSwitch";

/**
 * Portal Management → Access (DESIGN-portal-management; RULING-portal-access-model): the client-level master switch and the V7-parity
 * record around it — enable, trained, expiry, number of users, payment status and reference, notes — with the decision log and the
 * sign-in history. It replaces the old "Portal access" drawer.
 *
 * The switch and the expiry are *enforced*, not recorded: off (or past its expiry) blocks every user of this client at sign-in and
 * signs them out, and a client with no record is on. So switching off asks for a confirmation that says exactly that, and an
 * expiry that has already passed is warned about before it is saved. The cap is informational (it never blocks an invitation) and
 * payment gates nothing.
 */
export type PortalAccessLoad = { state: "loading" } | { state: "denied" } | { state: "failed" } | { state: "ready"; view: PortalClientAccessView };

type Draft = { enabled: boolean; trained: boolean; expires: string; userCap: string; paymentStatus: "" | PortalPaymentStatus; paymentRef: string; notes: string };
const draftOf = (access: PortalClientAccess): Draft => ({
  enabled: access.enabled, trained: access.trained, expires: access.expiresAt ? platformDateTimeLocal(access.expiresAt) : "", userCap: access.userCap === null ? "" : String(access.userCap),
  paymentStatus: access.paymentStatus ?? "", paymentRef: access.paymentRef ?? "", notes: access.notes,
});
const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

/** The save's changes against what is stored, or a field error. Nothing is sent that did not change. */
export function accessChanges(access: PortalClientAccess, draft: Draft): { changes: PortalClientAccessChanges } | { error: string } {
  const changes: PortalClientAccessChanges = {};
  if (draft.enabled !== access.enabled) changes.enabled = draft.enabled;
  if (draft.trained !== access.trained) changes.trained = draft.trained;
  const expiresAt = draft.expires.trim() === "" ? null : instantFromPlatformDateTimeLocal(draft.expires);
  if (draft.expires.trim() !== "" && expiresAt === null) return { error: "That expiry isn't a valid date and time." };
  if ((expiresAt === null ? null : new Date(expiresAt).toISOString()) !== (access.expiresAt === null ? null : new Date(access.expiresAt).toISOString())) changes.expiresAt = expiresAt;
  const cap = draft.userCap.trim() === "" ? null : Number(draft.userCap);
  if (cap !== null && !(Number.isInteger(cap) && cap >= 0)) return { error: "The number of users is a whole number, or blank." };
  if (cap !== access.userCap) changes.userCap = cap;
  const status = draft.paymentStatus === "" ? null : draft.paymentStatus;
  if (status !== access.paymentStatus) changes.paymentStatus = status;
  const ref = draft.paymentRef.trim() === "" ? null : draft.paymentRef.trim();
  if (ref !== access.paymentRef) changes.paymentRef = ref;
  if (draft.notes.trim() !== access.notes) changes.notes = draft.notes.trim();
  return { changes };
}

/** What saving would do beyond recording it: the two cut-offs, which are confirmed first. */
export function accessCutoff(changes: PortalClientAccessChanges, now = Date.now()): "switch-off" | "past-expiry" | null {
  if (changes.enabled === false) return "switch-off";
  if (typeof changes.expiresAt === "string" && Date.parse(changes.expiresAt) <= now) return "past-expiry";
  return null;
}

const FIELD_LABEL: Record<PortalAccessDecision["field"], string> = {
  enabled: "Enable portal access", trained: "Portal trained", expires_at: "Access expires at", user_cap: "No. of users", payment_status: "Payment status", payment_ref: "Payment / invoice reference", notes: "Notes",
};
const OUTCOME_LABEL: Record<PortalLoginEventRecord["outcome"], string> = {
  success: "Signed in", bad_password: "Wrong password", locked: "Locked out", unknown_user: "Unknown address", user_disabled: "Account disabled", client_disabled: "Refused — client switched off",
  client_expired: "Refused — client's access expired", bad_code: "Wrong code", invalid_challenge: "Sign-in step expired or invalid",
};
const shown = (field: PortalAccessDecision["field"], value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "expires_at") return formatDateTime(String(value));
  if (field === "payment_status") return PORTAL_PAYMENT_STATUS_LABELS[value as PortalPaymentStatus] ?? String(value);
  if (field === "enabled" || field === "trained") return value ? "On" : "Off";
  return String(value);
};

export function PortalAccessTab({ clientId, access: editAccess }: { clientId: string; access: EditAccess }) {
  const base = `/api/isolated/clients/${encodeURIComponent(clientId)}/portal-client-access`;
  const [load, setLoad] = useState<PortalAccessLoad>({ state: "loading" });
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(base, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 403) { setLoad({ state: "denied" }); return; }
      if (!response.ok) { setLoad({ state: "failed" }); return; }
      const view = await response.json() as PortalClientAccessView;
      setLoad(view && view.access && Array.isArray(view.decisions) && Array.isArray(view.loginEvents) ? { state: "ready", view } : { state: "failed" });
    } catch { setLoad({ state: "failed" }); }
  }, [base]);
  useEffect(() => { void refresh(); }, [refresh]);
  return <PortalAccessBody load={load} access={editAccess} onRetry={() => void refresh()} onSave={async (expectedVersion, changes, note) => {
    const result = await putBrowserCommand<{ sessionsEnded: number }>(base, { expectedVersion, changes, note: note.trim() || null }, crypto.randomUUID());
    if (result.state === "success") { await refresh(); return { ok: true as const, sessionsEnded: result.data.sessionsEnded }; }
    return { ok: false as const, message: errorText(result) };
  }} />;
}

/** The tab from props — what it shows and what it sends, with no fetching of its own (so it is testable). */
export function PortalAccessBody({ load, access: editAccess, onRetry, onSave, now = () => Date.now() }: {
  load: PortalAccessLoad; access: EditAccess; onRetry: () => void;
  onSave: (expectedVersion: number | null, changes: PortalClientAccessChanges, note: string) => Promise<{ ok: true; sessionsEnded: number } | { ok: false; message: string }>;
  now?: () => number;
}) {
  if (load.state === "loading") return <p className="sub" role="status">Loading this client&apos;s portal access…</p>;
  if (load.state === "denied") return <p className="sub" role="status">Your role does not include portal administration for this client — it needs portal.admin, and for a Consultant, to be the client&apos;s owner.</p>;
  if (load.state === "failed") return <div className="nz-banner warn" role="alert">Portal access could not be loaded. Nothing is shown rather than a state that might be wrong. <button type="button" className="nz-btn sm" onClick={onRetry}>Try again</button></div>;
  return <AccessForm key={`${load.view.access.version}`} view={load.view} editAccess={editAccess} onSave={onSave} now={now} />;
}

function AccessForm({ view, editAccess, onSave, now }: { view: PortalClientAccessView; editAccess: EditAccess; onSave: Parameters<typeof PortalAccessBody>[0]["onSave"]; now: () => number }) {
  const { access } = view;
  const [draft, setDraft] = useState<Draft>(() => draftOf(access));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<"switch-off" | "past-expiry" | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const allowed = editAccess.state === "allowed";
  const patch = (next: Partial<Draft>) => { setDraft((current) => ({ ...current, ...next })); setConfirming(null); };

  const planned = accessChanges(access, draft);
  const pastExpiry = draft.expires.trim() !== "" && (() => { const instant = instantFromPlatformDateTimeLocal(draft.expires); return instant !== null && Date.parse(instant) <= now(); })();
  const expired = access.expiresAt !== null && Date.parse(access.expiresAt) <= now();
  const status = !access.enabled ? "Switched off" : expired ? "Expired" : "Active";
  const expiryText = access.expiresAt ? (expired ? `Expired ${formatDateTime(access.expiresAt)}` : `Expires ${formatDateTime(access.expiresAt)}`) : "No expiry set";

  async function save(confirmed = false) {
    if ("error" in planned) { setMessage({ tone: "warn", text: planned.error }); return; }
    if (Object.keys(planned.changes).length === 0) { setMessage({ tone: "warn", text: "Nothing has changed." }); return; }
    const cutoff = accessCutoff(planned.changes, now());
    if (cutoff && !confirmed) { setConfirming(cutoff); return; }
    setBusy(true); setMessage(null);
    const result = await onSave(access.version, planned.changes, note);
    setBusy(false); setConfirming(null);
    if (result.ok) setMessage({ tone: "ok", text: result.sessionsEnded > 0 ? `Saved. ${result.sessionsEnded} signed-in session${result.sessionsEnded === 1 ? "" : "s"} ended.` : "Saved." });
    else setMessage({ tone: "warn", text: result.message });
  }

  const row = (label: string, control: React.ReactNode, hint?: string) => <div className="nz-pm-field"><div className="nz-pm-lab"><b>{label}</b>{hint ? <span>{hint}</span> : null}</div>{control}</div>;
  return <div className="nz-pm-tab">
    <div className={`nz-pm-status ${status === "Active" ? "ok" : "off"}`} role="status"><i />Portal access · {status} · {expiryText}</div>
    <label className="nz-pm-reason">
      <span>Reason (optional) — recorded with the next change you make</span>
      <input className="nz-in" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Agreed with the client's sustainability lead" />
    </label>
    {message ? <div className={`nz-banner ${message.tone}`} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</div> : null}
    {editAccess.state !== "allowed" ? <p className="sub" role="status">{editAccess.state === "checking" ? "Checking your permissions…" : `You can see portal access but not change it: ${editAccess.reason}`}</p> : null}

    {row("Enable portal access", <PmSwitch name="Enable portal access" on={draft.enabled} blocked={!allowed || busy} onToggle={() => patch({ enabled: !draft.enabled })} />, "Master switch. Off blocks every user for this client at sign-in and signs them out.")}
    {row("Portal trained", <PmSwitch name="Portal trained" on={draft.trained} blocked={!allowed || busy} onToggle={() => patch({ trained: !draft.trained })} />, "Has the client been walked through the portal?")}
    {row("Access expires at", <input className="nz-in" type="datetime-local" aria-label="Access expires at" value={draft.expires} disabled={!allowed || busy} onChange={(event) => patch({ expires: event.target.value })} />, "Leave blank for no expiry.")}
    {pastExpiry ? <p className="nz-banner warn" role="alert">That date has passed. Saving it locks out every user of this client and signs them out now.</p> : null}
    {row("No. of users", <input className="nz-in" type="number" min={0} step={1} aria-label="No. of users" placeholder="Unlimited" value={draft.userCap} disabled={!allowed || busy} onChange={(event) => patch({ userCap: event.target.value })} />, `Informational cap; it does not block inviting. ${view.activeUsers} active.`)}
    {row("Payment status", <select className="nz-sel" aria-label="Payment status" value={draft.paymentStatus} disabled={!allowed || busy} onChange={(event) => patch({ paymentStatus: event.target.value as Draft["paymentStatus"] })}>
      <option value="">—</option>{PORTAL_PAYMENT_STATUSES.map((value) => <option key={value} value={value}>{PORTAL_PAYMENT_STATUS_LABELS[value]}</option>)}</select>)}
    {row("Payment / invoice reference", <input className="nz-in" aria-label="Payment / invoice reference" maxLength={120} placeholder="e.g. INV-2026-0042" value={draft.paymentRef} disabled={!allowed || busy} onChange={(event) => patch({ paymentRef: event.target.value })} />)}
    {row("Notes", <textarea className="nz-in" aria-label="Notes" rows={2} maxLength={4000} placeholder="Internal notes…" value={draft.notes} disabled={!allowed || busy} onChange={(event) => patch({ notes: event.target.value })} />, "Internal. Never shown to the client.")}

    {confirming ? <div className="nz-banner warn" role="alertdialog" aria-label="Confirm" >
      <p style={{ margin: "0 0 8px" }}><b>{confirming === "switch-off" ? "Switch this client's portal access off?" : "Save an expiry that has already passed?"}</b>{" "}
        {confirming === "switch-off" ? `Every user of this client is blocked at sign-in and signed out now${view.activeUsers ? ` (${view.activeUsers} active user${view.activeUsers === 1 ? "" : "s"})` : ""}. Turn it back on to restore access; nobody needs re-inviting.`
          : "Every user of this client is locked out and signed out now. Clear the date to restore access."}</p>
      <button type="button" className="nz-btn pri sm" disabled={busy} onClick={() => void save(true)}>{confirming === "switch-off" ? "Switch off" : "Save and lock out"}</button>{" "}
      <button type="button" className="nz-btn sm" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
    </div> : null}

    <div className="nz-config-actions">
      <button type="button" className="nz-btn pri" disabled={!allowed || busy || confirming !== null} aria-disabled={!allowed || undefined} onClick={() => void save()}>{busy ? "Saving…" : "Save access settings"}</button>
      <button type="button" className="nz-btn" aria-expanded={showHistory} onClick={() => setShowHistory((open) => !open)}>Login history</button>
    </div>

    {showHistory ? <div className="nz-pm-history">
      <h3>Login history</h3>
      {view.loginEvents.length === 0 ? <p className="sub">No sign-in attempts are recorded for this client yet.</p> : <div style={{ overflowX: "auto" }}><table className="nz-tbl">
        <thead><tr><th>When</th><th>Result</th><th>User</th><th>Address</th><th>Browser</th></tr></thead>
        <tbody>{view.loginEvents.map((event) => <tr key={event.eventId}>
          <td>{formatDateTime(event.occurredAt)}</td><td>{OUTCOME_LABEL[event.outcome] ?? event.outcome}</td><td>{event.userName ?? <span className="muted">—</span>}</td>
          <td>{event.ip ?? <span className="muted">—</span>}</td><td title={event.userAgent ?? undefined}>{event.userAgent ? event.userAgent.slice(0, 40) : <span className="muted">—</span>}</td>
        </tr>)}</tbody></table></div>}
      <p className="sub">Address and browser are kept for 90 days.</p>
    </div> : null}

    <div className="nz-pm-history">
      <h3>Decisions</h3>
      {view.decisions.length === 0 ? <p className="sub">Nothing has been decided for this client; the defaults apply.</p> : <ul className="nz-pm-decisions">{view.decisions.map((decision) => <li key={decision.decisionId}>
        <b>{FIELD_LABEL[decision.field]}</b>: {shown(decision.field, decision.from)} → {shown(decision.field, decision.to)}
        <span className="nz-pm-src"> · {decision.changedByName ?? decision.changedBy} · {formatDateTime(decision.changedAt)}{decision.note ? <> · <q>{decision.note}</q></> : null}</span></li>)}</ul>}
    </div>
  </div>;
}
