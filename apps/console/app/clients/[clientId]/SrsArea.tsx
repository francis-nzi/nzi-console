"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { patchBrowserCommand, postBrowserCommand } from "@nzi/api-client";
import { SrsDial, SrsMeter, SrsPillarTable, SrsRadar, SrsScaleKey, SrsTrend } from "@nzi/charts";
import { Collapsible, Drawer, GatedButton, InfoTip } from "@nzi/ui";
import {
  comparePriority, gaps as resolveGaps, priorityLabels, srsBridgedBy, srsDashboard, strategiesBySrsRequirement, strategyStatusLabels,
  type ClientStrategy, type SrsAssessment, type SrsDashboardModel, type SrsFramework, type SrsGapSuggestion,
} from "@nzi/contracts";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { CardHead, Empty } from "./OverviewArea";
import { SrsWizard } from "./SrsAssessmentForms";
import { SrsReviewLine } from "./SrsReviewLine";
import { SrsConversation, SrsReviewRequestBanner } from "./SrsConversation";
import { portalFeatureEnabled } from "../../lib/portalFlags";
import type { SrsDrawerRequest } from "./srsDrawers";
import { gapsByPriority, pillarSummary } from "./srsWizard";

/**
 * UK SRS Readiness — the CRM readiness dashboard (SRS S2), on S1's model.
 *
 * In the order the brief sets: the headline (overall maturity and a KPI tile per pillar) → the four dials → the radar
 * with its table → the requirement heatmap → the reassessment trend → the Metrics & targets read-through, the roadmap
 * and the "Future" benchmark → the register. It **reads** S1's weighted rollups through `srsDashboard` (the same model
 * the client portal renders) and writes nothing but what it already did: answering and completing.
 *
 * **One scale.** Every graphic is on the five-step ladder (0–4), one validated ordinal ramp, with the number and the step
 * name beside every colour; the scale key is always on screen. **An assessment in progress** is drawn — its provisional
 * scores hatched and dashed, under a banner that says "In progress · n of m addressed · not yet assessed" — never as a
 * verdict, and never with an assessed date. The portal and the report read completed assessments only.
 */

export function SrsArea({ workspace, access, onDrawer, onSaved }: {
  workspace: ClientWorkspaceReadModel;
  access: EditAccess;
  onDrawer: (request: SrsDrawerRequest) => void;
  /** A command from the area itself (completing the assessment) — the workspace's notice and refresh. */
  onSaved: (text: string) => void;
}) {
  const { framework, assessments } = workspace.srs;
  // The one being worked on, else the most recent record.
  const current = assessments.find((assessment) => assessment.status === "draft") ?? assessments[0] ?? null;

  // The guided assessment. Conducting is a modal over this page; the page itself only reviews (and spot-edits through it).
  const [wizard, setWizard] = useState<{ assessmentId: string; startAt: string | null; nonce: number } | null>(null);
  const closeWizard = useRef<(() => void) | null>(null);
  const openWizard = (assessmentId: string, startAt: string | null = null) => setWizard({ assessmentId, startAt, nonce: Date.now() });
  // Starting an assessment lands in the wizard: open it as soon as the new draft arrives with the refreshed workspace.
  const [openOnArrival, setOpenOnArrival] = useState(false);
  useEffect(() => {
    if (openOnArrival && current?.status === "draft") { setOpenOnArrival(false); openWizard(current.assessmentId); }
  }, [openOnArrival, current]);
  const wizardAssessment = wizard ? assessments.find((entry) => entry.assessmentId === wizard.assessmentId) ?? null : null;
  const wizardDrawer = wizard && wizardAssessment && framework
    ? <Drawer open onClose={() => closeWizard.current?.()} ariaLabel="Guided SRS readiness assessment" className="nz-srs-wizard">
      <SrsWizard key={wizard.nonce} framework={framework} assessment={wizardAssessment} startAt={wizard.startAt} access={access} plan={workspace.strategies.plan}
        closeRef={closeWizard}
        onClose={(changed) => { setWizard(null); if (changed) onSaved("Assessment progress saved."); }}
        onBridge={(requirementId) => onDrawer({ kind: "srs-bridge", assessment: wizardAssessment, requirementId })}
        onCompleted={(assessedOn) => { setWizard(null); onSaved(`Assessment complete — assessed ${formatDate(assessedOn)}.`); }} />
    </Drawer> : null;

  if (!framework) {
    return <section className="nz-panel">
      <div className="nz-cw-vhead"><h2>UK SRS Readiness</h2></div>
      <Empty text="No SRS framework is published for this organisation, so there is nothing to assess against. An administrator publishes the framework — standards, pillars, requirements, weights and the maturity ladder — and it is versioned from then on." />
    </section>;
  }
  if (!current) return <SrsEmpty framework={framework} clientId={workspace.client.id} access={access} onSaved={onSaved} onStarted={() => setOpenOnArrival(true)} />;

  return <>
    <SrsDashboard workspace={workspace} framework={framework} current={current} assessments={assessments} access={access} onDrawer={onDrawer} onSaved={onSaved}
      onWizard={openWizard} onStarted={() => setOpenOnArrival(true)} />
    {wizardDrawer}
  </>;
}

