"use client";

import { useRef, useState } from "react";
import { GatedButton, NziIcon, type NziIconKey } from "@nzi/ui";
import { patchBrowserCommand, postBrowserCommand, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  requirementsByPillar,
  strategyProgressForStatus, strategyScopeLabel, strategyScopes, strategyControlLevelLabels, strategyControlLevels,
  strategyStatusForProgress, strategyStatuses, strategyStatusLabels,
  type SrsFramework, type StrategyLibraryEntry, type StrategyScope, type StrategyControlLevel, type StrategyStatus, type ClientStrategy,
} from "@nzi/contracts";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * The Reduction Strategies drawers: pick from the library, write a bespoke strategy, or
 * edit one already on the plan.
 *
 * Status and progress are kept in step as the person types, because the database holds a
 * constraint that "done" means one thing — a form that can offer 60%-and-complete is a
 * form that produces a save error instead of a plan.
 *
 * Every strategy is aligned to at least one UK SRS requirement. That rule lives in the
 * database as a deferred constraint trigger, in the command validators, and here — a form
 * that can submit an unaligned strategy is a form whose only feedback is a save error.
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

const iconKey = (key: string): NziIconKey => key as NziIconKey;

/**
 * The alignment picker: the framework's requirements, grouped by pillar.
 *
 * Codes and titles together — "S2 M2" is what a report prints and what an assessor asks
 * about, but only the title says what it means. Pillars are collapsible for the same reason
 * the lever groups are: four pillars of a dozen requirements each is a long drawer.
 */
