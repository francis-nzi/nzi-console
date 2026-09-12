import type { SrsAssessment, SrsAssessmentItem, SrsRequirement } from "@nzi/contracts";

/** Which SRS drawer the workspace has open. Hosted by the shell, like every other drawer. */
export type SrsDrawerRequest =
  | { kind: "srs-start" }
  | { kind: "srs-assess"; assessment: SrsAssessment }
  | { kind: "srs-item"; assessment: SrsAssessment; requirement: SrsRequirement; item: SrsAssessmentItem | null };

export const srsDrawerLabel = (request: SrsDrawerRequest): string => {
  switch (request.kind) {
    case "srs-start": return "Start an SRS readiness assessment";
    case "srs-assess": return "Continue the SRS readiness assessment";
    case "srs-item": return `Assess ${request.requirement.code}`;
  }
};
