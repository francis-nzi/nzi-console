"use client";
// Data entry D3 (R6): the client's open requests to reopen a reviewed entry, on the job for the CRM — which entry, why, who asked
// and when. The CRM reopens by editing the entry (it returns to pending), which marks the request reopened; nothing here acts.
import { useEffect, useState } from "react";
import type { OpenReopenRequest } from "@nzi/isolated-backend";
import { formatDate } from "../lib/formatDate";

export function ReopenRequestsBanner({ jobId, refreshKey, onOpenRow }: { jobId: string; refreshKey?: unknown; onOpenRow: (rowId: string) => void }) {
  const [requests, setRequests] = useState<OpenReopenRequest[] | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(`/api/isolated/jobs/${jobId}/reopen-requests`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body: { requests?: OpenReopenRequest[] }) => { if (live) setRequests(Array.isArray(body.requests) ? body.requests : []); })
      .catch(() => { if (live) setRequests(null); });
    return () => { live = false; };
  }, [jobId, refreshKey]);
  if (!requests?.length) return null;
  return <section className="nz-banner warn nz-reopen-requests" role="status" aria-label="Requests to reopen entries">
    <div>
      <b>{requests.length === 1 ? "The client has asked to reopen an entry" : `The client has asked to reopen ${requests.length} entries`}</b>
      <span className="muted"> · edit the entry to reopen it — it returns to pending, and the request is marked done</span>
      <ul>{requests.map((request) => <li key={request.requestId}>
        <button type="button" className="lnk" onClick={() => onOpenRow(request.rowId)}>{request.rowLabel}</button>
        {" — "}&ldquo;{request.reason}&rdquo; <span className="muted">· {request.requestedBy}, {formatDate(request.requestedAt.slice(0, 10))}{request.notified ? "" : " · no email sent (no adviser with an email on the job)"}</span>
      </li>)}</ul>
    </div>
  </section>;
}
