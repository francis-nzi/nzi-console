import "server-only";
import { resumeV7ImportBatch, startV7ImportBatch } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "./commandAuth";
import { commandContext, commandFailure, commandSuccess } from "./commandResponse";
import type { ImportBatchDeps } from "./importBatchHandler";
import { kickImportBatch } from "./importBatchRunner";
import { findCrosswalkPlanDirectory } from "./importRefreshPlan";
import { liveImportViewSource } from "./importViewSource";
import { isolatedPool } from "./isolatedDatabase";

/** The batch routes' real collaborators (start and resume share them). */
export const importBatchDeps: ImportBatchDeps = {
  principal: requireCommandPrincipal, context: commandContext, pool: isolatedPool,
  // Fail closed before a run exists: the view set reachable by its guard, and the committed plans found.
  ready: () => { liveImportViewSource(); findCrosswalkPlanDirectory(); },
  start: startV7ImportBatch, resume: resumeV7ImportBatch, kick: kickImportBatch, success: commandSuccess, failure: commandFailure,
};
