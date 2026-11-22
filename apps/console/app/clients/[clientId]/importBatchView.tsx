import Link from "next/link";
import type { V7ImportBatchFailureClass, V7ImportBatchTally } from "@nzi/contracts";
import { blockerParts, type FastPathBlocker } from "../../jobs/importRefreshView";

/**
 * The client's batch refresh (BRIEF-v7-import-server-side-phase-e §"The review queue"), drawn from the batch read. Pure: no hooks,
 * no requests, so a test renders it as the panel does.
 *
 * The tally: total · refreshed · exceptions · failed — then what needed nothing: "no change" (read, and every row already matches)
 * and "already current locally" (a committed refresh stands, so the batch did NOT read the job from the previous system again).
 * The queue is the jobs that did not refresh, each with why in the fast path's own words, linking to the job's refresh panel.
 */
export type ImportBatchQueueItem = {
  jobId: string; jobNumber: string; status: "queued" | "refused" | "failed";
  because: FastPathBlocker[]; flagged: number; refusalCodes: string[]; failureClass: V7ImportBatchFailureClass | null;
};
export type ImportBatchState = {
  clientId: string; importedJobs: number; writeEnabled: boolean;
  run: null | { runId: string; status: "queued" | "running" | "completed" | "cancelled"; createdAt: string; finishedAt: string | null; stopped: boolean;
    tally: V7ImportBatchTally; queue: ImportBatchQueueItem[] };
};

export const REFRESH_ALL = "Refresh all from the previous system";
export const ALREADY_CURRENT_LOCALLY = "already current locally";

const FAILURE_LABEL: Record<V7ImportBatchFailureClass, string> = {
  "view-timeout": "the previous system did not answer in time",
  "view-unavailable": "the previous system could not be reached",
  "plan-missing": "the committed import plans were not found",
  internal: "an unexpected error",
};

/** Why one job did not refresh, in one line. */
export function queueLine(item: ImportBatchQueueItem): string {
  if (item.status === "failed") return `Failed: ${FAILURE_LABEL[item.failureClass ?? "internal"]}.`;
  if (item.status === "refused") return `Refused: ${item.refusalCodes.join(", ")}.`;
  return `Not automatic: ${blockerParts(item.because, item.flagged).join(" · ")}.`;
}

export function tallyLine(tally: V7ImportBatchTally): string {
  return `${tally.total} jobs · ${tally.refreshed} refreshed · ${tally.exceptions} exceptions · ${tally.failed} failed`;
}

export function restLine(tally: V7ImportBatchTally): string | null {
  const parts = [tally.current ? `${tally.current} no change` : null, tally.skipped ? `${tally.skipped} ${ALREADY_CURRENT_LOCALLY}` : null,
    tally.pending ? `${tally.pending} still to run` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function ImportBatchRunView({ run }: { run: NonNullable<ImportBatchState["run"]> }) {
  const rest = restLine(run.tally);
  const open = run.status === "queued" || run.status === "running";
  return <div data-batch={run.status}>
    <p className="sub" data-tally><b>{tallyLine(run.tally)}</b>{rest ? <> · {rest}</> : null}</p>
    {open && !run.stopped ? <div className="nz-banner" role="status"><div>Refreshing, one job at a time. This page updates as it goes.</div></div> : null}
    {run.stopped ? <div className="nz-banner warn" role="alert"><div>This batch stopped before it finished (the service restarted). Resume it to carry on from where it stopped.</div></div> : null}
    {run.status === "cancelled" ? <div className="nz-banner warn" role="alert"><div>This batch was stopped: whoever started it may no longer run one. The jobs not reached were left as they were.</div></div> : null}
    {run.tally.skipped ? <p className="sub">Already current locally: a committed refresh stands and nothing has changed here since, so these jobs were not read from the previous system again. A job&rsquo;s own Refresh picks up a later change there.</p> : null}
    {run.queue.length ? <div className="nz-table-wrap"><table className="nz-tbl" data-queue>
      <thead><tr><th>Job</th><th>Why it was not refreshed</th></tr></thead>
      <tbody>{run.queue.map((item) => <tr key={item.jobId} data-job={item.jobId} data-status={item.status}>
        <td><Link href={`/jobs/${encodeURIComponent(item.jobId)}`}>{item.jobNumber}</Link></td><td>{queueLine(item)}</td>
      </tr>)}</tbody>
    </table></div> : run.status === "completed" ? <p className="sub">Nothing needs a person.</p> : null}
  </div>;
}
