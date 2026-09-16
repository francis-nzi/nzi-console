"use client";

import { useCallback, useEffect, useState } from "react";
import { Collapsible, GatedButton } from "@nzi/ui";
import { postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  knowledgeStatusLabels, transitionRefusal,
  type KnowledgeEntry, type KnowledgeStatus,
} from "@nzi/contracts";
import { formatDate } from "../lib/formatDate";
import { useEditAccess } from "../lib/useEditAccess";

/**
 * The knowledge library — NZI's own shared knowledge, not per-client.
 *
 * Two views over one collection. **Library** browses what has been approved; **Review** is the
 * queue of drafts waiting on a decision. They are separate because the questions they answer
 * are separate: "what do we know?" and "what needs me?".
 *
 * Both are hosted here as a page in 0a so the pipeline is usable and testable on its own;
 * 0b re-hosts the same components as tabs inside the help drawer.
 *
 * Every figure of authority is shown, not implied: an entry's tier, who drafted it, whether
 * a person or the AI wrote it, and who approved it. An entry the AI will cite has to be
 * traceable to the human who ratified it.
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

type Capabilities = { approve: boolean; publish: boolean };

export function KnowledgeWorkspace({ writeEnabled }: { writeEnabled: boolean }) {
  // The server check is authoritative; this only decides what to show, and hiding a control
  // someone cannot use is kinder than letting them press it and be refused.
  const approve = useEditAccess("knowledge.approve", writeEnabled);
  const publish = useEditAccess("knowledge.publish", writeEnabled);
  const capabilities = { approve: approve.state === "allowed", publish: publish.state === "allowed" };
  const [tab, setTab] = useState<"library" | "review">("library");
  const showReview = capabilities.approve || capabilities.publish;

  return <>
    <div className="nz-cw-vhead">
      <div><div className="eyebrow">Knowledge</div><h2>Knowledge library</h2></div>
    </div>
    <p className="nz-cw-vsub">
      NZI&rsquo;s shared knowledge — visible to everyone here whichever client you are working in.
      Approved entries ground the help assistant; public entries are the ones cleared to go in front of
      clients.
    </p>

    <div className="nz-toolbar">
      <button type="button" className={tab === "library" ? "nz-btn sm pri" : "nz-btn sm"} onClick={() => setTab("library")}>Library</button>
      {/* The queue is only a question for people who can answer it. */}
      {showReview ? <button type="button" className={tab === "review" ? "nz-btn sm pri" : "nz-btn sm"} onClick={() => setTab("review")}>Review</button> : null}
    </div>

    {tab === "library" ? <KnowledgeLibrary /> : <KnowledgeReview capabilities={capabilities} />}
  </>;
}

/* ── Library ─────────────────────────────────────────────────────────────────────────── */

export function KnowledgeLibrary() {
  const [entries, setEntries] = useState<KnowledgeEntry[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/isolated/knowledge", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { entries?: KnowledgeEntry[]; message?: string };
        if (!response.ok) throw new Error(body.message ?? "The library could not be loaded.");
        setEntries(body.entries ?? []);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "The library could not be loaded."));
  }, []);

  if (error) return <section className="nz-panel"><div className="nz-banner warn" role="alert">{error}</div></section>;
  if (entries === null) return <section className="nz-panel"><div className="nz-card-b"><p className="sub">Loading the library…</p></div></section>;

  const approved = entries.filter((entry) => entry.status !== "draft");
  const term = search.trim().toLowerCase();
  const shown = term === "" ? approved : approved.filter((entry) =>
    entry.canonicalQuestion.toLowerCase().includes(term)
    || entry.answer.toLowerCase().includes(term)
    || entry.aliases.some((alias) => alias.question.toLowerCase().includes(term)));

  return <section className="nz-panel">
    <div className="nz-card-h"><span className="eyebrow">Approved</span><h2>What we know</h2><span className="sp" />
      <input className="nz-inp" style={{ maxWidth: 260 }} value={search} placeholder="Search questions and answers"
        onChange={(event) => setSearch(event.target.value)} aria-label="Search the knowledge library" />
    </div>
    <div className="nz-card-b">
      {approved.length === 0
        ? <p className="sub" style={{ margin: "8px 0" }}>
          Nothing has been approved yet. Captured questions appear in the review queue first — an entry
          becomes part of the library once someone has approved it.
        </p>
        : shown.length === 0
          ? <p className="sub" style={{ margin: "8px 0" }}>No entry matches “{search.trim()}”.</p>
          : shown.map((entry) => <KnowledgeEntryCard key={entry.id} entry={entry} />)}
    </div>
  </section>;
}

