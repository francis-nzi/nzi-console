"use client";

import { useCallback, useEffect, useState } from "react";
import { putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  PORTAL_PROFILE_GROUP_LABELS, PORTAL_PROFILE_VALUE_LABELS, type PortalDecisionRecord, type PortalProfileGroup, type PortalProfileStaffView,
} from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";
import { useEditAccess, type EditAccess } from "../../lib/useEditAccess";

/**
 * Portal Management (portal data-entry phase 1; BUILD-portal-dataentry-phase1 §5): what this client's portal offers them,
 * over the organisation's default — each setting showing its effective value and whether that is the default or a recorded
 * decision (who, when, why) — and which scopes and categories the client sees. Every change is a governed command:
 *   - a portal setting → client.portal.profile.set (portal.admin);
 *   - a scope → client.portal.scope.visibility.set, a category → client.category.visibility.set (category.visibility — the
 *     same disclosure decision, NZC-110).
 * "Return to default" withdraws the decision (kept in the record), never deletes it.
 *
 * Minimal for phase 1: no sign-off, release or messaging controls — those are later phases.
 */

export type PortalManagementLoad = { state: "loading" } | { state: "denied" } | { state: "failed" } | { state: "ready"; view: PortalProfileStaffView };
const GROUPS: PortalProfileGroup[] = ["areas", "entry", "rowSections", "actions"];
const label = (value: string) => PORTAL_PROFILE_VALUE_LABELS[value] ?? value;
const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

function Decided({ decision, isDefault }: { decision: PortalDecisionRecord<unknown> | null; isDefault: boolean }) {
  if (!decision) return <span className="nz-pm-src">Default</span>;
  return <span className="nz-pm-src decided">
    {isDefault ? "Default, confirmed" : "Decision"} · {decision.decidedByName ?? decision.decidedBy} · {formatDate(decision.decidedAt.slice(0, 10))}
    {decision.note ? <> · <q>{decision.note}</q></> : null}
  </span>;
}

