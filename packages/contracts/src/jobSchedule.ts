import { MILESTONE_KINDS, type MilestoneKind } from "./adminMilestoneTemplates";

/**
 * A job's milestone schedule, as pure rules (PR 3; moved here by job.update, ruled J6): the anchor a template counts
 * from, and what a reschedule does kind by kind. Pure so the command that applies it and the screen that previews it run
 * literally the same function — the preview is the rule.
 */

/** Where a template's offsets count from: v7's rule, proven by C5 at 995 of 995. */
export type ScheduleAnchor = { anchor: string; from: "start_date" | "reporting_period_start" };

/** The later of the start date and the reporting-period start; the start when there is no period. */
export function anchorOf(startDate: string | null, periodStart: string | null): ScheduleAnchor | null {
  if (!startDate && !periodStart) return null;
  if (!startDate) return { anchor: periodStart!, from: "reporting_period_start" };
  if (periodStart && periodStart > startDate) return { anchor: periodStart, from: "reporting_period_start" };
  return { anchor: startDate, from: "start_date" };
}

/** A calendar day plus whole days — plain dates, no zone (a `date` + `integer`, as SQL computes it). */
export function addCalendarDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}-${String(moved.getUTCDate()).padStart(2, "0")}`;
}

/** One stored milestone, as the plan needs it. */
export type ScheduleRow = { due_date: string | null; completed_at: Date | string | null; due_source: "template" | "manual" | "import" };
/** A template, as the plan needs it: its items by kind. */
export type ScheduleTemplate = { items: ReadonlyArray<{ kind: MilestoneKind; daysOffset: number; included: boolean }> };

export type ReschedulePreview = Array<{ kind: MilestoneKind; action: "generate" | "move" | "keep" | "clear" | "unchanged"; from: string | null; to: string | null; because: string }>;

/**
 * What a reschedule does, kind by kind (Q11). Template rows that are not completed move — or are cleared, if the
 * template no longer schedules their kind (M3); a kind with no row that the template schedules is generated (Q7's
 * apply); manual, imported and completed rows are kept. Only included items are ever scheduled (C1's ruling).
 */
export function planReschedule(rows: ReadonlyMap<MilestoneKind, ScheduleRow>, template: ScheduleTemplate | null, anchor: ScheduleAnchor | null): ReschedulePreview {
  return MILESTONE_KINDS.map((kind) => {
    const row = rows.get(kind);
    const item = template?.items.find((candidate) => candidate.kind === kind && candidate.included);
    const to = item && anchor ? addCalendarDays(anchor.anchor, item.daysOffset) : null;
    if (row && row.completed_at) return { kind, action: "keep", from: row.due_date, to: row.due_date, because: "completed — never moved" };
    if (row && row.due_source !== "template") return { kind, action: "keep", from: row.due_date, to: row.due_date, because: row.due_source === "manual" ? "set by hand — never moved" : "from v7 — never moved" };
    if (!row) return to ? { kind, action: "generate", from: null, to, because: "scheduled by the template" } : { kind, action: "unchanged", from: null, to: null, because: "not scheduled" };
    if (!to) return row.due_date === null ? { kind, action: "unchanged", from: null, to: null, because: "not scheduled" } : { kind, action: "clear", from: row.due_date, to: null, because: "the template no longer schedules it" };
    return row.due_date === to ? { kind, action: "unchanged", from: to, to, because: "already on the template's date" } : { kind, action: "move", from: row.due_date, to, because: "recomputed from the template" };
  });
}
