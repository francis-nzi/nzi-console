"use client";

import { useRef, useState } from "react";
import { GatedButton, NziIcon, type NziIconKey } from "@nzi/ui";
import { patchBrowserCommand, postBrowserCommand, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  actionProgressForStatus, actionScopeLabel, actionScopes, actionControlLevelLabels, actionControlLevels,
  actionStatusForProgress, actionStatuses, actionStatusLabels,
  type ActionLibraryEntry, type ActionScope, type ActionControlLevel, type ActionStatus, type ClientAction,
} from "@nzi/contracts";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * The Actions drawers: pick from the library, write a bespoke action, or edit one already
 * on the plan.
 *
 * Status and progress are kept in step as the person types, because the database holds a
 * constraint that "done" means one thing — a form that can offer 60%-and-complete is a
 * form that produces a save error instead of a plan.
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

const iconKey = (key: string): NziIconKey => key as NziIconKey;

export function ActionLibraryForm({ clientId, library, access, onClose, onSaved, onBespoke }: {
  clientId: string; library: ActionLibraryEntry[]; access: EditAccess;
  onClose: () => void; onSaved: (text: string) => void; onBespoke: () => void;
}) {
  const [controlLevel, setControlLevel] = useState<ActionControlLevel | "all">("all");
  const [scope, setScope] = useState<ActionScope | "all">("all");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = library.filter((entry) =>
    (controlLevel === "all" || entry.lever.controlLevel === controlLevel) && (scope === "all" || entry.lever.scope === scope));

  async function add(entry: ActionLibraryEntry) {
    setPendingId(entry.lever.id);
    setError(null);
    const result = await postBrowserCommand<{ clientActionId: string }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/actions`, { leverId: entry.lever.id }, crypto.randomUUID());
    setPendingId(null);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved(`${entry.lever.title} added to the plan.`);
  }

  return <div className="nz-drawer-form">
    <p className="sub">
      Assign reduction levers from the NZI catalogue to this client&rsquo;s plan. The catalogue is
      Admin-managed; what you assign is tracked per client and grouped by how much of it the client controls.
    </p>

    <div className="nz-filters" style={{ marginBottom: 10 }}>
      <button type="button" aria-pressed={controlLevel === "all"} className={controlLevel === "all" ? "on" : undefined} onClick={() => setControlLevel("all")}>All levels</button>
      {actionControlLevels.map((value) => <button key={value} type="button" aria-pressed={controlLevel === value}
        className={controlLevel === value ? "on" : undefined} onClick={() => setControlLevel(value)}>{actionControlLevelLabels[value].split(" · ")[0]}</button>)}
    </div>
    <div className="nz-filters" style={{ marginBottom: 12 }}>
      <button type="button" aria-pressed={scope === "all"} className={scope === "all" ? "on" : undefined} onClick={() => setScope("all")}>All scopes</button>
      {actionScopes.map((value) => <button key={value} type="button" aria-pressed={scope === value}
        className={scope === value ? "on" : undefined} onClick={() => setScope(value)}>{actionScopeLabel(value)}</button>)}
    </div>

    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}

    {shown.length === 0
      ? <p className="sub">No lever in the catalogue matches that filter.</p>
      : shown.map((entry) => <div className="nz-lib-item" key={entry.lever.id}>
        <span className="nz-action-icon"><NziIcon name={iconKey(entry.lever.iconKey)} size={16} /></span>
        <div className="nz-lib-main">
          <div className="nm">{entry.lever.title}</div>
          <div className="sub">
            <span className="nz-tag">{actionScopeLabel(entry.lever.scope)}</span>
            {` ${[entry.lever.category, actionControlLevelLabels[entry.lever.controlLevel].split(" · ")[0]].filter(Boolean).join(" · ")}`}
          </div>
          {/* A withdrawn lever is still shown while a client holds it, and says why it
              cannot be added again. */}
          {!entry.lever.active ? <div className="hint">Withdrawn from the catalogue — kept because this client holds it.</div> : null}
        </div>
        {entry.assigned
          ? <span className="nz-tag">Added</span>
          : <GatedButton className="nz-btn sm" blocked={access.state !== "allowed" || !entry.lever.active || pendingId !== null}
            blockedReason={access.state !== "allowed" ? access.reason : !entry.lever.active ? "This lever has been withdrawn from the catalogue." : undefined}
            reasonClassName="hint nz-gated-reason"
            onClick={() => void add(entry)}>{pendingId === entry.lever.id ? "Adding…" : "Add"}</GatedButton>}
      </div>)}

    <div className="nz-drawer-actions">
      <button type="button" className="nz-btn" onClick={onBespoke}>Add something bespoke instead</button>
      <span style={{ flex: 1 }} />
      <button type="button" className="nz-btn" onClick={onClose}>Done</button>
    </div>
  </div>;
}

export function ActionBespokeForm({ clientId, access, onClose, onSaved }: {
  clientId: string; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<ActionScope>("3");
  const [controlLevel, setControlLevel] = useState<ActionControlLevel>("direct_control");
  const [category, setCategory] = useState("");
  const [owner, setOwner] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  async function save() {
    setPending(true); setError(null);
    key.current ??= crypto.randomUUID();
    const result = await postBrowserCommand<{ clientActionId: string }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/actions`,
      { bespoke: { title, scope, controlLevel, category }, owner, targetDate: targetDate || null, notes }, key.current);
    setPending(false);
    if (result.state !== "success") { key.current = null; setError(errorText(result)); return; }
    key.current = null;
    onSaved(`${title.trim()} added to the plan.`);
  }

  return <div className="nz-drawer-form">
    <p className="sub">
      For something this client is doing that is not in the catalogue. If it turns out to be common, an
      administrator can add it to the library so other clients can use it too.
    </p>
    <label className="nz-fl"><span>What are they doing?</span>
      <input className="nz-inp" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Replace the Leeds depot boiler" /></label>
    <div className="nz-two">
      <label className="nz-fl"><span>Scope</span>
        <select className="nz-sel" value={scope} onChange={(event) => setScope(event.target.value as ActionScope)}>
          {actionScopes.map((value) => <option key={value} value={value}>{actionScopeLabel(value)}</option>)}
        </select></label>
      <label className="nz-fl"><span>How much do they control?</span>
        <select className="nz-sel" value={controlLevel} onChange={(event) => setControlLevel(event.target.value as ActionControlLevel)}>
          {actionControlLevels.map((value) => <option key={value} value={value}>{actionControlLevelLabels[value]}</option>)}
        </select></label>
    </div>
    <div className="nz-two">
      <label className="nz-fl"><span>Category</span>
        <input className="nz-inp" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="e.g. Heating" /></label>
      <label className="nz-fl"><span>Owner</span>
        <input className="nz-inp" value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Who at the client is leading it" /></label>
    </div>
    <label className="nz-fl"><span>Target date</span>
      <input className="nz-inp" type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>
    <label className="nz-fl"><span>Notes</span>
      <textarea className="nz-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>

    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    <div className="nz-drawer-actions">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
      <span style={{ flex: 1 }} />
      <GatedButton className="nz-btn pri" blocked={access.state !== "allowed" || pending || title.trim() === ""}
        blockedReason={access.state !== "allowed" ? access.reason : title.trim() === "" ? "Say what the action is." : undefined}
        reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Adding…" : "Add to plan"}</GatedButton>
    </div>
  </div>;
}

