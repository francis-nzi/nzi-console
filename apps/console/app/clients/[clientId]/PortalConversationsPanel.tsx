"use client";

import React, { useCallback, useEffect, useState, type FormEvent } from "react";
import { PORTAL_THREAD_STATES, type PortalThreadDetail, type PortalThreadState, type PortalThreadSubject, type PortalThreadSummary } from "@nzi/contracts";
import { formatDate, formatDateTime } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { isSubjectList, isThreadDetail, isThreadList, STAFF_STATE_LABEL, targetNote } from "../../portal/messages/conversationsModel";

/**
 * Portal Management → Messages (RULING-portal-messages, M1): this client's conversations from the adviser's side - read, reply, start one,
 * assign an owner and set the state. Every action is an audited command (client.message.post, client.thread.start, client.thread.update);
 * the response target is a date to look at, not an enforced deadline. A thread is a conversation with the client, not an internal note.
 */
type List = { threads: PortalThreadSummary[]; subjects: PortalThreadSubject[]; staff: Array<{ userId: string; displayName: string }>; jobs: Array<{ jobId: string; jobNumber: string; title: string }> };
type Load<T> = { state: "loading" } | { state: "failed" } | { state: "ready"; value: T };

export function PortalConversationsPanel({ clientId, access }: { clientId: string; access: EditAccess }) {
  const base = `/api/isolated/clients/${encodeURIComponent(clientId)}/threads`;
  const allowed = access.state === "allowed";
  const [list, setList] = useState<Load<List>>({ state: "loading" });
  const [current, setCurrent] = useState<string | null>(null);
  const [detail, setDetail] = useState<Load<PortalThreadDetail>>({ state: "loading" });
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [form, setForm] = useState({ subjectCode: "", jobId: "", title: "", body: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(base, { cache: "no-store", credentials: "same-origin" });
      const body = response.ok ? await response.json().catch(() => null) as Partial<List> | null : null;
      if (body && isThreadList(body.threads) && isSubjectList(body.subjects) && Array.isArray(body.staff) && Array.isArray(body.jobs)) setList({ state: "ready", value: body as List });
      else setList({ state: "failed" });
    } catch { setList({ state: "failed" }); }
  }, [base]);
  useEffect(() => { void refresh(); }, [refresh]);

  const openThread = useCallback(async (threadId: string) => {
    setDetail({ state: "loading" });
    try {
      const response = await fetch(`${base}/${encodeURIComponent(threadId)}`, { cache: "no-store", credentials: "same-origin" });
      const body: unknown = response.ok ? await response.json().catch(() => null) : null;
      setDetail(isThreadDetail(body) ? { state: "ready", value: body } : { state: "failed" });
    } catch { setDetail({ state: "failed" }); }
  }, [base]);
  useEffect(() => { if (current) void openThread(current); }, [current, openThread]);

  const problem = (result: { state: string; message?: string; issues?: Array<{ message: string }> }) => ({ tone: "warn" as const, text: result.state === "validation_failed" ? (result.issues?.[0]?.message ?? result.message ?? "That could not be saved.") : (result.message ?? "That could not be saved.") });

  async function call(method: "POST" | "PATCH", url: string, body: unknown): Promise<{ ok: boolean; data?: Record<string, unknown>; message?: string }> {
    const response = await fetch(url, { method, credentials: "same-origin", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
    const answer = await response.json().catch(() => ({})) as { data?: Record<string, unknown>; message?: string; issues?: Array<{ message: string }> };
    return response.ok ? { ok: true, data: answer.data } : { ok: false, message: answer.issues?.[0]?.message ?? answer.message ?? "That could not be saved." };
  }

  async function reply(event: FormEvent) {
    event.preventDefault();
    if (!current || !draft.trim()) return;
    setBusy(true); setMessage(null);
    const result = await call("POST", `${base}/${encodeURIComponent(current)}`, { body: draft.trim() });
    setBusy(false);
    if (result.ok) { setDraft(""); await refresh(); await openThread(current); } else setMessage({ tone: "warn", text: result.message! });
  }
  async function change(thread: PortalThreadSummary, changes: { ownerId?: string | null; state?: PortalThreadState }) {
    setBusy(true); setMessage(null);
    const result = await call("PATCH", `${base}/${encodeURIComponent(thread.threadId)}`, { expectedVersion: thread.version, ...changes });
    setBusy(false);
    if (result.ok) { await refresh(); await openThread(thread.threadId); } else { setMessage({ tone: "warn", text: result.message! }); await refresh(); await openThread(thread.threadId); }
  }
  async function startNew(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    const result = await call("POST", base, { jobId: form.jobId || null, subjectCode: form.subjectCode, title: form.title.trim(), body: form.body.trim() });
    setBusy(false);
    if (result.ok) { setComposing(false); setForm({ subjectCode: "", jobId: "", title: "", body: "" }); setMessage({ tone: "ok", text: "The conversation has been started." }); await refresh(); if (typeof result.data?.threadId === "string") setCurrent(result.data.threadId); }
    else setMessage({ tone: "warn", text: result.message! });
  }
  return <section className="nz-panel nz-pm" aria-labelledby="pm-messages">
    <div className="nz-card-h"><span className="eyebrow">Manage</span><h2 id="pm-messages">Messages</h2></div>
    <div className="nz-card-b">
      <p className="sub">This client&apos;s conversations. Whatever you write here the client reads in their portal; the response target is a date to look at, not a deadline that is enforced.</p>
      {message ? <div className={`nz-banner ${message.tone}`} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</div> : null}
      {!allowed ? <p className="sub" role="status">{access.state === "checking" ? "Checking your permissions…" : `You can read these conversations but not change them: ${access.reason}`}</p> : null}
      <div className="nz-config-actions"><button type="button" className="nz-btn" disabled={!allowed || list.state !== "ready"} onClick={() => setComposing((value) => !value)}>{composing ? "Cancel" : "New conversation"}</button></div>
      {composing && list.state === "ready" ? <form className="nz-config-form" onSubmit={startNew} aria-label="New conversation">
        <label>About<select className="nz-sel" required value={form.subjectCode} onChange={(event) => setForm({ ...form, subjectCode: event.target.value })}><option value="">Choose…</option>{list.value.subjects.filter((s) => s.active).map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}</select></label>
        <label>Job<select className="nz-sel" value={form.jobId} onChange={(event) => setForm({ ...form, jobId: event.target.value })}><option value="">Whole organisation</option>{list.value.jobs.map((j) => <option key={j.jobId} value={j.jobId}>{j.jobNumber} · {j.title}</option>)}</select></label>
        <label>Title<input className="nz-in" required maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
        <label>Message<textarea className="nz-in" required rows={4} maxLength={4000} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} /></label>
        <button type="submit" className="nz-btn pri" disabled={busy || !form.subjectCode || !form.title.trim() || !form.body.trim()}>{busy ? "Sending…" : "Send to the client"}</button>
      </form> : null}

      {list.state === "loading" ? <p className="sub" role="status">Loading this client&apos;s conversations…</p> : null}
      {list.state === "failed" ? <div className="nz-banner warn" role="alert">The conversations could not be loaded. Nothing is shown rather than a list that might be wrong. <button type="button" className="nz-btn sm" onClick={() => { setList({ state: "loading" }); void refresh(); }}>Try again</button></div> : null}
      {list.state === "ready" && list.value.threads.length === 0 ? <p className="sub">No conversations with this client yet.</p> : null}
      {list.state === "ready" && list.value.threads.length > 0 ? <div className="nz-pm-conv">
        <div style={{ overflowX: "auto" }}><table className="nz-tbl">
          <thead><tr><th>Conversation</th><th>About</th><th>State</th><th>Owner</th><th className="num">New</th><th>Last</th></tr></thead>
          <tbody>{list.value.threads.map((thread) => <tr key={thread.threadId} className={thread.threadId === current ? "on" : undefined}>
            <td><button type="button" className="nz-link" aria-current={thread.threadId === current ? "true" : undefined} onClick={() => setCurrent(thread.threadId)}><b>{thread.title}</b></button>
              <div className="nz-hint">{thread.scope === "job" ? thread.jobNumber : "Whole organisation"}{thread.reportVersionId ? " · report comments" : ""}</div></td>
            <td>{thread.subjectLabel}</td>
            <td>{STAFF_STATE_LABEL[thread.state]}{targetNote(thread, "staff") ? <div className="nz-hint">{targetNote(thread, "staff")}</div> : null}</td>
            <td>{thread.ownerName ?? <span className="nz-hint">Unassigned</span>}</td>
            <td className="num">{thread.unread > 0 ? thread.unread : "—"}</td>
            <td>{formatDate(thread.lastMessageAt)}</td>
          </tr>)}</tbody>
        </table></div>
        {current ? <div className="nz-pm-conv-thread" aria-label="Conversation">
          {detail.state === "loading" ? <p className="sub" role="status">Loading…</p> : null}
          {detail.state === "failed" ? <p role="alert">This conversation could not be loaded.</p> : null}
          {detail.state === "ready" ? <>
            <h3>{detail.value.thread.title}</h3>
            <div className="nz-config-actions">
              <label>Owner<select className="nz-sel" disabled={!allowed || busy} value={detail.value.thread.ownerId ?? ""} onChange={(event) => void change(detail.value.thread, { ownerId: event.target.value || null })}><option value="">Unassigned</option>{list.value.staff.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></label>
              <label>State<select className="nz-sel" disabled={!allowed || busy} value={detail.value.thread.state} onChange={(event) => void change(detail.value.thread, { state: event.target.value as PortalThreadState })}>{PORTAL_THREAD_STATES.map((state) => <option key={state} value={state}>{STAFF_STATE_LABEL[state]}</option>)}</select></label>
            </div>
            <ol className="nz-conv-messages">{detail.value.messages.map((m) => <li key={m.messageId}><div className="nz-hint">{m.authorName ?? (m.authorPrincipal === "staff" ? "Adviser" : "Client user")} · {m.authorPrincipal === "staff" ? "adviser" : "client"} · {formatDateTime(m.createdAt)}</div><p>{m.body}</p></li>)}</ol>
            <form onSubmit={reply}>
              <label className="nz-sr" htmlFor="staff-conv-draft">Your reply</label>
              <textarea id="staff-conv-draft" className="nz-in" rows={3} maxLength={4000} disabled={!allowed} placeholder="Reply to the client…" value={draft} onChange={(event) => setDraft(event.target.value)} />
              <button type="submit" className="nz-btn pri" disabled={!allowed || busy || !draft.trim()}>{busy ? "Sending…" : "Send to the client"}</button>
            </form>
          </> : null}
        </div> : null}
      </div> : null}
    </div>
  </section>;
}