export function PortalManagementArea({ clientId, clientOwnerUserId, writeEnabled }: { clientId: string; clientOwnerUserId: string | null; writeEnabled: boolean }) {
  const [load, setLoad] = useState<PortalManagementLoad>({ state: "loading" });
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const profileAccess = useEditAccess("portal.admin", writeEnabled, clientOwnerUserId);
  const visibilityAccess = useEditAccess("category.visibility", writeEnabled, clientOwnerUserId);
  const base = `/api/isolated/clients/${encodeURIComponent(clientId)}`;

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${base}/portal-profile`, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 403) { setLoad({ state: "denied" }); return; }
      if (!response.ok) { setLoad({ state: "failed" }); return; }
      const view = await response.json() as PortalProfileStaffView;
      setLoad(Array.isArray(view.profile) && Array.isArray(view.scopes) ? { state: "ready", view } : { state: "failed" });
    } catch { setLoad({ state: "failed" }); }
  }, [base]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function send(key: string, path: string, body: Record<string, unknown>, done: string) {
    setPending(key); setMessage(null);
    const result = await putBrowserCommand(path, { ...body, note: note.trim() || null }, crypto.randomUUID());
    setPending(null);
    if (result.state === "success") { setMessage({ tone: "ok", text: done }); setNote(""); await refresh(); }
    else setMessage({ tone: "warn", text: errorText(result) });
  }

  return <PortalManagementBody load={load} note={note} onNote={setNote} pending={pending} message={message} profileAccess={profileAccess} visibilityAccess={visibilityAccess}
    onRetry={() => void refresh()} onSend={(key, path, input, done) => void send(key, `${base}${path}`, input, done)} />;
}

/** The area, from props — everything it shows and every command it sends, with no fetching of its own (so it is testable). */
export function PortalManagementBody({ load, note, onNote, pending, message, profileAccess, visibilityAccess, onRetry, onSend }: {
  load: PortalManagementLoad; note: string; onNote: (value: string) => void; pending: string | null; message: { tone: "ok" | "warn"; text: string } | null;
  profileAccess: EditAccess; visibilityAccess: EditAccess; onRetry: () => void;
  /** `path` is relative to the client's API base: /portal-profile, /portal-profile/scopes, /category-visibility. */
  onSend: (key: string, path: string, input: Record<string, unknown>, done: string) => void;
}) {
  return <section className="nz-panel nz-pm" aria-labelledby="area-portal">
    <div className="nz-card-h"><span className="eyebrow">Manage</span><h2 id="area-portal">Portal Management</h2></div>
    <div className="nz-card-b">
      <p className="sub">What this client&apos;s portal offers them, over your organisation&apos;s default. A change is recorded as a decision — who, when and why — and &ldquo;Return to default&rdquo; withdraws it without erasing that it was made.</p>
      <p className="nz-pm-note" role="note">Category visibility already applies in the client&apos;s portal. The other settings are recorded and explained now; the portal begins to follow them in the next phase of portal data entry.</p>

      {load.state === "loading" ? <p className="sub" role="status">Loading this client&apos;s portal profile…</p> : null}
      {load.state === "denied" ? <p className="sub" role="status">Your role does not include portal administration for this client — it needs portal.admin, and for a Consultant, to be the client&apos;s owner.</p> : null}
      {load.state === "failed" ? <div className="nz-banner warn" role="alert">The portal profile could not be loaded. Nothing is shown rather than a profile that might be wrong. <button type="button" className="nz-btn sm" onClick={onRetry}>Try again</button></div> : null}

      {load.state === "ready" ? <>
        <label className="nz-pm-reason">
          <span>Reason (optional) — recorded with the next change you make</span>
          <input className="nz-in" value={note} maxLength={500} onChange={(event) => onNote(event.target.value)} placeholder="e.g. Agreed with the client's sustainability lead" />
        </label>
        {message ? <div className={`nz-banner ${message.tone}`} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</div> : null}
        <AccessNote access={profileAccess} what="portal settings" />

        {GROUPS.map((group) => {
          const entries = load.view.profile.filter((entry) => entry.group === group);
          return <div key={group} className="nz-pm-group">
            <h3>{PORTAL_PROFILE_GROUP_LABELS[group]}</h3>
            {entries.map((entry) => {
              const blocked = profileAccess.state !== "allowed" || pending !== null;
              return <div key={entry.key} className="nz-pm-row">
                <div className="nz-pm-what"><b>{entry.label}</b><span>{entry.hint}</span><Decided decision={entry.decision} isDefault={entry.effectiveValue === entry.defaultValue} /></div>
                <div className="nz-pm-ctl">
                  <div className="nz-seg" role="group" aria-label={entry.label}>
                    {entry.values.map((value) => <button key={value} type="button" className={value === entry.effectiveValue ? "on" : ""} aria-pressed={value === entry.effectiveValue}
                      aria-disabled={blocked || undefined}
                      onClick={() => { if (blocked || value === entry.effectiveValue) return; onSend(entry.key, "/portal-profile", { profileKey: entry.key, value }, `${entry.label}: ${label(value)}.`); }}>
                      {label(value)}{value === entry.defaultValue ? <span className="badge">default</span> : null}
                    </button>)}
                  </div>
                  {entry.decision ? <button type="button" className="nz-btn sm" aria-disabled={blocked || undefined}
                    onClick={() => { if (!blocked) onSend(entry.key, "/portal-profile", { profileKey: entry.key, value: null }, `${entry.label}: back to the default.`); }}>Return to default</button> : null}
                </div>
              </div>;
            })}
          </div>;
        })}

        <div className="nz-pm-group">
          <h3>History</h3>
          <div className="nz-pm-row"><div className="nz-pm-what"><b>Always visible to the client</b><span>A row&apos;s history is how shared entry stays honest, so it is not a setting and cannot be switched off.</span></div></div>
        </div>

        <div className="nz-pm-group">
          <h3>Scopes and categories</h3>
          <AccessNote access={visibilityAccess} what="what this client is shown" />
          <p className="sub">A category is shown only when its scope is on and the category itself is on. Switching a scope off hides every category in it; switching it back restores them as they were.</p>
          {load.view.scopes.map((scope) => {
            const blocked = visibilityAccess.state !== "allowed" || pending !== null;
            return <div key={scope.scope} className="nz-pm-scope">
              <div className="nz-pm-row">
                <div className="nz-pm-what"><b>{scope.label}</b><Decided decision={scope.decision} isDefault={scope.effectiveVisible} /></div>
                <div className="nz-pm-ctl">
                  <div className="nz-seg" role="group" aria-label={scope.label}>
                    {[true, false].map((visible) => <button key={String(visible)} type="button" className={visible === scope.effectiveVisible ? "on" : ""} aria-pressed={visible === scope.effectiveVisible}
                      aria-disabled={blocked || undefined}
                      onClick={() => { if (blocked || visible === scope.effectiveVisible) return; onSend(`scope-${scope.scope}`, "/portal-profile/scopes", { scope: scope.scope, visible }, `${scope.label}: ${visible ? "shown" : "hidden"}.`); }}>
                      {visible ? "Shown" : "Hidden"}{visible ? <span className="badge">default</span> : null}
                    </button>)}
                  </div>
                  {scope.decision ? <button type="button" className="nz-btn sm" aria-disabled={blocked || undefined}
                    onClick={() => { if (!blocked) onSend(`scope-${scope.scope}`, "/portal-profile/scopes", { scope: scope.scope, visible: null }, `${scope.label}: back to the default.`); }}>Return to default</button> : null}
                </div>
              </div>
              <details className="nz-pm-cats">
                <summary>{scope.categories.length} categories · {scope.categories.filter((category) => category.shown).length} shown</summary>
                <ul>
                  {scope.categories.map((category) => {
                    const on = category.decision ? category.decision.value : true;
                    return <li key={category.categoryCode}>
                      <span className="nz-pm-what"><b>{category.name}</b>
                        <span>{category.hiddenBy === "scope" ? "Hidden by its scope" : category.shown ? "Shown" : "Hidden"}</span>
                        <Decided decision={category.decision} isDefault={on} /></span>
                      <span className="nz-pm-ctl">
                        <button type="button" className="nz-btn sm" aria-disabled={blocked || undefined}
                          onClick={() => { if (!blocked) onSend(`cat-${category.categoryCode}`, "/category-visibility", { categoryCode: category.categoryCode, visible: !on }, `${category.name}: ${on ? "hidden" : "shown"}.`); }}>{on ? "Hide" : "Show"}</button>
                        {category.decision ? <button type="button" className="nz-btn sm" aria-disabled={blocked || undefined}
                          onClick={() => { if (!blocked) onSend(`cat-${category.categoryCode}`, "/category-visibility", { categoryCode: category.categoryCode, visible: null }, `${category.name}: back to the default.`); }}>Return to default</button> : null}
                      </span>
                    </li>;
                  })}
                </ul>
              </details>
            </div>;
          })}
        </div>

        <p className="nz-pm-later">Sign-off, report release and messaging are managed here in later phases.</p>
      </> : null}
    </div>
  </section>;
}

function AccessNote({ access, what }: { access: EditAccess; what: string }) {
  if (access.state === "allowed") return null;
  return <p className="sub" role="status">{access.state === "checking" ? "Checking your permissions…" : `You can see ${what} but not change them: ${access.reason}`}</p>;
}