function SrsEmpty({ framework, clientId, access, onSaved, onStarted }: { framework: SrsFramework; clientId: string; access: EditAccess; onSaved: (text: string) => void; onStarted: () => void }) {
  const climate = framework.standards.find((standard) => standard.climateLed);
  const fromNzi = framework.requirements.filter((requirement) => requirement.active && requirement.source === "nzi-data").length;
  return <>
    <div className="nz-cw-vhead"><div><h2>UK SRS Readiness</h2></div>
      <InfoTip label="starting an assessment">
        <p>Requirements the client&apos;s own verified record already answers — the emissions, their targets and its intensity metrics — are filled in from that record rather than asked again ({fromNzi} of them). Each is marked as resolved from NZI data, carries the record it came from as evidence, and can be overridden inside the assessment.</p>
        <p>The assessment is stamped with {framework.label} version {framework.version}, so a later framework change never restates what was assessed today. It is opened today and saved as you go, and is dated as assessed only when every requirement has been addressed and you complete it — until then it reads as in progress.</p>
        <p>Assessing is gated on <b>srs.manage</b> and every answer is audited. The framework itself is Admin-managed and versioned.</p>
      </InfoTip><span style={{ flex: 1 }} />
      <StartButton clientId={clientId} access={access} onSaved={onSaved} onStarted={onStarted} label="Start assessment" /></div>
    <p className="nz-cw-vsub">How ready this client is against the UK Sustainability Reporting Standards, and what the path looks like.</p>
    <section className="nz-panel">
      <CardHead eyebrow="Not assessed yet" title="No readiness assessment" />
      <div className="nz-card-b">
        <p className="sub" style={{ margin: "8px 0" }}>This client has not been assessed. An assessment works through <b>{framework.requirements.filter((requirement) => requirement.active).length} requirements</b> across {framework.pillars.length} pillars, {climate ? <>led by <b>{climate.label}</b></> : null} — scoring each on the five-step ladder with its evidence.</p>
      </div>
    </section>
  </>;
}

/**
 * One click starts the assessment — the same gated, audited `srs.assessment.start` command the drawer ran, with the
 * client's-record pre-fill on (`prefillFromNziData: true`): the requirements its verified record answers arrive resolved
 * from NZI data, carrying that record as evidence, and are overridden per answer inside the assessment.
 */
