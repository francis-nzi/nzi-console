/**
 * Milestone templates (admin Phase C2; ruled plan `admin-phaseC-plan.md`, R12, Q5, Q6): a default delivery schedule a
 * new job's milestones are generated from (PR 3). A template carries up to one item per `job_milestones` kind — the
 * three the Risk rule reads — each with its own label and its own offset in days from the job's anchor.
 *
 * An item is never deleted (0139): a kind the template stops scheduling is kept with `included: false`, and only
 * included items are ever generated (ruled with C1). Exactly one template per organisation is the default, and it
 * cannot be deactivated (Q6); the default moves, atomically, with `milestone_template.set_default`.
 */
export const MILESTONE_KINDS = ["data_collection", "first_draft", "final_report"] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];
export const isMilestoneKind = (value: unknown): value is MilestoneKind =>
  typeof value === "string" && (MILESTONE_KINDS as readonly string[]).includes(value);

/** The design's two-letter mark and a label to start from, per kind. */
export const MILESTONE_KIND_META: Record<MilestoneKind, { mark: string; defaultLabel: string }> = {
  data_collection: { mark: "DC", defaultLabel: "Data collection" },
  first_draft: { mark: "FD", defaultLabel: "First draft" },
  final_report: { mark: "FR", defaultLabel: "Final report" },
};

export const MILESTONE_TEMPLATE_NAME_MAX = 120;
export const MILESTONE_TEMPLATE_DESCRIPTION_MAX = 2000;
export const MILESTONE_ITEM_LABEL_MAX = 120;
export const MILESTONE_OFFSET_MAX = 3650;

/** One item as a create or update carries it. */
export type MilestoneTemplateItemInput = { kind: MilestoneKind; label: string; daysOffset: number; included: boolean };

/** A template's editable fields. `items` is the whole schedule: a kind left out is not scheduled (kept, not deleted). */
export type MilestoneTemplateFields = { name: string; description?: string | null; items: MilestoneTemplateItemInput[] };
