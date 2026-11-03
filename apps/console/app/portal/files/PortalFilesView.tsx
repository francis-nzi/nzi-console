"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Drawer } from "@nzi/ui";
import { postBrowserCommand } from "@nzi/api-client";
import { PORTAL_FILE_CATEGORIES, PORTAL_FILE_CATEGORY_LABELS, PORTAL_FILE_FLAG_LABELS, type PortalFileCategory, type PortalFileHistoryEntry, type PortalFileRecord } from "@nzi/contracts";
import { formatDate, formatDateTime } from "../../lib/formatDate";
import { useOrganisationName } from "../../lib/OrganisationNameProvider";
import { isPortalJobList, type PortalJob } from "../portalPortfolioValidation";
import {
  canDownload, CATEGORY_FILTERS, fileSize, filterByCategory, groupFiles, HISTORY_ACTION_LABEL, historyWho, isPortalFileHistory, isPortalFileList,
  scanLabel, unavailableNote, type CategoryFilter,
} from "./portalFilesModel";

/**
 * Files (RULING-portal-files-client-ui): the client's documents, both ways - the mockup's dropzone and documents table, grouped by direction
 * ("From you" / "From NZI") and job. Every action is an existing audited command: an upload names a job the client holds and a category;
 * a download asks for one signed, time-limited link per click (no storage id or URL is ever drawn); the History drawer is a read.
 * What the client may see is the server's decision (`listPortalFiles`); a held, refused or withdrawn file has no download control.
 */
type Load<T> = { state: "loading" } | { state: "failed" } | { state: "ready"; value: T };
type Notice = { tone: "ok" | "warn"; text: string };

