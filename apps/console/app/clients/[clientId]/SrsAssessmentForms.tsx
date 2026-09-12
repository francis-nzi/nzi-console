"use client";

import { useRef, useState } from "react";
import { GatedButton } from "@nzi/ui";
import { postBrowserCommand, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { orderedRequirements, type SrsAssessment, type SrsAssessmentItem, type SrsFramework, type SrsMaturity, type SrsRequirement } from "@nzi/contracts";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * The SRS assessment editors. Guided and save-as-you-go: one requirement at a time, with
 * its plain-language help alongside, saving straight to the next one so a consultant can
 * work a pillar through without leaving the drawer.
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

export function SrsStartForm({ clientId, framework, access, onClose, onSaved }: {
  clientId: string; framework: SrsFramework; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [assessedOn, setAssessedOn] = useState(today);
  const [prefill, setPrefill] = useState(true);
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const requirementCount = framework.requirements.filter((requirement) => requirement.active).length;
  const fromNzi = framework.requirements.filter((requirement) => requirement.active && requirement.source === "nzi-data").length;

  async function save() {
    setPending(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    const result = await postBrowserCommand<{ assessmentId: string; prefilled: number }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/srs-assessments`,
      { assessedOn, notes, prefillFromNziData: prefill }, key.current);
    setPending(false);
    if (result.state !== "success") { key.current = null; setError(errorText(result)); return; }
    key.current = null;
    onSaved(result.data.prefilled > 0
      ? `Assessment started — ${result.data.prefilled} requirements answered from this client's own record.`
      : "Assessment started.");
  }

  return <>
    <div className="nz-dh"><div className="k">Disclosure</div><h3>Start a readiness assessment</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <p className="nz-hint" style={{ marginTop: 0 }}>An assessment scores <b>{requirementCount} requirements</b> against <b>{framework.label} version {framework.version}</b>. The version is stamped on it, so a later framework change never restates what was assessed today.</p>
      <label className="nz-fl"><span>Assessment date</span>
        <input className="nz-inp" type="date" value={assessedOn} onChange={(event) => setAssessedOn(event.target.value)} />
      </label>
      <label className="nz-check"><input type="checkbox" checked={prefill} onChange={(event) => setPrefill(event.target.checked)} />
        Answer what this client&apos;s record already answers</label>
      <span className="nz-hint">{fromNzi} requirements read the assured footprint, its targets and its intensity metrics. Each is marked as resolved from NZI data, carries the record it came from as evidence, and can be overridden.</span>
      <label className="nz-fl" style={{ marginTop: 10 }}><span>Notes</span>
        <input className="nz-inp" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Context for this assessment — optional" />
      </label>
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      <div className="nz-gov"><span className="lk" aria-hidden="true">🔒</span><span>Assessing is gated on <b>srs.manage</b> and every answer is audited. The framework itself is Admin-managed and versioned.</span></div>
    </div>
    <div className="nz-df">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button><span className="sp" />
      <GatedButton className="nz-btn pri" blocked={pending || access.state !== "allowed"}
        blockedReason={pending ? "Starting…" : access.state === "allowed" ? undefined : access.reason}
        reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Starting…" : "Start assessment"}</GatedButton>
    </div>
  </>;
}

export function SrsItemForm({ framework, assessment, requirement, item, access, onClose, onSaved, onNext }: {
  framework: SrsFramework;
  assessment: SrsAssessment;
  requirement: SrsRequirement;
  item: SrsAssessmentItem | null;
  access: EditAccess;
  onClose: () => void;
  onSaved: (text: string) => void;
  onNext: (requirement: SrsRequirement) => void;
}) {
  const [maturity, setMaturity] = useState<SrsMaturity | null>(item?.maturity ?? null);
  const [evidenceKind, setEvidenceKind] = useState<"document" | "data" | "note" | "">(item?.evidence?.kind ?? "");
  const [evidenceRef, setEvidenceRef] = useState(item?.evidence?.ref ?? "");
  const [evidenceNote, setEvidenceNote] = useState(item?.evidence?.note ?? "");
  const [owner, setOwner] = useState(item?.owner ?? "");
  const [dueDate, setDueDate] = useState(item?.dueDate ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  const ordered = orderedRequirements(framework);
  const index = ordered.findIndex((entry) => entry.id === requirement.id);
  const next = index >= 0 ? ordered[index + 1] ?? null : null;
  const pillar = framework.pillars.find((entry) => entry.key === requirement.pillarKey);
  const belowTarget = maturity !== null && maturity < requirement.targetMaturity;
  const targetLabel = framework.maturityLevels.find((level) => level.level === requirement.targetMaturity)?.label ?? "";

  const problem = evidenceKind !== "" && !evidenceRef.trim() && !evidenceNote.trim()
    ? "Evidence needs a reference or a note."
    : null;

  async function save(andNext: boolean) {
    setPending(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    const result = await putBrowserCommand<{ version: number }>(
      `/api/isolated/srs-assessments/${encodeURIComponent(assessment.assessmentId)}`,
      {
        requirementId: requirement.id, maturity,
        evidenceKind: evidenceKind === "" ? null : evidenceKind,
        evidenceRef: evidenceRef.trim() || null, evidenceNote: evidenceNote.trim(),
        owner: owner.trim(), dueDate: dueDate || null,
        linkedActionId: item?.linkedActionId ?? null,
        expectedVersion: item?.version ?? 0,
      }, key.current);
    setPending(false);
    if (result.state !== "success") {
      key.current = null;
      setError(result.state === "conflict" ? "This requirement changed since the drawer opened. Close and reopen it to see the latest." : errorText(result));
      return;
    }
    key.current = null;
    if (andNext && next) { onSaved(`${requirement.code} saved.`); onNext(next); return; }
    onSaved(`${requirement.code} saved.`);
  }

  return <>
    <div className="nz-dh"><div className="k">{requirement.standardKey} · {pillar?.label}</div><h3>{requirement.title}</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <p className="nz-hint" style={{ marginTop: 0 }}>{requirement.helpText}</p>
      {requirement.source === "nzi-data" ? <div className="nz-banner ok" role="status" style={{ marginBottom: 10 }}>
        <div><b>This one reads the client&apos;s own record.</b><div style={{ marginTop: 4 }}>{item?.source === "auto"
          ? "Answered from the assured footprint, targets or intensity already held for this client. Override it if the disclosure needs something different."
          : "It can be answered from the assured footprint, targets or intensity already held for this client."}</div></div>
      </div> : null}

      <div className="nz-sect">Maturity</div>
      <div className="nz-srs-ladder" role="radiogroup" aria-label="Maturity">
        {framework.maturityLevels.map((level) => <label key={level.level} className={`nz-srs-rung${maturity === level.level ? " on" : ""}`}>
          <input type="radio" name="srs-maturity" checked={maturity === level.level} onChange={() => setMaturity(level.level)} />
          <b>{level.label}</b><span>{level.definition}</span>
        </label>)}
      </div>
      <button type="button" className="nz-editlink" onClick={() => setMaturity(null)} disabled={maturity === null}>Clear answer</button>
      <p className="nz-maps">SRS expects <b>{targetLabel}</b> here. {belowTarget ? "Below that is a gap, and appears on the roadmap." : "At or above that, this requirement is not a gap."}</p>

      <div className="nz-sect">Evidence</div>
      <label className="nz-fl"><span>Kind</span>
        <select className="nz-sel" value={evidenceKind} onChange={(event) => setEvidenceKind(event.target.value as typeof evidenceKind)}>
          <option value="">None recorded</option>
          <option value="document">Document</option>
          <option value="data">Data reference</option>
          <option value="note">Note</option>
        </select>
      </label>
      {evidenceKind !== "" ? <>
        <label className="nz-fl"><span>Reference</span><input className="nz-inp" value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="e.g. Board minutes, 12/03/2026" /></label>
        <label className="nz-fl"><span>Note</span><input className="nz-inp" value={evidenceNote} onChange={(event) => setEvidenceNote(event.target.value)} placeholder="What the evidence shows" /></label>
      </> : <span className="nz-hint">Readiness that cannot be evidenced is shown as unevidenced rather than counted as assured.</span>}

      <div className="nz-sect">Owner and date</div>
      <div className="nz-two">
        <label className="nz-fl"><span>Owner</span><input className="nz-inp" value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Who closes this" /></label>
        <label className="nz-fl"><span>Target date</span><input className="nz-inp" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
      </div>

      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      <div className="nz-gov"><span className="lk" aria-hidden="true">🔒</span><span>Answers are versioned and audited. A gap here becomes an action in the action-lever library, so the roadmap and the decarbonisation plan stay one plan.</span></div>
    </div>
    <div className="nz-df">
      <button type="button" className="nz-btn" onClick={onClose}>Close</button><span className="sp" />
      {next ? <GatedButton className="nz-btn" blocked={pending || problem !== null || access.state !== "allowed"}
        blockedReason={pending ? "Saving…" : problem ?? (access.state === "allowed" ? undefined : access.reason)}
        reasonClassName="hint nz-gated-reason" onClick={() => void save(true)}>Save and next</GatedButton> : null}
      <GatedButton className="nz-btn pri" blocked={pending || problem !== null || access.state !== "allowed"}
        blockedReason={pending ? "Saving…" : problem ?? (access.state === "allowed" ? undefined : access.reason)}
        reasonClassName="hint nz-gated-reason" onClick={() => void save(false)}>{pending ? "Saving…" : "Save"}</GatedButton>
    </div>
  </>;
}
