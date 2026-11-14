import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { committedV7CrosswalkPlan, type V7ImportRefreshOptions } from "@nzi/isolated-backend";

/**
 * The refresh's committed crosswalk plan, passed explicitly (BRIEF-v7-import-server-side-phase-c §1).
 *
 * Why not the command's default: the backend finds `data/v7-crosswalk-v1` from `import.meta.url`, and in the Next server bundle
 * webpack replaces that with the BUILD machine's absolute source path (checked in the built chunk). It would resolve on Render only
 * because the build and the service share one checkout — an accident, not a contract. So the console finds the directory itself,
 * from where the service runs: up from the working directory to the repository's `packages/isolated-backend/data/v7-crosswalk-v1`.
 *
 * Fail closed: no such directory and the refresh refuses (`PlanDirectoryMissing`, the route's 503) — never an empty plan, which
 * would read every row as needing a decision.
 */
export const CROSSWALK_PLAN_PATH = join("packages", "isolated-backend", "data", "v7-crosswalk-v1");

export class PlanDirectoryMissing extends Error {
  constructor() { super(`The committed crosswalk plans (${CROSSWALK_PLAN_PATH}) were not found from the service's working directory.`); this.name = "PlanDirectoryMissing"; }
}

/** The plan directory, found upward from `from` (the service's working directory: apps/console under `npm run start -w`). */
export function findCrosswalkPlanDirectory(from: string = process.cwd(), exists: (path: string) => boolean = existsSync): string {
  let at = resolve(from);
  for (;;) {
    const candidate = join(at, CROSSWALK_PLAN_PATH);
    if (exists(candidate)) return candidate;
    const up = dirname(at);
    if (up === at) throw new PlanDirectoryMissing();
    at = up;
  }
}

/** The job's committed plan (or the empty one a job without a plan file has), from the directory found above. */
export function importRefreshPlanOptions(jobId: string, legacyJobNumber: string | null, dir: () => string = findCrosswalkPlanDirectory): V7ImportRefreshOptions {
  if (!legacyJobNumber) return {}; // The command refuses a job with no J number itself (JOB_NUMBER), before any plan is read.
  return { basePlan: committedV7CrosswalkPlan(jobId, legacyJobNumber, dir()) };
}
