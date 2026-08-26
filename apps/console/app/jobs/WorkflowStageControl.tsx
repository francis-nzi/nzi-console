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
    setPending(toStage); setNotice(null);
    const result = await postBrowserCommand<{ toStage: string; version: number }>("/api/isolated/commands/jobs/stage", {
      jobId: job.header.id, fromStage: job.header.workflowStage, toStage, expectedVersion: job.header.version, ...(note.trim() ? { note: note.trim() } : {}),
    }, crypto.randomUUID());
    setPending(null);
    if (result.state === "success") { setNote(""); setNotice({ kind: "ok", text: `Workflow moved to ${result.data.toStage}.` }); router.refresh(); return; }
    setNotice({ kind: "warn", text: result.state === "validation_failed" ? result.issues[0]?.message ?? result.message : result.message });
  }

  return <div className="nz-body" style={{ paddingTop: 16, paddingBottom: 0 }}>
    <div className="nz-panel nz-workflow-control">
      <div className="nz-workflow-heading">
        <div style={{ flex: 1 }}><b>Workflow stage</b><div className="sub" style={{ marginTop: 4 }}>Version {job.header.version} · adjacent transitions only · every move is audited.</div></div>
        <span className="nz-st done">{job.header.workflowStage}</span>
      </div>
      <div className="nz-stepper" style={{ padding: "16px 0 4px" }}>{stages.map((stage, index) => <div key={stage} className={`nz-step ${index === activeIndex ? "active" : index < activeIndex ? "done" : "todo"}`}><span className="n">{index < activeIndex ? "✓" : index + 1}</span><span className="lb">{stage}</span>{index < stages.length - 1 && <span className="bar" />}</div>)}</div>
      {notice && <div className={`nz-banner ${notice.kind}`} style={{ marginTop: 12 }}><div>{notice.text}</div></div>}
      <div className="nz-workflow-actions">
        <label><span className="nz-sr-only">Transition note</span><input className="nz-inp" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Transition note (recommended)" /></label>
        <div style={{ display: "flex", gap: 8 }}>{targets.map((target) => <button key={target} className={`nz-btn ${stages.indexOf(target) > activeIndex ? "pri" : ""}`} disabled={pending !== null} onClick={() => move(target)}>{pending === target ? "Moving…" : `${stages.indexOf(target) < activeIndex ? "Back to" : "Move to"} ${target}`}</button>)}</div>
      </div>
      <div className="nz-sect">Stage history</div>
      {job.stageHistory.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>No recorded transitions yet.</div> : job.stageHistory.map((event) => <div className="nz-kv" key={event.id}><span className="k">{new Date(event.occurredAt).toLocaleString("en-GB")}<br /><small>{event.actorId}</small></span><span className="v">{event.fromStage} → {event.toStage}{event.note ? <><br /><small>{event.note}</small></> : null}</span></div>)}
    </div>
  </div>;
}
