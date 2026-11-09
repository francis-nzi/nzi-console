"use client";

import { useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { GatedButton, InfoTip, SmartSearch } from "@nzi/ui";
import { postBrowserCommand, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  PRIORITIES, SRS_ASSESSMENT_NOTES_MAX, isPriority, priorityLabels, srsBridgedBy, strategyStatusLabels,
  type ClientContactReadModel, type ClientStrategy, type Priority, type SrsAssessment, type SrsAssessmentItem, type SrsFramework, type SrsMaturity,
} from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { addressedCount, canComplete, entersNewPillar, maturityMap, resumeIndex, wizardSteps } from "./srsWizard";

/**
 * The guided assessment: a focused modal that walks the requirements one question per screen, grouped by pillar.
 *
 * Every question carries all its fields inline — maturity on the 0–4 ladder, evidence, priority, owner, target date and
 * the gap→action link. Each question is saved on its own, through the same `srs.assessment.item.set` command, when you
 * move off it (Next, Back, a jump, or close), carrying the item's `expectedVersion` so a second person on the same
 * assessment is told rather than overwritten. A requirement with no maturity is not addressed — it is not a zero.
 * Below the fields sits the assessment's one context note — the same note on every question, saved through
 * `srs.assessment.notes.set` (carrying the assessment's version) at the same moments as the answer.
 * Complete assessment is offered only when every requirement has a maturity. A completed assessment opens read-only.
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

type Draft = {
  maturity: SrsMaturity | null;
  evidenceKind: "document" | "data" | "note" | "";
  evidenceRef: string; evidenceNote: string;
  priority: Priority | "";
  owner: string; dueDate: string;
};

const draftOf = (item: SrsAssessmentItem | null | undefined): Draft => ({
  maturity: item?.maturity ?? null,
  evidenceKind: item?.evidence?.kind ?? "", evidenceRef: item?.evidence?.ref ?? "", evidenceNote: item?.evidence?.note ?? "",
  priority: item?.priority ?? "",
  owner: item?.owner ?? "", dueDate: item?.dueDate ?? "",
});

const sameDraft = (a: Draft, b: Draft) => (Object.keys(a) as Array<keyof Draft>).every((key) => a[key] === b[key]);

const evidenceProblem = (draft: Draft) =>
  draft.evidenceKind !== "" && !draft.evidenceRef.trim() && !draft.evidenceNote.trim() ? "Evidence needs a reference or a note." : null;

export function SrsWizard({ framework, assessment, startAt, access, plan, contacts, closeRef, onClose, onBridge, onCompleted }: {
  framework: SrsFramework;
  assessment: SrsAssessment;
  /** The requirement to open on (a register row's Edit); otherwise the first one still to address. */
  startAt?: string | null;
  access: EditAccess;
  plan: readonly ClientStrategy[];
  /** This client's contacts — the owner is chosen from them, as the Actions owner is. */
  contacts: readonly ClientContactReadModel[];
  /** Escape and the page host close through here, so a question in progress is saved first. */
  closeRef: MutableRefObject<(() => void) | null>;
  /** `changed`: at least one answer was saved, so the page needs to refresh. */
  onClose: (changed: boolean) => void;
  onBridge: (requirementId: string) => void;
  onCompleted: (assessedOn: string) => void;
}) {
  const [steps] = useState(() => wizardSteps(framework));
  const [items] = useState(() => new Map(assessment.items.map((item) => [item.requirementId, item])));
  const readOnly = assessment.status !== "draft" || access.state !== "allowed";

  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(steps.map((step) => [step.requirement.id, draftOf(items.get(step.requirement.id))])));
  const baseline = useRef<Record<string, Draft>>({ ...drafts });
  const versions = useRef<Record<string, number>>(Object.fromEntries(assessment.items.map((item) => [item.requirementId, item.version])));
  const changed = useRef(false);
  const key = useRef<string | null>(null);
  // The assessment's note is one record for every screen: its own draft, baseline, version and idempotency key.
  const [notes, setNotes] = useState(assessment.notes);
  const savedNotes = useRef(assessment.notes);
  const assessmentVersion = useRef(assessment.version);
  const notesKey = useRef<string | null>(null);

  const [index, setIndex] = useState(() => {
    const requested = startAt ? steps.findIndex((step) => step.requirement.id === startAt) : -1;
    return requested >= 0 ? requested : resumeIndex(steps, maturityMap(assessment.items));
  });
  const [divider, setDivider] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [stuck, setStuck] = useState(false);

  const step = steps[index];
  if (!step) return null;
  const maturities = new Map(Object.entries(drafts).map(([id, entry]) => [id, entry.maturity]));
  const addressed = addressedCount(steps, maturities);
  const ready = canComplete(steps, maturities);
  const { requirement, pillar } = step;
  const draft = drafts[requirement.id]!;
  const item = items.get(requirement.id) ?? null;
  const targetLabel = framework.maturityLevels.find((level) => level.level === requirement.targetMaturity)?.label ?? "";
  const belowTarget = draft.maturity === null ? requirement.targetMaturity > 0 : draft.maturity < requirement.targetMaturity;
  const bridged = srsBridgedBy(requirement.id, plan, item?.linkedActionId ?? null);
  const set = (patch: Partial<Draft>) => setDrafts((now) => ({ ...now, [requirement.id]: { ...now[requirement.id]!, ...patch } }));
  const addressedIn = (pillarKey: string) => steps.filter((entry) => entry.pillar.key === pillarKey && maturities.get(entry.requirement.id) != null).length;

  /** Save the assessment note if it changed. False means stay put — the reason is on screen. */
  async function saveNotes(): Promise<boolean> {
    if (notes === savedNotes.current) return true;
    setPending(true); setError(null);
    notesKey.current ??= crypto.randomUUID();
    const result = await putBrowserCommand<{ version: number }>(
      `/api/isolated/srs-assessments/${encodeURIComponent(assessment.assessmentId)}/notes`,
      { notes, expectedVersion: assessmentVersion.current }, notesKey.current);
    setPending(false);
    notesKey.current = null;
    if (result.state !== "success") {
      if (result.state === "conflict") setConflict(true);
      setError(result.state === "conflict" ? "Someone else has changed this assessment since you opened it. Close and reopen it to see the latest." : errorText(result));
      return false;
    }
    assessmentVersion.current = result.data.version;
    savedNotes.current = notes;
    changed.current = true;
    return true;
  }

  /** Save the note and the question on screen if they changed. False means stay put — the reason is on screen. */
  async function saveCurrent(): Promise<boolean> {
    if (readOnly) return true;
    if (!(await saveNotes())) return false;
    const current = drafts[requirement.id]!;
    if (sameDraft(current, baseline.current[requirement.id]!)) return true;
    const problem = evidenceProblem(current);
    if (problem) { setError(problem); return false; }
    setPending(true); setError(null);
    key.current ??= crypto.randomUUID();
    const result = await putBrowserCommand<{ version: number }>(
      `/api/isolated/srs-assessments/${encodeURIComponent(assessment.assessmentId)}`,
      {
        requirementId: requirement.id, maturity: current.maturity,
        evidenceKind: current.evidenceKind === "" ? null : current.evidenceKind,
        evidenceRef: current.evidenceRef.trim() || null, evidenceNote: current.evidenceNote.trim(),
        priority: isPriority(current.priority) ? current.priority : null,
        owner: current.owner.trim(), dueDate: current.dueDate || null,
        linkedActionId: item?.linkedActionId ?? null,
        expectedVersion: versions.current[requirement.id] ?? 0,
      }, key.current);
    setPending(false);
    if (result.state !== "success") {
      key.current = null;
      if (result.state === "conflict") setConflict(true);
      setError(result.state === "conflict" ? "Someone else has changed this answer since you opened the assessment. Close and reopen it to see the latest." : errorText(result));
      return false;
    }
    key.current = null;
    versions.current[requirement.id] = result.data.version;
    baseline.current[requirement.id] = current;
    changed.current = true;
    return true;
  }

  async function go(to: number, showDivider = false) {
    if (to < 0 || to >= steps.length || pending) return;
    if (!(await saveCurrent())) return;
    setError(null);
    setDivider(showDivider);
    setIndex(to);
  }
  const next = () => divider ? setDivider(false) : go(index + 1, entersNewPillar(steps, index, index + 1));

  async function requestClose() {
    if (await saveCurrent()) onClose(changed.current);
    else setStuck(true);
  }

  closeRef.current = () => void requestClose();

  async function complete() {
    if (!(await saveCurrent())) return;
    setPending(true);
    const result = await postBrowserCommand<{ assessedOn: string }>(`/api/isolated/srs-assessments/${encodeURIComponent(assessment.assessmentId)}`,
      { expectedVersion: assessmentVersion.current }, crypto.randomUUID());
    setPending(false);
    if (result.state !== "success") { setError(errorText(result)); return; }
    onCompleted(result.data.assessedOn);
  }

  async function bridge() {
    if (await saveCurrent()) { onClose(changed.current); onBridge(requirement.id); }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const typing = target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
      || (target instanceof HTMLInputElement && target.type !== "radio");
    if (!divider && !readOnly && !typing && /^[0-4]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); set({ maturity: Number(event.key) as SrsMaturity }); return;
    }
    // A control that used the Enter itself (the owner search choosing a contact) keeps it.
    if (event.key === "Enter" && !event.shiftKey && !event.defaultPrevented && !(target instanceof HTMLButtonElement) && !(target instanceof HTMLSelectElement)
      && !(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLAnchorElement)) {
      event.preventDefault(); void next();
    }
  }

  const pillars = [...new Map(steps.map((entry) => [entry.pillar.key, entry.pillar])).values()];
  const jump = (pillarKey: string) => {
    const group = steps.filter((entry) => entry.pillar.key === pillarKey);
    const target = group.find((entry) => maturities.get(entry.requirement.id) == null) ?? group[0];
    if (target) void go(steps.indexOf(target));
  };
  const last = index === steps.length - 1;

  return <div className="nz-srs-wizard-body" onKeyDown={onKeyDown}>
    <div className="nz-dh">
      <div className="k">{divider ? "Next section" : `${pillar.label} · ${requirement.standardKey}`}</div>
      <h3>{divider ? pillar.label : requirement.title}</h3>
      <div className="m">
        <b>{index + 1} of {steps.length}</b> · {addressed} addressed
        {" · "}<label>Section <select className="nz-sel" aria-label="Jump to section" value={pillar.key} onChange={(event) => jump(event.target.value)}>
          {pillars.map((entry) => <option key={entry.key} value={entry.key}>{entry.label} — {addressedIn(entry.key)}/{steps.filter((s) => s.pillar.key === entry.key).length}</option>)}
        </select></label>
      </div>
      <button type="button" className="x" onClick={() => void requestClose()} aria-label="Close">×</button>
    </div>

    <div className="nz-db" aria-busy={pending}>
      {assessment.status !== "draft"
        ? <div className="nz-banner ok" role="status" style={{ marginBottom: 10 }}><div><b>Scores locked.</b> Assessed {assessment.assessedOn ? formatDate(assessment.assessedOn) : ""}. Reopen it from the readiness page to correct it.</div></div>
        : access.state !== "allowed"
          ? <div className="nz-banner warn" role="status" style={{ marginBottom: 10 }}>{access.reason}</div> : null}

      {divider
        ? <div className="nz-srs-divider">
          <p className="nz-hint" style={{ marginTop: 0 }}>{pillar.description}</p>
          <p><b>{step.pillarSize} questions</b> · {addressedIn(pillar.key)} addressed</p>
        </div>
        : <>
          <p className="nz-hint" style={{ marginTop: 0 }}>
            {requirement.code}{requirement.helpText ? <InfoTip label={`About ${requirement.code}`}>{requirement.helpText}</InfoTip> : null}
            {" · "}SRS expects <b>{targetLabel}</b> here.
          </p>
          {requirement.source === "nzi-data" ? <div className="nz-banner ok" role="status" style={{ marginBottom: 10 }}>
            <div>{item?.source === "auto"
              ? "Scored automatically from the client's verified data. Override if the disclosure needs something different."
              : "Can be scored automatically from the client's verified data."}</div>
          </div> : null}

          <div className="nz-sect">Maturity</div>
          <div className="nz-srs-ladder" role="radiogroup" aria-label="Maturity">
            {framework.maturityLevels.map((level) => <label key={level.level} className={`nz-srs-rung${draft.maturity === level.level ? " on" : ""}`}>
              <input type="radio" name="srs-maturity" disabled={readOnly} checked={draft.maturity === level.level} onChange={() => set({ maturity: level.level })} />
              <b>{level.level} · {level.label}</b><span>{level.definition}</span>
            </label>)}
          </div>
          <button type="button" className="nz-editlink" onClick={() => set({ maturity: null })} disabled={readOnly || draft.maturity === null}>Clear answer</button>

          <div className="nz-sect">Evidence</div>
          <label className="nz-fl"><span>Kind</span>
            <select className="nz-sel" disabled={readOnly} value={draft.evidenceKind} onChange={(event) => set({ evidenceKind: event.target.value as Draft["evidenceKind"] })}>
              <option value="">None recorded</option>
              <option value="document">Document</option>
              <option value="data">Data reference</option>
              <option value="note">Note</option>
            </select>
          </label>
          {draft.evidenceKind !== "" ? <>
            <label className="nz-fl"><span>Reference</span><input className="nz-inp" disabled={readOnly} value={draft.evidenceRef} onChange={(event) => set({ evidenceRef: event.target.value })} placeholder="e.g. Board minutes, 12/03/2026" /></label>
            <label className="nz-fl"><span>Note</span><input className="nz-inp" disabled={readOnly} value={draft.evidenceNote} onChange={(event) => set({ evidenceNote: event.target.value })} placeholder="What the evidence shows" /></label>
          </> : <span className="nz-hint">Readiness that cannot be evidenced is shown as unevidenced rather than counted as verified.</span>}

          <div className="nz-sect">Priority <InfoTip label="priority">Internal only — sets the order of Path to SRS-ready. The client doesn&apos;t see it.</InfoTip></div>
          <select className="nz-sel" aria-label="Priority" disabled={readOnly} value={draft.priority} onChange={(event) => set({ priority: isPriority(event.target.value) ? event.target.value : "" })}>
            <option value="">Not set</option>
            {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priorityLabels[priority]}</option>)}
          </select>

          <div className="nz-sect">Owner and date</div>
          <div className="nz-two">
            <SrsOwnerPicker contacts={contacts} owner={draft.owner} disabled={readOnly} onChange={(owner) => set({ owner })} />
            <label className="nz-fl"><span>Target date</span><input className="nz-inp" type="date" disabled={readOnly} value={draft.dueDate} onChange={(event) => set({ dueDate: event.target.value })} /></label>
          </div>

          <div className="nz-sect">Notes <InfoTip label="notes">One note for the whole assessment — your team only.</InfoTip></div>
          <textarea className="nz-in" aria-label="Notes" rows={3} style={{ width: "100%", boxSizing: "border-box" }} maxLength={SRS_ASSESSMENT_NOTES_MAX} disabled={readOnly} value={notes} onChange={(event) => setNotes(event.target.value)} />

          <div className="nz-sect">Gap → action</div>
          {bridged.length > 0
            ? bridged.map((action) => <p key={action.id} className="nz-hint" style={{ margin: "4px 0" }}>Bridged by <b>{action.title}</b> <span className="muted">{strategyStatusLabels[action.status]}</span></p>)
            : belowTarget && !readOnly
              ? <button type="button" className="nz-btn sm" disabled={pending} onClick={() => void bridge()}>Bridge this gap</button>
              : <p className="nz-hint" style={{ margin: "4px 0" }}>{belowTarget ? "No action yet." : "Not a gap at this score."}</p>}
        </>}

      {error ? <div className="nz-banner warn" role="alert">{error}
        {(stuck || conflict) ? <> <button type="button" className="nz-editlink" onClick={() => onClose(changed.current)}>{conflict ? "Close" : "Discard this change and close"}</button></> : null}</div> : null}
    </div>

    <div className="nz-df">
      <button type="button" className="nz-btn" disabled={pending || index === 0} onClick={() => void go(index - 1)}>Back</button>
      <span className="sp" />
      {assessment.status === "draft"
        ? <GatedButton className="nz-btn pri" blocked={pending || !ready || access.state !== "allowed" || conflict}
          blockedReason={pending ? "Saving…" : access.state !== "allowed" ? access.reason
            : !ready ? `${steps.length - addressed} of ${steps.length} requirements still to address — an assessment is complete when every one has a maturity.` : undefined}
          reasonClassName="hint nz-gated-reason" onClick={() => void complete()}>Complete assessment</GatedButton> : null}
      <button type="button" className="nz-btn" disabled={pending || (last && !divider) || conflict} onClick={() => void next()}>{divider ? "Start section" : pending ? "Saving…" : "Next"}</button>
    </div>
  </div>;
}

