"use client";
// Messages — an early version (BUILD-portal-shell-lookandfeel R7): the existing two-way thread between the client and their
// adviser on each published report of this job (`portal_report_comments`), laid out as MOCKUP-client-portal.html's Conversations —
// a thread list and the conversation. Real and live: on the client's portal it sends through the existing comment route and
// marks the thread read as the report page's Messages tab does. No automation, no notifications, no other subjects (phase 6).
// In the staff preview it reads through the GET-only mirror and draws no composer and no read receipt (#506).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PortalReportComment } from "@nzi/isolated-backend";
import { useOrganisationName } from "../../lib/OrganisationNameProvider";
import { formatDateTime } from "../../lib/formatDate";
import { usePortalSurface } from "../portalSurface";
import { isPortalReportComment } from "../jobs/[jobId]/publishedReportValidation";
import { publishedScopesOf } from "../reportsView";

type Thread = { reportVersionId: string; title: string; comments: PortalReportComment[] | null };
type State = { kind: "loading" } | { kind: "failed" } | { kind: "none" } | { kind: "ready"; jobNumber: string; threads: Thread[] };

export function PortalMessages({ jobId }: { jobId: string }) {
  const surface = usePortalSurface();
  const org = useOrganisationName();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [current, setCurrent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const base = `${surface.api}/jobs/${encodeURIComponent(jobId)}/published-report`;

  const commentsOf = useCallback(async (reportVersionId: string): Promise<PortalReportComment[] | null> => {
    const response = await fetch(`${base}/comments?reportVersionId=${encodeURIComponent(reportVersionId)}`, { cache: "no-store" });
    if (await surface.sessionEnded(response)) return null;
    const body: unknown = response.ok ? await response.json() : null;
    const comments = body && typeof body === "object" ? (body as { comments?: unknown }).comments : undefined;
    return Array.isArray(comments) && comments.every((comment) => isPortalReportComment(comment, reportVersionId)) ? comments as PortalReportComment[] : null;
  }, [base, surface]);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const response = await fetch(base, { cache: "no-store" });
      if (await surface.sessionEnded(response)) return;
      if (response.status === 404) { setState({ kind: "none" }); return; }
      const body: unknown = response.ok ? await response.json() : null;
      const scopes = publishedScopesOf(body);
      const jobNumber = (body as { report?: { snapshot?: { jobNumber?: string } } } | null)?.report?.snapshot?.jobNumber ?? "";
      if (!scopes) { setState({ kind: "failed" }); return; }
      const threads = await Promise.all(scopes.map(async (scope) => ({
        reportVersionId: scope.reportVersionId,
        title: scopes.length > 1 ? `${jobNumber} report · ${scope.scopeLabel}` : `${jobNumber} report`,
        comments: await commentsOf(scope.reportVersionId),
      })));
      setState({ kind: "ready", jobNumber, threads });
      setCurrent((previous) => previous && threads.some((thread) => thread.reportVersionId === previous) ? previous : threads[0]?.reportVersionId ?? null);
    } catch { setState({ kind: "failed" }); }
  }, [base, surface, commentsOf]);
  useEffect(() => { void load(); }, [load]);

  // The client reading the thread is recorded as the report page's Messages tab records it — never from the preview.
  useEffect(() => {
    if (surface.readOnly || !current || state.kind !== "ready") return;
    void fetch(`${base}/comments/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reportVersionId: current }) }).catch(() => undefined);
  }, [base, current, state.kind, surface.readOnly]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (surface.readOnly || pending || !current || !draft.trim()) return;
    setPending(true); setError("");
    try {
      const response = await fetch(`${base}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reportVersionId: current, body: draft }) });
      if (await surface.sessionEnded(response)) return;
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "The message could not be sent.");
      setDraft("");
      const comments = await commentsOf(current);
      setState((previous) => previous.kind !== "ready" ? previous : { ...previous, threads: previous.threads.map((thread) => thread.reportVersionId === current ? { ...thread, comments } : thread) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The message could not be sent."); }
    finally { setPending(false); }
  }

  const header = (
    <header className="nz-pd-top">
      <div>
        <span className="nz-eyebrow">Communication</span>
        <h1 className="nz-pd-client">Messages <span className="nzp-early">Early version</span></h1>
        <p className="nz-pd-meta">Conversations with {org.your("team")} about your published reports. More subjects and notifications are on the way.</p>
      </div>
    </header>
  );
  if (state.kind === "loading") return <>{header}<div className="nz-portal-state loading" role="status"><i>↻</i><div><b>Loading your messages</b><span>Reading your report conversations…</span></div></div></>;
  if (state.kind === "failed") return <>{header}<div className="nz-portal-state failed" role="alert"><i>!</i><div><b>Your messages are temporarily unavailable</b><span>Nothing has been assumed about your conversations.</span><button className="nz-btn" onClick={() => void load()}>Try again</button></div></div></>;
  if (state.kind === "none") return <>{header}<div className="nz-portal-state empty"><i>✓</i><div><b>No conversations yet</b><span>Conversations open with your first published report for this job — you can ask {org.your("team")} about it right there.</span></div></div></>;

  const thread = state.threads.find((entry) => entry.reportVersionId === current) ?? null;
  return (
    <>
      {header}
      <div className="nzp-msgwrap">
        <nav className="nzp-threadlist" aria-label="Conversations">
          {state.threads.map((entry) => {
            const last = entry.comments?.at(-1);
            return (
              <button key={entry.reportVersionId} type="button" className="nzp-thread" aria-current={entry.reportVersionId === current ? "true" : undefined} onClick={() => setCurrent(entry.reportVersionId)}>
                <span className="tr1"><span className="nzp-subj">Reports</span>{last ? <span className="when">{formatDateTime(last.createdAt)}</span> : null}</span>
                <span className="tt">{entry.title}</span>
                <span className="tp">{entry.comments === null ? "Could not be loaded" : last ? last.body : "No messages yet"}</span>
              </button>
            );
          })}
        </nav>
        <section className="nzp-convo" aria-label={thread ? thread.title : "Conversation"}>
          {thread === null ? null : thread.comments === null ? (
            <p className="nzp-metric-note" role="alert">This conversation could not be loaded just now. Nothing has been assumed about it.</p>
          ) : (
            <>
              <div className="nzp-convo-b">
                {thread.comments.length === 0 ? <p className="nzp-metric-note">No messages on this report yet. {surface.readOnly ? "" : `Ask ${org.your("team")} anything about it here.`}</p> : null}
                {thread.comments.map((comment) => (
                  <div key={comment.commentId} className={`nzp-msg ${comment.authorPrincipal === "portal" ? "me" : "them"}`}>
                    <p>{comment.body}</p>
                    <span className="meta">{comment.authorPrincipal === "portal" ? (surface.readOnly ? `${comment.authorDisplayName} · client` : "You") : `${comment.authorDisplayName} · ${org.short}`} · {formatDateTime(comment.createdAt)}</span>
                  </div>
                ))}
              </div>
              {surface.readOnly ? <p className="nzp-convo-ro" role="note">Read-only preview: the client replies here, and the reply reaches the report&rsquo;s review thread.</p> : (
                <form className="nzp-composer" onSubmit={send}>
                  <label className="nz-sr-only" htmlFor="nzp-reply">Message</label>
                  <textarea id="nzp-reply" rows={2} maxLength={4000} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a message…" />
                  <button className="nz-btn pri" type="submit" disabled={pending || !draft.trim()}>{pending ? "Sending…" : "Send"}</button>
                  {error ? <p className="nzp-metric-note" role="alert">{error}</p> : null}
                </form>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
