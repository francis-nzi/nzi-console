"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import {
  MESSAGE_TEMPLATE_BODY_MAX, MESSAGE_TEMPLATE_SUBJECT_MAX, messageTemplateDefinition, messageTemplateRequiredIssues, messageTemplateTokenIssues, previewMessage,
} from "@nzi/contracts";
import type { MessageTemplateRow } from "@nzi/isolated-backend";
import { AuditLine, CapabilityChip, DrawerEditor, ProvenanceBadge, TextAreaField, TextField } from "@nzi/ui";

/**
 * The Message templates screen (admin Phase F1): one card per message the console sends, and a drawer to word it — the
 * subject and body over the message's declared tokens, a live preview against the registry's **sample** values (never a
 * real client's data, F-Q2), and the way back to the built-in wording. Who it is from and the footer are the organisation
 * profile's (F-Q7), shown for reference only.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
export type SenderReference = { name: string | null; email: string | null; footer: string | null };
type Failure = Exclude<BrowserCommandResult<unknown>, { state: "success" }>;

export function MessageTemplatesBoard({ templates, sender, editing }: { templates: MessageTemplateRow[]; sender: SenderReference; editing: Editing }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openRow = templates.find((row) => row.key === open) ?? null;

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Communications</div>
        <h1>Message templates</h1>
        <p>The wording of each message the console sends. The set of messages is fixed — a message exists because something in the console sends it — and each can be worded in your own terms, or left in its built-in wording.</p>
      </div>
      <div className="nz-a-head-actions"><CapabilityChip capability="admin.templates" /></div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>A message can use only its own <b>tokens</b> — the values the console fills in when it sends, such as <span className="nz-a-mono">{"{{firstName}}"}</span>. The preview fills them with sample values, never a real client’s. Messages are plain text.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <ul className="nz-a-sub-records" aria-label="Messages">
      {templates.map((row) => <li key={row.key}>
        <div className="nz-a-sub-record-head">
          <div>
            <button type="button" className="nz-a-linkish" onClick={() => setOpen(row.key)}>{row.label}</button>
            <div className="nz-a-sub">{row.purpose}</div>
            <div className="nz-a-sub nz-a-mono">{row.key}</div>
          </div>
          <div className="nz-a-sub-record-actions">
            {row.saved ? <ProvenanceBadge provenance={row.saved.provenance} /> : null}
            {row.inUse === "own"
              ? <span className="nz-a-badge ok"><i aria-hidden="true" />Your wording · v{row.saved!.version}</span>
              : <span className="nz-a-badge"><i aria-hidden="true" />Built-in wording{row.saved ? " (yours kept, not in use)" : ""}</span>}
          </div>
        </div>
      </li>)}
    </ul>

    {openRow ? <TemplateDrawer key={`${openRow.key}:${openRow.saved?.version ?? 0}`} row={openRow} sender={sender} editing={editing}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setNotice(message); router.refresh(); }} /> : null}
  </>;
}

function TemplateDrawer({ row, sender, editing, onClose, onSaved }: {
  row: MessageTemplateRow; sender: SenderReference; editing: Editing; onClose: () => void; onSaved: (message: string) => void;
}) {
  const definition = messageTemplateDefinition(row.key)!;
  const readOnly = !editing.allowed;
  // An organisation with no wording of its own starts from the built-in.
  const [draft, setDraft] = useState({ subject: row.saved?.subject ?? row.builtIn.subject, body: row.saved?.body ?? row.builtIn.body });
  const [reason, setReason] = useState("");
  const [reverting, setReverting] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const path = `/api/isolated/message-templates/${encodeURIComponent(row.key)}`;

  const live = {
    subject: [...messageTemplateTokenIssues(draft.subject, definition)],
    body: [...messageTemplateTokenIssues(draft.body, definition), ...messageTemplateRequiredIssues(draft.body, definition)],
  };
  const preview = previewMessage(draft, definition);
  const changed = row.saved ? draft.subject !== row.saved.subject || draft.body !== row.saved.body : draft.subject !== row.builtIn.subject || draft.body !== row.builtIn.body;
  const fail = (result: Failure) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["subject", "body", "reason"].includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This message changed since you opened it. Close the panel and open it again to see the latest." : result.message);
    keys.current = {};
  };
  const run = async (step: () => Promise<BrowserCommandResult<unknown>>, message: string) => {
    if (saving) return;
    setSaving(true); setIssues({}); setProblem(null);
    try {
      const result = await step();
      if (result.state !== "success") return fail(result);
      onSaved(message);
    } finally { setSaving(false); }
  };

  async function save() {
    const local: Record<string, string> = {};
    if (!draft.subject.trim()) local.subject = "A subject is required.";
    else if (live.subject.length) local.subject = live.subject.join(" ");
    if (!draft.body.trim()) local.body = "A body is required.";
    else if (live.body.length) local.body = live.body.join(" ");
    if (Object.keys(local).length) { setIssues(local); return; }
    const content = { subject: draft.subject, body: draft.body };
    if (!row.saved) await run(() => postBrowserCommand("/api/isolated/message-templates", { templateKey: row.key, ...content }, key("create")), `“${row.label}” now uses your wording.`);
    else if (changed) await run(() => patchBrowserCommand(path, { ...content, expectedVersion: row.saved!.version }, key("update")), `“${row.label}” saved.`);
    else if (!row.saved.active) await run(() => postBrowserCommand(`${path}/reinstate`, { expectedVersion: row.saved!.version }, key("reinstate")), `“${row.label}” uses your wording again.`);
  }

  const inUse = row.inUse === "own" ? `Your wording, version ${row.saved!.version}` : row.saved ? "The built-in wording — yours is kept, not in use" : "The built-in wording";
  const primary = !row.saved ? "Use this wording" : changed ? "Save" : !row.saved.active ? "Use your wording again" : null;

  return <DrawerEditor open onClose={onClose} eyebrow="Message template" title={row.label}
    audit={<AuditLine version={row.saved ? row.saved.version : "new"}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      <button type="button" className="nz-a-btn" onClick={onClose}>Close</button>
      {primary ? <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : primary}</button> : null}
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <p className="nz-a-hint">{row.purpose} <b>In use:</b> {inUse}.</p>

    <TextField label="Subject" value={draft.subject} required maxLength={MESSAGE_TEMPLATE_SUBJECT_MAX} readOnly={readOnly}
      error={issues.subject ?? (live.subject.length ? live.subject.join(" ") : undefined)} onChange={(subject) => setDraft({ ...draft, subject })} />
    <TextAreaField label="Body" value={draft.body} rows={12} required disabled={readOnly} hint={`Plain text — up to ${MESSAGE_TEMPLATE_BODY_MAX.toLocaleString("en-GB")} characters.`}
      error={issues.body ?? (live.body.length ? live.body.join(" ") : undefined)} onChange={(body) => setDraft({ ...draft, body })} />
    {!readOnly && (row.saved ? draft.subject !== row.builtIn.subject || draft.body !== row.builtIn.body : changed)
      ? <button type="button" className="nz-a-linkish" onClick={() => setDraft({ subject: row.builtIn.subject, body: row.builtIn.body })}>Start again from the built-in wording</button> : null}

    <h3>Tokens</h3>
    <ul className="nz-a-token-list">
      {definition.tokens.map((token) => <li key={token.name}>
        <span className="nz-a-mono">{`{{${token.name}}}`}</span>{token.required ? <b> required</b> : null}
        <span className="nz-a-sub">{token.description}</span>
      </li>)}
    </ul>

    <h3>Preview <span className="nz-a-sub">with sample values</span></h3>
    <div className="nz-a-message-preview" aria-label="Preview">
      <div className="nz-a-message-preview-subject">{preview.subject}</div>
      <div className="nz-a-message-preview-body">{preview.body}</div>
    </div>
    <p className="nz-a-hint">Not part of the template: the sender and footer are the organisation’s, from Organisation settings —
      {" "}<b>{sender.name ?? "no display name set"}</b>{sender.email ? <> · {sender.email}</> : null}{sender.footer ? <> · “{sender.footer}”</> : null}.</p>
    <p className="nz-a-hint">Sent by: {row.sendSite}.</p>

    {row.inUse === "own" && !readOnly ? <>
      {reverting ? <>
        <TextAreaField label="Reason for going back to the built-in wording" hint="Required — it is recorded in the audit log. Your wording is kept, to use again." value={reason} rows={2} required
          error={issues.reason} onChange={setReason} />
        <div className="nz-a-sub-record-actions">
          <button type="button" className="nz-a-btn" onClick={() => { setReverting(false); setIssues({}); }}>Cancel</button>
          <button type="button" className="nz-a-btn pri" disabled={saving} onClick={() => {
            if (!reason.trim()) { setIssues({ reason: "Say why this message is going back to its built-in wording." }); return; }
            void run(() => postBrowserCommandWithReason(`${path}/deactivate`, { expectedVersion: row.saved!.version }, key("deactivate"), reason), `“${row.label}” is back to its built-in wording.`);
          }}>Use the built-in wording</button>
        </div>
      </> : <button type="button" className="nz-a-btn" onClick={() => setReverting(true)}>Go back to the built-in wording…</button>}
    </> : null}
  </DrawerEditor>;
}
