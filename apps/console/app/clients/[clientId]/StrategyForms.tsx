"use client";

import { useRef, useState, type ReactNode } from "react";
import { Collapsible, GatedButton, NziIcon, type NziIconKey } from "@nzi/ui";
import { StrategyEstimateFields } from "./StrategyEstimateFields";
import { patchBrowserCommand, postBrowserCommand, putBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import {
  requirementsByPillar,
  strategyProgressForStatus, strategyScopeLabel, strategyScopes, strategyControlLevelLabels, strategyControlLevels,
  strategyNextStatuses, strategyOriginLabels, strategyStatusForProgress, strategyStatusLabels,
  type ClientContactReadModel, type Lever, type SrsFramework, type StrategyLibraryEntry, type StrategyScope, type StrategyControlLevel, type StrategyStatus, type ClientStrategy, type LibraryStrategy, type TargetBenchmark,
} from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * The Reduction Strategies drawers: pick from the library, confirm what a library strategy
 * advances, write a bespoke strategy, or edit one already on the plan.
 *
 * Every drawer has the side-panel anatomy of the job scope-row panel (DESIGN_CONVENTIONS
 * §3.4): a fixed header (eyebrow + title + subtitle), a body that is the only thing that
 * scrolls, and a pinned footer holding the actions. The footer is the point — with the SRS
 * pillars open the body is far taller than the screen, and a primary action that scrolls
 * away with it is a form nobody can submit. An error from that action renders in the footer
 * beside it for the same reason.
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

/** The fixed header: eyebrow, title, subtitle — the scope-row panel's own markup. */
function DrawerHeader({ kicker, title, subtitle }: { kicker: string; title: string; subtitle?: ReactNode }) {
  return <div className="nz-dh">
    <div className="kick">{kicker}</div>
    <h3>{title}</h3>
    {subtitle ? <div className="m">{subtitle}</div> : null}
  </div>;
}

/** An action's error, shown in the pinned footer so it stays next to the button that caused it. */
function FooterError({ error }: { error: string | null }) {
  return error ? <div className="nz-banner warn" role="alert">{error}</div> : null;
}

/**
 * The alignment picker: the framework's requirements, grouped by pillar.
 *
 * Codes and titles together — "S2 M2" is what a report prints and what an assessor asks
 * about, but only the title says what it means. Each pillar is a collapsed-by-default
 * `Collapsible` (§3.4): four pillars of a dozen requirements each is far longer than a
 * drawer, and the header's "n of m" count says where the selections are while it is shut.
 */
function SrsAlignmentPicker({ framework, selected, onChange, disabled }: {
  framework: SrsFramework; selected: readonly string[]; onChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const groups = requirementsByPillar(framework);
  const chosen = new Set(selected);

  const toggleRequirement = (id: string) =>
    onChange(chosen.has(id) ? selected.filter((value) => value !== id) : [...selected, id]);

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
      const count = group.requirements.filter((requirement) => chosen.has(requirement.id)).length;
      return <Collapsible key={group.pillar.key} title={group.pillar.label} count={`${count} of ${group.requirements.length}`}>
        {group.requirements.map((requirement) => <label className="nz-srs-req" key={requirement.id}>
          <input type="checkbox" checked={chosen.has(requirement.id)} disabled={disabled}
            onChange={() => toggleRequirement(requirement.id)} />
          <span><span className="nz-tag srs">{requirement.code}</span> {requirement.title}</span>
        </label>)}
      </Collapsible>;
    })}
  </div>;
}

/**
 * The owner (Actions A1, R4): one of this client's contacts, never free text. The list is the client's active contacts;
 * an owner who has since become inactive stays selectable on the action they already own, marked as such, so opening
 * the drawer never silently changes who owns it. What 0075's free-text owner said is shown until a contact is chosen.
 */
