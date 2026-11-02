"use client";

import { useCallback, useEffect, useState } from "react";
import { postBrowserCommand, postBrowserCommandWithReason } from "@nzi/api-client";
import type { PortalFileRecord } from "@nzi/contracts";
import { formatDateTime } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * Portal Management → Files (BRIEF-portal-files-secure-upload-storage): everything shared with this client in both directions — NZI's
 * deliverables and the client's own uploads — with what the gate decided about each. A held file is not downloadable by anyone; a
 * withdrawn one is kept, with its reason. Every action here is an audited command, and a download is a signed, time-limited link
 * issued per click. The bytes and storage identifiers never reach this component.
 */
const STATUS_LABEL: Record<PortalFileRecord["status"], string> = { quarantined: "Held — being checked", released: "Available", rejected: "Refused", deactivated: "Withdrawn" };
const FLAG_LABEL: Record<string, string> = {
  infected: "A virus was found", oversize: "Too large", type_not_allowed: "File type not accepted", executable: "Contains something executable", macro: "Contains macros",
  empty: "Empty", scan_inconclusive: "The check has not finished", scan_failed: "The check could not be completed",
};
const size = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function PortalFilesPanel({ clientId, access }: { clientId: string; access: EditAccess }) {
  const base = `/api/isolated/clients/${encodeURIComponent(clientId)}/files`;
  const [files, setFiles] = useState<PortalFileRecord[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const allowed = access.state === "allowed";

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(base, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) { setState("failed"); return; }
      const body = await response.json() as { files?: PortalFileRecord[] };
      if (!Array.isArray(body.files)) { setState("failed"); return; }
      setFiles(body.files); setState("ready");
    } catch { setState("failed"); }
  }, [base]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function upload(file: File) {
    setBusy("upload"); setMessage(null);
    const form = new FormData();
    form.set("file", file);
    try {
      const response = await fetch(base, { method: "POST", body: form, credentials: "same-origin", headers: { "idempotency-key": crypto.randomUUID() } });
      const body = await response.json().catch(() => ({})) as { data?: { status?: string; flag?: string | null }; message?: string };
      if (response.ok && body.data) {
        const { status, flag } = body.data;
        setMessage(status === "released" ? { tone: "ok", text: `${file.name} is shared with the client.` }
          : status === "quarantined" ? { tone: "warn", text: `${file.name} is held until its check finishes; it can't be downloaded yet.` }
          : { tone: "warn", text: `${file.name} was refused: ${FLAG_LABEL[flag ?? ""] ?? "it did not pass the checks"}.` });
        await refresh();
      } else setMessage({ tone: "warn", text: body.message ?? "The file could not be shared." });
    } catch { setMessage({ tone: "warn", text: "The file could not be shared." }); }
    setBusy(null);
  }

  async function download(file: PortalFileRecord) {
    setBusy(file.fileId); setMessage(null);
    const result = await postBrowserCommand<{ url: string }>(`${base}/${encodeURIComponent(file.fileId)}/download`, {}, crypto.randomUUID());
    setBusy(null);
    if (result.state === "success") window.open(result.data.url, "_blank", "noopener");
    else setMessage({ tone: "warn", text: result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message });
  }

  async function rescan(file: PortalFileRecord) {
    setBusy(file.fileId); setMessage(null);
    const result = await postBrowserCommand<{ status: string }>(`${base}/${encodeURIComponent(file.fileId)}/rescan`, {}, crypto.randomUUID());
    setBusy(null);
    if (result.state === "success") { setMessage({ tone: result.data.status === "released" ? "ok" : "warn", text: result.data.status === "released" ? `${file.fileName} passed and is now available.` : `${file.fileName} is ${result.data.status === "rejected" ? "refused" : "still held"}.` }); await refresh(); }
    else setMessage({ tone: "warn", text: result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message });
  }

  async function withdraw(file: PortalFileRecord) {
    if (!reason.trim()) return;
    setBusy(file.fileId); setMessage(null);
    const result = await postBrowserCommandWithReason(`${base}/${encodeURIComponent(file.fileId)}/deactivate`, {}, crypto.randomUUID(), reason.trim());
    setBusy(null);
    if (result.state === "success") { setWithdrawing(null); setReason(""); setMessage({ tone: "ok", text: `${file.fileName} is withdrawn. The record is kept.` }); await refresh(); }
    else setMessage({ tone: "warn", text: result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message });
  }

  return <section className="nz-panel nz-pm" aria-labelledby="pm-files">
    <div className="nz-card-h"><span className="eyebrow">Manage</span><h2 id="pm-files">Files</h2></div>
    <div className="nz-card-b">
      <p className="sub">Documents shared with this client, and the client&apos;s own uploads. Every file is held until it has been checked; nothing held, refused or withdrawn can be downloaded. Downloads are signed, short-lived links, and each one is recorded.</p>
      {message ? <div className={`nz-banner ${message.tone}`} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</div> : null}
      <div className="nz-config-actions">
        <label className="nz-btn" aria-disabled={!allowed || busy !== null || undefined}>{busy === "upload" ? "Sharing…" : "Share a file with the client"}
          <input type="file" hidden disabled={!allowed || busy !== null} aria-label="Share a file with the client"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} /></label>
      </div>
      {!allowed ? <p className="sub" role="status">{access.state === "checking" ? "Checking your permissions…" : `You can see these files but not change them: ${access.reason}`}</p> : null}
      {state === "loading" ? <p className="sub" role="status">Loading this client&apos;s files…</p> : null}
      {state === "failed" ? <div className="nz-banner warn" role="alert">The files could not be loaded. Nothing is shown rather than a list that might be wrong. <button type="button" className="nz-btn sm" onClick={() => { setState("loading"); void refresh(); }}>Try again</button></div> : null}
      {state === "ready" && files?.length === 0 ? <p className="sub">No files have been shared in either direction yet.</p> : null}
      {state === "ready" && files?.length ? <div style={{ overflowX: "auto" }}>
        <table className="nz-tbl">
          <thead><tr><th>File</th><th>Direction</th><th>Status</th><th className="num">Size</th><th>Added</th><th /></tr></thead>
          <tbody>{files.map((file) => <tr key={file.fileId}>
            <td><b>{file.fileName}</b><div className="nz-hint" title={file.sha256}>SHA-256 {file.sha256.slice(0, 12)}…</div></td>
            <td>{file.direction === "deliverable" ? "NZI → client" : "Client → NZI"}</td>
            <td><span className={`nz-st ${file.status === "released" ? "done" : file.status === "quarantined" ? "need" : "nof"}`}>{STATUS_LABEL[file.status]}</span>
              {file.flag ? <div className="nz-hint">{FLAG_LABEL[file.flag] ?? file.flag}</div> : null}</td>
            <td className="num">{size(file.sizeBytes)}</td>
            <td>{formatDateTime(file.uploadedAt)}</td>
            <td>{withdrawing === file.fileId ? <span className="nz-config-actions">
              <input className="nz-in" aria-label={`Reason for withdrawing ${file.fileName}`} placeholder="Reason" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
              <button type="button" className="nz-btn sm" disabled={!reason.trim() || busy !== null} onClick={() => void withdraw(file)}>Withdraw</button>
              <button type="button" className="nz-btn sm" onClick={() => { setWithdrawing(null); setReason(""); }}>Cancel</button></span>
              : <span className="nz-config-actions">
                {file.status === "released" ? <button type="button" className="nz-btn sm" disabled={!allowed || busy !== null} onClick={() => void download(file)}>Download</button> : null}
                {file.status === "quarantined" ? <button type="button" className="nz-btn sm" disabled={!allowed || busy !== null} onClick={() => void rescan(file)}>Check again</button> : null}
                {file.status !== "deactivated" ? <button type="button" className="nz-btn sm" disabled={!allowed || busy !== null} onClick={() => { setWithdrawing(file.fileId); setReason(""); }}>Withdraw</button> : null}
              </span>}</td>
          </tr>)}</tbody>
        </table>
      </div> : null}
    </div>
  </section>;
}
