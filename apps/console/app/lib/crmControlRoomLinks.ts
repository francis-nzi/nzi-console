import { utcDay } from "@nzi/contracts";
import type { CrmDeadline, CrmRedBoxRow, CrmTask, CrmThread } from "@nzi/isolated-backend";

/**
 * Where the Control Room's rows go (BRIEF-crm-control-room-p2/p3), in one place the page, the drawers and the tests share: a
 * job, a conversation (the message drawer, `/?msg=<threadId>`), a task (the task drawer, `/?task=<taskId>`), or the client's
 * SRS or plan.
 */
export const threadHref = (threadId: string) => `/?msg=${encodeURIComponent(threadId)}`;
export const taskHref = (taskId: string) => `/?task=${encodeURIComponent(taskId)}`;

/** Where a conversation is read from, and where a reply goes: the SRS conversation through `srs.message.post`, any other through `client.message.post`. */
export function threadPaths(thread: Pick<CrmThread, "clientId" | "threadId" | "srs">): { read: string; reply: string } {
  const client = `/api/isolated/clients/${encodeURIComponent(thread.clientId)}`;
  const read = `${client}/threads/${encodeURIComponent(thread.threadId)}`;
  return { read, reply: thread.srs ? `${client}/srs-thread` : read };
}

/** The task commands' routes: create, edit (PATCH), and the two transitions. */
export const TASKS_PATH = "/api/isolated/tasks";
export const taskPath = (taskId: string, action?: "complete" | "reopen") => `${TASKS_PATH}/${encodeURIComponent(taskId)}${action ? `/${action}` : ""}`;

const clientArea = (clientId: string | null, area: string) => `/clients/${encodeURIComponent(clientId ?? "")}?area=${area}`;
const jobHref = (jobId: string | null) => `/jobs/${encodeURIComponent(jobId ?? "")}`;

/** A Red box row's target and its action word. */
export function redBoxLink(row: Pick<CrmRedBoxRow, "kind" | "threadId" | "clientId" | "jobId" | "taskId">): { href: string; go: string } {
  if (row.kind === "task-due" && row.taskId) return { href: taskHref(row.taskId), go: "Do" };
  if (row.kind === "unread" && row.threadId) return { href: threadHref(row.threadId), go: "Reply" };
  if (row.kind === "srs-review-request" && row.threadId) return { href: threadHref(row.threadId), go: "Reopen" };
  if (row.kind === "srs-review-overdue" || row.kind === "srs-review-today") return { href: clientArea(row.clientId, "srs"), go: "Review" };
  return { href: jobHref(row.jobId), go: row.kind === "awaiting-approval" ? "Approve" : "Open" };
}

export function deadlineHref(row: Pick<CrmDeadline, "kind" | "clientId" | "jobId" | "taskId">): string {
  if (row.kind === "task-due" && row.taskId) return taskHref(row.taskId);
  return row.kind === "srs-review" ? clientArea(row.clientId, "srs") : row.kind === "action-due" ? clientArea(row.clientId, "strategies") : jobHref(row.jobId);
}

/** My tasks' filters: due today or before, within the week (today and the six days after), or every open task. */
export const TASK_FILTERS = ["today", "week", "all"] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];
export const taskFilterOf = (value: unknown): TaskFilter => TASK_FILTERS.includes(value as TaskFilter) ? value as TaskFilter : "all";
export function tasksFor<T extends Pick<CrmTask, "dueDate">>(tasks: readonly T[], filter: TaskFilter, today: string): T[] {
  if (filter === "all") return [...tasks];
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const last = filter === "today" ? today : utcDay(new Date(Date.UTC(year, month - 1, day + 6)));
  return tasks.filter((task) => task.dueDate !== null && task.dueDate <= last);
}
