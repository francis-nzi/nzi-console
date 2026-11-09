"use client";

import { useRef, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { GatedButton } from "@nzi/ui";
import type { SrsThreadReadModel } from "@nzi/contracts";
import { formatDate, formatDateTime } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { CardHead } from "./OverviewArea";
import { STAFF_STATE_LABEL } from "../../portal/messages/conversationsModel";

/**
 * SRS messaging (Phase B): a review the client has asked for, surfaced where the CRM acts on it — Reopen to correct or Reassess,
 * the existing commands. The portal never reopens anything (NZC-022).
 */
export function SrsReviewRequestBanner({ thread }: { thread: SrsThreadReadModel }) {
  if (!thread.openReviewRequest) return null;
  return <div className="nz-banner warn" role="status">
    <b>The client asked for a review</b> on {formatDate(thread.openReviewRequest.createdAt)} — see their message below. Reopen to correct, or reassess, then reply to let them know.
  </div>;
}

/**
 * The client's SRS readiness conversation, kept and visible on both sides: the CRM reads it here and replies through the gated,
 * audited `srs.message.post` (srs.manage). The client is told by a notify-only email — a link, never the words.
 */
export function SrsConversation({ clientId, thread, access, onSaved }: { clientId: string; thread: SrsThreadReadModel; access: EditAccess; onSaved: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  async function send() {
    setPending(true); setError(null);
    key.current ??= crypto.randomUUID();
    const result = await postBrowserCommand(`/api/isolated/clients/${encodeURIComponent(clientId)}/srs-thread`, { body: draft }, key.current);
    setPending(false);
    key.current = null;
    if (result.state !== "success") { setError(result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message); return; }
    setDraft("");
    onSaved("Reply sent. The client is told by email that there is a new message — the email is a link, not your words.");
  }

  return <section className="nz-panel" aria-label="Client conversation about readiness">
    <CardHead eyebrow="Client conversation" title="Messages about readiness" right={thread.thread ? <span className="nz-st">{STAFF_STATE_LABEL[thread.thread.state]}</span> : undefined} />
    <div className="nz-card-b">
      {thread.messages.length === 0
        ? <p className="sub">No messages yet. The client writes from their portal&apos;s readiness page; you can write first here.</p>
        : <ol className="nzp-conv-messages">{thread.messages.map((message) => <li key={message.messageId} className={`nzp-conv-msg ${message.authorPrincipal === "staff" ? "adviser" : "colleague"}`}>
          <div className="nz-hint">{message.authorName ?? (message.authorPrincipal === "staff" ? "Adviser" : "Client user")} · {formatDateTime(message.createdAt)}{message.reviewRequest ? " · asked for a review" : ""}</div>
          <p>{message.body}</p>
        </li>)}</ol>}
      <label className="nz-sr" htmlFor="srs-reply">Reply to the client</label>
      <textarea id="srs-reply" className="nz-in" rows={3} maxLength={4000} placeholder="Write to the client…" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <GatedButton className="nz-btn pri" blocked={pending || access.state !== "allowed" || !draft.trim()}
        blockedReason={pending ? "Sending…" : access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
        onClick={() => void send()}>{pending ? "Sending…" : "Send"}</GatedButton>
      {error ? <span className="nz-banner warn" role="alert">{error}</span> : null}
    </div>
  </section>;
}