function OwnerPicker({ contacts, value, current, legacy, onChange, disabled }: {
  contacts: readonly ClientContactReadModel[]; value: string; current?: { id: string; name: string } | null; legacy?: string;
  onChange: (contactId: string) => void; disabled?: boolean;
}) {
  const options = contacts.filter((contact) => contact.status === "active");
  const held = current && !options.some((contact) => contact.id === current.id) ? current : null;
  return <label className="nz-fl"><span>Owner</span>
    <select className="nz-sel" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">No owner yet</option>
      {options.map((contact) => <option key={contact.id} value={contact.id}>{contact.fullName}{contact.jobTitle ? ` — ${contact.jobTitle}` : ""}</option>)}
      {held ? <option value={held.id}>{held.name || "A contact no longer on file"} (inactive)</option> : null}
    </select>
    {options.length === 0 && !held ? <small className="hint">This client has no active contacts yet — add one in Profile to give the action an owner.</small> : null}
    {legacy && !value ? <small className="hint">Previously noted as &ldquo;{legacy}&rdquo; — choose the contact who owns it.</small> : null}
  </label>;
}

/** Whether the client has already agreed the action as it is added — else it joins the plan as a proposal (R3). */
function AgreedCheck({ agreed, onChange, disabled }: { agreed: boolean; onChange: (agreed: boolean) => void; disabled?: boolean }) {
  return <>
    <label className="nz-fl nz-check"><input type="checkbox" checked={agreed} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>The client has already agreed this</span></label>
    <small className="hint">Otherwise it joins the plan as Proposed, and appears in reports once it is Agreed.</small>
  </>;
}

/** No framework, no requirements to align to — said plainly rather than shown as a dead form. */
function NoFramework() {
  return <div className="nz-banner warn" role="alert">
    No UK SRS framework is published for this organisation yet, and every strategy must be aligned to at
    least one requirement. An administrator publishes the framework before a plan can be built.
  </div>;
}

