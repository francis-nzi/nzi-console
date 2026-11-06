"use client";

import React, { useEffect, useState } from "react";
import { formatDateTime } from "../../../lib/formatDate";
import { editHeadline, historyText } from "./editHistory";

type Edit = { editId: string; seq: number; actorId: string; actorName: string | null; principal: "staff" | "portal"; sectionKey: string; action: "edit" | "amend" | "restore"; beforeHtml: string; afterHtml: string; at: string };

/**
 * The version's edit trail, oldest first, so the history is visible and not only stored (S3). Read once, per version; `refresh` re-reads
 * after an amend. A read that fails says so - an empty trail is never shown for a failed read.
 */
export function ReportEditHistory({ reportVersionId, refresh }: { reportVersionId: string; refresh?: number }) {
  const [edits, setEdits] = useState<Edit[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch(`/api/isolated/report-versions/${encodeURIComponent(reportVersionId)}/edits`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => response.ok ? (await response.json() as { edits: Edit[] }).edits : null)
      .catch(() => null)
      .then((value) => { if (live) setEdits(value); });
    return () => { live = false; };
  }, [reportVersionId, refresh]);
  return <details className="nzs-edit-history" data-report-edit-history style={{ margin: "8px 16px 0" }}>
    <summary>Edit history{Array.isArray(edits) ? ` (${edits.length})` : ""}</summary>
    {edits === undefined ? <p className="muted">Loading the edit history…</p>
      : edits === null ? <p className="muted" role="alert">The edit history could not be read.</p>
      : edits.length === 0 ? <p className="muted">No edits have been made to this version.</p>
      : <ol>
        {edits.map((edit) => <li key={edit.editId} data-edit-seq={edit.seq}>
          <b>{editHeadline(edit)}</b> <span className="muted">{formatDateTime(edit.at)}</span>
          <div><span className="muted">Before:</span> {historyText(edit.beforeHtml)}</div>
          <div><span className="muted">After:</span> {historyText(edit.afterHtml)}</div>
        </li>)}
      </ol>}
  </details>;
}