function SrsAlignmentPicker({ framework, selected, onChange, disabled }: {
  framework: SrsFramework; selected: readonly string[]; onChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const groups = requirementsByPillar(framework);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(groups.map((group) => group.pillar.key)));
  const chosen = new Set(selected);

  const toggleRequirement = (id: string) =>
    onChange(chosen.has(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  const togglePillar = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return <div className="nz-srs-picker">
    <div className="nz-srs-picker-head">
      <span>What does this advance?</span>
      <span className={chosen.size === 0 ? "hint warn" : "hint"}>
        {chosen.size === 0 ? "Pick at least one requirement" : `${chosen.size} selected`}
      </span>
    </div>
    <p className="hint">
      A strategy earns its place by advancing something the client is assessed on. What you pick
      here is what the report prints beside it.
    </p>
    {groups.map((group) => {
      const bodyId = `srs-pillar-${group.pillar.key}`;
      const count = group.requirements.filter((requirement) => chosen.has(requirement.id)).length;
      return <div className="nz-srs-pillar" key={group.pillar.key}>
        <button type="button" className="nz-srs-pillar-head" aria-expanded={open.has(group.pillar.key)} aria-controls={bodyId}
          onClick={() => togglePillar(group.pillar.key)}>
          <b>{group.pillar.label}</b>
          <span className="cnt">· {count} of {group.requirements.length}</span>
          <span className="sp" />
          <span className="nz-srs-chev" aria-hidden="true"><NziIcon name="check" size={13} /></span>
        </button>
        <div className="nz-srs-pillar-body" id={bodyId} hidden={!open.has(group.pillar.key)}>
          {group.requirements.map((requirement) => <label className="nz-srs-req" key={requirement.id}>
            <input type="checkbox" checked={chosen.has(requirement.id)} disabled={disabled}
              onChange={() => toggleRequirement(requirement.id)} />
            <span><span className="nz-tag srs">{requirement.code}</span> {requirement.title}</span>
          </label>)}
        </div>
      </div>;
    })}
  </div>;
}

/** No framework, no requirements to align to — said plainly rather than shown as a dead form. */
function NoFramework() {
  return <div className="nz-banner warn" role="alert">
    No UK SRS framework is published for this organisation yet, and every strategy must be aligned to at
    least one requirement. An administrator publishes the framework before a plan can be built.
  </div>;
}

export function StrategyLibraryForm({ clientId, library, framework, access, onClose, onSaved, onBespoke }: {
  clientId: string; library: StrategyLibraryEntry[]; framework: SrsFramework | null; access: EditAccess;
  onClose: () => void; onSaved: (text: string) => void; onBespoke: () => void;
}) {
  const [controlLevel, setControlLevel] = useState<StrategyControlLevel | "all">("all");
  const [scope, setScope] = useState<StrategyScope | "all">("all");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The entry awaiting confirmation, and the alignment as the person has it so far.
  const [confirming, setConfirming] = useState<StrategyLibraryEntry | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const shown = library.filter((entry) =>
    (controlLevel === "all" || entry.strategy.controlLevel === controlLevel) && (scope === "all" || entry.strategy.scope === scope));

  // Codes, not ids: the row says what the client will be shown to be advancing.
  const codes = new Map((framework?.requirements ?? []).map((requirement) => [requirement.id, requirement.code]));
  const defaults = (entry: StrategyLibraryEntry) =>
    entry.strategy.defaultSrsRequirementIds.filter((id) => codes.has(id));

  const startAdd = (entry: StrategyLibraryEntry) => {
    setError(null);
    setSelected(defaults(entry));
    setConfirming(entry);
  };
  const cancelAdd = () => { setConfirming(null); setSelected([]); setError(null); };

  async function add(entry: StrategyLibraryEntry) {
    setPending(true);
    setError(null);
    const result = await postBrowserCommand<{ clientStrategyId: string }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/strategies`,
      { strategyId: entry.strategy.id, srsRequirementIds: selected }, crypto.randomUUID());
    setPending(false);
    if (result.state !== "success") { setError(errorText(result)); return; }
    cancelAdd();
    onSaved(`${entry.strategy.title} added to the plan.`);
  }

  /**
   * The confirm step. The library's alignment arrives pre-filled, so agreeing with it is one
   * click — but it is a click. Carrying the default silently would produce alignments nobody
   * judged, and an alignment nobody judged is worse than none: it looks like consideration.
   */
  if (confirming !== null && framework !== null) {
    const entry = confirming;
    const unchanged = selected.length === defaults(entry).length
      && defaults(entry).every((id) => selected.includes(id));
    return <div className="nz-drawer-form">
      <div className="nz-action-head">
        <span className="nz-action-icon"><NziIcon name={iconKey(entry.strategy.iconKey)} size={18} /></span>
        <div><b>{entry.strategy.title}</b>
          <div className="sub"><span className="nz-tag">{strategyScopeLabel(entry.strategy.scope)}</span> {entry.strategy.category}</div></div>
      </div>
      <p className="sub">
        Confirm what this advances for <b>this</b> client before it joins the plan. The catalogue&rsquo;s
        alignment is filled in below — keep it, or change it to match what they are actually doing.
      </p>

      <SrsAlignmentPicker framework={framework} selected={selected} onChange={setSelected} disabled={pending} />
      {!unchanged ? <small className="hint">Changed from the catalogue&rsquo;s alignment for this client.</small> : null}

      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      <div className="nz-drawer-actions">
        <button type="button" className="nz-btn" onClick={cancelAdd}>Back to the library</button>
        <span style={{ flex: 1 }} />
        <GatedButton className="nz-btn pri" blocked={access.state !== "allowed" || pending || selected.length === 0}
          blockedReason={access.state !== "allowed" ? access.reason
            : selected.length === 0 ? "Align this strategy to at least one UK SRS requirement." : undefined}
          reasonClassName="hint nz-gated-reason"
          onClick={() => void add(entry)}>{pending ? "Adding…" : "Add to plan"}</GatedButton>
      </div>
    </div>;
  }

  return <div className="nz-drawer-form">
    <p className="sub">
      Assign reduction levers from the NZI catalogue to this client&rsquo;s plan. The catalogue is
      Admin-managed; what you assign is tracked per client and grouped by how much of it the client controls.
    </p>

    <div className="nz-filters" style={{ marginBottom: 10 }}>
      <button type="button" aria-pressed={controlLevel === "all"} className={controlLevel === "all" ? "on" : undefined} onClick={() => setControlLevel("all")}>All levels</button>
      {strategyControlLevels.map((value) => <button key={value} type="button" aria-pressed={controlLevel === value}
        className={controlLevel === value ? "on" : undefined} onClick={() => setControlLevel(value)}>{strategyControlLevelLabels[value].split(" · ")[0]}</button>)}
    </div>
    <div className="nz-filters" style={{ marginBottom: 12 }}>
      <button type="button" aria-pressed={scope === "all"} className={scope === "all" ? "on" : undefined} onClick={() => setScope("all")}>All scopes</button>
      {strategyScopes.map((value) => <button key={value} type="button" aria-pressed={scope === value}
        className={scope === value ? "on" : undefined} onClick={() => setScope(value)}>{strategyScopeLabel(value)}</button>)}
    </div>

    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    {framework === null ? <NoFramework /> : null}

    {shown.length === 0
      ? <p className="sub">No lever in the catalogue matches that filter.</p>
      : shown.map((entry) => {
        const aligned = defaults(entry);
        return <div className="nz-lib-item" key={entry.strategy.id}>
          <span className="nz-action-icon"><NziIcon name={iconKey(entry.strategy.iconKey)} size={16} /></span>
          <div className="nz-lib-main">
            <div className="nm">{entry.strategy.title}</div>
            <div className="sub">
              <span className="nz-tag">{strategyScopeLabel(entry.strategy.scope)}</span>
              {` ${[entry.strategy.category, strategyControlLevelLabels[entry.strategy.controlLevel].split(" · ")[0]].filter(Boolean).join(" · ")}`}
            </div>
            {/* What the library says this advances. It pre-fills the confirm step rather than
                being applied silently — see the confirm branch above. */}
            {aligned.length > 0
              ? <div className="sub">{aligned.map((id) => <span className="nz-tag srs" key={id}>{codes.get(id)}</span>)}</div>
              : <div className="hint">No SRS alignment set in the catalogue — an administrator sets one before this can be assigned.</div>}
            {/* A withdrawn lever is still shown while a client holds it, and says why it
                cannot be added again. */}
            {!entry.strategy.active ? <div className="hint">Withdrawn from the catalogue — kept because this client holds it.</div> : null}
          </div>
          {entry.assigned
            ? <span className="nz-tag">Added</span>
            : <GatedButton className="nz-btn sm" blocked={access.state !== "allowed" || !entry.strategy.active || framework === null || aligned.length === 0}
              blockedReason={access.state !== "allowed" ? access.reason
                : !entry.strategy.active ? "This lever has been withdrawn from the catalogue."
                  : framework === null ? "No UK SRS framework is published yet."
                    : aligned.length === 0 ? "Every strategy must advance at least one UK SRS requirement." : undefined}
              reasonClassName="hint nz-gated-reason"
              onClick={() => startAdd(entry)}>Add</GatedButton>}
        </div>;
      })}

    <div className="nz-drawer-actions">
      <button type="button" className="nz-btn" onClick={onBespoke}>Add something bespoke instead</button>
      <span style={{ flex: 1 }} />
      <button type="button" className="nz-btn" onClick={onClose}>Done</button>
    </div>
  </div>;
}

export function StrategyBespokeForm({ clientId, framework, access, onClose, onSaved }: {
  clientId: string; framework: SrsFramework | null; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [srsRequirementIds, setSrsRequirementIds] = useState<string[]>([]);
  const [scope, setScope] = useState<StrategyScope>("3");
  const [controlLevel, setControlLevel] = useState<StrategyControlLevel>("direct_control");
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
    const result = await postBrowserCommand<{ clientStrategyId: string }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/strategies`,
      { bespoke: { title, scope, controlLevel, category }, srsRequirementIds, owner, targetDate: targetDate || null, notes }, key.current);
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
        <select className="nz-sel" value={scope} onChange={(event) => setScope(event.target.value as StrategyScope)}>
          {strategyScopes.map((value) => <option key={value} value={value}>{strategyScopeLabel(value)}</option>)}
        </select></label>
      <label className="nz-fl"><span>How much do they control?</span>
        <select className="nz-sel" value={controlLevel} onChange={(event) => setControlLevel(event.target.value as StrategyControlLevel)}>
          {strategyControlLevels.map((value) => <option key={value} value={value}>{strategyControlLevelLabels[value]}</option>)}
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

    {framework === null
      ? <NoFramework />
      : <SrsAlignmentPicker framework={framework} selected={srsRequirementIds} onChange={setSrsRequirementIds} />}

    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    <div className="nz-drawer-actions">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
      <span style={{ flex: 1 }} />
      <GatedButton className="nz-btn pri" blocked={access.state !== "allowed" || pending || title.trim() === "" || srsRequirementIds.length === 0}
        blockedReason={access.state !== "allowed" ? access.reason
          : title.trim() === "" ? "Say what the strategy is."
            : srsRequirementIds.length === 0 ? "Align this strategy to at least one UK SRS requirement." : undefined}
        reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Adding…" : "Add to plan"}</GatedButton>
    </div>
  </div>;
}

export function StrategyEditForm({ action, framework, access, onClose, onSaved }: {
  action: ClientStrategy; framework: SrsFramework | null; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [status, setStatus] = useState<StrategyStatus>(action.status);
  const [progressPct, setProgressPct] = useState(action.progressPct);
  const [owner, setOwner] = useState(action.owner);
  const [targetDate, setTargetDate] = useState(action.targetDate ?? "");
  const [notes, setNotes] = useState(action.notes);
  const [srsRequirementIds, setSrsRequirementIds] = useState<string[]>([...action.srsRequirementIds]);
  const [includeInReport, setIncludeInReport] = useState(action.includeInReport);
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The two controls are one fact seen two ways, so moving either moves the other. The
  // database holds the same rule; keeping them in step here means the person never meets it.
  const chooseStatus = (next: StrategyStatus) => { setStatus(next); setProgressPct(strategyProgressForStatus(next, progressPct)); };
  const chooseProgress = (next: number) => { setProgressPct(next); setStatus(strategyStatusForProgress(next, status)); };

  async function save() {
    setPending(true); setError(null);
    const result = await patchBrowserCommand<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(action.clientId)}/strategies`,
      { clientStrategyId: action.id, expectedVersion: action.version, status, owner, targetDate: targetDate || null, progressPct, notes,
        srsRequirementIds, includeInReport },
      crypto.randomUUID());
    setPending(false);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved("Strategy updated.");
  }

  async function remove() {
    setPending(true); setError(null);
    const result = await putBrowserCommand<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(action.clientId)}/strategies`,
      { clientStrategyId: action.id, expectedVersion: action.version, reason }, crypto.randomUUID());
    setPending(false);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved("Action removed from the plan. It stays on the record.");
  }

  return <div className="nz-drawer-form">
    <div className="nz-action-head">
      <span className="nz-action-icon"><NziIcon name={iconKey(action.iconKey)} size={18} /></span>
      <div><b>{action.title}</b><div className="sub"><span className="nz-tag">{strategyScopeLabel(action.scope)}</span> {action.category}</div></div>
    </div>

    <label className="nz-fl"><span>Status</span>
      <select className="nz-sel" value={status} onChange={(event) => chooseStatus(event.target.value as StrategyStatus)}>
        {strategyStatuses.map((value) => <option key={value} value={value}>{strategyStatusLabels[value]}</option>)}
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

    {framework === null
      ? <NoFramework />
      : <SrsAlignmentPicker framework={framework} selected={srsRequirementIds} onChange={setSrsRequirementIds} />}

    {/* Read when a report is issued and frozen with it. Turning it off later does not change
        a report already sent — and turning it on does not add it to one either. */}
    <label className="nz-fl nz-check"><input type="checkbox" checked={includeInReport}
      onChange={(event) => setIncludeInReport(event.target.checked)} />
      <span>Include in the client&rsquo;s report</span></label>
    <small className="hint">
      Applies to reports issued from now on. A report already issued keeps the plan it was issued with.
    </small>

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
          <GatedButton className="nz-btn pri" blocked={access.state !== "allowed" || pending || srsRequirementIds.length === 0}
            blockedReason={access.state !== "allowed" ? access.reason
              : srsRequirementIds.length === 0 ? "Align this strategy to at least one UK SRS requirement." : undefined}
            reasonClassName="hint nz-gated-reason"
            onClick={() => void save()}>{pending ? "Saving…" : "Save"}</GatedButton>
        </>}
    </div>
  </div>;
}
