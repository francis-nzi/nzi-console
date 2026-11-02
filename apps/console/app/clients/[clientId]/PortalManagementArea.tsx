"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { type PortalDecisionRecord, type PortalProfileStaffView } from "@nzi/contracts";
import { Tabs, TabPanel } from "@nzi/ui";
import { formatDate } from "../../lib/formatDate";
import { portalFeatureEnabled } from "../../lib/portalFlags";
import { useEditAccess, type EditAccess } from "../../lib/useEditAccess";
import { PortalFilesPanel } from "./PortalFilesPanel";

/**
 * Portal Management (DESIGN-portal-management; BRIEF-portal-management-redesign): what this client's portal offers them, over the
 * organisation's default, and which scopes and categories they see — as tabs: Access · Users · Visibility · Scopes & categories ·
 * Jobs · Files · History. This is the first step: the shell, Visibility and Scopes & categories. The other tabs are named, and say
 * so, until each ships (Users still lives in Platform & audit).
 *
 * Every change is a governed command, unchanged by the redesign:
 *   - a portal setting → client.portal.profile.set (portal.admin);
 *   - a scope → client.portal.scope.visibility.set, a category → client.category.visibility.set (category.visibility — the
 *     same disclosure decision, NZC-110).
 * A switch is wordless (on = shown) and carries only its name. "Reset all to default" withdraws every decision on the tab — one
 * withdrawal per decision (each recorded, kept in the history) — and says how many.
 *
 * Datasets and Setup are not offered: a client cannot act on datasets, and Setup's only client-relevant content (the reporting
 * period and the sites in boundary) is the job's own context, not a toggle. Their stored decisions are left inert.
 */

export type PortalManagementLoad = { state: "loading" } | { state: "denied" } | { state: "failed" } | { state: "ready"; view: PortalProfileStaffView };
export type PortalManagementTab = "access" | "users" | "visibility" | "scopes" | "jobs" | "files" | "history";

/** Not offered in the UI (see above). The keys and their stored decisions remain in the contract; nothing here writes them. */
export const HIDDEN_PROFILE_KEYS = ["setup", "datasets"] as const;
const SUB_SECTIONS = ["evidenceProvenance", "factorCalculation", "dataQuality", "sourceDetail"] as const;
const SUB_SECTION_LABELS: Record<(typeof SUB_SECTIONS)[number], string> = {
  evidenceProvenance: "Evidence & provenance", factorCalculation: "Factor & calculation", dataQuality: "Data quality", sourceDetail: "Source detail",
};
/** Switch on = the value that shows or enables the thing; the contract's value sets stay as they are. */
const ON_VALUE: Record<string, string> = { time: "visible", milestones: "view", entryDrawer: "detailed", evidenceProvenance: "visible", factorCalculation: "visible", dataQuality: "visible", sourceDetail: "visible", deactivate: "enabled" };
const OFF_VALUE: Record<string, string> = { time: "hidden", milestones: "hidden", entryDrawer: "simple", evidenceProvenance: "hidden", factorCalculation: "hidden", dataQuality: "hidden", sourceDetail: "hidden", deactivate: "disabled" };
const NAME: Record<string, string> = { time: "Time", milestones: "Milestones", entryDrawer: "Detailed row drawer", deactivate: "Deactivate a row", ...SUB_SECTION_LABELS };

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

/** Who decided, when and why — said on hover where the row carries it, never as text on the row. */
const decidedTitle = (decision: PortalDecisionRecord<unknown> | null) =>
  decision ? `Decided by ${decision.decidedByName ?? decision.decidedBy} · ${formatDate(decision.decidedAt.slice(0, 10))}${decision.note ? ` · “${decision.note}”` : ""}` : undefined;

type Command = { key: string; path: string; input: Record<string, unknown> };
type Send = (key: string, path: string, input: Record<string, unknown>, done: string) => void;

