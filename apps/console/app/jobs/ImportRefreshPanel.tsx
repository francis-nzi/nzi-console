"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import type { V7ImportRefreshCommitted, V7ImportRefreshPreview } from "@nzi/contracts";
import type { V7ImportMapping, V7ImportMappingRow } from "@nzi/isolated-backend";
import { ImportResolution } from "../admin/import/ImportResolution";
import { ImportMappingView } from "./importMappingView";
import { FastPathRefreshedView, ImportRefreshPreviewView, notAutomaticLine, refreshViewOf, type FastPathOutcome, type ImportRefreshState } from "./importRefreshView";

/**
 * "Refresh from the previous system" on a job imported from it (BRIEF-v7-import-server-side-phase-c §3; `import.refresh`).
 *
 *   0. Refresh is one action (Phase D, R-4): a job with no issued report, no manual edits and nothing flagged is refreshed there
 *      and then — "Refreshed automatically", Σ per scope and the audit id. Any other job goes on to 1–3, with why in one line.
 *   1. Refresh → a preview: the whole chain rolled back, nothing written. It shows Σ per scope and the exceptions only.
 *   2. Exceptions are resolved with the Phase 2 controls, in Import reconciliation: a resolver (import.manage) stores the summary
 *      as the previous system gives it now, and works the rows there; then previews again here.
 *   3. Commit, on a preview that would commit: a reason, and the two fingerprints the preview showed — the command refuses if the
 *      job or its decisions moved since. Admin-only when the organisation's import policy says so; otherwise the CRM commits.
 *
 * Nothing shows for a job of another origin, or for someone who may not refresh.
 */
type Load = { state: "loading" } | { state: "hidden" } | { state: "failed" } | { state: "ready"; value: Extract<ImportRefreshState, { applies: true }> };

const failureText = (result: BrowserCommandResult<unknown>) => result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") || result.message
  : result.state === "success" ? "" : result.message;

