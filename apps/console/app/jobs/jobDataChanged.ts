"use client";

import { useEffect, useRef } from "react";

/**
 * "This job's data changed under you" — said once, by whatever changed it (a bring-in from the previous system), and heard by each
 * part of the job's page that reads its own figures in the browser rather than from the page's props: the totals band, the category
 * list, the import panel and its drift banner. `router.refresh()` redraws what the server renders (the rows, the datasets chip, the
 * header's stage); this re-reads the rest, so nothing on screen is left behind without a page reload.
 */
export const JOB_DATA_CHANGED = "nzi:job-data-changed";

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">;
const browser = (): Target | null => (typeof window === "undefined" ? null : window);

/** Say that the job's data changed. */
export function announceJobDataChanged(jobId: string, target: Target | null = browser()): void {
  target?.dispatchEvent(new CustomEvent(JOB_DATA_CHANGED, { detail: { jobId } }));
}

/** Listen for this job's change (another job's is not heard); returns the unsubscribe. */
export function onJobDataChanged(jobId: string, listener: () => void, target: Target | null = browser()): () => void {
  if (!target) return () => undefined;
  const handle = (event: Event) => { if ((event as CustomEvent<{ jobId?: string }>).detail?.jobId === jobId) listener(); };
  target.addEventListener(JOB_DATA_CHANGED, handle);
  return () => target.removeEventListener(JOB_DATA_CHANGED, handle);
}

/** A component's hook: re-read when this job's data changes. The latest `listener` is called; it need not be stable. */
export function useJobDataChanged(jobId: string, listener: () => void): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => onJobDataChanged(jobId, () => latest.current()), [jobId]);
}
