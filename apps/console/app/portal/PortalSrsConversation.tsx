"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import type { SrsThreadReadModel } from "@nzi/contracts";
import { useOrganisationName } from "../lib/OrganisationNameProvider";
import { formatDateTime } from "../lib/formatDate";
import { clientAuthorLabel, clientStateLabel } from "./messages/conversationsModel";
import { redirectIfPortalSessionEnded } from "./portalSessionClient";

/**
 * SRS messaging (Phase B): the client's one conversation with their adviser about their readiness, under the readiness view.
 * The assessment above stays read-only; writing here is the client's only act, and "Ask for a review" marks the message as a
 * request their adviser sees — it reopens nothing by itself. The adviser is the firm, never a named person (NZC-110), and the
 * email either side gets is a link, never these words. The same markup as the Messages page's thread.
 */
export function PortalSrsConversation() {
  const org = useOrganisationName();
  const [model, setModel] = useState<SrsThreadReadModel | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [reviewRequest, setReviewRequest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const load = useCallback(() => {
    fetch("/api/portal/srs-thread", { cache: "no-store" }).then(async (response) => {
      if (await redirectIfPortalSessionEnded(response)) return;
      if (response.status === 404) { setModel(null); setFailed(false); return; }
      if (!response.ok) throw new Error();
      setModel(await response.json() as SrsThreadReadModel); setFailed(false);
    }).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice(null);
    const result = await postBrowserCommand("/api/portal/srs-thread", { body: draft, ...(reviewRequest ? { reviewRequest: true } : {}) }, crypto.randomUUID());
    setBusy(false);
    if (result.state !== "success") { setNotice({ tone: "warn", text: result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message }); return; }
    setNotice({ tone: "ok", text: reviewRequest ? `Sent. ${org.Short} will see you have asked for a review.` : "Sent." });
    setDraft(""); setReviewRequest(false);
    load();
  }

  if (failed) return <section className="nz-panel"><div className="nzp-files-notice warn" role="alert">Your conversation about readiness could not be loaded. Nothing has changed — try again shortly.</div></section>;
  if (model === null) return null;

  return <section className="nz-panel"><div className="nz-card-b nzp-conv-thread" aria-label="Talk to your adviser about readiness">
    <h3 className="nz-portal-readiness-h">Talk to {org.short} about your readiness</h3>
    <p className="sub" style={{ marginTop: 0 }}>Ask a question, or ask for your assessment to be reviewed. Your assessment is consultant-led: {org.short} reviews it and updates it here.</p>
    {model.thread ? <p className="nz-hint">{clientStateLabel(model.thread.state, org.short)}</p> : null}
    {notice ? <div className={`nzp-files-notice ${notice.tone}`} role={notice.tone === "ok" ? "status" : "alert"}>{notice.text}</div> : null}
    {model.messages.length > 0 ? <ol className="nzp-conv-messages">
      {model.messages.map((message) => <li key={message.messageId} className={`nzp-conv-msg ${message.author}`}>
        <div className="nz-hint">{clientAuthorLabel(message.author, org.Short)} · {formatDateTime(message.createdAt)}{message.reviewRequest ? " · asked for a review" : ""}</div>
        <p>{message.body}</p>
      </li>)}
    </ol> : null}
    <form onSubmit={send} className="nzp-conv-composer">
      <label className="nz-sr" htmlFor="srs-draft">Your message</label>
      <textarea id="srs-draft" className="nz-in" rows={3} maxLength={4000} placeholder="Write to your adviser…" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <label className="nzp-conv-check"><input type="checkbox" checked={reviewRequest} onChange={(event) => setReviewRequest(event.target.checked)} /> Ask for my assessment to be reviewed</label>
      <button type="submit" className="nz-btn pri" disabled={busy || !draft.trim()}>{busy ? "Sending…" : "Send"}</button>
    </form>
  </div></section>;
}