export function PortalManagementArea({ clientId, clientOwnerUserId, writeEnabled }: { clientId: string; clientOwnerUserId: string | null; writeEnabled: boolean }) {
  const [load, setLoad] = useState<PortalManagementLoad>({ state: "loading" });
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [tab, setTab] = useState<PortalManagementTab>("visibility");
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
    const result = await putBrowserCommand(`${base}${path}`, { ...body, note: note.trim() || null }, crypto.randomUUID());
    setPending(null);
    if (result.state === "success") { setMessage({ tone: "ok", text: done }); setNote(""); await refresh(); }
    else setMessage({ tone: "warn", text: errorText(result) });
  }

  /** One withdrawal per decision, in order; stops at the first refusal and says how far it got. Refreshes once. */
  async function resetAll(commands: Command[]) {
    if (!commands.length) return;
    setPending("reset"); setMessage(null);
    let done = 0;
    for (const command of commands) {
      const result = await putBrowserCommand(`${base}${command.path}`, { ...command.input, note: note.trim() || null }, crypto.randomUUID());
      if (result.state !== "success") { setPending(null); setMessage({ tone: "warn", text: `${done} of ${commands.length} returned to default; then: ${errorText(result)}` }); await refresh(); return; }
      done += 1;
    }
    setPending(null); setNote("");
    setMessage({ tone: "ok", text: `${done} setting${done === 1 ? "" : "s"} returned to default.` });
    await refresh();
  }

  return <PortalManagementBody load={load} note={note} onNote={setNote} pending={pending} message={message} profileAccess={profileAccess} visibilityAccess={visibilityAccess}
    tab={tab} onTab={setTab} files={portalFeatureEnabled("portal-files") ? <PortalFilesPanel clientId={clientId} access={profileAccess} /> : null}
    onRetry={() => void refresh()} onSend={(key, path, input, done) => void send(key, path, input, done)} onResetAll={(commands) => void resetAll(commands)} />;
}

