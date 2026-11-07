"use client";

import React, { useEffect, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { staffMayEditNarrative, type ReportComposition } from "@nzi/contracts";
import { formatDateTime } from "../../../lib/formatDate";
import { ReportComposedView } from "../../../reports/[versionId]/ReportComposedView";
import { chainLabel, restoredMessage, RESTORE_NOTE } from "./versionChain";

type Entry = { reportVersionId: string; revision: number; status: string; version: number; createdAt: string; publishedAt: string | null; current: boolean; restorable: boolean };
/** Logos load through the published-report routes, which do not serve a prior round - the preview shows the words and figures, not the artwork. */
const NO_LOGO = () => "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/**
 * The version chain (client-review loop S7): this job and scope's rounds, oldest first, a read-only look at an earlier one, and - while this
 * round can still be amended - a way to bring an earlier round's WORDS back into it. Figures and the section plan never move. A read that fails
 * says so; a single version has no history to show, so nothing is drawn.
 */
export function ReportVersionChain({ reportVersionId, refresh }: { reportVersionId: string; refresh?: number }) {
  const [chain, setChain] = useState<Entry[] | null | undefined>(undefined);
  const [previewing, setPreviewing] = useState<{ id: string; composition: ReportComposition | null } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "problem"; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/isolated/report-versions/${encodeURIComponent(reportVersionId)}/chain`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => response.ok ? (await response.json() as { chain: Entry[] }).chain : null)
      .catch(() => null)
      .then((value) => { if (live) setChain(value); });
    return () => { live = false; };
  }, [reportVersionId, refresh]);

  if (chain === undefined || (Array.isArray(chain) && chain.length < 2)) return null;
  if (chain === null) return <p className="muted" role="alert" style={{ margin: "8px 16px 0" }}>The version history could not be read.</p>;
  const current = chain.find((entry) => entry.current)!;
  const canRestore = staffMayEditNarrative(current.status);

  async function preview(id: string) {
    if (previewing?.id === id) { setPreviewing(null); return; }
    setPreviewing({ id, composition: null });
    const response = await fetch(`/api/isolated/report-versions/${encodeURIComponent(reportVersionId)}/chain/${encodeURIComponent(id)}`, { cache: "no-store", credentials: "same-origin" }).catch(() => null);
    const body = response?.ok ? await response.json() as { composition: ReportComposition } : null;
    setPreviewing(body ? { id, composition: body.composition } : null);
    if (!body) setMessage({ tone: "problem", text: "That version could not be opened." });
  }

  async function restore(id: string) {
    if (busy) return;
    setBusy(true); setMessage(null);
    const result = await postBrowserCommand<{ changedSections: string[]; fromRevision: number }>("/api/isolated/reports/restore", { reportVersionId, fromReportVersionId: id, expectedVersion: current.version }, crypto.randomUUID());
    setBusy(false); setConfirming(null);
    if (result.state === "success") {
      setMessage({ tone: "ok", text: restoredMessage(result.data?.changedSections ?? [], result.data?.fromRevision ?? 0) });
      if ((result.data?.changedSections ?? []).length > 0) setTimeout(() => window.location.reload(), 1200);
    } else setMessage({ tone: "problem", text: result.state === "conflict" ? "This report changed since you opened it. Reload to see the latest, then try again." : result.state === "validation_failed" ? result.issues?.map((issue) => issue.message).join(" ") || result.message || "Nothing was restored." : result.message || "Nothing was restored." });
  }

  return <details className="nzs-edit-history" data-report-version-chain style={{ margin: "8px 16px 0" }}>
    <summary>Version history ({chain.length})</summary>
    {message ? <p className={message.tone === "ok" ? "muted" : "nzs-narr-note"} role={message.tone === "ok" ? "status" : "alert"} data-version-chain-message>{message.text}</p> : null}
    <ol>
      {chain.map((entry) => <li key={entry.reportVersionId} data-chain-revision={entry.revision}>
        <b>{chainLabel(entry)}</b> <span className="muted">{formatDateTime(entry.publishedAt ?? entry.createdAt)}</span>
        {entry.restorable ? <>
          {" "}<button type="button" className="nz-btn" onClick={() => void preview(entry.reportVersionId)}>{previewing?.id === entry.reportVersionId ? "Close preview" : "Preview"}</button>
          {canRestore ? <>{" "}<button type="button" className="nz-btn" data-version-restore disabled={busy || confirming !== null} onClick={() => setConfirming(entry.reportVersionId)}>Restore wording</button></> : null}
        </> : null}
        {confirming === entry.reportVersionId ? <div className="nz-hint" role="alertdialog" aria-label="Restore wording" data-version-restore-note>
          <p>{RESTORE_NOTE(entry.revision)}</p>
          <button type="button" className="nz-btn pri" data-version-restore-confirm disabled={busy} onClick={() => void restore(entry.reportVersionId)}>{busy ? "Restoring…" : "Restore"}</button>
          <button type="button" className="nz-btn" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
        </div> : null}
        {previewing?.id === entry.reportVersionId ? (previewing.composition
          ? <div data-version-preview style={{ maxHeight: 520, overflow: "auto", border: "1px solid var(--line2)", marginTop: 6 }}><ReportComposedView composition={previewing.composition} issuerLogoSrc={NO_LOGO} clientLogoSrc={NO_LOGO} preview mode="flow" /></div>
          : <p className="muted" role="status">Opening that version…</p>) : null}
      </li>)}
    </ol>
  </details>;
}
