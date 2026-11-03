"use client";

import React, { useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { PORTAL_MESSAGE_MAX_ATTACHMENTS, type PortalAttachmentState, type PortalMessageAttachment } from "@nzi/contracts";
import { portalFeatureEnabled } from "./portalFlags";

/**
 * Message attachments in the UI (RULING-portal-messages, M3): the picker under a composer and the files on a message, on both sides.
 * Dark unless `portal-conversations`, `portal-files` and `portal-message-attachments` are all on - the file gate is the dependency.
 *
 * What is drawn is the server's decision, in words: a file is **available** (the only state with a Download), **being checked**, **blocked** (it did
 * not pass - never the scanner's detail) or **withdrawn**. A download asks for one signed, time-limited link per click, opened and forgotten: no
 * storage identifier or URL is ever drawn, stored or logged here.
 */
export const attachmentsOn = (): boolean =>
  portalFeatureEnabled("portal-conversations") && portalFeatureEnabled("portal-files") && portalFeatureEnabled("portal-message-attachments");

export const ATTACHMENT_STATE_LABEL: Record<PortalAttachmentState, string> = {
  available: "", scanning: "Being checked — it can’t be downloaded until it has passed", blocked: "Blocked — it did not pass the checks and was not shared", withdrawn: "Withdrawn",
};
const size = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Send a message with files as a multipart form. The server reads the text fields and each `file`, runs the gate, and records it all in one command. */
export async function sendMessageForm(url: string, fields: Record<string, string | null>, files: readonly File[], idempotencyKey: string): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) if (value !== null) form.set(name, value);
  for (const file of files) form.append("file", file);
  try {
    const response = await fetch(url, { method: "POST", body: form, credentials: "same-origin", headers: { "idempotency-key": idempotencyKey } });
    const body = await response.json().catch(() => ({})) as { data?: Record<string, unknown>; message?: string; issues?: Array<{ message: string }> };
    if (response.ok && body.data) return { ok: true, data: body.data };
    return { ok: false, message: body.issues?.[0]?.message ?? body.message ?? "That could not be sent." };
  } catch { return { ok: false, message: "That could not be sent." }; }
}

/** The files chosen for the next message: add, see, remove. Nothing is sent until the message is. */
export function AttachmentPicker({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  const [problem, setProblem] = useState("");
  if (!attachmentsOn()) return null;
  function add(selected: FileList | null) {
    if (!selected) return;
    const next = [...files, ...Array.from(selected)];
    if (next.length > PORTAL_MESSAGE_MAX_ATTACHMENTS) { setProblem(`A message takes at most ${PORTAL_MESSAGE_MAX_ATTACHMENTS} attachments.`); onChange(next.slice(0, PORTAL_MESSAGE_MAX_ATTACHMENTS)); return; }
    setProblem(""); onChange(next);
  }
  return <div className="nz-attach-picker">
    <label className="nz-btn sm">Attach files
      <input type="file" multiple hidden disabled={disabled} onChange={(event) => { add(event.target.files); event.target.value = ""; }} />
    </label>
    {problem ? <span className="nz-hint" role="alert">{problem}</span> : null}
    {files.length ? <ul className="nz-attach-chosen" aria-label="Files to attach">
      {files.map((file, index) => <li key={`${file.name}-${index}`}>{file.name} <span className="nz-hint">{size(file.size)}</span>{" "}
        <button type="button" className="nz-a-linkish" disabled={disabled} onClick={() => onChange(files.filter((_, at) => at !== index))} aria-label={`Remove ${file.name}`}>Remove</button></li>)}
    </ul> : null}
  </div>;
}

/** The files on one message. `downloadPath` is the file's audited download route for this reader (the portal's, or staff's for this client). */
export function AttachmentList({ attachments, downloadPath }: { attachments: readonly PortalMessageAttachment[]; downloadPath: (fileId: string) => string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  if (!attachments.length) return null;
  async function download(attachment: PortalMessageAttachment) {
    setBusy(attachment.fileId); setProblem("");
    const result = await postBrowserCommand<{ url: string }>(downloadPath(attachment.fileId), {}, crypto.randomUUID());
    setBusy(null);
    if (result.state === "success") window.open(result.data.url, "_blank", "noopener");
    else setProblem(result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message);
  }
  return <ul className="nz-attach-list" aria-label="Attachments">
    {attachments.map((attachment) => <li key={attachment.fileId} className={`nz-attach ${attachment.state}`}>
      <span className="nz-attach-name">{attachment.fileName}</span> <span className="nz-hint">{size(attachment.sizeBytes)}</span>
      {attachment.state === "available"
        ? <button type="button" className="nz-btn sm" disabled={busy !== null} onClick={() => void download(attachment)} aria-label={`Download ${attachment.fileName}`}>Download</button>
        : <span className="nz-hint">{ATTACHMENT_STATE_LABEL[attachment.state]}</span>}
    </li>)}
    {problem ? <li className="nz-hint" role="alert">{problem}</li> : null}
  </ul>;
}
