"use client";

import { useState } from "react";
import { putBrowserCommandWithReason } from "@nzi/api-client";
import type { ApprovalPolicy } from "@nzi/isolated-backend";
import { CapabilityChip, TextAreaField } from "@nzi/ui";
import { formatDateTime } from "../../lib/formatDate";
import { statusOf, type ActionStatus } from "./actionStatus";
import { approvalPolicyStatement } from "./approvalPolicyText";

type Editing = { allowed: true } | { allowed: false; reason: string };

/** Organisation → Report approval: the in-app switch for NZC-022's separation of duties (0215). Always says why, and is audited. */
export function ApprovalPolicyCard({ policy, editing, status, report, saved }: {
  policy: ApprovalPolicy; editing: Editing; status: ActionStatus | undefined;
  report: (card: "approval", status: ActionStatus | null) => void; saved: (card: "approval", text: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [issue, setIssue] = useState<string | undefined>();
  const [asking, setAsking] = useState(false);
  const busy = status?.kind === "saving";
  const next = !policy.required;

  async function apply() {
    if (!reason.trim()) { setIssue("Say why — it is recorded in the audit log."); report("approval", { kind: "error", text: "A reason is required." }); return; }
    setIssue(undefined);
    report("approval", { kind: "saving", text: "Saving…" });
    const result = await putBrowserCommandWithReason<{ version: number; requireIndependentApproval: boolean }>(
      "/api/isolated/organisation/approval-policy", { requireIndependentApproval: next, expectedVersion: policy.version }, crypto.randomUUID(), reason);
    if (result.state !== "success") { report("approval", statusOf(result, "approval policy")); return; }
    setAsking(false); setReason("");
    saved("approval", result.data.requireIndependentApproval ? "Saved — independent approval is now required." : "Saved — independent approval is now off.");
  }

  const line = status && status.kind !== "saving"
    ? <span className={`nz-a-status ${status.kind}`} role={status.kind === "error" || status.kind === "conflict" ? "alert" : "status"}>{status.kind === "saved" ? "✓ " : ""}{status.text}</span> : null;

  return <div className="nz-a-section" data-approval-policy={policy.required ? "required" : "off"}>
    <h3>Report approval <CapabilityChip capability="admin.settings" /></h3>
    <p data-approval-statement>{approvalPolicyStatement(policy)}</p>
    <div className="nz-a-hint">Turning it off only lets a holder of the release capability (Admin, Reviewer) approve and publish what they prepared themselves; it does not give anyone that capability. Every change is recorded with its reason.{policy.updatedAt ? ` Last set ${formatDateTime(policy.updatedAt)} by ${policy.updatedBy}.` : ""}</div>
    {!asking ? <div className="nz-a-actions">
      {editing.allowed ? <button type="button" className={policy.required ? "nz-a-btn" : "nz-a-btn pri"} onClick={() => { report("approval", null); setAsking(true); }}>{policy.required ? "Turn independent approval off…" : "Turn independent approval on…"}</button> : null}
      {line}
    </div> : <div className="nz-a-subform">
      <TextAreaField label={next ? "Reason for requiring independent approval again" : "Reason for turning independent approval off"} hint="Required — it is recorded in the audit log." value={reason} rows={2} required error={issue} onChange={setReason} />
      <div className="nz-a-actions">
        <button type="button" className="nz-a-btn pri" disabled={busy} aria-busy={busy} onClick={() => void apply()}>{busy ? "Saving…" : next ? "Require independent approval" : "Turn independent approval off"}</button>
        <button type="button" className="nz-a-btn" disabled={busy} onClick={() => { setAsking(false); setReason(""); setIssue(undefined); report("approval", null); }}>Cancel</button>
        {line}
      </div>
    </div>}
  </div>;
}
