// Track C — job-family modularization (NZC-024; docs/MODEL_FIDELITY_JOB_FAMILIES.md
// §7 build order). Each family's reference module ships behind its own flag,
// OFF by default, with `FamilyWorkspace` (the generic placeholder) serving that
// family until its module passes acceptance — same strangler discipline as the
// data-entry adapters (`featureFlags.ts`) and the report slices (`reportFlags.ts`),
// just a third, independent flag variable since a job-family module is neither.
//
//   NEXT_PUBLIC_FEATURE_JOB_MODULES=job-module-lca

export type JobModuleFlag = "job-module-lca";

const enabledModules = (): Set<string> =>
  new Set(
    (process.env.NEXT_PUBLIC_FEATURE_JOB_MODULES ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );

export function jobModuleEnabled(module: JobModuleFlag): boolean {
  return enabledModules().has(module);
}
