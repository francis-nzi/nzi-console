"use client";

import React, { useRef, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { crpReportSectionTemplate, reportNarrativeBodyIssues, reportTokenCatalogue, serializeReportSectionBody, type ReportComposition, type ReportNarrativeElement } from "@nzi/contracts";
import { ReportComposedView } from "../../../../reports/[versionId]/ReportComposedView";
import { narrativeForEditing, resolveComposedToken } from "../../../../reports/[versionId]/composedNarrative";
import { editsToSend, savedMessage } from "./reviewEditing";

export type ReviewRound = {
  reportVersionId: string; status: "in_client_review" | "client_approved"; version: number; scopeLabel: string; editableSections: string[]; composition: ReportComposition;
};

const titleOf = (key: string) => crpReportSectionTemplate(key)?.title ?? key;
/** Issuer and client logos load through the published-report routes, which do not serve a round still in review. */
const NO_LOGO = () => "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/**
 * The report open for the client's review: the live document with its narrative sections editable and everything else - figures,
 * charts, tables - read-only. Edits are held here until "Update", which sends the whole batch in one command. The client changes
 * words, never numbers: a figure is a locked chip they can insert from the palette, never type.
 */
export function PortalReviewReport({ jobId, initial }: { jobId: string; initial: ReviewRound }) {
  const [round, setRound] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "problem"; text: string } | null>(null);
  const open = round.status === "in_client_review";
  const pending = editsToSend(drafts, round.composition.narrative ?? []);

  async function reread(): Promise<ReviewRound | null> {
    const response = await fetch(`/api/portal/jobs/${encodeURIComponent(jobId)}/review-report?reportVersionId=${encodeURIComponent(round.reportVersionId)}`, { cache: "no-store", credentials: "same-origin" });
    return response.ok ? (await response.json() as { round: ReviewRound }).round : null;
  }

  async function update() {
    if (busy || pending.length === 0) return;
    setBusy(true); setMessage(null);
    const result = await postBrowserCommand<{ changedSections: string[] }>(`/api/portal/jobs/${encodeURIComponent(jobId)}/review-report/update`,
      { reportVersionId: round.reportVersionId, expectedVersion: round.version, edits: pending }, crypto.randomUUID());
    if (result.state === "success") {
      const fresh = await reread();
      if (fresh) setRound(fresh);
      setDrafts({});
      setMessage({ tone: "ok", text: savedMessage(result.data?.changedSections ?? [], titleOf) });
    } else {
      setMessage({ tone: "problem", text: result.state === "validation_failed" ? result.issues?.map((issue) => issue.message).join(" ") || result.message || "Your changes were not saved."
        : result.state === "conflict" ? "This report changed since you opened it. Reload to see the latest, then make your changes again."
        : result.message || "Your changes were not saved." });
    }
    setBusy(false);
  }

  const editor = open && round.editableSections.length > 0
    ? (_key: string, element: ReportNarrativeElement, drawn: React.ReactNode) => round.editableSections.includes(element.key)
      ? <PortalNarrativeSection element={element} composition={round.composition} drawn={drawn} draft={drafts[element.key]}
          onDraft={(html) => setDrafts((current) => { const next = { ...current }; if (html === null) delete next[element.key]; else next[element.key] = html; return next; })} />
      : drawn
    : undefined;

  return <div className="nz-portal-review" data-portal-review={round.status}>
    <div className="nz-hint" role="note" data-portal-review-banner style={{ margin: "8px 0" }}>
      {open ? <>This report is open for your review ({round.scopeLabel}). You can edit the wording in each section; figures, charts and tables are locked to the verified data. Press <b>Update</b> to send your changes to the team.</>
        : <>You have approved this report ({round.scopeLabel}). It is locked; message the team if you need to change it.</>}
    </div>
    {open ? <div className="nzs-toolbar" role="toolbar" aria-label="Review" style={{ position: "sticky", top: 0, zIndex: 2 }}>
      <span className="nzs-hint">{pending.length === 0 ? "No unsaved changes" : `${pending.length} section${pending.length === 1 ? "" : "s"} changed, not yet sent`}</span>
      <span className="nzs-spacer" />
      <button type="button" className="nz-btn pri" data-portal-review-update disabled={busy || pending.length === 0} onClick={() => void update()}>{busy ? "Updating…" : "Update"}</button>
    </div> : null}
    {message ? <p className={message.tone === "ok" ? "nz-hint" : "nzs-narr-note"} role={message.tone === "ok" ? "status" : "alert"} data-portal-review-message>{message.text}</p> : null}
    <ReportComposedView composition={round.composition} issuerLogoSrc={NO_LOGO} clientLogoSrc={NO_LOGO} preview mode="flow" {...(editor ? { narrativeEditor: editor } : {})} />
  </div>;
}

