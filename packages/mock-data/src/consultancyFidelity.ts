// Worst-case Consultancy fixtures proving the Phase 0 model (0050): a retainer
// over budget, a delivered deliverable stuck past its due date, and a
// fixed-scope engagement with a rejected deliverable in rework. Typed against
// @nzi/contracts; see docs/MODEL_FIDELITY_JOB_FAMILIES.md §4.
// Illustrative demonstrator data only — no real client data, no PII.
import type {
  ConsultancyDeliverable,
  ConsultancyDetail,
  ConsultancyJobView,
} from "@nzi/contracts";

// Fixture 1 — a retainer that has burned past its hours budget.
export const retainerOverBudgetDetail: ConsultancyDetail = {
  jobId: "718",
  engagementType: "retainer",
  scope: "Monthly decarbonisation advisory retainer — 8h/month.",
  hoursBudget: 96,
  hoursUsed: 112.5,
  nextReviewDate: "2026-10-01",
  summaryNotes: "Q3 scope creep on supplier engagement workshops; renewal conversation flagged.",
  workflowStageKey: "delivery",
  version: 5,
  reviewStatus: "pending",
  reviewedVersion: null,
};

// Fixture 3 — a fixed-scope engagement: 5 deliverables, 2 accepted, 1 rejected
// (in rework), 1 delivered-awaiting-acceptance past due (fixture 2), 1 planned.
export const fixedScopeDetail: ConsultancyDetail = {
  jobId: "719",
  engagementType: "fixed_scope",
  scope: "Net-zero transition plan: baseline review, target setting, roadmap, board pack, assurance-readiness memo.",
  hoursBudget: 140,
  hoursUsed: 96,
  nextReviewDate: "2026-09-15",
  summaryNotes: "Roadmap rejected at first client review — methodology annex requested.",
  workflowStageKey: "client_review",
  version: 3,
  reviewStatus: "approved",
  reviewedVersion: 3,
};

const deliverable = (
  over: Partial<ConsultancyDeliverable> & Pick<ConsultancyDeliverable, "id" | "title" | "sortOrder" | "status">,
): ConsultancyDeliverable => ({
  jobId: "719",
  description: "",
  dueDate: null,
  deliveredAt: null,
  acceptedAt: null,
  reworkNote: null,
  fileId: null,
  reportVersionId: null,
  ...over,
});

export const fixedScopeDeliverables: ConsultancyDeliverable[] = [
  deliverable({
    id: "dlv-baseline", title: "Baseline emissions review", sortOrder: 1, status: "accepted",
    dueDate: "2026-06-30", deliveredAt: "2026-06-24T09:00:00Z", acceptedAt: "2026-07-02T14:00:00Z",
  }),
  deliverable({
    id: "dlv-targets", title: "Science-based target proposal", sortOrder: 2, status: "accepted",
    dueDate: "2026-07-31", deliveredAt: "2026-07-28T09:00:00Z", acceptedAt: "2026-08-05T11:00:00Z",
  }),
  // Fixture 2 — delivered but not accepted, and the due date has passed.
  deliverable({
    id: "dlv-boardpack", title: "Board decision pack", sortOrder: 4, status: "delivered",
    dueDate: "2026-08-15", deliveredAt: "2026-08-14T17:00:00Z",
  }),
  // Rejected → in rework (rework_note required by the migration constraint).
  deliverable({
    id: "dlv-roadmap", title: "Decarbonisation roadmap", sortOrder: 3, status: "rejected",
    dueDate: "2026-08-10", deliveredAt: "2026-08-08T10:00:00Z",
    reworkNote: "Add a methodology annex and per-scope marginal abatement cost curve before re-submission.",
  }),
  deliverable({
    id: "dlv-assurance", title: "Assurance-readiness memo", sortOrder: 5, status: "planned",
    dueDate: "2026-09-30",
  }),
];

export const retainerOverBudgetView: ConsultancyJobView = {
  detail: retainerOverBudgetDetail,
  deliverables: [
    deliverable({
      jobId: "718", id: "dlv-retainer-q3", title: "Q3 advisory summary", sortOrder: 1, status: "accepted",
      dueDate: "2026-07-05", deliveredAt: "2026-07-03T09:00:00Z", acceptedAt: "2026-07-08T09:00:00Z",
    }),
    deliverable({
      jobId: "718", id: "dlv-retainer-q4", title: "Q4 advisory summary", sortOrder: 2, status: "in_progress",
      dueDate: "2026-10-05",
    }),
  ],
};

export const fixedScopeView: ConsultancyJobView = {
  detail: fixedScopeDetail,
  deliverables: fixedScopeDeliverables,
};

export const consultancyFidelityViews: ConsultancyJobView[] = [retainerOverBudgetView, fixedScopeView];
