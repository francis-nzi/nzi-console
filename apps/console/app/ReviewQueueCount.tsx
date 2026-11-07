"use client";
import { useEffect, useState } from "react";
import { crmQueue, reportStageLabels } from "@nzi/contracts";

type Queue = ReturnType<typeof crmQueue>;
const STAGES = ["client-responded", "changes-requested", "awaiting-final-approval"] as const;

/**
 * Client-review loop S6: how many reports wait on the team, on the Control Room's Client review inbox panel. Derived from the report
 * register (the same read the Reports page uses); nothing is stored and nothing is written. Honest states: while it loads it says so,
 * and a failed read shows no number rather than a zero.
 */
export function ReviewQueueCount() {
  const [queue, setQueue] = useState<Queue | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch("/api/isolated/report-status", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => response.ok ? crmQueue(((await response.json()) as { jobs: Parameters<typeof crmQueue>[0] }).jobs) : null)
      .catch(() => null)
      .then((result) => { if (live) setQueue(result); });
    return () => { live = false; };
  }, []);
  if (queue === undefined) return <p role="status" data-review-queue="loading" style={{ fontSize: 13, opacity: 0.85, margin: "0 0 14px" }}>Counting the reports waiting on you…</p>;
  if (queue === null) return <p role="alert" data-review-queue="failed" style={{ fontSize: 13, color: "var(--amber)", margin: "0 0 14px" }}>The count could not be read. Open the report workflow to see where each report stands.</p>;
  return <div data-review-queue="ready" data-review-queue-total={queue.total} style={{ margin: "0 0 14px" }}>
    <div style={{ fontSize: 28, fontWeight: 700 }} className="num">{queue.total}</div>
    <div style={{ fontSize: 13, opacity: 0.85 }}>{queue.total === 0 ? "No reports are waiting on you." : `report${queue.total === 1 ? "" : "s"} waiting on you`}</div>
    {queue.total > 0 ? <ul style={{ fontSize: 12.5, opacity: 0.85, margin: "6px 0 0", paddingLeft: 18 }}>
      {STAGES.filter((stage) => queue.byStage[stage] > 0).map((stage) => <li key={stage}>{queue.byStage[stage]} · {reportStageLabels[stage]}</li>)}
    </ul> : null}
  </div>;
}