function PortalNarrativeSection({ element, composition, drawn, draft, onDraft }: {
  element: ReportNarrativeElement; composition: ReportComposition; drawn: React.ReactNode; draft: string | undefined; onDraft: (html: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const palette = reportTokenCatalogue.filter((token) => resolveComposedToken(token.key, composition).ok && token.kind !== "phrase");

  function keep() {
    const html = serializeReportSectionBody(body.current?.innerHTML ?? "");
    const issues = reportNarrativeBodyIssues(html);
    if (issues.length) { setProblem(issues.map((issue) => issue.message).join(" ")); return; }
    setProblem(null); setEditing(false);
    onDraft(html.trim() === element.bodyHtml.trim() ? null : html);
  }

  function insert(key: string) {
    if (!key || !body.current) return;
    const token = resolveComposedToken(key, composition);
    if (!token.ok) return;
    const host = body.current;
    host.focus();
    const selection = window.getSelection();
    const range = selection && selection.rangeCount && host.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.getRangeAt(0)
      : (() => { const end = document.createRange(); end.selectNodeContents(host.lastElementChild ?? host); end.collapse(false); return end; })();
    const chip = document.createElement("span");
    chip.className = "r5-tok"; chip.setAttribute("data-token", key); chip.setAttribute("contenteditable", "false"); chip.textContent = token.text;
    const after = document.createTextNode(" ");
    range.deleteContents(); range.insertNode(after); range.insertNode(chip);
    range.setStartAfter(after); range.collapse(true);
    selection?.removeAllRanges(); selection?.addRange(range);
  }

  const shown = draft ?? element.bodyHtml;
  return <div className={`nzs-narr${editing ? " editing" : ""}`} data-portal-section={element.key}>
    {editing
      ? <div className="r5-editblock">
          <span className="r5-spill">Editing</span>
          <div ref={body} className="r5-prose nzs-narr-body" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
            aria-label={`Wording: ${element.key}`} dangerouslySetInnerHTML={{ __html: narrativeForEditing(shown, composition) }} />
        </div>
      : draft !== undefined
        ? <div className="r5-editblock r5-src-client-edited" data-portal-section-changed><span className="r5-spill">Changed, not yet sent</span>
            <div className="r5-prose" dangerouslySetInnerHTML={{ __html: narrativeForEditing(draft, composition) }} /></div>
        : drawn}
    <div className="nzs-narr-tools" role="group" aria-label="Section wording">
      {editing ? <>
        <select className="nz-sel" value="" aria-label="Insert a figure" onChange={(event) => insert(event.target.value)}>
          <option value="">Insert a figure…</option>
          {palette.map((token) => <option key={token.key} value={token.key}>{token.label}</option>)}
        </select>
        <button type="button" className="nz-btn pri" onClick={keep}>Done</button>
        <button type="button" className="nz-btn" onClick={() => { setEditing(false); setProblem(null); }}>Cancel</button>
      </> : <>
        <button type="button" className="nz-btn" onClick={() => { setEditing(true); setProblem(null); }}>Edit wording</button>
        {draft !== undefined ? <button type="button" className="nz-btn" onClick={() => onDraft(null)}>Discard my change</button> : null}
      </>}
    </div>
    {problem ? <p className="nzs-narr-note" role="alert">{problem}</p> : null}
  </div>;
}