export function ActionEditForm({ action, access, onClose, onSaved }: {
  action: ClientAction; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [status, setStatus] = useState<ActionStatus>(action.status);
  const [progressPct, setProgressPct] = useState(action.progressPct);
  const [owner, setOwner] = useState(action.owner);
  const [targetDate, setTargetDate] = useState(action.targetDate ?? "");
  const [notes, setNotes] = useState(action.notes);
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The two controls are one fact seen two ways, so moving either moves the other. The
  // database holds the same rule; keeping them in step here means the person never meets it.
  const chooseStatus = (next: ActionStatus) => { setStatus(next); setProgressPct(actionProgressForStatus(next, progressPct)); };
  const chooseProgress = (next: number) => { setProgressPct(next); setStatus(actionStatusForProgress(next, status)); };

  async function save() {
    setPending(true); setError(null);
    const result = await patchBrowserCommand<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(action.clientId)}/actions`,
      { clientActionId: action.id, expectedVersion: action.version, status, owner, targetDate: targetDate || null, progressPct, notes },
      crypto.randomUUID());
    setPending(false);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved("Action updated.");
  }

  async function remove() {
    setPending(true); setError(null);
    const result = await putBrowserCommand<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(action.clientId)}/actions`,
      { clientActionId: action.id, expectedVersion: action.version, reason }, crypto.randomUUID());
    setPending(false);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved("Action removed from the plan. It stays on the record.");
  }

  return <div className="nz-drawer-form">
    <div className="nz-action-head">
      <span className="nz-action-icon"><NziIcon name={iconKey(action.iconKey)} size={18} /></span>
      <div><b>{action.title}</b><div className="sub"><span className="nz-tag">{actionScopeLabel(action.scope)}</span> {action.category}</div></div>
    </div>

    <label className="nz-fl"><span>Status</span>
      <select className="nz-sel" value={status} onChange={(event) => chooseStatus(event.target.value as ActionStatus)}>
        {actionStatuses.map((value) => <option key={value} value={value}>{actionStatusLabels[value]}</option>)}
      </select></label>

    <label className="nz-fl"><span>Progress — {progressPct}%</span>
      <input type="range" min={0} max={100} step={5} value={progressPct}
        onChange={(event) => chooseProgress(Number(event.target.value))} />
      <small className="hint">What the client reports, not a modelled reduction.</small></label>

    <div className="nz-two">
      <label className="nz-fl"><span>Owner</span>
        <input className="nz-inp" value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
      <label className="nz-fl"><span>{status === "complete" ? "Completed" : "Target date"}</span>
        <input className="nz-inp" type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>
    </div>
    <label className="nz-fl"><span>Notes</span>
      <textarea className="nz-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>

    {removing ? <div className="nz-action-remove">
      <p className="sub">
        Removing takes this off the plan but keeps it on the record — a report that cited it must not end up
        pointing at nothing.
      </p>
      <label className="nz-fl"><span>Why is it being removed?</span>
        <input className="nz-inp" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. superseded by the site-wide retrofit" /></label>
    </div> : null}

    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}

    <div className="nz-drawer-actions">
      {removing
        ? <>
          <button type="button" className="nz-btn" onClick={() => { setRemoving(false); setReason(""); }}>Cancel</button>
          <span style={{ flex: 1 }} />
          <GatedButton className="nz-btn danger" blocked={pending || reason.trim() === ""}
            blockedReason={reason.trim() === "" ? "A reason is required." : undefined} reasonClassName="hint nz-gated-reason"
            onClick={() => void remove()}>{pending ? "Removing…" : "Remove from plan"}</GatedButton>
        </>
        : <>
          <GatedButton className="nz-btn danger" blocked={access.state !== "allowed"}
            blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
            onClick={() => setRemoving(true)}>Remove</GatedButton>
          <span style={{ flex: 1 }} />
          <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
          <GatedButton className="nz-btn pri" blocked={access.state !== "allowed" || pending}
            blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
            onClick={() => void save()}>{pending ? "Saving…" : "Save"}</GatedButton>
        </>}
    </div>
  </div>;
}