/**
 * The owner: a type-ahead over this client's active contacts (the ones the Actions owner picker lists), not free text.
 * The answer still stores the owner as a name — choosing a contact writes their name, so the item command is unchanged.
 * An owner typed before this, who is not one of the contacts, is shown until a contact is chosen.
 */
function SrsOwnerPicker({ contacts, owner, disabled, onChange }: {
  contacts: readonly ClientContactReadModel[]; owner: string; disabled: boolean; onChange: (owner: string) => void;
}) {
  const options = contacts.filter((contact) => contact.status === "active")
    .map((contact) => ({ id: contact.id, label: contact.fullName, ...(contact.jobTitle ? { hint: contact.jobTitle } : {}) }));
  const chosen = options.find((option) => option.label === owner) ?? null;
  return <div className="nz-fl"><label htmlFor="srs-owner"><span>Owner</span></label>
    <SmartSearch id="srs-owner" label="Owner" options={options} value={chosen?.id ?? ""} disabled={disabled}
      emptyHint="This client has no active contacts yet — add one in Profile to give it an owner."
      onChange={(_id, option) => onChange(option?.label ?? "")} />
    {owner && !chosen ? <small className="hint">Previously noted as &ldquo;{owner}&rdquo; — choose the contact who owns it.</small> : null}
  </div>;
}