function KnowledgeEntryCard({ entry }: { entry: KnowledgeEntry }) {
  return <Collapsible title={entry.canonicalQuestion} count={<StatusChip status={entry.status} />}>
    <p className="sub" style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>
      {entry.answer === "" ? "No answer has been written yet." : entry.answer}
    </p>
    {entry.aliases.length > 0 ? <div className="nz-know-aliases">
      <span className="l">Also asked as</span>
      <ul>{entry.aliases.map((alias) => <li key={alias.key}>{alias.question}</li>)}</ul>
    </div> : null}
    <Provenance entry={entry} />
  </Collapsible>;
}

/**
 * Who stands behind this entry.
 *
 * Shown rather than implied, and it names whether a person or the AI drafted it: an
 * AI-drafted answer is only citable because a named human approved it, and hiding that would
 * make the approval look decorative.
 */
function Provenance({ entry }: { entry: KnowledgeEntry }) {
  return <p className="nz-maps">
    {entry.draftedByKind === "ai" ? "Drafted by the assistant" : "Drafted"} by {entry.draftedBy}
    {entry.askedBy !== "" ? `, asked by ${entry.askedBy}` : ""}
    {entry.approvedBy !== null ? ` · approved by ${entry.approvedBy} on ${formatDate(entry.approvedAt!.slice(0, 10))}` : ""}
    {entry.publishedBy !== null ? ` · published by ${entry.publishedBy} on ${formatDate(entry.publishedAt!.slice(0, 10))}` : ""}
    {" · version "}{entry.version}
  </p>;
}

function StatusChip({ status }: { status: KnowledgeStatus }) {
  const tone = status === "public" ? "done" : status === "internal" ? "need" : "est";
  return <span className={`nz-st ${tone}`}>{knowledgeStatusLabels[status]}</span>;
}

/* ── Review ──────────────────────────────────────────────────────────────────────────── */