export function PortalFilesView() {
  const org = useOrganisationName();
  const [files, setFiles] = useState<Load<PortalFileRecord[]>>({ state: "loading" });
  const [jobs, setJobs] = useState<Load<PortalJob[]>>({ state: "loading" });
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [uploadJob, setUploadJob] = useState("");
  const [uploadCategory, setUploadCategory] = useState<PortalFileCategory>("data_evidence");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<{ file: PortalFileRecord; load: Load<PortalFileHistoryEntry[]> } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/portal/files", { cache: "no-store", credentials: "same-origin" });
      const body = response.ok ? await response.json().catch(() => null) as { files?: unknown } | null : null;
      setFiles(body && isPortalFileList(body.files) ? { state: "ready", value: body.files } : { state: "failed" });
    } catch { setFiles({ state: "failed" }); }
  }, []);
  useEffect(() => {
    void refresh();
    void (async () => {
      try {
        const response = await fetch("/api/portal/jobs", { cache: "no-store", credentials: "same-origin" });
        const body = response.ok ? await response.json().catch(() => null) as { jobs?: unknown } | null : null;
        setJobs(body && isPortalJobList(body.jobs) ? { state: "ready", value: body.jobs } : { state: "failed" });
      } catch { setJobs({ state: "failed" }); }
    })();
  }, [refresh]);
  useEffect(() => { if (jobs.state === "ready" && !uploadJob && jobs.value.length === 1) setUploadJob(jobs.value[0]!.id); }, [jobs, uploadJob]);

  const jobTitle = (jobId: string) => {
    const job = jobs.state === "ready" ? jobs.value.find((candidate) => candidate.id === jobId) : undefined;
    return job ? `${job.number} · ${job.title}` : "Another job";
  };

  async function upload(selected: FileList | File[]) {
    const list = [...selected];
    if (list.length === 0) return;
    if (!uploadJob) { setNotice({ tone: "warn", text: "Choose the job these files are for first." }); return; }
    setBusy("upload"); setNotice(null);
    const results: Notice[] = [];
    for (const file of list) {
      const form = new FormData();
      form.set("file", file); form.set("jobId", uploadJob); form.set("category", uploadCategory);
      try {
        const response = await fetch("/api/portal/files", { method: "POST", body: form, credentials: "same-origin", headers: { "idempotency-key": crypto.randomUUID() } });
        const body = await response.json().catch(() => ({})) as { data?: { status?: string; flag?: keyof typeof PORTAL_FILE_FLAG_LABELS | null }; message?: string };
        if (response.ok && body.data) {
          const { status, flag } = body.data;
          results.push(status === "released" ? { tone: "ok", text: `${file.name} was checked and shared with your adviser.` }
            : status === "quarantined" ? { tone: "warn", text: `${file.name} is being checked. You can see it below; it can't be downloaded until it has passed.` }
            : { tone: "warn", text: `${file.name} was quarantined: ${flag ? PORTAL_FILE_FLAG_LABELS[flag] : "it did not pass the checks"}. It was not shared.` });
        } else results.push({ tone: "warn", text: `${file.name}: ${body.message ?? "it could not be uploaded."}` });
      } catch { results.push({ tone: "warn", text: `${file.name}: it could not be uploaded.` }); }
    }
    setBusy(null);
    setNotice({ tone: results.every((result) => result.tone === "ok") ? "ok" : "warn", text: results.map((result) => result.text).join(" ") });
    await refresh();
  }

  async function download(file: PortalFileRecord) {
    setBusy(file.fileId); setNotice(null);
    // One signed, time-limited link per click (portal.file.download), opened and forgotten: it is never drawn, stored or logged here.
    const result = await postBrowserCommand<{ url: string }>(`/api/portal/files/${encodeURIComponent(file.fileId)}/download`, {}, crypto.randomUUID());
    setBusy(null);
    if (result.state === "success") window.open(result.data.url, "_blank", "noopener");
    else setNotice({ tone: "warn", text: result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message });
  }

  async function openHistory(file: PortalFileRecord) {
    setHistory({ file, load: { state: "loading" } });
    try {
      const response = await fetch(`/api/portal/files/${encodeURIComponent(file.fileId)}/history`, { cache: "no-store", credentials: "same-origin" });
      const body = response.ok ? await response.json().catch(() => null) as { history?: unknown } | null : null;
      setHistory({ file, load: body && isPortalFileHistory(body.history) ? { state: "ready", value: body.history } : { state: "failed" } });
    } catch { setHistory({ file, load: { state: "failed" } }); }
  }

  const visible = files.state === "ready" ? filterByCategory(files.value, filter) : [];
  const groups = groupFiles(visible, jobTitle, org.short);

  return (
    <div className="nzp-metrics nzp-files">
      <header className="nz-pd-top">
        <div>
          <span className="nz-eyebrow">Documents</span>
          <h1 className="nz-pd-client">Files</h1>
          <p className="nz-pd-meta">Upload, share and audit every document — both ways</p>
        </div>
      </header>
      {notice ? <div className={`nzp-files-notice ${notice.tone}`} role={notice.tone === "ok" ? "status" : "alert"}>{notice.text}</div> : null}

      <div className={`nzp-dropzone${dragging ? " on" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); if (busy === null) void upload(event.dataTransfer.files); }}>
        <b>Drag files here, or browse</b>
        <span>PDF, Excel, Word, images · every upload virus-scanned before anyone can open it</span>
        <span className="nzp-dropzone-pick">
          <label>Job
            <select className="nz-sel" value={uploadJob} onChange={(event) => setUploadJob(event.target.value)} disabled={jobs.state !== "ready"}>
              <option value="">{jobs.state === "ready" ? "Choose a job…" : jobs.state === "failed" ? "Jobs could not be loaded" : "Loading jobs…"}</option>
              {jobs.state === "ready" ? jobs.value.map((job) => <option key={job.id} value={job.id}>{job.number} · {job.title}</option>) : null}
            </select></label>
          <label>Category
            <select className="nz-sel" value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value as PortalFileCategory)}>
              {PORTAL_FILE_CATEGORIES.map((value) => <option key={value} value={value}>{PORTAL_FILE_CATEGORY_LABELS[value]}</option>)}
            </select></label>
        </span>
        <label className="nz-btn pri" aria-disabled={busy !== null || !uploadJob || undefined}>{busy === "upload" ? "Uploading…" : "Choose files"}
          <input type="file" multiple hidden disabled={busy !== null || !uploadJob} aria-label="Choose files to upload"
            onChange={(event) => { if (event.target.files) void upload(event.target.files); event.target.value = ""; }} /></label>
      </div>

      <div className="nzp-files-filter" role="group" aria-label="Filter by category">
        {CATEGORY_FILTERS.map((option) => <button key={option.value} type="button" className={`nzp-chip${filter === option.value ? " on" : ""}`} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>)}
      </div>

      {files.state === "loading" ? <p className="nz-pd-meta" role="status">Loading your documents…</p> : null}
      {files.state === "failed" ? <div className="nzp-files-notice warn" role="alert">Your documents could not be loaded, so none are shown rather than a list that might be wrong. <button type="button" className="nz-btn" onClick={() => { setFiles({ state: "loading" }); void refresh(); }}>Try again</button></div> : null}
      {files.state === "ready" && files.value.length === 0 ? <p className="nz-pd-meta">No documents yet. Drop a file above, or your adviser will share documents here.</p> : null}
      {files.state === "ready" && files.value.length > 0 && groups.length === 0 ? <p className="nz-pd-meta">No documents in this category.</p> : null}

      {groups.map((group) => (
        <section key={group.key} className="nzp-metric-card" aria-label={group.heading}>
          <div className="nzp-metric-h"><h3>{group.heading}</h3></div>
          {group.jobs.map((job) => (
            <div key={job.jobId ?? "all"} className="nzp-files-job">
              <h4>{job.heading}</h4>
              <div className="nzp-tablewrap"><table className="nz-tbl">
                <thead><tr><th>Name</th><th>Category</th><th>By</th><th>Scan</th><th>Added</th><th><span className="nz-sr">Actions</span></th></tr></thead>
                <tbody>
                  {job.files.map((file) => {
                    const scan = scanLabel(file), note = unavailableNote(file, org.short);
                    return (
                      <tr key={file.fileId} className={file.status === "deactivated" ? "nzp-files-gone" : undefined}>
                        <td><b>{file.fileName}</b> <span className="nz-hint">{fileSize(file.sizeBytes)}</span>{note ? <div className="nz-hint">{note}</div> : null}</td>
                        <td>{PORTAL_FILE_CATEGORY_LABELS[file.category]}</td>
                        <td>{file.uploadedByPrincipal === "staff" ? org.Short : file.uploadedBy}</td>
                        <td>{scan ? <span className={`nzp-scan ${scan.toLowerCase()}`}>{scan}</span> : <span aria-hidden="true">—</span>}</td>
                        <td>{formatDate(file.uploadedAt)}</td>
                        <td className="nzp-files-actions">
                          {canDownload(file) ? <button type="button" className="nz-btn sm" disabled={busy !== null} onClick={() => void download(file)}>Download</button> : null}
                          <button type="button" className="nz-btn sm" onClick={() => void openHistory(file)}>History</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            </div>
          ))}
        </section>
      ))}

      <Drawer open={history !== null} onClose={() => setHistory(null)} ariaLabel={history ? `History of ${history.file.fileName}` : "History"} className="nzp-files-drawer" dismissOnOutsideClick>
        {history ? (
          <div className="nzp-files-history">
            <h2>History</h2>
            <p className="nz-pd-meta">{history.file.fileName}</p>
            {history.file.status === "deactivated" ? <p className="nzp-files-withdrawn" role="note">{unavailableNote(history.file, org.short)}</p> : null}
            {history.load.state === "loading" ? <p role="status">Loading…</p> : null}
            {history.load.state === "failed" ? <p role="alert">The history could not be loaded.</p> : null}
            {history.load.state === "ready" && history.load.value.length === 0 ? <p>Nothing has been recorded for this file yet.</p> : null}
            {history.load.state === "ready" && history.load.value.length > 0 ? (
              <ol className="nzp-files-timeline">
                {history.load.value.map((entry, index) => (
                  <li key={`${entry.at}-${entry.action}-${index}`}>
                    <b>{HISTORY_ACTION_LABEL[entry.action]}</b>{entry.detail ? <> — {entry.detail}</> : null}
                    <div className="nz-hint">{historyWho(entry.who, org.Short)} · {formatDateTime(entry.at)}</div>
                  </li>
                ))}
              </ol>
            ) : null}
            <button type="button" className="nz-btn" onClick={() => setHistory(null)}>Close</button>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
