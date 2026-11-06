import type { SrsAssessment } from "@nzi/contracts";

/**
 * Which SRS drawer the workspace has open. Hosted by the shell, like every other drawer. Conducting an assessment is not a
 * drawer: it is the guided wizard, a modal owned by the SRS area itself.
 */
export type SrsDrawerRequest =
  /** SRS S3: bridge one gap — the library first, AI ideas second, or the consultant's own action. */
  { kind: "srs-bridge"; assessment: SrsAssessment; requirementId: string };

export const srsDrawerLabel = (_request: SrsDrawerRequest): string => "Bridge a readiness gap";
