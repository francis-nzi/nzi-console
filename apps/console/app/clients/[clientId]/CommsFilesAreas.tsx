"use client";

import Link from "next/link";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import { CardHead, Empty } from "./OverviewArea";

/**
 * Communications and Files (client workspace v10, phase 2).
 *
 * Both areas are deliberately narrower than their names suggest, and say so. This
 * platform records exactly one channel of client correspondence — the review thread on a
 * published report — and holds exactly two kinds of client file: the logo, and evidence
 * attached to a client factor. Showing an empty "inbox" or "documents" screen would imply
 * a store that exists and happens to be empty; neither does.
 */

export function CommsArea({ workspace }: { workspace: ClientWorkspaceReadModel }) {
  const { messages } = workspace;
  const threads = new Map<string, typeof messages>();
  for (const message of messages) {
    const key = message.reportVersionId;
    threads.set(key, [...(threads.get(key) ?? []), message]);
  }

  return <>
    <div className="nz-cw-vhead"><div><div className="eyebrow">Relationship</div><h2>Communications</h2></div><span style={{ flex: 1 }} />
      <span className="sub">{messages.length === 0 ? "Nothing recorded" : `${messages.length} message${messages.length === 1 ? "" : "s"} · ${threads.size} thread${threads.size === 1 ? "" : "s"}`}</span></div>
    <p className="nz-cw-vsub">The correspondence this platform records: the review conversation between your team and the client on each published report.</p>

    <section className="nz-panel">
      <CardHead eyebrow="Report review" title="Review threads" />
      {messages.length === 0
        ? <Empty text="No review message has been exchanged with this client. Threads appear here once a report is published to the portal and someone comments on it." />
        : <div style={{ padding: "6px 16px 12px" }}>
          {[...threads.entries()].map(([reportVersionId, thread]) => <div key={reportVersionId} style={{ marginBottom: 14 }}>
            <div className="nz-kv"><span className="k"><Link className="nz-table-link" href={`/reports/${encodeURIComponent(reportVersionId)}`}>{thread[0]!.jobNumber} · report review</Link></span>
              <span className="v muted">{thread.length} message{thread.length === 1 ? "" : "s"}</span></div>
            {thread.map((message) => <div key={message.commentId} className="nz-kv" style={{ alignItems: "flex-start" }}>
              <span className="k">{message.author}<span className="hint">{message.authorPrincipal === "portal" ? "Client" : "NZI"} · {formatDate(message.at)}</span></span>
              <span className="v" style={{ fontWeight: 400, textAlign: "left" }}>{message.body}</span>
            </div>)}
          </div>)}
        </div>}
      <div className="nz-card-b">
        <p className="nz-maps">Email and calls are not recorded by this platform, so they are not shown here. Replies are sent from the report review inbox, where the thread keeps its report context.</p>
        <Link className="nz-btn" href="/reports">Open the review inbox</Link>
      </div>
    </section>
  </>;
}

export function FilesArea({ workspace }: { workspace: ClientWorkspaceReadModel }) {
  const { files } = workspace;
  const size = (bytes: number | null) => bytes === null ? "—" : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  return <>
    <div className="nz-cw-vhead"><div><div className="eyebrow">Record</div><h2>Files</h2></div><span style={{ flex: 1 }} />
      <span className="sub">{files.length === 0 ? "No files" : `${files.length} file${files.length === 1 ? "" : "s"}`}</span></div>
    <p className="nz-cw-vsub">The files held against this client. There is no general document store yet — what is here is the client logo and the evidence attached to client factors.</p>

    <section className="nz-panel">
      <CardHead eyebrow="Held" title="Client files" />
      {files.length === 0
        ? <Empty text="No file is held for this client. A logo uploaded on the identity drawer, or evidence attached to a client factor, appears here." />
        : <table className="nz-tbl">
          <thead><tr><th>File</th><th>Kind</th><th>Where it is</th><th className="num">Size</th><th>Recorded</th><th /></tr></thead>
          <tbody>
            {files.map((file) => <tr key={`${file.kind}-${file.id}`}>
              <td><b>{file.name}</b><div className="muted">{file.context}</div></td>
              <td><span className="nz-st est">{file.kind === "logo" ? "Logo" : "Factor evidence"}</span></td>
              <td>{file.storage === "console" ? "This platform" : file.storage === "external" ? "External provider" : <span className="muted">Not recorded</span>}</td>
              <td className="num">{size(file.byteSize)}</td>
              <td className="num">{formatDate(file.at)}</td>
              <td style={{ textAlign: "right" }}>{file.href
                ? <a className="nz-table-link" href={file.href} target={file.storage === "external" ? "_blank" : undefined} rel="noreferrer">Open →</a>
                : <span className="muted">No link</span>}</td>
            </tr>)}
          </tbody>
        </table>}
      <div className="nz-card-b">
        <p className="nz-maps">Factor evidence is held by whichever provider recorded it — this platform keeps the reference and its hash, not the bytes. A general client document store is not built.</p>
      </div>
    </section>
  </>;
}
