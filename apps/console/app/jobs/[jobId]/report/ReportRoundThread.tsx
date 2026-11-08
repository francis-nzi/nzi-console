"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { StaffReportThread } from "@nzi/isolated-backend";
import { formatDateTime } from "../../../lib/formatDate";
import { useOrganisationName } from "../../../lib/OrganisationNameProvider";
import { ROUND_THREAD_EMPTY, threadOfRound } from "./roundThread";

/**
 * F1: the round's conversation, read and answered where the document is - the review inbox's thread for this one version, through the same staff
 * read and reply route (`reports/review-messages`, `portal.report` comments). A read that fails says so; it is never drawn as an empty thread.
 */
export function ReportRoundThread({ reportVersionId }: { reportVersionId: string }) {
  const org = useOrganisationName();
  const [thread, setThread] = useState<StaffReportThread | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      const response = await fetch("/api/isolated/reports/review-messages", { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as { threads?: StaffReportThread[] };
      if (!response.ok || !Array.isArray(body.threads)) throw new Error("unreadable");
      setThread(threadOfRound(body.threads, reportVersionId)); setFailed(false);
    } catch { setFailed(true); }
  }
  useEffect(() => { void load(); }, [reportVersionId]);

  async function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !thread) return;
    const form = event.currentTarget, body = String(new FormData(form).get("body") ?? "");
    setPending(true); setNotice(null);
    try {
      const response = await fetch("/api/isolated/reports/review-messages", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: thread.jobId, reportVersionId, body }) });
      if (!response.ok) throw new Error("not sent");
      form.reset(); setNotice("Reply sent to the client."); await load();
    } catch { setNotice("The reply could not be sent."); }
    setPending(false);
  }

  if (failed) return <p className="muted" role="alert" style={{ margin: "8px 16px 0" }}>This round&rsquo;s messages could not be read.</p>;
  if (thread === undefined) return null;
  return <details className="nzs-edit-history" data-report-round-thread open={Boolean(thread?.needsReply)} style={{ margin: "8px 16px 0" }}>
    <summary>Messages with the client ({thread?.comments.length ?? 0}){thread?.needsReply ? " - client reply needed" : ""}</summary>
    {thread === null || thread.comments.length === 0 ? <p className="muted">{ROUND_THREAD_EMPTY}</p> : <ol>
      {thread.comments.map((comment) => <li key={comment.commentId}>
        <b>{comment.authorDisplayName}</b> <span className="muted">{comment.authorPrincipal === "portal" ? "Client" : org.short} · {formatDateTime(comment.createdAt)}</span>
        <div>{comment.body}</div>
      </li>)}
    </ol>}
    {thread ? <form onSubmit={(event) => void reply(event)} data-round-reply>
      <input className="nz-inp" name="body" maxLength={4000} required disabled={pending} aria-label="Reply to the client" placeholder="Reply to the client…" />
      {" "}<button className="nz-btn pri" disabled={pending}>{pending ? "Sending…" : "Reply to client"}</button>
    </form> : null}
    {notice ? <p className="muted" role="status">{notice}</p> : null}
  </details>;
}