export function StrategyLibraryForm({ clientId, library, framework, contacts, access, onClose, onSaved, onBespoke }: {
  clientId: string; library: StrategyLibraryEntry[]; framework: SrsFramework | null; contacts: readonly ClientContactReadModel[]; access: EditAccess;
  onClose: () => void; onSaved: (text: string) => void; onBespoke: () => void;
}) {
  const [controlLevel, setControlLevel] = useState<StrategyControlLevel | "all">("all");
  const [scope, setScope] = useState<StrategyScope | "all">("all");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The entry awaiting confirmation, and the alignment as the person has it so far.
  const [confirming, setConfirming] = useState<StrategyLibraryEntry | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  // A1: who owns it, by when, and whether the client has already agreed it.
  const [ownerContactId, setOwnerContactId] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [agreed, setAgreed] = useState(false);

  const shown = library.filter((entry) =>
    (controlLevel === "all" || entry.strategy.controlLevel === controlLevel) && (scope === "all" || entry.strategy.scope === scope));

  // Codes, not ids: the row says what the client will be shown to be advancing.
  const codes = new Map((framework?.requirements ?? []).map((requirement) => [requirement.id, requirement.code]));
  const defaults = (entry: StrategyLibraryEntry) =>
    entry.strategy.defaultSrsRequirementIds.filter((id) => codes.has(id));

  const startAdd = (entry: StrategyLibraryEntry) => {
    setError(null);
    setSelected(defaults(entry));
    setOwnerContactId(""); setTargetDate(""); setAgreed(false);
    setConfirming(entry);
  };
  const cancelAdd = () => { setConfirming(null); setSelected([]); setError(null); };

  async function add(entry: StrategyLibraryEntry) {
    setPending(true);
    setError(null);
    const result = await postBrowserCommand<{ clientStrategyId: string }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/strategies`,
      { strategyId: entry.strategy.id, srsRequirementIds: selected, ownerContactId: ownerContactId || null, targetDate: targetDate || null,
        status: agreed ? "agreed" : "proposed" }, crypto.randomUUID());
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
    return <>
      <DrawerHeader kicker="Reduction strategies · confirm alignment" title={entry.strategy.title}
        subtitle="Confirm what this advances for this client before it joins the plan." />
      <div className="nz-db">
        <div className="nz-action-head">
          <span className="nz-action-icon"><NziIcon name={iconKey(entry.strategy.iconKey)} size={18} /></span>
          <div className="sub"><span className="nz-tag">{strategyScopeLabel(entry.strategy.scope)}</span> {entry.strategy.category}</div>
        </div>
        <p className="hint">
          The catalogue&rsquo;s alignment is filled in below — keep it, or change it to match what they are
          actually doing.
        </p>

        <div className="nz-two">
          <OwnerPicker contacts={contacts} value={ownerContactId} onChange={setOwnerContactId} disabled={pending} />
          <label className="nz-fl"><span>Target date</span>
            <input className="nz-inp" type="date" value={targetDate} disabled={pending} onChange={(event) => setTargetDate(event.target.value)} /></label>
        </div>
        <AgreedCheck agreed={agreed} onChange={setAgreed} disabled={pending} />

        <SrsAlignmentPicker framework={framework} selected={selected} onChange={setSelected} disabled={pending} />
        {!unchanged ? <small className="hint">Changed from the catalogue&rsquo;s alignment for this client.</small> : null}
      </div>
      <div className="nz-df">
        <FooterError error={error} />
        <button type="button" className="nz-btn" onClick={cancelAdd}>Back to the library</button>
        <span className="sp" />
        <GatedButton className="nz-btn pri" blocked={access.state !== "allowed" || pending || selected.length === 0}
          blockedReason={access.state !== "allowed" ? access.reason
            : selected.length === 0 ? "Align this strategy to at least one UK SRS requirement." : undefined}
          reasonClassName="hint nz-gated-reason"
          onClick={() => void add(entry)}>{pending ? "Adding…" : "Add to plan"}</GatedButton>
      </div>
    </>;
  }

  return <>
    <DrawerHeader kicker="Reduction strategies" title="Add from the library"
      subtitle="Choose from the NZI catalogue. It is Admin-managed; what you add is tracked for this client." />
    <div className="nz-db">
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

      {framework === null ? <NoFramework /> : null}

      {shown.length === 0
        ? <p className="sub">No strategy in the catalogue matches that filter.</p>
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
              {/* A withdrawn strategy is still shown while a client holds it, and says why it
                  cannot be added again. */}
              {!entry.strategy.active ? <div className="hint">Withdrawn from the catalogue — kept because this client holds it.</div> : null}
            </div>
            {entry.assigned
              ? <span className="nz-tag">Added</span>
              : <GatedButton className="nz-btn sm" blocked={access.state !== "allowed" || !entry.strategy.active || framework === null || aligned.length === 0}
                blockedReason={access.state !== "allowed" ? access.reason
                  : !entry.strategy.active ? "This strategy has been withdrawn from the catalogue."
                    : framework === null ? "No UK SRS framework is published yet."
                      : aligned.length === 0 ? "Every strategy must advance at least one UK SRS requirement." : undefined}
                reasonClassName="hint nz-gated-reason"
                onClick={() => startAdd(entry)}>Add</GatedButton>}
          </div>;
        })}
    </div>
    <div className="nz-df">
      <FooterError error={error} />
      <button type="button" className="nz-btn" onClick={onBespoke}>Add something bespoke instead</button>
      <span className="sp" />
      <button type="button" className="nz-btn" onClick={onClose}>Done</button>
    </div>
  </>;
}

export function StrategyBespokeForm({ clientId, framework, contacts, access, onClose, onSaved }: {
  clientId: string; framework: SrsFramework | null; contacts: readonly ClientContactReadModel[]; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [srsRequirementIds, setSrsRequirementIds] = useState<string[]>([]);
  const [scope, setScope] = useState<StrategyScope>("3");
  const [controlLevel, setControlLevel] = useState<StrategyControlLevel>("direct_control");
  const [category, setCategory] = useState("");
  const [ownerContactId, setOwnerContactId] = useState("");
  const [agreed, setAgreed] = useState(false);
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
      { bespoke: { title, scope, controlLevel, category }, srsRequirementIds, ownerContactId: ownerContactId || null, targetDate: targetDate || null, notes,
        status: agreed ? "agreed" : "proposed" }, key.current);
    setPending(false);
    if (result.state !== "success") { key.current = null; setError(errorText(result)); return; }
    key.current = null;
    onSaved(`${title.trim()} added to the plan.`);
  }

  return <>
    <DrawerHeader kicker="Reduction strategies" title="Add a bespoke strategy"
      subtitle="For something this client is doing that is not in the catalogue." />
    <div className="nz-db">
      <p className="hint">
        If it turns out to be common, an administrator can add it to the library so other clients can use it too.
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
        <OwnerPicker contacts={contacts} value={ownerContactId} onChange={setOwnerContactId} />
      </div>
      <label className="nz-fl"><span>Target date</span>
        <input className="nz-inp" type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>
      <AgreedCheck agreed={agreed} onChange={setAgreed} />
      <label className="nz-fl"><span>Notes</span>
        <textarea className="nz-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>

      {framework === null
        ? <NoFramework />
        : <SrsAlignmentPicker framework={framework} selected={srsRequirementIds} onChange={setSrsRequirementIds} />}
    </div>
    <div className="nz-df">
      <FooterError error={error} />
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
      <span className="sp" />
      <GatedButton className="nz-btn pri" blocked={access.state !== "allowed" || pending || title.trim() === "" || srsRequirementIds.length === 0}
        blockedReason={access.state !== "allowed" ? access.reason
          : title.trim() === "" ? "Say what the strategy is."
            : srsRequirementIds.length === 0 ? "Align this strategy to at least one UK SRS requirement." : undefined}
        reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Adding…" : "Add to plan"}</GatedButton>
    </div>
  </>;
}

export function StrategyEditForm({ action, framework, contacts, benchmark, libraryDefault, access, onClose, onSaved }: {
  action: ClientStrategy; framework: SrsFramework | null; contacts: readonly ClientContactReadModel[];
  /** The baseline a percentage estimate resolves against — the target pathway's own. */
  benchmark: TargetBenchmark | null;
  /** The catalogue entry this strategy came from, so its modelled figure can seed the form. */
  libraryDefault: LibraryStrategy | null;
  access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [status, setStatus] = useState<StrategyStatus>(action.status);
  const [progressPct, setProgressPct] = useState(action.progressPct);
  const [ownerContactId, setOwnerContactId] = useState(action.ownerContactId ?? "");
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
      { clientStrategyId: action.id, expectedVersion: action.version, status, ownerContactId: ownerContactId || null, targetDate: targetDate || null, progressPct, notes,
        srsRequirementIds, includeInReport },
      crypto.randomUUID());
    setPending(false);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved("Strategy updated.");
  }

  async function remove() {
    setPending(true); setError(null);
    // The reason travels as the command's reason header — the one the validator reads — as well as in the body.
    const result = await putBrowserCommandWithReason<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(action.clientId)}/strategies`,
      { clientStrategyId: action.id, expectedVersion: action.version, reason }, crypto.randomUUID(), reason);
    setPending(false);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved("Strategy removed from the plan. It stays on the record.");
  }

  return <>
    <DrawerHeader kicker={`Reduction strategy · version ${action.version}`} title={action.title}
      subtitle={<><span className="nz-tag">{strategyScopeLabel(action.scope)}</span> {action.category}
        {" · "}<span className="nz-tag">{strategyOriginLabels[action.origin]}</span></>} />
    <div className="nz-db">
      {/* Only the moves the ladder allows from where it stands (A1, R3) — the command refuses the rest. */}
      <label className="nz-fl"><span>Status</span>
        <select className="nz-sel" value={status} onChange={(event) => chooseStatus(event.target.value as StrategyStatus)}>
          {strategyNextStatuses(action.status).map((value) => <option key={value} value={value}>{strategyStatusLabels[value]}</option>)}
        </select>
        <small className="hint">Proposed → Agreed → In progress → Complete, or On hold / Declined along the way.</small></label>

      <label className="nz-fl"><span>Progress — {progressPct}%</span>
        <input type="range" min={0} max={100} step={5} value={progressPct}
          onChange={(event) => chooseProgress(Number(event.target.value))} />
        <small className="hint">What the client reports, not a modelled reduction.</small></label>

      <div className="nz-two">
        <OwnerPicker contacts={contacts} value={ownerContactId}
          current={action.ownerContactId ? { id: action.ownerContactId, name: action.owner } : null}
          legacy={action.ownerContactId ? undefined : action.owner} onChange={setOwnerContactId} />
        <label className="nz-fl"><span>{status === "complete" ? "Completed" : "Target date"}</span>
          <input className="nz-inp" type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>
      </div>
      <label className="nz-fl"><span>Notes</span>
        <textarea className="nz-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>

      {framework === null
        ? <NoFramework />
        : <SrsAlignmentPicker framework={framework} selected={srsRequirementIds} onChange={setSrsRequirementIds} />}

      {/* One flag, two surfaces. The portal plan reads it live, so clearing it takes the
          strategy off the client's portal on their next load; the report reads it when a
          report is issued and freezes it, so a report already sent is unaffected either way. */}
      <label className="nz-fl nz-check"><input type="checkbox" checked={includeInReport}
        onChange={(event) => setIncludeInReport(event.target.checked)} />
        <span>Include in report</span></label>
      <small className="hint">
        Controls what the client sees: their portal plan, which updates live, and the reports issued from
        now on — where it appears once it is Agreed or beyond. A report already issued keeps the plan it was
        issued with. Clear it to hold a strategy back from both; this plan here shows it either way.
      </small>

      {removing ? <div className="nz-action-remove">
        <p className="sub">
          Removing takes this off the plan but keeps it on the record — a report that cited it must not end up
          pointing at nothing.
        </p>
        <label className="nz-fl"><span>Why is it being removed?</span>
          <input className="nz-inp" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. superseded by the site-wide retrofit" /></label>
      </div> : null}

      {/* The quantified layer, in its own section with its own action: an estimate is a
          separate governed fact, and Save above must not be a way to change a carbon figure
          while editing a target date. */}
      <StrategyEstimateFields strategy={action} benchmark={benchmark} libraryDefault={libraryDefault}
        access={access} onSaved={onSaved} />
    </div>

    <div className="nz-df">
      <FooterError error={error} />
      {removing
        ? <>
          <button type="button" className="nz-btn" onClick={() => { setRemoving(false); setReason(""); }}>Cancel</button>
          <span className="sp" />
          <GatedButton className="nz-btn danger" blocked={pending || reason.trim() === ""}
            blockedReason={reason.trim() === "" ? "A reason is required." : undefined} reasonClassName="hint nz-gated-reason"
            onClick={() => void remove()}>{pending ? "Removing…" : "Remove from plan"}</GatedButton>
        </>
        : <>
          <GatedButton className="nz-btn danger" blocked={access.state !== "allowed"}
            blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
            onClick={() => setRemoving(true)}>Remove</GatedButton>
          <span className="sp" />
          <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
          <GatedButton className="nz-btn pri" blocked={access.state !== "allowed" || pending || srsRequirementIds.length === 0}
            blockedReason={access.state !== "allowed" ? access.reason
              : srsRequirementIds.length === 0 ? "Align this strategy to at least one UK SRS requirement." : undefined}
            reasonClassName="hint nz-gated-reason"
            onClick={() => void save()}>{pending ? "Saving…" : "Save"}</GatedButton>
        </>}
    </div>
  </>;
}

