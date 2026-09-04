"use client";

// R4 — in-place report section editing + Regenerate (NZC-048). Behind
// `report-edit`. Rich-text scoped to each section body; figure tokens are locked
// chips resolved from the job's live figures (final values freeze at snapshot).
// Every save/regenerate/reset is a versioned command with provenance; an unsaved
// edit is a distinct state from saved.

import { useCallback, useEffect, useRef, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import {
  renderReportSectionBody,
  serializeReportSectionBody,
  verifyReportSectionTokens,
  type ReportSectionEditorScreen,
  type ReportSectionReadModel,
} from "@nzi/contracts";

const SOURCE_PILL = { default: "Default template", ai: "AI-drafted", "client-edited": "Edited by client" } as const;
const commandError = (result: { state: string; message?: string; issues?: Array<{ message: string }> }) =>
  result.state === "validation_failed" ? result.issues?.[0]?.message ?? "Validation failed." : result.message ?? "Command failed.";

export function CrpReportSectionEditor({ jobId }: { jobId: string }) {
  const [screen, setScreen] = useState<ReportSectionEditorScreen | null>(null);
  const [state, setState] = useState<"loading" | "failed" | "ready">("loading");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(`/api/isolated/jobs/${jobId}/report-sections`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Report sections are unavailable.");
      setScreen(body as ReportSectionEditorScreen);
      setState("ready");
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "Report sections are unavailable." });
      setState("failed");
    }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  async function run(kind: "edit" | "regenerate" | "reset", section: ReportSectionReadModel, bodyHtml?: string) {
    if (pendingKey) return;
    setPendingKey(section.key);
    setNotice(null);
    const path = kind === "edit" ? "/api/isolated/reports/sections/edit" : kind === "regenerate" ? "/api/isolated/reports/sections/regenerate" : "/api/isolated/reports/sections/reset";
    const payload = kind === "edit"
      ? { jobId, sectionKey: section.key, bodyHtml: bodyHtml ?? section.bodyHtml, expectedVersion: section.version }
      : { jobId, sectionKey: section.key, expectedVersion: section.version };
    const result = await postBrowserCommand<{ version: number }>(path, payload, crypto.randomUUID());
    setPendingKey(null);
    if (result.state !== "success") { setNotice({ ok: false, text: commandError(result) }); return; }
    setEditingKey(null);
    setNotice({ ok: true, text: kind === "edit" ? `“${section.title}” saved — figures stay locked to Outputs.` : kind === "regenerate" ? `“${section.title}” redrafted. You can still edit it.` : `“${section.title}” reset to the NZI template.` });
    await load();
  }

  if (state === "loading") return <section className="nz-panel nz-config-panel" aria-busy><div className="nz-register-loading" role="status"><i /><span><b>Loading report narrative</b><small>Sections and current figures…</small></span></div></section>;
  if (state === "failed" || !screen) return <section className="nz-panel nz-config-panel"><div className="nz-banner warn" role="alert">{notice?.text ?? "Report sections are unavailable."}</div><button className="nz-btn" onClick={() => void load()}>Retry</button></section>;

  const verification = verifyReportSectionTokens(screen.sections, screen.figures);

  return <section className="nz-panel nz-config-panel nz-report-editor" aria-busy={pendingKey !== null}>
    <div className="nz-config-head">
      <div>
        <span className="nz-eyebrow">Report narrative</span>
        <b>Editable sections</b>
        <div className="sub">Every figure is bound to Outputs and locked in the text. Edits are versioned; the wording freezes into the reviewed snapshot.</div>
      </div>
      <span className={`nz-st ${verification.ok ? "done" : "need"}`}>{verification.ok ? "Figures bound" : `${verification.tokens.filter(t => !t.ok).length} figure${verification.tokens.filter(t => !t.ok).length === 1 ? "" : "s"} unresolved`}</span>
    </div>
    {!verification.ok && <div className="nz-banner warn" role="status">Some figures cannot resolve from the current job data yet (no target or intensity denominator). They will resolve once the job data is complete; the section text is still editable.</div>}
    {notice && <div className={`nz-banner ${notice.ok ? "ok" : "warn"}`} role={notice.ok ? "status" : "alert"}>{notice.text}</div>}
    <ol className="nz-report-editor-list">
      {screen.sections.map(section => (
        <SectionRow
          key={section.key}
          section={section}
          figures={screen.figures}
          editing={editingKey === section.key}
          busy={pendingKey === section.key}
          disabled={pendingKey !== null && pendingKey !== section.key}
          onEdit={() => { setNotice(null); setEditingKey(section.key); }}
          onCancel={() => setEditingKey(null)}
          onSave={(html) => run("edit", section, html)}
          onRegenerate={() => run("regenerate", section)}
          onReset={() => run("reset", section)}
        />
      ))}
    </ol>
  </section>;
}

type Figures = ReportSectionEditorScreen["figures"];

function SectionRow({ section, figures, editing, busy, disabled, onEdit, onCancel, onSave, onRegenerate, onReset }: {
  section: ReportSectionReadModel;
  figures: Figures;
  editing: boolean;
  busy: boolean;
  disabled: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (html: string) => void;
  onRegenerate: () => void;
  onReset: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (editing && bodyRef.current) {
      bodyRef.current.innerHTML = renderReportSectionBody(section.bodyHtml, figures, { locked: true });
      setDirty(false);
      bodyRef.current.focus();
    }
  }, [editing, section.bodyHtml, figures]);

  const isTemplate = section.version === 0;

  return <li className="nz-report-section-row" id={`edit-section-${section.key}`}>
    <div className="nz-report-section-h">
      <h3>{section.title}</h3>
      <span className={`nz-section-source ${section.contentSource}`}>{editing && dirty ? "Unsaved edit" : SOURCE_PILL[section.contentSource]}</span>
    </div>

    {editing
      ? <>
          <div
            ref={bodyRef}
            className="nz-report-section-body nz-editable"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label={`${section.title} body`}
            onInput={() => setDirty(true)}
          />
          <div className="nz-report-section-actions">
            <button className="nz-btn pri" disabled={busy} onClick={() => onSave(serializeReportSectionBody(bodyRef.current?.innerHTML ?? section.bodyHtml))}>{busy ? "Saving…" : "Save"}</button>
            <button className="nz-btn" disabled={busy} onClick={onCancel}>Cancel</button>
            <span className="nz-report-section-hint">Type around the locked figure chips — they cannot be edited or deleted mid-word.</span>
          </div>
        </>
      : <>
          <div className="nz-report-section-body" dangerouslySetInnerHTML={{ __html: renderReportSectionBody(section.bodyHtml, figures) }} />
          <div className="nz-report-section-actions">
            <button className="nz-btn" disabled={disabled || busy} onClick={onEdit}>Edit text</button>
            <button className="nz-btn" disabled={disabled || busy} onClick={onRegenerate}>{busy ? "Working…" : "Regenerate"}</button>
            <button className="nz-btn" disabled={disabled || busy || isTemplate} onClick={onReset}>Reset to template</button>
            {section.updatedBy && <span className="nz-report-section-hint">v{section.version} · {section.updatedBy}</span>}
          </div>
        </>}
  </li>;
}
