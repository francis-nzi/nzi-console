// Consultancy job-family model — Phase 0 contract types (NZC-056).
// Mirrors migration 0050_consultancy. The lightest family: a single versioned
// detail row + a deliverable checklist. No time-tracking engine. See
// docs/MODEL_FIDELITY_JOB_FAMILIES.md §4.

export type ConsultancyEngagementType =
  | "advisory"
  | "retainer"
  | "fixed_scope"
  | "workshop"
  | "audit";

export type ConsultancyStageKey =
  | "scope"
  | "plan"
  | "delivery"
  | "client_review"
  | "complete";

export type ConsultancyReviewStatus = "pending" | "approved" | "rejected";

export type ConsultancyDeliverableStatus =
  | "planned"
  | "in_progress"
  | "delivered"
  | "accepted"
  | "rejected";

export type ConsultancyDetail = {
  jobId: string;
  engagementType: ConsultancyEngagementType;
  scope: string;
  hoursBudget: number | null;
  hoursUsed: number;
  nextReviewDate: string | null;
  summaryNotes: string;
  workflowStageKey: ConsultancyStageKey;
  version: number;
  reviewStatus: ConsultancyReviewStatus;
  reviewedVersion: number | null;
};

export type ConsultancyDeliverable = {
  id: string;
  jobId: string;
  title: string;
  description: string;
  sortOrder: number;
  status: ConsultancyDeliverableStatus;
  dueDate: string | null;
  deliveredAt: string | null;
  acceptedAt: string | null;
  reworkNote: string | null;
  fileId: string | null;
  reportVersionId: string | null;
};

export type ConsultancyJobView = {
  detail: ConsultancyDetail;
  deliverables: ConsultancyDeliverable[];
};

/** Budget health for a consultancy engagement. Pure — no time-log, just the pair. */
export function consultancyBudgetState(detail: Pick<ConsultancyDetail, "hoursBudget" | "hoursUsed">): {
  overBudget: boolean;
  remainingHours: number | null;
  usedPct: number | null;
} {
  if (detail.hoursBudget === null) {
    return { overBudget: false, remainingHours: null, usedPct: null };
  }
  const remainingHours = detail.hoursBudget - detail.hoursUsed;
  const usedPct =
    detail.hoursBudget === 0 ? 100 : Math.round((detail.hoursUsed / detail.hoursBudget) * 1000) / 10;
  return { overBudget: remainingHours < 0, remainingHours, usedPct };
}

/**
 * The "Client review → Complete" gate: every deliverable must be accepted (or
 * explicitly dropped by removal). A delivered-but-unaccepted or rejected
 * deliverable blocks completion.
 */
export function consultancyCompletionBlockers(
  deliverables: ConsultancyDeliverable[],
): ConsultancyDeliverable[] {
  return deliverables.filter((d) => d.status !== "accepted");
}

/** A delivered deliverable still unaccepted after its due date. */
export function consultancyOverdueDeliverables(
  deliverables: ConsultancyDeliverable[],
  asOf: string,
): ConsultancyDeliverable[] {
  return deliverables.filter(
    (d) =>
      d.status !== "accepted" &&
      d.dueDate !== null &&
      d.dueDate < asOf,
  );
}

export function isAllowedDeliverableTransition(
  from: ConsultancyDeliverableStatus,
  to: ConsultancyDeliverableStatus,
): boolean {
  const allowed: Record<ConsultancyDeliverableStatus, ConsultancyDeliverableStatus[]> = {
    planned: ["in_progress", "delivered"],
    in_progress: ["delivered", "planned"],
    delivered: ["accepted", "rejected"],
    rejected: ["in_progress", "delivered"],
    accepted: [],
  };
  return allowed[from].includes(to);
}