/**
 * A client's proposed action (Actions A2, R2/R3): the consultant rules on it, once.
 *
 * **Approve** settles it as a plan action — its wording, scope, control level and category as the consultant judges them,
 * what it advances (the alignment every action on a plan carries), who owns it and by when — and it joins the plan
 * **Agreed**. **Decline** keeps it off the plan, with a reason the client reads in their portal ("Not taken forward").
 *
 * **Also add to the library** is offered only to an Admin holding the library capability: a deliberate copy, made after
 * the approval succeeds, so the library entry is always of an approved action. It never happens on its own.
 */
export function StrategyProposalForm({ proposal, framework, contacts, levers, canPromote, access, onClose, onSaved }: {
  proposal: ClientStrategy; framework: SrsFramework | null; contacts: readonly ClientContactReadModel[];
  levers: readonly Lever[]; canPromote: boolean; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [scope, setScope] = useState<StrategyScope>(proposal.scope);
  const [controlLevel, setControlLevel] = useState<StrategyControlLevel>(proposal.controlLevel);
  const [category, setCategory] = useState(proposal.category);
  const [ownerContactId, setOwnerContactId] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [includeInReport, setIncludeInReport] = useState(true);
  const [srsRequirementIds, setSrsRequirementIds] = useState<string[]>([]);
  const [promote, setPromote] = useState(false);
  const [libraryKey, setLibraryKey] = useState(proposal.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60));
  const [leverIds, setLeverIds] = useState<string[]>([]);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const note = proposal.proposal?.note ?? "";

  async function approve() {
    setPending(true); setError(null);
    const result = await patchBrowserCommand<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(proposal.clientId)}/strategies/proposals`,
      { clientStrategyId: proposal.id, expectedVersion: proposal.version, title, scope, controlLevel, category, srsRequirementIds, includeInReport,
        ownerContactId: ownerContactId || null, targetDate: targetDate || null }, crypto.randomUUID());
    if (result.state !== "success") { setPending(false); setError(errorText(result)); return; }
    if (promote) {
      const promoted = await postBrowserCommand<{ strategyId: string }>("/api/isolated/reduction-strategies/promote",
        { clientStrategyId: proposal.id, key: libraryKey, leverIds, description: note }, crypto.randomUUID());
      setPending(false);
      // The approval stands either way; a failed copy is said plainly rather than undoing the decision.
      if (promoted.state !== "success") { onSaved(`${title.trim()} approved and agreed — but not added to the library: ${errorText(promoted)}`); return; }
      onSaved(`${title.trim()} approved, agreed, and added to the library.`);
      return;
    }
    setPending(false);
    onSaved(`${title.trim()} approved — it is on the plan as Agreed.`);
  }

  async function decline() {
    setPending(true); setError(null);
    const result = await putBrowserCommandWithReason<{ version: number }>(
      `/api/isolated/clients/${encodeURIComponent(proposal.clientId)}/strategies/proposals`,
      { clientStrategyId: proposal.id, expectedVersion: proposal.version, reason }, crypto.randomUUID(), reason);
    setPending(false);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onSaved("Proposal declined. The client sees it as not taken forward, with your reason.");
  }

  const activeLevers = levers.filter((lever) => lever.active);
  const toggleLever = (id: string) => setLeverIds((now) => now.includes(id) ? now.filter((value) => value !== id) : [...now, id]);

  return <>
    <DrawerHeader kicker={`Proposed by the client${proposal.proposal ? ` · ${formatDate(proposal.proposal.proposedOn)}` : ""}`}
      title={proposal.title} subtitle="Approve it onto the plan as Agreed, or decline it with a reason the client will read." />
    <div className="nz-db">
      {note !== "" ? <div className="nz-banner"><b>What the client wrote</b><p className="sub" style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{note}</p></div> : null}
      {declining
        ? <label className="nz-fl"><span>Why is it not being taken forward?</span>
          <textarea className="nz-notes" rows={4} value={reason} disabled={pending} onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Already covered by the site-wide LED retrofit on your plan." />
          <small className="hint">The client reads this in their portal, beside &ldquo;Not taken forward&rdquo;.</small></label>
        : <>
          <label className="nz-fl"><span>The action, as it will appear on the plan</span>
            <input className="nz-inp" value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} /></label>
          <div className="nz-two">
            <label className="nz-fl"><span>Scope</span>
              <select className="nz-sel" value={scope} disabled={pending} onChange={(event) => setScope(event.target.value as StrategyScope)}>
                {strategyScopes.map((value) => <option key={value} value={value}>{strategyScopeLabel(value)}</option>)}
              </select></label>
            <label className="nz-fl"><span>How much do they control?</span>
              <select className="nz-sel" value={controlLevel} disabled={pending} onChange={(event) => setControlLevel(event.target.value as StrategyControlLevel)}>
                {strategyControlLevels.map((value) => <option key={value} value={value}>{strategyControlLevelLabels[value]}</option>)}
              </select></label>
          </div>
          <div className="nz-two">
            <label className="nz-fl"><span>Category</span>
              <input className="nz-inp" value={category} disabled={pending} onChange={(event) => setCategory(event.target.value)} placeholder="e.g. Heating" /></label>
            <OwnerPicker contacts={contacts} value={ownerContactId} onChange={setOwnerContactId} disabled={pending} />
          </div>
          <label className="nz-fl"><span>Target date</span>
            <input className="nz-inp" type="date" value={targetDate} disabled={pending} onChange={(event) => setTargetDate(event.target.value)} /></label>
          <label className="nz-fl nz-check"><input type="checkbox" checked={includeInReport} disabled={pending} onChange={(event) => setIncludeInReport(event.target.checked)} />
            <span>Include in report</span></label>
          <small className="hint">Shown on the client&rsquo;s portal plan, and in reports issued from now on (as Agreed).</small>
          {framework === null ? <NoFramework />
            : <SrsAlignmentPicker framework={framework} selected={srsRequirementIds} onChange={setSrsRequirementIds} disabled={pending} />}

          {canPromote ? <div className="nz-srs-picker">
            <label className="nz-fl nz-check"><input type="checkbox" checked={promote} disabled={pending} onChange={(event) => setPromote(event.target.checked)} />
              <span>Also add it to the library, for every client</span></label>
            <small className="hint">A copy, made once the approval succeeds — with this wording, scope and alignment as its defaults. This client&rsquo;s own action stays theirs.</small>
            {promote ? <>
              <label className="nz-fl"><span>Library key</span>
                <input className="nz-inp" value={libraryKey} disabled={pending} onChange={(event) => setLibraryKey(event.target.value)} /></label>
              <div className="nz-fl"><span>Levers it sits under</span>
                <div className="nz-filters">{activeLevers.map((lever) => <button key={lever.id} type="button" aria-pressed={leverIds.includes(lever.id)}
                  className={leverIds.includes(lever.id) ? "on" : undefined} disabled={pending} onClick={() => toggleLever(lever.id)}>{lever.title}</button>)}</div>
              </div>
            </> : null}
          </div> : null}
        </>}
    </div>
    <div className="nz-df">
      <FooterError error={error} />
      {declining
        ? <>
          <button type="button" className="nz-btn" onClick={() => { setDeclining(false); setReason(""); }}>Back</button>
          <span className="sp" />
          <GatedButton className="nz-btn danger" blocked={access.state !== "allowed" || pending || reason.trim() === ""}
            blockedReason={access.state !== "allowed" ? access.reason : reason.trim() === "" ? "Say why — the client reads it." : undefined}
            reasonClassName="hint nz-gated-reason" onClick={() => void decline()}>{pending ? "Declining…" : "Decline proposal"}</GatedButton>
        </>
        : <>
          <GatedButton className="nz-btn danger" blocked={access.state !== "allowed" || pending}
            blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
            onClick={() => setDeclining(true)}>Decline…</GatedButton>
          <span className="sp" />
          <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
          <GatedButton className="nz-btn pri" blocked={access.state !== "allowed" || pending || title.trim() === "" || srsRequirementIds.length === 0 || (promote && libraryKey.trim() === "")}
            blockedReason={access.state !== "allowed" ? access.reason
              : title.trim() === "" ? "Say what the action is."
                : srsRequirementIds.length === 0 ? "Align it to at least one UK SRS requirement — it joins the plan."
                  : promote && libraryKey.trim() === "" ? "Give the library entry a key." : undefined}
            reasonClassName="hint nz-gated-reason" onClick={() => void approve()}>{pending ? "Approving…" : "Approve and agree"}</GatedButton>
        </>}
    </div>
  </>;
}
