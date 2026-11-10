"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";
import { Drawer } from "@nzi/ui";
import type { CrmControlRoom, CrmTask } from "@nzi/isolated-backend";
import { TASKS_PATH, taskPath } from "./lib/crmControlRoomLinks";

/**
 * The Control Room's tasks (BRIEF-crm-control-room-p3-tasks): the quick-add under My tasks, and the task drawer. Every change
 * is a staff command (`task.create`, `task.update`, `task.complete`, `task.reopen`), versioned against what was read; the
 * dashboard is read again after each, so the widget, the Red box and the deadlines move together.
 */
type Options = CrmControlRoom["taskOptions"];
type Answer = { ok: true; data: Record<string, unknown> } | { ok: false; message: string };

async function send(method: "POST" | "PATCH", url: string, body: unknown): Promise<Answer> {
  try {
    const response = await fetch(url, { method, credentials: "same-origin", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
    const answer = await response.json().catch(() => ({})) as { data?: Record<string, unknown>; message?: string; issues?: Array<{ message: string }> };
    return response.ok ? { ok: true, data: answer.data ?? {} } : { ok: false, message: answer.issues?.[0]?.message ?? answer.message ?? "That could not be saved." };
  } catch { return { ok: false, message: "That could not be saved." }; }
}

/** Add a task for yourself: a title, and a due date or a job if you like. */
export function TaskQuickAdd({ jobs }: { jobs: Options["jobs"] }) {
  const router = useRouter();
  const [form, setForm] = useState({ title: "", dueDate: "", jobId: "" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!form.title.trim() || busy) return;
    setBusy(true); setProblem(null);
    const answer = await send("POST", TASKS_PATH, { title: form.title.trim(), dueDate: form.dueDate || null, jobId: form.jobId || null });
    setBusy(false);
    if (!answer.ok) { setProblem(answer.message); return; }
    setForm({ title: "", dueDate: "", jobId: "" });
    router.refresh();
  }
  return <form className="nz-crm-task-add" onSubmit={add} aria-label="Add a task" data-crm-task-add>
    {problem ? <div className="nz-banner warn" role="alert">{problem}</div> : null}
    <label className="nz-sr-only" htmlFor="crm-task-title">Task</label>
    <input id="crm-task-title" className="nz-in" maxLength={200} placeholder="Add a task…" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} disabled={busy} />
    <label className="nz-sr-only" htmlFor="crm-task-due">Due</label>
    <input id="crm-task-due" className="nz-in" type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} disabled={busy} />
    <label className="nz-sr-only" htmlFor="crm-task-job">Job</label>
    <select id="crm-task-job" className="nz-sel" value={form.jobId} onChange={(event) => setForm({ ...form, jobId: event.target.value })} disabled={busy}>
      <option value="">No job</option>{jobs.map((job) => <option key={job.jobId} value={job.jobId}>{job.jobNumber} · {job.client}</option>)}
    </select>
    <button type="submit" className="nz-btn pri" disabled={busy || !form.title.trim()}>{busy ? "Adding…" : "Add"}</button>
  </form>;
}

/**
 * One of the CRM's open tasks over the dashboard: its title, notes, due date and assignee to change, the job or client it is
 * about, and mark done. A task done here stays in the drawer, struck through, with Reopen, until it is closed. A task that is
 * not one of the CRM's open tasks is not opened.
 */