/** A wordless switch: on = shown. It carries only its name, for the screen reader and the tooltip. */
function Switch({ name, on, blocked, onToggle, title }: { name: string; on: boolean; blocked: boolean; onToggle: () => void; title?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={name} title={title} aria-disabled={blocked || undefined} className={`nz-pm-sw${on ? " on" : ""}`}
    onClick={() => { if (!blocked) onToggle(); }} />;
}

const TABS: ReadonlyArray<{ id: PortalManagementTab; label: string }> = [
  { id: "access", label: "Access" }, { id: "users", label: "Users" }, { id: "visibility", label: "Visibility" }, { id: "scopes", label: "Scopes & categories" },
  { id: "jobs", label: "Jobs" }, { id: "files", label: "Files" }, { id: "history", label: "History" },
];
/** Tabs that are live in this step. The rest are named so the shape is visible, and are not selectable until they ship. */
const LIVE: ReadonlySet<PortalManagementTab> = new Set(["visibility", "scopes"]);

/** The area, from props — everything it shows and every command it sends, with no fetching of its own (so it is testable). */
export function PortalManagementBody({ load, note, onNote, pending, message, profileAccess, visibilityAccess, tab, onTab, files, onRetry, onSend, onResetAll }: {
  load: PortalManagementLoad; note: string; onNote: (value: string) => void; pending: string | null; message: { tone: "ok" | "warn"; text: string } | null;
  profileAccess: EditAccess; visibilityAccess: EditAccess; tab: PortalManagementTab; onTab: (tab: PortalManagementTab) => void;
  /** The Files tab's content, when it is on. */
  files?: ReactNode; onRetry: () => void;
  /** `path` is relative to the client's API base: /portal-profile, /portal-profile/scopes, /category-visibility. */
  onSend: Send; onResetAll: (commands: Command[]) => void;
}) {
  const live = new Set<PortalManagementTab>([...LIVE, ...(files ? (["files"] as const) : [])]);
  const items = TABS.map((entry) => ({ id: entry.id, label: entry.label, disabled: !live.has(entry.id) }));
  return <section className="nz-panel nz-pm" aria-labelledby="area-portal">
    <div className="nz-card-h"><span className="eyebrow">Manage</span><h2 id="area-portal">Portal Management</h2></div>
    <div className="nz-card-b">
      <Tabs items={items} value={tab} onChange={(id) => onTab(id as PortalManagementTab)} ariaLabel="Portal Management" idBase="pm" className="nz-tabs nz-pm-tabs" />
      {message ? <div className={`nz-banner ${message.tone}`} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</div> : null}

      <TabPanel id="visibility" idBase="pm" active={tab === "visibility"} ariaLabel="Visibility">
        <LoadGate load={load} onRetry={onRetry}>{(view) => <VisibilityTab view={view} note={note} onNote={onNote} pending={pending} access={profileAccess} onSend={onSend} onResetAll={onResetAll} />}</LoadGate>
      </TabPanel>
      <TabPanel id="scopes" idBase="pm" active={tab === "scopes"} ariaLabel="Scopes and categories">
        <LoadGate load={load} onRetry={onRetry}>{(view) => <ScopesTab view={view} note={note} onNote={onNote} pending={pending} access={visibilityAccess} onSend={onSend} onResetAll={onResetAll} />}</LoadGate>
      </TabPanel>
      <TabPanel id="files" idBase="pm" active={tab === "files"} ariaLabel="Files">{files}</TabPanel>
      {(["access", "users", "jobs", "history"] as const).map((id) => <TabPanel key={id} id={id} idBase="pm" active={tab === id}><p className="sub" role="status">This tab is not available yet.</p></TabPanel>)}
    </div>
  </section>;
}

function LoadGate({ load, onRetry, children }: { load: PortalManagementLoad; onRetry: () => void; children: (view: PortalProfileStaffView) => ReactNode }) {
  if (load.state === "loading") return <p className="sub" role="status">Loading this client&apos;s portal profile…</p>;
  if (load.state === "denied") return <p className="sub" role="status">Your role does not include portal administration for this client — it needs portal.admin, and for a Consultant, to be the client&apos;s owner.</p>;
  if (load.state === "failed") return <div className="nz-banner warn" role="alert">The portal profile could not be loaded. Nothing is shown rather than a profile that might be wrong. <button type="button" className="nz-btn sm" onClick={onRetry}>Try again</button></div>;
  return <>{children(load.view)}</>;
}

function Reason({ note, onNote }: { note: string; onNote: (value: string) => void }) {
  return <label className="nz-pm-reason">
    <span>Reason (optional) — recorded with the next change you make</span>
    <input className="nz-in" value={note} maxLength={500} onChange={(event) => onNote(event.target.value)} placeholder="e.g. Agreed with the client's sustainability lead" />
  </label>;
}

function AccessNote({ access, what }: { access: EditAccess; what: string }) {
  if (access.state === "allowed") return null;
  return <p className="sub" role="status">{access.state === "checking" ? "Checking your permissions…" : `You can see ${what} but not change them: ${access.reason}`}</p>;
}

function ResetAll({ count, blocked, onReset }: { count: number; blocked: boolean; onReset: () => void }) {
  return <button type="button" className="nz-pm-reset" aria-disabled={blocked || count === 0 || undefined} disabled={count === 0}
    onClick={() => { if (!blocked && count) onReset(); }}>Reset all to default</button>;
}

function VisibilityTab({ view, note, onNote, pending, access, onSend, onResetAll }: {
  view: PortalProfileStaffView; note: string; onNote: (value: string) => void; pending: string | null; access: EditAccess; onSend: Send; onResetAll: (commands: Command[]) => void;
}) {
  const entries = view.profile.filter((entry) => !(HIDDEN_PROFILE_KEYS as readonly string[]).includes(entry.key));
  const byKey = new Map(entries.map((entry) => [entry.key as string, entry]));
  const blocked = access.state !== "allowed" || pending !== null;
  const toggle = (key: string, on: boolean): void => onSend(key, "/portal-profile", { profileKey: key, value: on ? ON_VALUE[key] : OFF_VALUE[key] }, `${NAME[key]}: ${on ? "on" : "off"}.`);
  const row = (key: string) => {
    const entry = byKey.get(key);
    if (!entry) return null;
    const on = entry.effectiveValue === ON_VALUE[key];
    return <div key={key} className="nz-pm-row" title={decidedTitle(entry.decision)}>
      <span className="nz-pm-name">{NAME[key]}</span>
      <Switch name={NAME[key]!} on={on} blocked={blocked} onToggle={() => toggle(key, !on)} title={decidedTitle(entry.decision)} />
    </div>;
  };
  const detailed = byKey.get("entryDrawer")?.effectiveValue === ON_VALUE.entryDrawer;
  const decided: Command[] = entries.filter((entry) => entry.decision !== null).map((entry) => ({ key: entry.key, path: "/portal-profile", input: { profileKey: entry.key, value: null } }));
  return <div className="nz-pm-tab">
    <Reason note={note} onNote={onNote} />
    <AccessNote access={access} what="portal settings" />
    <div className="nz-pm-grouphead"><h3>Areas</h3><ResetAll count={decided.length} blocked={blocked} onReset={() => onResetAll(decided)} /></div>
    {row("time")}{row("milestones")}
    <div className="nz-pm-grouphead"><h3>Entry</h3></div>
    {row("entryDrawer")}
    {detailed ? <div className="nz-pm-sub">{SUB_SECTIONS.map(row)}</div> : null}
    <div className="nz-pm-grouphead"><h3>Actions</h3></div>
    {row("deactivate")}
    <p className="nz-pm-fixed">History — a row&apos;s change history is always visible to the client. It is not a setting.</p>
  </div>;
}

function ScopesTab({ view, note, onNote, pending, access, onSend, onResetAll }: {
  view: PortalProfileStaffView; note: string; onNote: (value: string) => void; pending: string | null; access: EditAccess; onSend: Send; onResetAll: (commands: Command[]) => void;
}) {
  const blocked = access.state !== "allowed" || pending !== null;
  const decided: Command[] = view.scopes.flatMap((scope) => [
    ...(scope.decision ? [{ key: `scope-${scope.scope}`, path: "/portal-profile/scopes", input: { scope: scope.scope, visible: null } }] : []),
    ...scope.categories.filter((category) => category.decision).map((category) => ({ key: `cat-${category.categoryCode}`, path: "/category-visibility", input: { categoryCode: category.categoryCode, visible: null } })),
  ]);
  return <div className="nz-pm-tab">
    <Reason note={note} onNote={onNote} />
    <AccessNote access={access} what="what this client is shown" />
    <div className="nz-pm-grouphead"><h3>Scopes &amp; categories</h3><ResetAll count={decided.length} blocked={blocked} onReset={() => onResetAll(decided)} /></div>
    {view.scopes.map((scope) => <div key={scope.scope} className="nz-pm-scope">
      <div className="nz-pm-row" title={decidedTitle(scope.decision)}>
        <span className="nz-pm-name">{scope.label}{scope.decision ? <span className="nz-pm-ov">Overridden · <button type="button" className="nz-pm-link" aria-disabled={blocked || undefined}
          onClick={() => { if (!blocked) onSend(`scope-${scope.scope}`, "/portal-profile/scopes", { scope: scope.scope, visible: null }, `${scope.label}: reset.`); }}>Reset</button></span> : null}</span>
        <Switch name={scope.label} on={scope.effectiveVisible} blocked={blocked} title={decidedTitle(scope.decision)}
          onToggle={() => onSend(`scope-${scope.scope}`, "/portal-profile/scopes", { scope: scope.scope, visible: !scope.effectiveVisible }, `${scope.label}: ${scope.effectiveVisible ? "off" : "on"}.`)} />
      </div>
      {scope.categories.length ? <details className="nz-pm-cats">
        <summary>{scope.categories.length} categories · {scope.categories.filter((category) => category.shown).length} shown</summary>
        <div className="nz-pm-sub">{scope.categories.map((category) => {
          const on = category.decision ? Boolean(category.decision.value) : true;
          return <div key={category.categoryCode} className="nz-pm-row" title={decidedTitle(category.decision)}>
            <span className="nz-pm-name">{category.name}{category.hiddenBy === "scope" ? <span className="nz-pm-dim"> (its scope is off)</span> : null}{category.decision ? <span className="nz-pm-ov">Overridden · <button type="button" className="nz-pm-link" aria-disabled={blocked || undefined}
              onClick={() => { if (!blocked) onSend(`cat-${category.categoryCode}`, "/category-visibility", { categoryCode: category.categoryCode, visible: null }, `${category.name}: reset.`); }}>Reset</button></span> : null}</span>
            <Switch name={category.name} on={on} blocked={blocked} title={decidedTitle(category.decision)}
              onToggle={() => onSend(`cat-${category.categoryCode}`, "/category-visibility", { categoryCode: category.categoryCode, visible: !on }, `${category.name}: ${on ? "off" : "on"}.`)} />
          </div>;
        })}</div>
      </details> : null}
    </div>)}
  </div>;
}
