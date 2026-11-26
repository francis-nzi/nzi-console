"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ImportRowsModal } from "./ImportRowsModal";
import type { ImportRefreshState } from "./importRefreshView";
import { announceJobDataChanged, useJobDataChanged } from "./jobDataChanged";

/**
 * "Refresh from the previous system" on a job imported from it (BRIEF-v7-import-server-side-phase-c §3; `import.refresh`) — now
 * one action and one modal (BRIEF-v7-import-rows-modal): "Import rows from the previous system" opens the rows, matched,
 * reconciled and accepted there; the in-page preview, its flagged table and Import reconciliation are retired. The panel keeps
 * its place and its one line of outcome.
 *
 * Nothing shows for a job of another origin, or for someone who may not refresh. `?import=rows` opens the modal on arrival (the
 * retired Import reconciliation page sends a job there).
 */
/**
 * The drift guard's banner (BRIEF-v7-import-j000663 Part C): from the job's latest check against the previous system. Behind → the
 * brief's line, red, with the panel's Import rows as the action; can't check, or a two-dataset-year job not yet checked → amber; level → nothing.
 */
export function DriftBanner({ drift }: { drift: NonNullable<Extract<ImportRefreshState, { applies: true }>["drift"]> | null }) {
  if (!drift?.line) return null;
  const when = drift.checkedAt ? ` Checked ${new Date(drift.checkedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" })}.` : "";
  return <div className={`nz-banner ${drift.tone === "behind" ? "bad" : "warn"}`} role={drift.tone === "behind" ? "alert" : "status"} data-drift={drift.tone}>
    <div><b>{drift.line}</b>{drift.tone === "behind" ? " It can't be published until its rows are brought in." : ""}{when}</div>
  </div>;
}

type Load = { state: "loading" } | { state: "hidden" } | { state: "failed" } | { state: "ready"; value: Extract<ImportRefreshState, { applies: true }> };

export function ImportRefreshPanel({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // Re-read after a bring-in (its drift banner is this read's), keeping the panel on screen meanwhile.
  const [reads, setReads] = useState(0);
  useJobDataChanged(jobId, () => setReads((count) => count + 1));

  useEffect(() => {
    let live = true;
    fetch(`/api/isolated/jobs/${encodeURIComponent(jobId)}/import-refresh`, { cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401 || response.status === 403) return setLoad({ state: "hidden" });
        if (!response.ok) return setLoad({ state: "failed" });
        const value = await response.json() as ImportRefreshState;
        setLoad(value.applies ? { state: "ready", value } : { state: "hidden" });
        // `?import=rows` opens the modal on arrival only — never again on a re-read after a bring-in.
        if (reads === 0 && value.applies && new URLSearchParams(window.location.search).get("import") === "rows") setOpen(true);
      })
      .catch(() => { if (live) setLoad({ state: "failed" }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `reads` is the re-read trigger
  }, [jobId, reads]);

  /**
   * Brought in: the modal has closed itself; say so here, and bring the whole page up to date without a reload — `router.refresh()`
   * for what the server draws (the rows, the datasets chip, the header's stage), the announcement for what reads its own (the totals
   * band, the category list, this panel's drift banner).
   */
  const broughtIn = (line: string) => { setDone(line); router.refresh(); announceJobDataChanged(jobId); };

  if (load.state === "hidden" || load.state === "loading") return null;
  if (load.state === "failed") {
    return <section className="nz-body nz-milestones-body"><div className="nz-panel nz-milestones"><div className="nz-banner warn" role="alert"><div>Whether this job can be refreshed from the previous system could not be read just now.</div></div></div></section>;
  }
  const state = load.value;
  return <section className="nz-body nz-milestones-body"><div className="nz-panel nz-milestones" data-import-refresh={state.jobId}>
    <div className="nz-milestones-heading">
      <div><h2>Refresh from the previous system</h2><span className="sub">{state.legacyJobNumber}: bring this job&rsquo;s rows in from the previous system — each matched to a console factor, its figures checked, then accepted. Opening it changes nothing.</span></div>
      <div className="nz-milestone-actions">
        <button type="button" className="nz-btn pri" data-open-import-rows onClick={() => { setDone(null); setOpen(true); }}>Import rows from the previous system</button>
      </div>
    </div>
    <DriftBanner drift={state.drift ?? null} />
    {done ? <div className="nz-banner ok" role="status"><div>{done}</div></div> : null}
    <ImportRowsModal state={state} open={open} onClose={() => setOpen(false)} onBroughtIn={(line) => broughtIn(line)} />
  </div></section>;
}