export function KnowledgeReview({ capabilities }: { capabilities: Capabilities }) {
  const [queue, setQueue] = useState<KnowledgeEntry[] | null>(null);
  const [internal, setInternal] = useState<KnowledgeEntry[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [drafts, approved] = await Promise.all([
        fetch("/api/isolated/knowledge?queue=1", { cache: "no-store" }).then((response) => response.json() as Promise<{ entries?: KnowledgeEntry[] }>),
        fetch("/api/isolated/knowledge?status=internal", { cache: "no-store" }).then((response) => response.json() as Promise<{ entries?: KnowledgeEntry[] }>),
      ]);
      setQueue(drafts.entries ?? []);
      setInternal(approved.entries ?? []);
    } catch {
      setError("The review queue could not be loaded.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <section className="nz-panel"><div className="nz-banner warn" role="alert">{error}</div></section>;
  if (queue === null) return <section className="nz-panel"><div className="nz-card-b"><p className="sub">Loading the queue…</p></div></section>;

  return <>
    {notice !== "" ? <div className="nz-banner" role="status">{notice}</div> : null}

    <section className="nz-panel">
      <div className="nz-card-h"><span className="eyebrow">Waiting</span><h2>Drafts to review</h2><span className="sp" />
        <span className="hint">{queue.length} waiting</span></div>
      <div className="nz-card-b">
        {queue.length === 0
          ? <p className="sub" style={{ margin: "8px 0" }}>Nothing is waiting. Captured questions land here for approval.</p>
          : queue.map((entry) => <ReviewRow key={entry.id} entry={entry} capabilities={capabilities}
            onDone={(text) => { setNotice(text); void load(); }} />)}
      </div>
    </section>

    <section className="nz-panel">
      <div className="nz-card-h"><span className="eyebrow">Internal</span><h2>Approved, not yet public</h2></div>
      <div className="nz-card-b">
        {internal.length === 0
          ? <p className="sub" style={{ margin: "8px 0" }}>Nothing is approved and awaiting publication.</p>
          : internal.map((entry) => <ReviewRow key={entry.id} entry={entry} capabilities={capabilities}
            onDone={(text) => { setNotice(text); void load(); }} />)}
      </div>
    </section>
  </>;
}

function ReviewRow({ entry, capabilities, onDone }: {
  entry: KnowledgeEntry; capabilities: Capabilities; onDone: (text: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  async function act(action: string, extra: Record<string, unknown> = {}, done = "") {
    setPending(action); setError(null);
    const result = await postBrowserCommand<{ status: string }>(
      `/api/isolated/knowledge/${encodeURIComponent(entry.id)}`,
      { action, expectedVersion: entry.version, ...extra }, crypto.randomUUID());
    setPending(null);
    if (result.state !== "success") {
      setError(result.state === "conflict"
        ? "Someone else changed this entry while you were reading it. Reload the queue to see where it got to."
        : errorText(result));
      return;
    }
    onDone(done);
  }

  const approveRefusal = transitionRefusal(entry.status, "approve");
  const publishRefusal = transitionRefusal(entry.status, "publish");

  return <div className="nz-know-row">
    <div className="hd">
      <b>{entry.canonicalQuestion}</b>
      <StatusChip status={entry.status} />
      {/* Surfaced at capture and carried here, so the approver sees what the asker saw. */}
      {entry.possibleDuplicate ? <span className="nz-st nof" title="Similar to something already in the library">Possible duplicate</span> : null}
      {entry.revisesEntryId !== null ? <span className="nz-st est">Revision</span> : null}
      {entry.draftedByKind === "ai" ? <span className="nz-st est">AI draft</span> : null}
    </div>
    <p className="sub" style={{ whiteSpace: "pre-wrap" }}>{entry.answer === "" ? "No answer written yet." : entry.answer}</p>
    <Provenance entry={entry} />

    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}

    {rejecting ? <div className="nz-know-reject">
      <label className="nz-fl"><span>Why is it being rejected?</span>
        <input className="nz-inp" value={reason} onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. already answered by the entry on assurance wording" /></label>
      <div className="nz-know-actions">
        <button type="button" className="nz-btn sm" onClick={() => setRejecting(false)}>Cancel</button>
        <GatedButton className="nz-btn sm danger" blocked={pending !== null || reason.trim() === ""}
          blockedReason={pending !== null ? "Working…" : reason.trim() === "" ? "Give a reason — it stays on the record." : undefined}
          reasonClassName="hint nz-gated-reason"
          onClick={() => void act("reject", { reason: reason.trim() }, `“${entry.canonicalQuestion}” rejected. It stays on the record.`)}>
          Confirm rejection
        </GatedButton>
      </div>
    </div> : <div className="nz-know-actions">
      <button type="button" className="nz-btn sm" onClick={() => setRejecting(true)}>Reject</button>
      {/* Each tier is its own capability. A Consultant approves; only an Admin publishes. */}
      <GatedButton className="nz-btn sm" blocked={!capabilities.approve || pending !== null || approveRefusal !== null}
        blockedReason={!capabilities.approve ? "You do not hold knowledge.approve." : pending !== null ? "Working…" : approveRefusal ?? undefined}
        reasonClassName="hint nz-gated-reason"
        onClick={() => void act("approve", {}, `“${entry.canonicalQuestion}” approved for internal use.`)}>
        {pending === "approve" ? "Approving…" : "Approve"}
      </GatedButton>
      <GatedButton className="nz-btn sm pri" blocked={!capabilities.publish || pending !== null || publishRefusal !== null}
        blockedReason={!capabilities.publish ? "Publishing to the client-facing tier is Admin-only." : pending !== null ? "Working…" : publishRefusal ?? undefined}
        reasonClassName="hint nz-gated-reason"
        onClick={() => void act("publish", {}, `“${entry.canonicalQuestion}” published.`)}>
        {pending === "publish" ? "Publishing…" : "Publish"}
      </GatedButton>
    </div>}
  </div>;
}
