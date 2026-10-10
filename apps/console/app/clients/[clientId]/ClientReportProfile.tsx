"use client";

// Reporting F-1b (0164, R-D1) — the client's report profile: the order this client's reports issue in by default, and an
// optional line for the cover. It seeds a report's order when the report is validated; a report already validated or
// issued keeps its own (RULING-reporting-F Q3). A version is the whole profile — every save or withdraw writes the next one.
import { useRef, useState } from "react";
import { Collapsible, GatedButton } from "@nzi/ui";
import { postBrowserCommandWithReason, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { defaultReportSectionPlan, isReportDataSection, REPORT_ISSUER_LINE_MAX, reportIssuerLineIssues, reportOmittedSections, reportPlanSectionTitle, type ReportSectionPlan } from "@nzi/contracts";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { SectionPlanEditor } from "../../reports/SectionPlanEditor";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";

type Profile = ClientWorkspaceReadModel["reportProfile"];
const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;
const orderText = (plan: ReportSectionPlan) => {
  const order = plan.filter((entry) => entry.included && isReportDataSection(entry.key) && entry.key !== "cover")
    .map((entry) => reportPlanSectionTitle(entry.key)).join(" · ");
  // F-4b: what the profile leaves out is said beside the order, never only implied by its absence.
  const leftOut = reportOmittedSections(plan);
  return leftOut.length ? `${order} — left out: ${leftOut.join(", ")}` : order;
};

/** The card on the Overview: the profile in force, or the standard order every report starts from without one. */
export function ReportProfileCard({ profile, access, onEdit }: { profile: Profile; access: EditAccess; onEdit: () => void }) {
  const current = profile.current;
  return <Collapsible className="nz-panel nz-collapsible-card nz-report-profile" headingClassName="nz-card-h"
    title={<><span className="eyebrow">Reporting</span><h2>Report profile</h2></>}
    count={current ? `Version ${current.version}` : "Standard order"}>
    <div className="nz-card-b">
      {current
        ? <p className="sub">Version {current.version} · {current.setBy}, {formatDate(current.setAt)}. A report starts in this order when it is validated; one already validated or issued keeps its own.</p>
        : <p className="sub">No profile yet: this client&rsquo;s reports start in the standard order. A profile sets this client&rsquo;s own order, and a line for the cover.</p>}
      <div className="nz-kv"><span className="k">Order</span><span className="v">{orderText(current?.sectionPlan ?? defaultReportSectionPlan)}</span></div>
      {current?.issuerLine ? <div className="nz-kv"><span className="k">Cover line</span><span className="v">{current.issuerLine}</span></div> : null}
      {access.state === "allowed" ? <button type="button" className="nz-editlink" style={{ marginTop: 6 }} onClick={onEdit}>{current ? "Edit the profile" : "Set up a profile"}</button> : null}
    </div>
  </Collapsible>;
}

/** The editor: the order and the cover line — the next version on Save. Withdraw is here too, with a reason. */
export function ReportProfileForm({ clientId, profile, access, onClose, onSaved }: {
  clientId: string; profile: Profile; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [plan, setPlan] = useState<ReportSectionPlan>(profile.current?.sectionPlan ?? defaultReportSectionPlan);
  const [issuerLine, setIssuerLine] = useState(profile.current?.issuerLine ?? "");
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotency = useRef<string | null>(null);
  const path = `/api/isolated/clients/${encodeURIComponent(clientId)}/report-profile`;
  const line = issuerLine.trim() || null;
  const problem = reportIssuerLineIssues(line)[0]?.message ?? null;

  async function save() {
    setPending(true); setError(null);
    idempotency.current ??= crypto.randomUUID();
    const result = await putBrowserCommand<{ version: number }>(path, { expectedVersion: profile.latestVersion, sectionPlan: plan, issuerLine: line }, idempotency.current);
    setPending(false);
    if (result.state === "success") onSaved("Report profile saved. Reports validated from now on start in this order.");
    else { setError(errorText(result)); idempotency.current = null; }
  }
  async function withdraw() {
    setPending(true); setError(null);
    const result = await postBrowserCommandWithReason<{ version: number }>(`${path}/deactivate`, { expectedVersion: profile.latestVersion }, crypto.randomUUID(), reason.trim());
    setPending(false);
    if (result.state === "success") onSaved("Report profile withdrawn — kept in the record. Reports start in the standard order again.");
    else setError(errorText(result));
  }

  const blockedReason = access.state !== "allowed" ? access.reason : problem;
  return <>
    <div className="nz-dh"><div className="k">Reporting</div><h3>Report profile</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <p className="sub">Saving writes the next version; the one before stays in the record. It sets the order a report starts in when it is validated — a report already validated or issued keeps its own.</p>
      <SectionPlanEditor plan={plan} onChange={setPlan} disabled={pending} label="This client's section order" />
      <label className="nz-fl"><span>Cover line <span className="muted">· optional, e.g. &ldquo;Prepared for the Board of …&rdquo;</span></span>
        <input className="nz-inp" value={issuerLine} maxLength={REPORT_ISSUER_LINE_MAX} onChange={(e) => setIssuerLine(e.target.value)} /></label>
      {withdrawing ? <label className="nz-fl" style={{ marginTop: 10 }}><span>Why withdraw it? <span className="muted">· kept in the audit trail</span></span>
        <input className="nz-inp" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label> : null}
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    </div>
    <div className="nz-df">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
      {profile.current && access.state === "allowed"
        ? withdrawing
          ? <button type="button" className="nz-btn" disabled={pending || !reason.trim()} onClick={() => void withdraw()}>Withdraw profile</button>
          : <button type="button" className="nz-btn" onClick={() => { setWithdrawing(true); setReason(""); }}>Withdraw…</button>
        : null}
      <span className="sp" />
      {withdrawing ? null : <GatedButton className="nz-btn pri" blocked={pending || blockedReason !== null} blockedReason={pending ? "Saving…" : blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Saving…" : "Save profile"}</GatedButton>}
    </div>
  </>;
}
