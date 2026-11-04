"use client";

import React, { useCallback, useEffect, useState, type FormEvent } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import type { PortalThreadDetail, PortalThreadSubject, PortalThreadSummary } from "@nzi/contracts";
import { useOrganisationName } from "../../lib/OrganisationNameProvider";
import { formatDate, formatDateTime } from "../../lib/formatDate";
import { AttachmentList, AttachmentPicker, sendMessageForm } from "../../lib/MessageAttachments";
import { clientAuthorLabel, clientStateLabel, filterBySubject, isSubjectList, isThreadDetail, isThreadList, pickThread, targetNote } from "./conversationsModel";

/**
 * Messages - the Conversations lane (RULING-portal-messages, M1): the client's threads with their adviser, tagged by subject, on this job and
 * for the whole organisation, as MOCKUP-client-portal.html lays them out - a list and the conversation. Real: starting a conversation,
 * writing, and marking it read are the audited commands; what the user may see is the server's decision (`listPortalThreads`). Dark behind
 * `portal-conversations`; the report page's Messages tab is one conversation with the Reports-tagged thread here.
 */
type Load<T> = { state: "loading" } | { state: "failed" } | { state: "ready"; value: T };
type Notice = { tone: "ok" | "warn"; text: string };

export function PortalConversations({ jobId }: { jobId: string }) {
  const org = useOrganisationName();
  const [list, setList] = useState<Load<{ threads: PortalThreadSummary[]; subjects: PortalThreadSubject[] }>>({ state: "loading" });
  // A notification email deep-links here with ?thread=<id>: open that conversation first (it only takes effect if the user may see it - the list decides).
  const [current, setCurrent] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("thread")));
  const [detail, setDetail] = useState<Load<PortalThreadDetail>>({ state: "loading" });
  const [filter, setFilter] = useState<string>("all");
  const [draft, setDraft] = useState("");
  const [draftFiles, setDraftFiles] = useState<File[]>([]);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [composing, setComposing] = useState(false);
  const [form, setForm] = useState({ subjectCode: "", title: "", body: "", wholeOrganisation: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const api = "/api/portal/threads";

  const refresh = useCallback(async (keep?: string | null) => {
    try {
      const response = await fetch(`${api}?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = response.ok ? await response.json().catch(() => null) as { threads?: unknown; subjects?: unknown } | null : null;
      if (body && isThreadList(body.threads) && isSubjectList(body.subjects)) {
        setList({ state: "ready", value: { threads: body.threads, subjects: body.subjects } });
        setCurrent((previous) => pickThread(body.threads as PortalThreadSummary[], keep ?? previous));
      } else setList({ state: "failed" });
    } catch { setList({ state: "failed" }); }
  }, [jobId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const openThread = useCallback(async (threadId: string) => {
    setDetail({ state: "loading" });
    try {
      const response = await fetch(`${api}/${encodeURIComponent(threadId)}`, { cache: "no-store", credentials: "same-origin" });
      const body: unknown = response.ok ? await response.json().catch(() => null) : null;
      if (isThreadDetail(body)) {
        setDetail({ state: "ready", value: body });
        // Reading is recorded as the audited command, once there is something unread.
        if (body.thread.unread > 0) void postBrowserCommand(`${api}/${encodeURIComponent(threadId)}/read`, {}, crypto.randomUUID()).then(() => refresh(threadId));
      } else setDetail({ state: "failed" });
    } catch { setDetail({ state: "failed" }); }
  }, [refresh]);
  useEffect(() => { if (current) void openThread(current); }, [current, openThread]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!current || !draft.trim()) return;
    setBusy(true); setNotice(null);
    // With files, the message goes as a form (each file through the gate, recorded with the message); without, exactly as before.
    if (draftFiles.length) {
      const sent = await sendMessageForm(`${api}/${encodeURIComponent(current)}`, { body: draft.trim() }, draftFiles, crypto.randomUUID());
      setBusy(false);
      if (sent.ok) { setDraft(""); setDraftFiles([]); await refresh(current); await openThread(current); } else setNotice({ tone: "warn", text: sent.message });
      return;
    }
    const result = await postBrowserCommand(`${api}/${encodeURIComponent(current)}`, { body: draft.trim() }, crypto.randomUUID());
    setBusy(false);
    if (result.state === "success") { setDraft(""); await refresh(current); await openThread(current); }
    else setNotice({ tone: "warn", text: result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message });
  }

  async function startNew(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice(null);
    const fields = { jobId: form.wholeOrganisation ? null : jobId, subjectCode: form.subjectCode, title: form.title.trim(), body: form.body.trim() };
    if (newFiles.length) {
      const sent = await sendMessageForm(api, fields, newFiles, crypto.randomUUID());
      setBusy(false);
      if (sent.ok) {
        setComposing(false); setNewFiles([]); setForm({ subjectCode: "", title: "", body: "", wholeOrganisation: false }); setNotice({ tone: "ok", text: `Your conversation has been sent to ${org.short}.` });
        await refresh(typeof sent.data.threadId === "string" ? sent.data.threadId : undefined);
      } else setNotice({ tone: "warn", text: sent.message });
      return;
    }
    const result = await postBrowserCommand<{ threadId: string }>(api, fields, crypto.randomUUID());
    setBusy(false);
    if (result.state === "success") {
      setComposing(false); setForm({ subjectCode: "", title: "", body: "", wholeOrganisation: false }); setNotice({ tone: "ok", text: `Your conversation has been sent to ${org.short}.` });
      await refresh(result.data.threadId);
    } else setNotice({ tone: "warn", text: result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message });
  }

  if (list.state === "loading") return <p className="nz-pd-meta" role="status">Loading your conversations…</p>;
  if (list.state === "failed") return <div className="nzp-files-notice warn" role="alert">Your conversations could not be loaded, so none are shown rather than a list that might be wrong. <button type="button" className="nz-btn" onClick={() => { setList({ state: "loading" }); void refresh(); }}>Try again</button></div>;

  const { threads, subjects } = list.value;
  const shown = filterBySubject(threads, filter);
  const open = detail.state === "ready" ? detail.value : null;
  const targetText = open ? targetNote(open.thread, "client", org.short) : null;

  return (
    <div className="nzp-metrics nzp-conv">
      <header className="nz-pd-top">
        <div>
          <span className="nz-eyebrow">Conversations</span>
          <h1 className="nz-pd-client">Messages</h1>
          <p className="nz-pd-meta">Ask {org.short} a question, or reply — every conversation is kept here.</p>
        </div>
        <button type="button" className="nz-btn pri" onClick={() => { setComposing((value) => !value); setNotice(null); }}>{composing ? "Cancel" : "New conversation"}</button>
      </header>
      {notice ? <div className={`nzp-files-notice ${notice.tone}`} role={notice.tone === "ok" ? "status" : "alert"}>{notice.text}</div> : null}

      {composing ? (
        <form className="nzp-metric-card nzp-conv-new" onSubmit={startNew} aria-label="New conversation">
          <label>About<select className="nz-sel" required value={form.subjectCode} onChange={(event) => setForm({ ...form, subjectCode: event.target.value })}>
            <option value="">Choose a subject…</option>{subjects.map((subject) => <option key={subject.code} value={subject.code}>{subject.label}</option>)}</select></label>
          <label>Title<input className="nz-in" required maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label>Message<textarea className="nz-in" required rows={4} maxLength={4000} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} /></label>
          <AttachmentPicker files={newFiles} onChange={setNewFiles} disabled={busy} />
          <label className="nzp-conv-check"><input type="checkbox" checked={form.wholeOrganisation} onChange={(event) => setForm({ ...form, wholeOrganisation: event.target.checked })} /> This is not about this job — it is for our whole organisation</label>
          <button type="submit" className="nz-btn pri" disabled={busy || !form.subjectCode || !form.title.trim() || !form.body.trim()}>{busy ? "Sending…" : "Send"}</button>
        </form>
      ) : null}

      <div className="nzp-conv-grid">
        <section className="nzp-metric-card nzp-conv-list" aria-label="Conversations">
          <div className="nzp-files-filter" role="group" aria-label="Filter by subject">
            {[{ code: "all", label: "All" }, ...subjects].map((subject) => <button key={subject.code} type="button" className={`nzp-chip${filter === subject.code ? " on" : ""}`} aria-pressed={filter === subject.code} onClick={() => setFilter(subject.code)}>{subject.label}</button>)}
          </div>
          {threads.length === 0 ? <p className="nz-pd-meta">No conversations yet. Start one with “New conversation”.</p> : null}
          {threads.length > 0 && shown.length === 0 ? <p className="nz-pd-meta">No conversations with this subject.</p> : null}
          <ul className="nzp-conv-items">
            {shown.map((thread) => (
              <li key={thread.threadId}>
                <button type="button" className={`nzp-conv-item${thread.threadId === current ? " on" : ""}`} aria-current={thread.threadId === current ? "true" : undefined} onClick={() => setCurrent(thread.threadId)}>
                  <span className="nzp-conv-top"><span className="nzp-conv-tag">{thread.subjectLabel}</span>{thread.unread > 0 ? <span className="nzp-conv-unread" aria-label={`${thread.unread} unread`}>{thread.unread}</span> : null}</span>
                  <b>{thread.title}</b>
                  <span className="nz-hint">{thread.scope === "job" ? thread.jobNumber ?? "This job" : "Whole organisation"} · {clientStateLabel(thread.state, org.short)} · {formatDate(thread.lastMessageAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="nzp-metric-card nzp-conv-thread" aria-label="Conversation">
          {detail.state === "loading" ? <p className="nz-pd-meta" role="status">Loading…</p> : null}
          {detail.state === "failed" ? <p role="alert">This conversation could not be loaded.</p> : null}
          {!current && detail.state !== "loading" ? <p className="nz-pd-meta">Choose a conversation.</p> : null}
          {open ? (
            <>
              <div className="nzp-metric-h"><h3>{open.thread.title}</h3><span className="nzp-conv-tag">{open.thread.subjectLabel}</span></div>
              <p className="nz-hint">{clientStateLabel(open.thread.state, org.short)}{targetText ? ` · ${targetText}` : ""}</p>
              <ol className="nzp-conv-messages">
                {open.messages.map((message) => (
                  <li key={message.messageId} className={`nzp-conv-msg ${message.author}`}>
                    <div className="nz-hint">{clientAuthorLabel(message.author, org.Short)} · {formatDateTime(message.createdAt)}</div>
                    <p>{message.body}</p>
                    <AttachmentList attachments={message.attachments ?? []} downloadPath={(fileId) => `/api/portal/files/${encodeURIComponent(fileId)}/download`} />
                  </li>
                ))}
              </ol>
              <form onSubmit={send} className="nzp-conv-composer">
                <label className="nz-sr" htmlFor="conv-draft">Your message</label>
                <textarea id="conv-draft" className="nz-in" rows={3} maxLength={4000} placeholder={open.thread.state === "resolved" ? "Write to reopen this conversation…" : "Write a reply…"} value={draft} onChange={(event) => setDraft(event.target.value)} />
                <AttachmentPicker files={draftFiles} onChange={setDraftFiles} disabled={busy} />
                <button type="submit" className="nz-btn pri" disabled={busy || !draft.trim()}>{busy ? "Sending…" : "Send"}</button>
              </form>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