export function ImportRefreshPanel({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [preview, setPreview] = useState<V7ImportRefreshPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<V7ImportRefreshCommitted | null>(null);
  const [auto, setAuto] = useState<Extract<FastPathOutcome, { fastPath: "refreshed" }> | null>(null);
  const [notAutomatic, setNotAutomatic] = useState<string | null>(null);
  const commitKey = useRef<string | null>(null);
  const [mapping, setMapping] = useState<V7ImportMapping | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [mappingError, setMappingError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/isolated/jobs/${encodeURIComponent(jobId)}/import-refresh`, { cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401 || response.status === 403) return setLoad({ state: "hidden" });
        if (!response.ok) return setLoad({ state: "failed" });
        const value = await response.json() as ImportRefreshState;
        setLoad(value.applies ? { state: "ready", value } : { state: "hidden" });
      })
      .catch(() => { if (live) setLoad({ state: "failed" }); });
    return () => { live = false; };
  }, [jobId]);

  if (load.state === "hidden" || load.state === "loading") return null;
  if (load.state === "failed") {
    return <section className="nz-body nz-milestones-body"><div className="nz-panel nz-milestones"><div className="nz-banner warn" role="alert"><div>Whether this job can be refreshed from the previous system could not be read just now.</div></div></div></section>;
  }
  const state = load.value;
  const path = `/api/isolated/jobs/${encodeURIComponent(state.jobId)}/import-refresh`;

  async function runPreview() {
    if (busy) return;
    setBusy(true); setError(null); setDone(null); setAuto(null); setNotAutomatic(null);
    try {
      // One action (Phase D): an eligible job is refreshed there and then; any other comes back as a preview, and why. Each is
      // a new attempt with its own key: a preview writes nothing, and an automatic commit is refused if the job moved.
      const result = await postBrowserCommand<FastPathOutcome>(path, { mode: "auto" }, crypto.randomUUID());
      if (result.state !== "success") { setPreview(null); setError(failureText(result)); return; }
      commitKey.current = null;
      if (result.data.fastPath === "refreshed") { setPreview(null); setAuto(result.data); router.refresh(); return; }
      setPreview(result.data.preview); setNotAutomatic(notAutomaticLine(result.data));
    } finally { setBusy(false); }
  }
  async function storeAndResolve() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await postBrowserCommand(`${path}/summary`, {}, crypto.randomUUID());
      if (result.state !== "success") { setError(failureText(result)); return; }
      window.location.assign(`/admin/import?job=${encodeURIComponent(state.jobId)}`);
    } finally { setBusy(false); }
  }
  // The mapping view (Part 2): a read of every row against its intended mapping; re-read after each inline decision.
  async function readMapping() {
    setMappingOpen(true); setMappingError(null);
    try {
      const response = await fetch(`${path}/mapping`, { cache: "no-store" });
      const body = await response.json().catch(() => null) as { data?: V7ImportMapping; message?: string } | null;
      if (!response.ok || !body?.data) { setMapping(null); setMappingError(body?.message ?? "The mapping could not be read just now."); return; }
      setMapping(body.data);
    } catch { setMapping(null); setMappingError("The mapping could not be read just now."); }
  }
  async function storeForInline() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await postBrowserCommand(`${path}/summary`, {}, crypto.randomUUID());
      if (result.state !== "success") { setError(failureText(result)); return; }
    } finally { setBusy(false); }
    await readMapping();
  }
  async function runCommit() {
    if (busy || !preview || !reason.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = await postBrowserCommandWithReason<V7ImportRefreshCommitted>(path,
        { mode: "commit", summarySha256: preview.summarySha256, decisionsSha256: preview.decisionsSha256 }, commitKey.current ??= crypto.randomUUID(), reason.trim());
      // A refused commit is answered (the job or decisions moved, D7, the Admin gate): the next one is a new attempt.
      if (result.state !== "success") { if (result.state !== "failed" || !result.retryable) commitKey.current = null; setError(failureText(result)); return; }
      setDone(result.data); setPreview(null); setNotAutomatic(null); setReason(""); commitKey.current = null; router.refresh();
    } finally { setBusy(false); }
  }

  const gated = state.commitNeedsAdmin && !state.isAdmin;
  const view = preview ? refreshViewOf(preview) : null;
  const resolve = view?.kind === "exceptions" ? (state.canResolve
    ? <div className="nz-milestone-actions">
      <button type="button" className="nz-btn pri" disabled={busy || !state.writeEnabled} onClick={() => void storeAndResolve()}>Resolve these rows</button>
      <span className="sub">Stores this summary, then opens Import reconciliation for this job. Preview again here once they are resolved.</span>
    </div>
    : <div className="sub">An Admin resolves these rows, in Import reconciliation. Preview again once they have.</div>) : null;
  const commit = view?.kind === "ready" ? (gated
    ? <div className="nz-banner warn" role="status"><div>This organisation requires an Admin to commit a refresh. You can preview; an Admin commits.</div></div>
    : <form className="nz-milestone-form" onSubmit={(event) => { event.preventDefault(); void runCommit(); }}>
      <label className="nz-fl">Reason for the refresh<textarea className="nz-inp" rows={2} value={reason} required disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>
      <button type="submit" className="nz-btn pri" disabled={busy || !reason.trim() || !state.writeEnabled}>Commit the refresh</button>
    </form>) : null;

  const reconciliation = `/admin/import?job=${encodeURIComponent(state.jobId)}`;
  // A flagged row's control: inline once the job's stored summary is the one shown (a decision is checked against it); a pair, in
  // Import reconciliation, where pairs are carried as a group.
  const resolveRow = (row: V7ImportMappingRow) => {
    if (!state.canResolve || !mapping) return null;
    if (row.flag === "PAIR_TO_CARRY" || row.flag === "NEEDS_FRESH_SUMMARY") return <a href={reconciliation}>Carry it in Import reconciliation</a>;
    if (!mapping.summaryCurrent || row.ownStatus === "matched" || row.ownStatus === "changed") return null;
    return <ImportResolution jobId={state.jobId} legacyDbId={row.legacyDbId} status={row.ownStatus} scope={row.scope} resolution={row.resolution}
      decision={row.decision} invalid={row.invalid} onSaved={() => void readMapping()} />;
  };
  const mappingSection = mappingOpen ? <div data-mapping-panel>
    <div className="nz-milestones-heading"><div><h3>Each row&rsquo;s mapping</h3><span className="sub">Every row the previous system holds for this job, against what the console will map it to. Reading it changes nothing.</span></div>
      <div className="nz-milestone-actions"><a className="nz-btn" href={reconciliation}>Open Import reconciliation</a><button type="button" className="nz-btn" onClick={() => setMappingOpen(false)}>Hide</button></div></div>
    {mappingError ? <div className="nz-banner warn" role="alert"><div>{mappingError}</div></div> : null}
    {mapping && state.canResolve && !mapping.summaryCurrent && mapping.rows.some((row) => row.flag !== null) ? <div className="nz-milestone-actions">
      <button type="button" className="nz-btn pri" disabled={busy || !state.writeEnabled} onClick={() => void storeForInline()}>Resolve here</button>
      <span className="sub">Stores this summary first, so each decision is checked against the rows shown.</span>
    </div> : null}
    {mapping ? <ImportMappingView mapping={mapping} resolve={resolveRow} /> : null}
  </div> : null;

  return <section className="nz-body nz-milestones-body"><div className="nz-panel nz-milestones" data-import-refresh={state.jobId}>
    <div className="nz-milestones-heading">
      <div><h2>Refresh from the previous system</h2><span className="sub">{state.legacyJobNumber}: compare this job with the previous system&rsquo;s records now, then bring it up to date. A preview changes nothing.</span></div>
      <div className="nz-milestone-actions">
        <button type="button" className="nz-btn" disabled={busy} onClick={() => void readMapping()}>{mappingOpen ? "Read the mapping again" : "Show each row's mapping"}</button>
        <button type="button" className="nz-btn" disabled={busy || !state.writeEnabled} onClick={() => void runPreview()}>{preview ? "Preview again" : "Refresh from the previous system"}</button>
      </div>
    </div>
    {!state.writeEnabled ? <div className="sub">Refreshing is not enabled in this environment.</div> : null}
    {error ? <div className="nz-banner warn" role="alert"><div>{error}</div></div> : null}
    {done ? <div className="nz-banner ok" role="status"><div>Refreshed. The job&rsquo;s rows now match the previous system, re-synced {done.resync.superseded + done.resync.added + done.resync.withdrawn} row(s); the new rows wait for a reviewer&rsquo;s attest.</div></div> : null}
    {auto ? <FastPathRefreshedView outcome={auto} /> : null}
    {preview && notAutomatic ? <div className="sub" data-not-automatic>{notAutomatic}</div> : null}
    {preview ? <ImportRefreshPreviewView preview={preview} resolve={resolve} commit={commit} /> : null}
    {mappingSection}
  </div></section>;
}
