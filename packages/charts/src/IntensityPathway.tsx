import type { IntensityPathwayData } from "./types";
import { ReductionPathway } from "./ReductionPathway";

/** Intensity target chart reuses the canonical pathway geometry and renderer. */
export function IntensityPathway(props: { data: IntensityPathwayData; width?: number; showChrome?: boolean }) {
  return <ReductionPathway {...props} />;
}
