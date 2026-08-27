"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand } from "@nzi/api-client";
import { jobWorkflowStages } from "@nzi/contracts";
import type { FamilyJob } from "@nzi/mock-data";

export function WorkflowStageControl({ job }: { job: FamilyJob }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const stages: readonly string[] = jobWorkflowStages[job.header.family];
  const activeIndex = stages.indexOf(job.header.workflowStage);
  const targets = stages.filter((_, index) => Math.abs(index - activeIndex) === 1);

  async function move(toStage: string) {
    if (pending) return;
    setPending(toStage); setNotice(null);
    const result = await postBrowserCommand<{ toStage: string; version: number }>("/api/isolated/commands/jobs/stage", {
      jobId: job.header.id, fromStage: job.header.workflowStage, toStage, expectedVersion: job.header.version, ...(note.trim() ? { note: note.trim() } : {}),
    }, crypto.randomUUID());
    setPending(null);
    if (result.state === "success") { setNote(""); setNotice({ kind: "ok", text: `Workflow moved to ${result.data.toStage}.` }); router.refresh(); return; }
    setNotice({ kind: "warn", text: result.state === "validation_failed" ? result.issues[0]?.message ?? result.message : result.message });
  }

  return <div className="nz-body nz-workflow-body">
    <div className="nz-panel nz-workflow-control">
      <div className="nz-workflow-heading">
        <div><span className="nz-eyebrow">Governed lifecycle</span><b>Workflow stage</b><div className="sub">Version {job.header.version} · adjacent transitions only · every move is audited.</div></div>
        <span className="nz-st done">{job.header.workflowStage}</span>
      </div>
      <ol className="nz-stepper nz-workflow-stepper" aria-label="Recorded workflow position">{stages.map((stage, index) => <li key={stage} className={`nz-step ${index === activeIndex ? "active" : index < activeIndex ? "done" : "todo"}`} aria-current={index===activeIndex?"step":undefined}><span className="n">{index < activeIndex ? "✓" : index + 1}</span><span className="lb">{stage}</span>{index < stages.length - 1 && <span className="bar" />}</li>)}</ol>
      {notice && <div className={`nz-banner ${notice.kind}`} role={notice.kind==="warn"?"alert":"status"}><div>{notice.text}</div></div>}
      <div className="nz-workflow-actions">
        <label className="nz-fl">Transition note <span className="nz-optional">recommended</span><input className="nz-inp" value={note} maxLength={500} disabled={pending!==null} onChange={(event) => setNote(event.target.value)} placeholder="Reason or handoff context for the audit record" /></label>
        <div>{targets.map((target) => <button type="button" key={target} className={`nz-btn ${stages.indexOf(target) > activeIndex ? "pri" : ""}`} disabled={pending !== null} onClick={() => move(target)}>{pending === target ? "Moving…" : `${stages.indexOf(target) < activeIndex ? "Back to" : "Move to"} ${target}`}</button>)}</div>
      </div>
      <div className="nz-history-head"><div><div className="nz-sect">Stage history</div><span>Immutable transition record</span></div><b>{job.stageHistory.length}</b></div>
      {job.stageHistory.length === 0 ? <div className="nz-history-empty">No recorded transitions yet. The first stage change will appear here.</div> : <ol className="nz-stage-history">{job.stageHistory.map((event) => <li key={event.id}><i aria-hidden="true"/><div><b>{event.fromStage} → {event.toStage}</b>{event.note&&<p>{event.note}</p>}<span>{new Date(event.occurredAt).toLocaleString("en-GB")} · {event.actorId}</span></div></li>)}</ol>}
    </div>
  </div>;
}
