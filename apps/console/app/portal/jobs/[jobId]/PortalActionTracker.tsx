"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isPortalActionTracker, type PortalActionTracker, type PortalTrackerAction } from "@nzi/contracts";
import { redirectIfPortalSessionEnded } from "../../portalSessionClient";

type LoadState = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; tracker: PortalActionTracker };
type Draft = { leverCode: string; title: string; notes: string; progressPercent: number };
const emptyDraft = { leverCode: "A1.1", title: "", notes: "", progressPercent: 0 };

export function PortalActionTrackerPanel({ jobId }: { jobId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/portal/jobs/${jobId}/actions`, { cache: "no-store" });
      if (await redirectIfPortalSessionEnded(response)) return;
      const body: unknown = await response.json();
      if (!response.ok || !isPortalActionTracker(body)) throw new Error("Your action tracker could not be verified.");
      setState({ kind: "ready", tracker: body });
    } catch (error) { setState({ kind: "failed", message: error instanceof Error ? error.message : "Your action tracker could not be loaded." }); }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => state.kind !== "ready" ? [] : ["A", "B", "C"].map((code) => ({
    code,
    name: state.tracker.levers.find((lever) => lever.sphereCode === code)?.sphereName ?? "",
    levers: state.tracker.levers.filter((lever) => lever.sphereCode === code),
  })), [state]);

  const request = async (method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/portal/jobs/${jobId}/actions`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (await redirectIfPortalSessionEnded(response)) return false;
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message || "The action could not be saved.");
      setNotice(method === "POST" ? "Action added." : method === "DELETE" ? "Action removed." : "Action saved.");
      if (method === "POST") setDraft(emptyDraft);
      await load();
      return true;
    } catch (error) { setNotice(error instanceof Error ? error.message : "The action could not be saved."); return false; }
    finally { setBusy(false); }
  };

  if (state.kind === "loading") return <section className="nz-action-tracker-state" role="status"><b>Loading your action tracker</b><span>Reading client-managed engagement actions…</span></section>;
  if (state.kind === "failed") return <section className="nz-action-tracker-state failed" role="alert"><b>Action tracker unavailable</b><span>{state.message}</span><button className="nz-btn" onClick={() => void load()}>Try again</button></section>;

  return <section className="nz-action-tracker" aria-labelledby="action-tracker-title">
    <header>
      <div><span className="nz-eyebrow">Client-managed engagement plan</span><h2 id="action-tracker-title">Spheres of Influence action tracker</h2><p>Track delivery of qualitative actions across the 24 recognised levers. Progress percentages describe completion of your actions only; they are not emissions reductions.</p></div>
      <span className="nz-engagement-badge">Engagement data · not assured emissions</span>
    </header>

    <div className="nz-action-add">
      <h3>Add an action</h3>
      <label>Lever<select value={draft.leverCode} onChange={(e) => setDraft({ ...draft, leverCode: e.target.value })}>{state.tracker.levers.map((lever) => <option key={lever.code} value={lever.code}>{lever.code} · {lever.subSphereName} — {lever.description}</option>)}</select></label>
      <label>Action title<input value={draft.title} maxLength={240} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
      <label>Notes<textarea rows={3} maxLength={4000} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
      <label>Completion: <output>{draft.progressPercent}%</output><input type="range" min={0} max={100} step={5} value={draft.progressPercent} onChange={(e) => setDraft({ ...draft, progressPercent: Number(e.target.value) })} /></label>
      <button className="nz-btn pri" disabled={busy || !draft.title.trim()} onClick={() => void request("POST", draft)}>Add action</button>
    </div>

    <p className="nz-sr-status" role="status" aria-live="polite">{notice}</p>
    <div className="nz-spheres">
      {groups.map((group) => <section key={group.code} aria-labelledby={`sphere-${group.code}`}><h3 id={`sphere-${group.code}`}>Sphere {group.code} · {group.name}</h3>{group.levers.map((lever) => {
        const actions = state.tracker.actions.filter((action) => action.leverCode === lever.code);
        const average = actions.length ? Math.round(actions.reduce((sum, action) => sum + action.progressPercent, 0) / actions.length) : null;
        return <details key={lever.code} className="nz-lever" open={actions.length > 0}><summary><span><b>{lever.code}</b> {lever.description}</span><span>{actions.length} {actions.length === 1 ? "action" : "actions"}{average === null ? "" : ` · ${average}% average completion`}</span></summary><p className="nz-lever-sub">{lever.subSphereCode} · {lever.subSphereName}</p>{actions.length ? <ul>{actions.map((action) => <ActionRow key={action.id} action={action} levers={state.tracker.levers} busy={busy} save={(value) => request("PATCH", { actionId: action.id, expectedVersion: action.version, ...value })} />)}</ul> : <p className="nz-action-empty">No action recorded for this lever.</p>}</details>;
      })}</section>)}
    </div>
  </section>;
}

function ActionRow({ action, levers, busy, save }: { action: PortalTrackerAction; levers: PortalActionTracker["levers"]; busy: boolean; save: (value: Draft) => Promise<boolean> }) {
  const original = (): Draft => ({ leverCode: action.leverCode, title: action.title, notes: action.notes, progressPercent: action.progressPercent });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(original);
  useEffect(() => setDraft(original()), [action]);
  if (!editing) return <li><div><b>{action.title}</b>{action.notes ? <p>{action.notes}</p> : null}</div><span className="nz-action-progress">{action.progressPercent}% complete</span><button className="nz-btn" disabled={busy} onClick={() => setEditing(true)}>Edit action</button></li>;
  return <li className="editing">
    <label>Lever<select value={draft.leverCode} onChange={(e) => setDraft({ ...draft, leverCode: e.target.value })}>{levers.map((lever) => <option key={lever.code} value={lever.code}>{lever.code} · {lever.subSphereName}</option>)}</select></label>
    <label>Action title<input value={draft.title} maxLength={240} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
    <label>Notes<textarea rows={2} maxLength={4000} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
    <label htmlFor={`progress-${action.id}`}>Completion <output>{draft.progressPercent}%</output><input id={`progress-${action.id}`} type="range" min={0} max={100} step={5} value={draft.progressPercent} onChange={(e) => setDraft({ ...draft, progressPercent: Number(e.target.value) })} /></label>
    <div className="nz-action-row-buttons"><button className="nz-btn pri" disabled={busy || !draft.title.trim()} onClick={async () => { if (await save(draft)) setEditing(false); }}>Save action</button><button className="nz-btn" disabled={busy} onClick={() => { setDraft(original()); setEditing(false); }}>Cancel</button></div>
  </li>;
}
