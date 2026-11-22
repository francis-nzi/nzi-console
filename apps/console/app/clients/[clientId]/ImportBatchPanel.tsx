"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { ImportBatchRunView, REFRESH_ALL, type ImportBatchState } from "./importBatchView";

/**
 * "Refresh all from the previous system" on a client (BRIEF-v7-import-server-side-phase-e; `import.refresh_batch`, Admin only).
 * One action starts a batch over the client's imported jobs; the service runs it one job at a time, and this panel reads its
 * progress until it finishes. A batch that stopped (the service restarted) offers Resume. Each queued job links to its own
 * refresh panel, where a person works it.
 *
 * Nothing shows for someone who may not run a batch, or for a client with no imported jobs.
 */
type Load = { state: "loading" } | { state: "hidden" } | { state: "failed" } | { state: "ready"; value: ImportBatchState };

const POLL_MS = 5000;
const failureText = (result: BrowserCommandResult<unknown>) => result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") || result.message
  : result.state === "success" ? "" : result.message;

export function ImportBatchPanel({ clientId }: { clientId: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/isolated/clients/${encodeURIComponent(clientId)}/import-refresh-batch`;

  const read = useCallback(async () => {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (response.status === 401 || response.status === 403) return setLoad({ state: "hidden" });
      if (!response.ok) return setLoad({ state: "failed" });
      const value = await response.json() as ImportBatchState;
      setLoad(value.importedJobs > 0 ? { state: "ready", value } : { state: "hidden" });
    } catch { setLoad({ state: "failed" }); }
  }, [path]);

  useEffect(() => { void read(); }, [read]);
  const open = load.state === "ready" && load.value.run !== null && (load.value.run.status === "queued" || load.value.run.status === "running") && !load.value.run.stopped;
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => { void read(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, read]);

  if (load.state === "hidden" || load.state === "loading") return null;
  const section = (body: ReactNode) => <section className="nz-panel" aria-labelledby="area-import-batch">
    <div className="nz-card-h"><h2 id="area-import-batch">Refresh from the previous system</h2></div>
    <div className="nz-card-b">{body}</div>
  </section>;
  if (load.state === "failed") return section(<div className="nz-banner warn" role="alert"><div>This client&rsquo;s batch refresh could not be read just now.</div></div>);
  const { value } = load;
  const run = value.run;

  async function act(kind: "start" | "resume") {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await postBrowserCommand(kind === "start" ? path : `${path}/resume`, kind === "start" ? {} : { runId: run?.runId }, crypto.randomUUID());
      if (result.state !== "success") setError(failureText(result));
      await read();
    } finally { setBusy(false); }
  }

  const runOpen = run !== null && (run.status === "queued" || run.status === "running");
  return section(<>
    <p className="sub">Every job of this client imported from the previous system, one at a time: a job with no issued report, no manual
      edits and nothing flagged is refreshed automatically; any other is listed here for a person.</p>
    <div>
      <button type="button" className="nz-btn pri" disabled={busy || runOpen || !value.writeEnabled} onClick={() => void act("start")}>{REFRESH_ALL}</button>
      {run?.stopped ? <>{" "}<button type="button" className="nz-btn" disabled={busy || !value.writeEnabled} onClick={() => void act("resume")}>Resume</button></> : null}
    </div>
    {!value.writeEnabled ? <div className="sub">Refreshing is not enabled in this environment.</div> : null}
    {error ? <div className="nz-banner warn" role="alert"><div>{error}</div></div> : null}
    {run ? <ImportBatchRunView run={run} /> : null}
  </>);
}