export function CrmTaskDrawer({ task: opened, staff }: { task: CrmTask | null; staff: Options["staff"] }) {
  const router = useRouter();
  const close = useCallback(() => router.push("/", { scroll: false }), [router]);
  // The task as it was opened: once done or reassigned it leaves the CRM's open list, but the drawer keeps showing it until closed.
  const [task] = useState(opened);
  const fields = { title: task?.title ?? "", notes: task?.notes ?? "", dueDate: task?.dueDate ?? "", assignedUserId: task?.assignedUserId ?? "" };
  const [form, setForm] = useState(fields);
  const [saved, setSaved] = useState(fields);
  const [state, setState] = useState<{ version: number; status: "open" | "done" }>({ version: task?.version ?? 1, status: "open" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  async function act(run: () => Promise<Answer>, done: (data: Record<string, unknown>) => string): Promise<boolean> {
    setBusy(true); setNotice(null);
    const answer = await run();
    setBusy(false);
    if (!answer.ok) { setNotice({ tone: "warn", text: answer.message }); return false; }
    setState({ version: Number(answer.data.version), status: answer.data.status === "done" ? "done" : "open" });
    setNotice({ tone: "ok", text: done(answer.data) });
    router.refresh();
    return true;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!task || busy) return;
    // Only what changed since the last save is sent, against the version that save returned.
    const changes: Record<string, unknown> = { expectedVersion: state.version };
    if (form.title.trim() !== saved.title) changes.title = form.title.trim();
    if (form.notes !== saved.notes) changes.notes = form.notes;
    if (form.dueDate !== saved.dueDate) changes.dueDate = form.dueDate || null;
    if (form.assignedUserId !== saved.assignedUserId) changes.assignedUserId = form.assignedUserId;
    if (await act(() => send("PATCH", taskPath(task.taskId), changes), (data) => data.reassigned ? "Reassigned. It leaves your list." : data.rescheduled ? "Rescheduled." : "Saved.")) setSaved({ ...form, title: form.title.trim() });
  }

  const done = state.status === "done";
  return <Drawer open onClose={close} ariaLabel={task ? `Task: ${task.title}` : "Task"} className="nz-site-drawer" dismissOnOutsideClick>
    <div className="nz-dh">
      <div className="k">{done ? "Task · done" : "Task"}</div>
      <h3 className={done ? "nz-crm-task-done" : undefined}>{task?.title ?? "Task"}</h3>
      {task ? <div className="sub">{task.jobId
        ? <Link className="nz-table-link" href={`/jobs/${encodeURIComponent(task.jobId)}`}>{task.jobNumber} · {task.client} — open job →</Link>
        : task.clientId ? <Link className="nz-table-link" href={`/clients/${encodeURIComponent(task.clientId)}`}>{task.client} — open client →</Link> : "Not on a job or client"}</div> : null}
      <button type="button" className="x" aria-label="Close task" onClick={close}>×</button>
    </div>
    <div className="nz-db" data-crm-task={task?.taskId ?? "not-mine"}>
      {!task ? <p className="sub" role="status">This task is not one of your open tasks, so it is not opened here.</p> : <>
        {notice ? <div className={`nz-banner ${notice.tone}`} role={notice.tone === "ok" ? "status" : "alert"}>{notice.text}</div> : null}
        <form className="nz-drawer-form" onSubmit={(event) => void save(event)} id="crm-task-form">
          <label className="nz-fl">Title<input className="nz-in" required maxLength={200} value={form.title} disabled={busy || done} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label className="nz-fl">Due<input className="nz-in" type="date" value={form.dueDate} disabled={busy || done} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} /></label>
          <label className="nz-fl">Assigned to<select className="nz-sel" value={form.assignedUserId} disabled={busy || done} onChange={(event) => setForm({ ...form, assignedUserId: event.target.value })}>
            {staff.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></label>
          <label className="nz-fl">Notes<textarea className="nz-in" rows={4} maxLength={4000} value={form.notes} disabled={busy || done} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
        </form>
      </>}
    </div>
    {task ? <div className="nz-crm-compose"><div className="nz-drawer-actions">
      {done
        ? <button type="button" className="nz-btn" disabled={busy} onClick={() => void act(() => send("POST", taskPath(task.taskId, "reopen"), { expectedVersion: state.version }), () => "Reopened.")}>Reopen</button>
        : <><button type="submit" form="crm-task-form" className="nz-btn" disabled={busy || !form.title.trim()}>Save</button>
          <button type="button" className="nz-btn pri" disabled={busy} onClick={() => void act(() => send("POST", taskPath(task.taskId, "complete"), { expectedVersion: state.version }), () => "Done.")}>Mark done</button></>}
      {task.jobId ? <Link className="nz-btn" href={`/jobs/${encodeURIComponent(task.jobId)}`}>Open job</Link> : null}
    </div></div> : null}
  </Drawer>;
}