function StartButton({ clientId, access, onSaved, onStarted, label, primary = true }: {
  clientId: string; access: EditAccess; onSaved: (text: string) => void; onStarted: () => void; label: string; primary?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  async function start() {
    setPending(true); setError(null);
    key.current ??= crypto.randomUUID();
    const result = await postBrowserCommand<{ assessmentId: string; prefilled: number }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/srs-assessments`,
      { notes: "", prefillFromNziData: true }, key.current);
    setPending(false);
    if (result.state !== "success") {
      key.current = null;
      setError(result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message);
      return;
    }
    key.current = null;
    onStarted();
    onSaved(result.data.prefilled > 0
      ? `Assessment started — ${result.data.prefilled} requirements answered from this client's own record.`
      : "Assessment started.");
  }
  return <>
    <GatedButton className={primary ? "nz-btn pri" : "nz-btn"} blocked={pending || access.state !== "allowed"}
      blockedReason={pending ? "Starting…" : access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
      onClick={() => void start()}>{pending ? "Starting…" : label}</GatedButton>
    {error ? <span className="nz-banner warn" role="alert">{error}</span> : null}
  </>;
}

const signed = (delta: number | null) => delta === null ? null : delta === 0 ? "no change" : `${delta > 0 ? "▲ +" : "▼ −"}${Math.abs(delta).toFixed(1)}`;
const shortPillar = (label: string) => label.length <= 11 ? label : label.replace(/\bmanagement\b/i, "mgmt").replace(/\s*&\s*targets$/i, "").slice(0, 12).trim();

function SrsDashboard({ workspace, framework, current, assessments, access, onDrawer, onSaved, onWizard, onStarted }: {
  workspace: ClientWorkspaceReadModel;
  framework: SrsFramework;
  current: SrsAssessment;
  assessments: SrsAssessment[];
  access: EditAccess;
  onDrawer: (request: SrsDrawerRequest) => void;
  onSaved: (text: string) => void;
  /** Open the guided assessment on an assessment, at a requirement (a row's Edit) or at the first still to address. */
  onWizard: (assessmentId: string, startAt?: string | null) => void;
  onStarted: () => void;
}) {
  const { client } = workspace;
  // SRS messaging (Phase B): the client's conversation about readiness, with the conversations.
  const conversation = portalFeatureEnabled("portal-conversations") ? workspace.srs.thread ?? null : null;
  // The filter row (R10): which standard, which assessment. The one in progress (or the latest) leads.
  const [standardKey, setStandardKey] = useState<string | null>(null);
  const [assessmentId, setAssessmentId] = useState(current.assessmentId);
  const [dialsAs, setDialsAs] = useState<"dials" | "meters">("dials");
  const [trendBy, setTrendBy] = useState<"overall" | "pillar">("overall");
  const [showTable, setShowTable] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setShowTable((now) => ({ ...now, [key]: !now[key] }));

  const assessment = assessments.find((entry) => entry.assessmentId === assessmentId) ?? current;
  // S3 (from the S2 review): each assessment read against the framework version it was made against.
  const frameworks = useMemo(() => new Map(workspace.srs.frameworks.map((version) => [version.frameworkId, version])), [workspace.srs.frameworks]);
  const model = useMemo(() => srsDashboard(framework, assessment, assessments, { standardKey, frameworks }), [framework, assessment, assessments, standardKey, frameworks]);
  const provisional = model.assessment.provisional;
  const strategiesByRequirement = useMemo(() => strategiesBySrsRequirement(workspace.strategies.plan), [workspace.strategies.plan]);
  const gaps = useMemo(() => gapsByPriority(resolveGaps(framework, assessment.items), assessment.items).filter((gap) => !standardKey || gap.requirement.standardKey === standardKey), [framework, assessment, standardKey]);

  const gapPriority = useMemo(() => new Map(assessment.items.map((item) => [item.requirementId, item.priority])), [assessment]);

  // Reopen to correct: the same assessment goes back to a draft (no new round, no new trend point), through the gated command.
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const inProgress = assessments.find((entry) => entry.status === "draft") ?? null;
  async function reopen() {
    setReopening(true); setReopenError(null);
    const result = await patchBrowserCommand(`/api/isolated/srs-assessments/${encodeURIComponent(assessment.assessmentId)}`,
      { expectedVersion: assessment.version }, crypto.randomUUID());
    setReopening(false);
    if (result.state !== "success") { setReopenError(result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message); return; }
    onSaved("Assessment reopened. It is a draft again, so the portal and reports show the previous completed assessment (or none) until you complete it.");
  }
  const currentCompletion = useMemo(() => srsDashboard(framework, current, assessments).assessment, [framework, current, assessments]);
  const tableRows = model.pillars.map((pillar) => ({ label: pillar.label, level: pillar.level, stepName: pillar.stepName, target: pillar.targetLevel, delta: pillar.delta }));
  const standardLabel = standardKey ? model.standards.find((standard) => standard.key === standardKey)?.label ?? standardKey : "S1 and S2";

  return <>
    <div className="nz-cw-vhead"><div><h2>UK SRS Readiness</h2></div>
      <InfoTip label="this assessment">
        <p>Each assessment is measured against {model.frameworkLabel} version {model.frameworkVersion}; the version is stamped on it, so a later framework change never restates what was assessed. It is dated as assessed only when every requirement has been addressed and it is completed — until then it reads as in progress.</p>
        <p>Requirements the client&apos;s verified record answers are filled in from it and marked resolved from NZI data; override any of them with Assess.</p>
        <p>Assessing is gated on <b>srs.manage</b> and every answer is audited. The framework is Admin-managed and versioned.</p>
      </InfoTip><span style={{ flex: 1 }} />
      <span className={current.status === "draft" ? "nz-st need" : "nz-st done"}>{current.status === "draft" ? `In progress · ${currentCompletion.addressed} of ${currentCompletion.total} addressed` : "Assessed"}</span>
      {current.status === "draft"
        // Conducting the assessment is the guided wizard; it is completed on its last screen (dated on completion, S1 R3).
        ? <GatedButton className="nz-btn pri" blocked={access.state !== "allowed"} blockedReason={access.state === "allowed" ? undefined : access.reason}
          reasonClassName="hint nz-gated-reason" onClick={() => onWizard(current.assessmentId)}>Continue assessment</GatedButton>
        // A completed assessment is a record; reassessing starts a new one, which is what gives readiness a trend.
        : <>
          {/* Only the latest assessment can be reopened (the command refuses an older one, NOT_LATEST): an earlier one may have a report issued against it. */}
          {assessment.status === "complete" && assessment.assessmentId === current.assessmentId
            ? <GatedButton className="nz-btn" blocked={access.state !== "allowed" || reopening || inProgress !== null}
              blockedReason={access.state !== "allowed" ? access.reason : inProgress ? "Another assessment is in progress for this client — complete it first." : reopening ? "Reopening…" : undefined}
              reasonClassName="hint nz-gated-reason" onClick={() => void reopen()}>{reopening ? "Reopening…" : "Reopen to correct"}</GatedButton> : null}
          <StartButton clientId={client.id} access={access} onSaved={onSaved} onStarted={onStarted} label="Reassess" primary={false} />
        </>}
      {/* S3, R5: the report — from the latest completed assessment, as the UK SRS template draws it. */}
      {assessments.some((entry) => entry.status === "complete")
        ? <a className="nz-btn" href={`/clients/${encodeURIComponent(client.id)}/srs-report?template=uk-srs${model.assessment.assessedOn ? `&assessment=${encodeURIComponent(model.assessment.id)}` : ""}`}>Readiness report (PDF)</a>
        : null}
    </div>
    {reopenError ? <div className="nz-banner warn" role="alert">{reopenError}</div> : null}
    <p className="nz-cw-vsub">{client.name} · {model.assessment.assessedOn
      ? <>assessed {formatDate(model.assessment.assessedOn)} · scores locked · overall {model.overall.stepName} ({model.overall.level.toFixed(1)} of 4)</>
      : <>started {formatDate(model.assessment.startedOn)} · not yet assessed</>} · consultant-led by {assessment.assessedBy}.</p>
    {/* The review loop (Phase A): the latest completed assessment's review date and its reminder to the client manager. */}
    {workspace.srs.review && workspace.srs.review.assessmentId === current.assessmentId
      ? <SrsReviewLine review={workspace.srs.review} access={access} onSaved={onSaved} /> : null}
    {/* SRS messaging (Phase B): a review the client asked for, surfaced beside Reopen / Reassess. */}
    {conversation ? <SrsReviewRequestBanner thread={conversation} /> : null}

    {/* The filter row (R10): which standard, which assessment — one row, above every graphic. */}
    <div className="nz-srs-filters" role="group" aria-label="Readiness filters">
      <label>Standard <select className="nz-sel" value={standardKey ?? ""} onChange={(event) => setStandardKey(event.target.value || null)}>
        <option value="">Both — S2 climate-led, S1 general</option>
        {model.standards.map((standard) => <option key={standard.key} value={standard.key}>{standard.label}</option>)}
      </select></label>
      <label>Assessment <select className="nz-sel" value={assessmentId} onChange={(event) => setAssessmentId(event.target.value)}>
        {assessments.map((entry) => <option key={entry.assessmentId} value={entry.assessmentId}>
          {entry.status === "complete" && entry.assessedOn ? `Assessed ${formatDate(entry.assessedOn)}` : `In progress — started ${formatDate(entry.startedOn)}`}
        </option>)}
      </select></label>
      <span className="sp" />
      <SrsScaleKey ladder={model.ladder} provisional={provisional} />
    </div>

    {/* R11: a draft's scores are provisional — said once, loudly, and drawn hatched below. */}
    {provisional ? <div className="nz-srs-provisional" role="status">
      <b>In progress · {model.assessment.addressed} of {model.assessment.total} addressed · not yet assessed.</b> The scores below are provisional — hatched and dashed —
      and change as the assessment is worked through. The client portal and reports show completed assessments only.
    </div> : null}

    {/* R1: the headline — overall maturity on the ladder, then a tile per pillar. Numbers first. */}
    <section className={`nz-panel nz-srs-headline${provisional ? " provisional" : ""}`} aria-label="Readiness headline">
      <div className="nz-srs-hero2">
        <div className="l">Overall maturity · {standardLabel}</div>
        <div className="v num">{model.overall.level.toFixed(1)}<small> of 4</small></div>
        <div className="step"><span className="nz-srs-chip" data-step={model.overall.step}>{model.overall.step}</span> {model.overall.stepName}{provisional ? " · provisional" : ""}</div>
        <div className="d">{provisional ? "Change is shown once this assessment is complete"
          : signed(model.overall.delta) ? <>{signed(model.overall.delta)} since the previous assessment</> : "No earlier assessment to compare"}</div>
      </div>
      <div className="nz-srs-kpis">{model.pillars.map((pillar) => <div className="nz-srs-kpi" key={pillar.key}>
        <div className="l">{pillar.label}</div>
        <div className="v num">{pillar.level.toFixed(1)}</div>
        <div className="step"><span className="nz-srs-chip" data-step={pillar.step}>{pillar.step}</span> {pillar.stepName}</div>
        <div className="d">{signed(pillar.delta) ?? "—"}<span className="muted"> · target {pillar.targetLevel}</span></div>
      </div>)}</div>
    </section>

    {/* R2: the dials — with the linear meters as the compact equivalent, and the table view. */}
    <section className="nz-panel">
      <CardHead title="By pillar" right={<span className="nz-srs-seg" role="group" aria-label="Show as">
        <button type="button" aria-pressed={dialsAs === "dials"} onClick={() => setDialsAs("dials")}>Dials</button>
        <button type="button" aria-pressed={dialsAs === "meters"} onClick={() => setDialsAs("meters")}>Meters</button>
        <button type="button" aria-pressed={Boolean(showTable.dials)} onClick={() => toggle("dials")}>Table</button>
      </span>} />
      <div className="nz-card-b">
        {dialsAs === "dials"
          ? <div className="nz-srs-dials">{model.pillars.map((pillar) => <SrsDial key={pillar.key} label={pillar.label} level={pillar.level} stepName={pillar.stepName} target={pillar.targetLevel} provisional={provisional} />)}</div>
          : <SrsMeter rows={model.pillars.map((pillar) => ({ label: pillar.label, level: pillar.level, stepName: pillar.stepName, target: pillar.targetLevel }))} provisional={provisional} />}
        {showTable.dials ? <SrsPillarTable rows={tableRows} caption={`Maturity by pillar — ${standardLabel}`} provisional={provisional} /> : null}
      </div>
    </section>

    <div className="nz-cw-grid">
      <div className="nz-cw-col">
        {/* R3: the radar — four fixed axes, the client and the target, and its table beside it (always). */}
        <section className="nz-panel">
          <CardHead title="The readiness web" right={<span className="hint">4 pillars · ≤ 2 shapes</span>} />
          <div className="nz-card-b nz-srs-radar2">
            <SrsRadar axes={model.pillars.map((pillar) => ({ label: shortPillar(pillar.label), value: pillar.level, target: pillar.targetLevel }))}
              seriesLabel={client.name.length > 24 ? "This client" : client.name} provisional={provisional} />
            <SrsPillarTable rows={tableRows} caption="The same four numbers" provisional={provisional} />
          </div>
        </section>
      </div>
      <div className="nz-cw-col">
        {/* R5: the trend — completed assessments only; one assessment is one point. */}
        <section className="nz-panel">
          <CardHead title="Readiness over time" right={<span className="nz-srs-seg" role="group" aria-label="Trend by">
            <button type="button" aria-pressed={trendBy === "overall"} onClick={() => setTrendBy("overall")}>Overall</button>
            <button type="button" aria-pressed={trendBy === "pillar"} onClick={() => setTrendBy("pillar")}>By pillar</button>
            <button type="button" aria-pressed={Boolean(showTable.trend)} onClick={() => toggle("trend")}>Table</button>
          </span>} />
          <div className="nz-card-b">
            {trendBy === "overall"
              ? <SrsTrend title="Overall maturity" points={model.trend.overall.map((point) => ({ label: formatDate(point.assessedOn), level: point.level }))} />
              : <div className="nz-srs-multiples">{model.pillars.map((pillar) => <div key={pillar.key}>
                <div className="hint">{pillar.label}</div>
                <SrsTrend compact title={pillar.label} points={(model.trend.byPillar[pillar.key] ?? []).map((point) => ({ label: formatDate(point.assessedOn), level: point.level }))} />
              </div>)}</div>}
            <p className="nz-maps">{model.trend.overall.length <= 1
              ? "One completed assessment so far — a single point. The line appears on reassessment; an assessment in progress is not on it."
              : "Completed assessments only, on the 0–4 ladder. An assessment in progress is not plotted."}</p>
            {showTable.trend ? <table className="nz-srs-table"><caption>Overall maturity by assessment</caption>
              <thead><tr><th scope="col">Assessed</th><th scope="col">Maturity (of 4)</th></tr></thead>
              <tbody>{model.trend.overall.map((point) => <tr key={point.assessmentId}><th scope="row">{formatDate(point.assessedOn)}</th><td className="num">{point.level.toFixed(1)}</td></tr>)}</tbody>
            </table> : null}
          </div>
        </section>
      </div>
    </div>


    <div className="nz-cw-grid">
      <div className="nz-cw-col">
        <MetricsReadThrough model={model} />
        <section className="nz-panel">
          <CardHead title="Sector comparison" right={<span className="nz-st est">Future</span>} />
          <div className="nz-card-b">
            {/* R8: truthful — what it will show, never an invented number and no bar that reads as data. */}
            <div className="nz-srs-future">
              {model.benchmark.state === "future"
                ? <><b>Future.</b> When a defensible peer dataset exists, this will place the client against its sector by percentile. Until then there is deliberately no figure here — no invented comparisons. {model.benchmark.reason}</>
                : <>This client sits at the <b>{model.benchmark.percentile}th percentile</b> for {model.benchmark.sectorKey}, per {model.benchmark.source}.</>}
            </div>
          </div>
        </section>
      </div>
      <div className="nz-cw-col">
        <section className="nz-panel">
          <CardHead title="Path to SRS-ready" right={<span className="hint">by priority · gaps → actions</span>} />
          <div style={{ padding: "6px 16px 12px" }}>
            {gaps.length === 0
              ? <p className="sub" style={{ margin: "6px 0" }}>No requirement sits below its target. Reassess as the framework moves.</p>
              : gaps.slice(0, 8).map((gap) => <div className="nz-srs-rm" key={gap.requirement.id}>
                <span className="dot" aria-hidden="true" />
                <div>
                  <div className="nm">{gap.requirement.title}</div>
                  <div className="sub">{framework.pillars.find((pillar) => pillar.key === gap.requirement.pillarKey)?.label} · {gap.requirement.standardKey}
                    {gap.owner ? ` · owner ${gap.owner}` : ""}
                    {gapPriority.get(gap.requirement.id) ? ` · ${priorityLabels[gapPriority.get(gap.requirement.id)!]} priority` : ""}</div>
                  <AlignedStrategies strategies={strategiesByRequirement.get(gap.requirement.id) ?? []} />
                </div>
                <span className="d">{gap.dueDate ? formatDate(gap.dueDate) : "No date"}</span>
              </div>)}
            {gaps.length > 8 ? <p className="nz-maps">{gaps.length - 8} further gaps are in the register.</p> : null}
          </div>
        </section>
      </div>
    </div>

    <SrsRegister model={model} assessment={assessment} framework={framework} access={access} onDrawer={onDrawer} onWizard={onWizard} standardKey={standardKey} strategiesByRequirement={strategiesByRequirement}
      plan={workspace.strategies.plan} suggestions={workspace.srs.suggestions} />
    {conversation ? <SrsConversation clientId={client.id} thread={conversation} access={access} onSaved={onSaved} /> : null}
  </>;
}


/**
 * R7: Metrics & targets as the client's assured NZI record answered it — read through with its provenance (the evidence
 * each pre-filled answer carries), not re-keyed and not redrawn as new numbers.
 */
function MetricsReadThrough({ model }: { model: SrsDashboardModel }) {
  const fromData = model.requirements.filter((requirement) => requirement.source === "auto");
  return <section className="nz-panel">
    <CardHead title="From the verified NZI record" right={<span className="hint">read-through · not re-keyed</span>} />
    <div style={{ padding: "6px 16px 12px" }}>
      {fromData.length === 0
        ? <p className="sub" style={{ margin: "6px 0" }}>Nothing in this assessment was answered from the client&apos;s verified record — no verified emissions, targets or intensity metrics were held when it was started, so the consultant answered every requirement.</p>
        : fromData.map((requirement) => <div className="nz-kv" key={requirement.id}>
          <span className="k"><b>{requirement.code}</b> {requirement.title}</span>
          <span className="v"><span className="nz-srs-chip" data-step={requirement.maturity ?? 0}>{requirement.maturity ?? "–"}</span> {requirement.stepName ?? "—"}
            <span className="muted"> · {requirement.evidence?.note || requirement.evidence?.ref || "NZI record"}</span></span>
        </div>)}
    </div>
  </section>;
}

/** What this client is actually doing about a requirement — the strategies, named, rather than "a link exists". */
function AlignedStrategies({ strategies }: { strategies: readonly ClientStrategy[] }) {
  if (strategies.length === 0) return <div className="nz-srs-align none">No strategy yet</div>;
  return <div className="nz-srs-align">
    {strategies.map((strategy) => <span key={strategy.id} className="s">
      <b>{strategy.title}</b> <span className="muted">{strategyStatusLabels[strategy.status]}</span>
    </span>)}
  </div>;
}

type SortKey = "order" | "code" | "maturity" | "gap" | "priority" | "due";

/**
 * R6: the register — every requirement with its score, evidence, owner, due and priority, sortable: the always-available
 * non-chart view, and the one per-requirement surface on this page. It is cut into collapsible pillar sections, collapsed
 * by default, each header carrying that pillar's rollup. Nothing is scored here: **Edit** opens the guided assessment at
 * that question (**View**, read-only, once the assessment is complete). Its last column is the **gap→action hook** (S3, R1):
 * what bridges the gap — an action written from it (`srs_gap`, naming the requirement) or the one the assessment links —
 * else the strategies that advance it; and on an unbridged gap, **Bridge this gap**: the library's aligned actions first, AI
 * ideas second, or your own.
 */
function SrsRegister({ model, assessment, framework, access, onDrawer, onWizard, strategiesByRequirement, plan, suggestions, standardKey }: {
  model: SrsDashboardModel; assessment: SrsAssessment; framework: SrsFramework; access: EditAccess; onDrawer: (request: SrsDrawerRequest) => void;
  onWizard: (assessmentId: string, startAt?: string | null) => void;
  strategiesByRequirement: Map<string, ClientStrategy[]>; plan: readonly ClientStrategy[]; suggestions: readonly SrsGapSuggestion[]; standardKey: string | null;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "order", dir: 1 });
  const order = new Map(model.requirements.map((requirement, index) => [requirement.id, index]));
  const sorted = [...model.requirements].sort((a, b) => {
    const by: Record<SortKey, number> = {
      order: order.get(a.id)! - order.get(b.id)!,
      code: a.code.localeCompare(b.code),
      maturity: (a.maturity ?? -1) - (b.maturity ?? -1),
      gap: Number(b.gap) - Number(a.gap) || ((a.maturity ?? -1) - a.target) - ((b.maturity ?? -1) - b.target),
      priority: comparePriority(a.priority, b.priority),
      due: (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
    };
    return (by[sort.key] || order.get(a.id)! - order.get(b.id)!) * sort.dir;
  });
  const header = (key: SortKey, label: string) => <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
    <button type="button" className="nz-srs-sort" onClick={() => setSort((now) => ({ key, dir: now.key === key ? (now.dir === 1 ? -1 : 1) : 1 }))}>{label}{sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}</button>
  </th>;
  const editable = assessment.status === "draft";
  const pillars = [...framework.pillars].sort((a, b) => a.ordering - b.ordering)
    .map((pillar) => ({ pillar, rows: sorted.filter((requirement) => requirement.pillarKey === pillar.key) })).filter((group) => group.rows.length > 0);

  return <section className="nz-panel" style={{ marginTop: 16 }}>
    <CardHead title="Requirement register" right={<span className="hint">{model.requirements.length} requirements · sortable</span>} />
    <div className="nz-card-b">
      {pillars.map(({ pillar, rows }) => <Collapsible key={pillar.key} title={pillar.label} count={pillarSummary(framework, pillar.key, assessment.items, standardKey).text}>
        <div className="nz-srs-tablewrap">
          <table className="nz-tbl nz-srs-register">
            <thead><tr>{header("code", "Requirement")}{header("maturity", "Maturity")}<th scope="col">Target</th><th scope="col">Evidence</th>{header("priority", "Priority")}<th scope="col">Owner</th>{header("due", "Due")}{header("gap", "Gap → action")}<th /></tr></thead>
            <tbody>
              {rows.map((requirement) => {
                const bridged = srsBridgedBy(requirement.id, plan, requirement.linkedActionId ?? null);
                const aligned = (strategiesByRequirement.get(requirement.id) ?? []).filter((strategy) => !bridged.some((action) => action.id === strategy.id));
                const ideas = suggestions.filter((idea) => idea.assessmentId === assessment.assessmentId && idea.requirementId === requirement.id).length;
                return <tr key={requirement.id}>
                  <td><b>{requirement.title}</b>{requirement.helpText ? <InfoTip label={`About ${requirement.code}`}>{requirement.helpText}</InfoTip> : null}
                    <div className="muted">{requirement.code} · {requirement.standardKey}{requirement.source === "auto" ? " · from NZI data" : ""}</div></td>
                  <td>{requirement.maturity === null ? <span className="muted">Not answered</span>
                    : <><span className="nz-srs-chip" data-step={requirement.maturity}>{requirement.maturity}</span> {requirement.stepName}{model.assessment.provisional ? <span className="muted"> · provisional</span> : null}</>}</td>
                  <td className="num">{requirement.target}</td>
                  <td>{requirement.evidence ? <span title={requirement.evidence.note}>{requirement.evidence.kind} · {(requirement.evidence.ref ?? requirement.evidence.note).slice(0, 40)}</span> : <span className="up">none</span>}</td>
                  <td>{requirement.priority ? priorityLabels[requirement.priority] : <span className="muted">—</span>}</td>
                  <td>{requirement.owner || <span className="muted">—</span>}</td>
                  <td>{requirement.dueDate ? formatDate(requirement.dueDate) : <span className="muted">—</span>}</td>
                  <td>
                    {bridged.map((action) => <a key={action.id} className="nz-srs-hook" href="?area=strategies">Bridged by <b>{action.title}</b> <span className="muted">{strategyStatusLabels[action.status]}</span></a>)}
                    {aligned.length > 0 ? <AlignedStrategies strategies={aligned} /> : null}
                    {requirement.gap && bridged.length === 0
                      ? <GatedButton className="nz-btn sm nz-srs-bridge-btn" blocked={access.state !== "allowed"} blockedReason={access.state === "allowed" ? undefined : access.reason}
                        reasonClassName="hint nz-gated-reason" onClick={() => onDrawer({ kind: "srs-bridge", assessment, requirementId: requirement.id })}>
                        Bridge this gap{ideas > 0 ? ` · ${ideas} AI idea${ideas === 1 ? "" : "s"}` : ""}</GatedButton>
                      : bridged.length === 0 && aligned.length === 0 ? <span className="muted">—</span> : null}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {editable
                      ? <GatedButton className="nz-editlink" blocked={access.state !== "allowed"} blockedReason={access.state === "allowed" ? undefined : access.reason}
                        reasonClassName="hint nz-gated-reason" onClick={() => onWizard(assessment.assessmentId, requirement.id)}>Edit</GatedButton>
                      : <button type="button" className="nz-editlink" onClick={() => onWizard(assessment.assessmentId, requirement.id)}>View</button>}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </Collapsible>)}
    </div>
  </section>;
}
