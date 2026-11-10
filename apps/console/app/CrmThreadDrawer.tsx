"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Drawer } from "@nzi/ui";
import type { PortalThreadDetail } from "@nzi/contracts";
import type { CrmThread } from "@nzi/isolated-backend";
import { threadPaths } from "./lib/crmControlRoomLinks";
import { formatDateTime } from "./lib/formatDate";
import { isThreadDetail } from "./portal/messages/conversationsModel";

/**
 * The Control Room's message drawer (BRIEF-crm-control-room-p2): one of the CRM's conversations over the dashboard — the
 * thread, a reply, a link to its job or client, and on a review request the way to reopen. It is not a new thread or a new
 * write: it reads the conversation the client workspace reads (portal.admin on the client) and replies through the existing
 * commands — `srs.message.post` for the client's SRS conversation, `client.message.post` for any other — which queue the
 * client's notify-only email (a link, never the words, and only with their consent).
 *
 * The thread is one of the CRM's own: the page passes it from the Control Room read, and a drawer for any other says so
 * rather than opening it. The open drawer is the URL (`/?msg=<threadId>`), so closing it is going back to the dashboard.
 */
type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; value: PortalThreadDetail };

export function CrmThreadDrawer({ thread }: { thread: CrmThread | null }) {
  const router = useRouter();
  const close = useCallback(() => router.push("/", { scroll: false }), [router]);
  const [detail, setDetail] = useState<Load>({ state: "loading" });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!thread) return;
    try {
      const response = await fetch(threadPaths(thread).read, { cache: "no-store", credentials: "same-origin" });
      const body: unknown = response.ok ? await response.json().catch(() => null) : null;
      setDetail(isThreadDetail(body) ? { state: "ready", value: body } : { state: "failed" });
    } catch { setDetail({ state: "failed" }); }
  }, [thread]);
  useEffect(() => { void load(); }, [load]);

  async function reply(event: FormEvent) {
    event.preventDefault();
    if (!thread || !draft.trim() || busy) return;
    setBusy(true); setProblem(null);
    try {
      const response = await fetch(threadPaths(thread).reply, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ body: draft.trim() }),
      });
      const answer = await response.json().catch(() => ({})) as { message?: string; issues?: Array<{ message: string }> };
      if (!response.ok) { setProblem(answer.issues?.[0]?.message ?? answer.message ?? "The reply could not be sent."); return; }
      setDraft("");
      await load();
      // The reply answers the client: the dashboard's counts and the Red box are read again.
      router.refresh();
    } catch { setProblem("The reply could not be sent."); }
    finally { setBusy(false); }
  }

  const label = thread ? `Conversation with ${thread.client}` : "Conversation";
  return <Drawer open onClose={close} ariaLabel={label} className="nz-site-drawer" dismissOnOutsideClick>
    <div className="nz-dh">
      <div className="k">{thread ? [thread.subjectLabel, thread.jobNumber].filter(Boolean).join(" · ") : "Conversation"}</div>
      <h3>{thread?.client ?? "Conversation"}</h3>
      {thread ? <div className="sub">{thread.title} · {thread.jobId
        ? <Link className="nz-table-link" href={`/jobs/${encodeURIComponent(thread.jobId)}`}>Open job →</Link>
        : <Link className="nz-table-link" href={`/clients/${encodeURIComponent(thread.clientId)}`}>Open client →</Link>}</div> : null}
      <button type="button" className="x" aria-label="Close conversation" onClick={close}>×</button>
    </div>
    <div className="nz-db" data-crm-thread={thread?.threadId ?? "not-mine"}>
      {!thread ? <p className="sub" role="status">This conversation is not one of yours, so it is not opened here. It is in the client&apos;s Communications.</p> : <>
        {thread.reviewRequest ? <div className="nz-banner warn" data-crm-review-request><div><b>The client has asked for a review.</b><div>Reopen their SRS readiness assessment, then answer them here.</div></div>
          <Link className="nz-btn sm pri" href={`/clients/${encodeURIComponent(thread.clientId)}?area=srs`}>Reopen in SRS →</Link></div> : null}
        {thread.reportReview && thread.jobId ? <div className="nz-banner" role="note"><div>This conversation is the comments on a report review.</div></div> : null}
        {detail.state === "loading" ? <p className="sub" role="status">Loading the conversation…</p> : null}
        {detail.state === "failed" ? <p role="alert">This conversation could not be loaded. Nothing is shown rather than a thread that might be wrong.</p> : null}
        {detail.state === "ready" ? <ol className="nz-conv-messages">{detail.value.messages.map((message) => <li key={message.messageId}>
          <div className="nz-hint">{message.authorName ?? (message.authorPrincipal === "staff" ? "Adviser" : "Client user")} · {message.authorPrincipal === "staff" ? "adviser" : "client"} · {formatDateTime(message.createdAt)}</div>
          <p>{message.body}</p>
        </li>)}</ol> : null}
      </>}
    </div>
    {thread ? <form className="nz-crm-compose" onSubmit={reply}>
      {problem ? <div className="nz-banner warn" role="alert">{problem}</div> : null}
      <label className="nz-sr-only" htmlFor="crm-thread-reply">Reply to {thread.client}</label>
      <textarea id="crm-thread-reply" className="nz-in" rows={3} maxLength={4000} placeholder={`Reply to ${thread.client}…`} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} />
      <div className="nz-drawer-actions"><button type="submit" className="nz-btn pri" disabled={busy || !draft.trim()}>{busy ? "Sending…" : "Send to the client"}</button>
        <span className="nz-hint">The client is emailed a link only, never the message text, and only if they have agreed to email.</span></div>
    </form> : null}
  </Drawer>;
}
