"use client";

import { useRef, useState, type ReactNode } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { reportNarrativeBodyIssues, reportTokenCatalogue, serializeReportSectionBody, type ReportComposition, type ReportNarrativeElement } from "@nzi/contracts";
import { narrativeForEditing, resolveComposedToken } from "../../../reports/[versionId]/composedNarrative";

/**
 * B2-4 (C of DESIGN-report-studio-small-fixes; RULING-report-studio-B2-4 (d)(i)): a draft's narrative block, editable where it is
 * drawn — Edit, Regenerate (the AI redraft) and Reset (the template), driving the existing `report.section.*` commands, pinned by
 * the section version the draft was composed at. Figures stay locked tokens: the editor shows them as chips that typing goes
 * around, a figure is inserted from the palette, and a body with a typed figure or an amount of money is refused here with the
 * server's own words before it is sent. On success the draft recomposes. Screen-only chrome: none of it prints.
 *
 * B2-4 (d)(ii): on a **validated** version the same controls drive `report.narrative.update` instead, pinned by the version, so
 * the change is made in place and the version bumps — nothing is re-validated, and publish issues exactly what is now frozen.
 */
export type NarrativeEditTarget =
  /** The job's draft: the working sections, through `report.section.*`, pinned by the section version the draft was composed at. */
  | { kind: "draft"; jobId: string }
  /** A validated version: `report.narrative.update`, pinned by the version this screen opened. */
  | { kind: "validated"; reportVersionId: string; version: number };

export function StudioNarrativeEditor({ target, composition, element, drawn, canEdit, blockedReason }: {
  target: NarrativeEditTarget; composition: ReportComposition; element: ReportNarrativeElement; drawn: ReactNode;
  /** The draft or validated version, the `report-edit` flag and the person's `report.edit` all allow it. */
  canEdit: boolean;
  /** Why editing is unavailable, when it is. */
  blockedReason?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"edit" | "regenerate" | "reset" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const palette = reportTokenCatalogue.filter((token) => resolveComposedToken(token.key, composition).ok && token.kind !== "phrase");

  async function send(kind: "edit" | "regenerate" | "reset", bodyHtml?: string) {
    if (busy) return;
    setBusy(kind); setProblem(null);
    const result = target.kind === "draft"
      ? await postBrowserCommand<{ version: number }>(`/api/isolated/reports/sections/${kind}`, kind === "edit"
          ? { jobId: target.jobId, sectionKey: element.key, bodyHtml, expectedVersion: element.sectionVersion }
          : { jobId: target.jobId, sectionKey: element.key, expectedVersion: element.sectionVersion }, crypto.randomUUID())
      : await postBrowserCommand<{ version: number }>("/api/isolated/reports/narrative", {
          reportVersionId: target.reportVersionId, expectedVersion: target.version, sectionKey: element.key, change: kind,
          ...(kind === "edit" ? { bodyHtml } : {}),
        }, crypto.randomUUID());
    setBusy(null);
    if (result.state === "success") { window.location.reload(); return; }
    setProblem(result.state === "validation_failed" ? result.issues?.map((issue) => issue.message).join(" ") || result.message || "The section was not saved."
      : result.state === "conflict" ? (target.kind === "draft"
        ? "This section changed since the draft was composed — reload to see it, then edit again."
        : "This version changed since you opened it — reload to see it, then edit again.")
      : result.message || "The section was not saved.");
  }

  function save() {
    const html = serializeReportSectionBody(body.current?.innerHTML ?? "");
    const issues = reportNarrativeBodyIssues(html);
    if (issues.length) { setProblem(issues.map((issue) => issue.message).join(" ")); return; }
    void send("edit", html);
  }

  function insert(key: string) {
    if (!key || !body.current) return;
    const token = resolveComposedToken(key, composition);
    if (!token.ok) return;
    // A Range insert, not execCommand("insertHTML"): Chrome's insertHTML collapses a plain space before the caret ("was 13…" saved as "was13…").
    const host = body.current;
    host.focus();
    const selection = window.getSelection();
    const range = selection && selection.rangeCount && host.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.getRangeAt(0)
      : (() => { const end = document.createRange(); end.selectNodeContents(host.lastElementChild ?? host); end.collapse(false); return end; })();
    const chip = document.createElement("span");
    chip.className = "r5-tok";
    chip.setAttribute("data-token", key);
    chip.setAttribute("contenteditable", "false");
    chip.textContent = token.text;
    const after = document.createTextNode(" ");
    range.deleteContents();
    range.insertNode(after);
    range.insertNode(chip);
    range.setStartAfter(after);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  return <div className={`nzs-narr${editing ? " editing" : ""}`} data-studio-narrative={element.key}>
    {editing
      ? <div className={`r5-editblock r5-src-${element.contentSource}`}>
          <span className="r5-spill">Unsaved edit</span>
          <div ref={body} className="r5-prose nzs-narr-body" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
            aria-label={`Narrative: ${element.key}`} dangerouslySetInnerHTML={{ __html: narrativeForEditing(element.bodyHtml, composition) }} />
        </div>
      : drawn}
    <div className="nzs-narr-tools" role="group" aria-label="Narrative">
      {editing ? <>
        <select className="nz-sel" value="" aria-label="Insert a figure" onChange={(event) => insert(event.target.value)}>
          <option value="">Insert a figure…</option>
          {palette.map((token) => <option key={token.key} value={token.key}>{token.label}</option>)}
        </select>
        <button type="button" className="nz-btn pri" disabled={busy !== null} onClick={save}>{busy === "edit" ? "Saving…" : "Save"}</button>
        <button type="button" className="nz-btn" disabled={busy !== null} onClick={() => { setEditing(false); setProblem(null); }}>Cancel</button>
      </> : <>
        <button type="button" className="nz-btn" disabled={!canEdit || busy !== null} title={canEdit ? "Edit this narrative in place" : blockedReason} onClick={() => { setEditing(true); setProblem(null); }}>Edit</button>
        <button type="button" className="nz-btn" disabled={!canEdit || busy !== null} title={canEdit ? "Redraft with the AI wording (figures stay locked)" : blockedReason} onClick={() => void send("regenerate")}>{busy === "regenerate" ? "Generating…" : "Generate"}</button>
        <button type="button" className="nz-btn" disabled={!canEdit || busy !== null || (element.contentSource === "default" && element.sectionVersion === 0)}
          title={canEdit ? "Back to the template wording" : blockedReason} onClick={() => void send("reset")}>{busy === "reset" ? "Resetting…" : "Reset"}</button>
      </>}
    </div>
    {problem ? <p className="nzs-narr-note" role="alert">{problem}</p> : null}
  </div>;
}
