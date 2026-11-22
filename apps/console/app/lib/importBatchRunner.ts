import "server-only";
import { runV7ImportBatch, type V7ImportRefreshSource } from "@nzi/isolated-backend";
import { findCrosswalkPlanDirectory, importRefreshPlanOptions, PlanDirectoryMissing } from "./importRefreshPlan";
import { liveImportViewSource } from "./importViewSource";
import { isolatedPool } from "./isolatedDatabase";

/**
 * The batch runner, in the console's own process (RULING-v7-import-phase-e-infra §1, R): `next start` is a long-lived Node server,
 * so a run started here outlives the request that started it. The database lease is what keeps it correct — one runner per run,
 * whatever this process does; if the process goes (a deploy, a crash) the lease runs out and an Admin's Resume starts a new one.
 *
 * Jobs run one at a time through the one view pool, with a pause between them (NZI_IMPORT_BATCH_PAUSE_MS, 250 by default).
 * Logs ids and a class only, never a message that could carry a figure.
 */
const holder = globalThis as typeof globalThis & { nziImportBatchRuns?: Set<string> };

export function kickImportBatch(organisationId: string, runId: string): void {
  const running = holder.nziImportBatchRuns ??= new Set<string>();
  const key = `${organisationId}:${runId}`;
  if (running.has(key)) return; // already running here; the lease would refuse a second runner anyway
  running.add(key);
  // The source is made per read, so a view the guard refuses mid-run is that job's failure (view-unavailable), not the runner's.
  const source: V7ImportRefreshSource = (db, job) => liveImportViewSource()(db, job);
  const pauseMs = Number(process.env.NZI_IMPORT_BATCH_PAUSE_MS ?? "250");
  void runV7ImportBatch(isolatedPool(), organisationId, runId, {
    source,
    optionsFor: (jobId, legacyJobNumber) => importRefreshPlanOptions(jobId, legacyJobNumber, findCrosswalkPlanDirectory),
    classify: (error) => error instanceof PlanDirectoryMissing ? "plan-missing" : null,
    pauseMs: Number.isFinite(pauseMs) && pauseMs >= 0 ? pauseMs : 250,
  })
    .then((result) => console.log(JSON.stringify({ event: "import-batch.runner", runId, claimed: result.claimed, processed: result.processed, status: result.status })))
    .catch((error: unknown) => console.error(JSON.stringify({ event: "import-batch.runner-stopped", runId, error: error instanceof Error ? error.name : "unknown" })))
    .finally(() => running.delete(key));
}
