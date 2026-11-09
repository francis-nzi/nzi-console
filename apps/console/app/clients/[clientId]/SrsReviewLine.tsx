"use client";

import { useRef, useState } from "react";
import { putBrowserCommand } from "@nzi/api-client";
import { GatedButton } from "@nzi/ui";
import { SRS_REVIEW_CADENCES, srsReviewCadenceLabels, srsReviewReminderLabel, type SrsReviewCadence, type SrsReviewStatus } from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * The review loop (Phase A): when the latest completed assessment is next reviewed, what its reminder to the client manager
 * will do, and the CRM's change — a cadence, a date, or off — through the gated, audited `srs.assessment.review.set`. A new
 * date re-arms the reminder. Reviewing itself is the existing Reopen to correct / Reassess.
 */
export function SrsReviewLine({ review, access, onSaved }: { review: SrsReviewStatus; access: EditAccess; onSaved: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [cadence, setCadence] = useState<SrsReviewCadence>(review.cadence);
  const [customDate, setCustomDate] = useState(review.cadence === "custom" ? review.nextReviewDate ?? "" : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  async function save() {
    setPending(true); setError(null);
    key.current ??= crypto.randomUUID();
    const result = await putBrowserCommand<{ nextReviewDate: string | null }>(`/api/isolated/srs-assessments/${encodeURIComponent(review.assessmentId)}/review`,
      { cadence, customDate: cadence === "custom" ? customDate : null, expectedVersion: review.version }, key.current);
    setPending(false);
    key.current = null;
    if (result.state !== "success") { setError(result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message); return; }
    setEditing(false);
    onSaved(result.data.nextReviewDate ? `Next review set for ${formatDate(result.data.nextReviewDate)}.` : "Review reminder turned off for this assessment.");
  }

  return <div className="nz-srs-filters" role="group" aria-label="Review date">
    <span><b>Next review</b> {review.nextReviewDate ? formatDate(review.nextReviewDate) : "none"} · {srsReviewCadenceLabels[review.cadence]}</span>
    <span className="muted">{srsReviewReminderLabel(review.reminder)}</span>
    <span className="sp" />
    {editing ? <>
      <label>Review <select className="nz-sel" value={cadence} onChange={(event) => setCadence(event.target.value as SrsReviewCadence)}>
        {SRS_REVIEW_CADENCES.map((option) => <option key={option} value={option}>{srsReviewCadenceLabels[option]}</option>)}
      </select></label>
      {cadence === "custom" ? <label>Date <input className="nz-sel" type="date" value={customDate} onChange={(event) => setCustomDate(event.target.value)} /></label> : null}
      <GatedButton className="nz-btn pri" blocked={pending || access.state !== "allowed" || (cadence === "custom" && customDate === "")}
        blockedReason={pending ? "Saving…" : access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
        onClick={() => void save()}>{pending ? "Saving…" : "Save"}</GatedButton>
      <button type="button" className="nz-btn" onClick={() => { setEditing(false); setError(null); setCadence(review.cadence); }}>Cancel</button>
    </> : <GatedButton className="nz-btn" blocked={access.state !== "allowed"} blockedReason={access.state === "allowed" ? undefined : access.reason}
      reasonClassName="hint nz-gated-reason" onClick={() => setEditing(true)}>Change review date</GatedButton>}
    {error ? <span className="nz-banner warn" role="alert">{error}</span> : null}
  </div>;
}
