"use client";

import { useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { SrsDial, SrsHeatmap, SrsMeter, SrsPillarTable, SrsRadar, SrsScaleKey, SrsTrend } from "@nzi/charts";
import { GatedButton, InfoTip } from "@nzi/ui";
import {
  gaps as resolveGaps, srsBridgedBy, srsDashboard, strategiesBySrsRequirement, strategyStatusLabels,
  type ClientStrategy, type SrsAssessment, type SrsDashboardModel, type SrsDashboardRequirement, type SrsFramework, type SrsGapSuggestion,
} from "@nzi/contracts";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { CardHead, Empty } from "./OverviewArea";
import type { SrsDrawerRequest } from "./srsDrawers";

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

  if (!framework) {
    return <section className="nz-panel">
      <CardHead eyebrow="Disclosure" title="UK SRS Readiness" />
      <Empty text="No SRS framework is published for this organisation, so there is nothing to assess against. An administrator publishes the framework — standards, pillars, requirements, weights and the maturity ladder — and it is versioned from then on." />
    </section>;
  }
  if (!current) return <SrsEmpty framework={framework} access={access} onDrawer={onDrawer} />;

  return <SrsDashboard workspace={workspace} framework={framework} current={current} assessments={assessments} access={access} onDrawer={onDrawer} onSaved={onSaved} />;
}

function SrsEmpty({ framework, access, onDrawer }: { framework: SrsFramework; access: EditAccess; onDrawer: (request: SrsDrawerRequest) => void }) {
  const climate = framework.standards.find((standard) => standard.climateLed);
  return <>
    <div className="nz-cw-vhead"><div><div className="eyebrow">Disclosure</div><h2>UK SRS Readiness</h2></div><span style={{ flex: 1 }} />
      <StartButton access={access} onDrawer={onDrawer} label="Start assessment" /></div>
    <p className="nz-cw-vsub">How ready this client is against the UK Sustainability Reporting Standards, and what the path looks like.</p>
    <section className="nz-panel">
      <CardHead eyebrow="Not assessed yet" title="No readiness assessment" />
      <div className="nz-card-b">
        <p className="sub" style={{ margin: "8px 0" }}>This client has not been assessed. An assessment works through <b>{framework.requirements.filter((requirement) => requirement.active).length} requirements</b> across {framework.pillars.length} pillars, {climate ? <>led by <b>{climate.label}</b></> : null} — scoring each on the five-step ladder with its evidence.</p>
        <p className="nz-maps">Requirements the client&apos;s own assured record already answers — the emissions, their targets and its intensity metrics — can be filled in from that record rather than asked again, each marked as resolved from NZI data.</p>
        <div className="nz-kv"><span className="k">Framework</span><span className="v">{framework.label} · version {framework.version}</span></div>
      </div>
    </section>
  </>;
}

function StartButton({ access, onDrawer, label }: { access: EditAccess; onDrawer: (request: SrsDrawerRequest) => void; label: string }) {
  return <GatedButton className="nz-btn pri" blocked={access.state !== "allowed"}
    blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason"
    onClick={() => onDrawer({ kind: "srs-start" })}>{label}</GatedButton>;
}

const signed = (delta: number | null) => delta === null ? null : delta === 0 ? "no change" : `${delta > 0 ? "▲ +" : "▼ −"}${Math.abs(delta).toFixed(1)}`;
const shortPillar = (label: string) => label.length <= 11 ? label : label.replace(/\bmanagement\b/i, "mgmt").replace(/\s*&\s*targets$/i, "").slice(0, 12).trim();

function SrsDashboard({ workspace, framework, current, assessments, access, onDrawer, onSaved }: {
  workspace: ClientWorkspaceReadModel;
  framework: SrsFramework;
  current: SrsAssessment;
  assessments: SrsAssessment[];
  access: EditAccess;
  onDrawer: (request: SrsDrawerRequest) => void;
  onSaved: (text: string) => void;
}) {
  const { client } = workspace;
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
  const gaps = useMemo(() => resolveGaps(framework, assessment.items).filter((gap) => !standardKey || gap.requirement.standardKey === standardKey), [framework, assessment, standardKey]);

  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  async function complete() {
    setCompleting(true); setCompleteError(null);
    const result = await postBrowserCommand<{ assessedOn: string }>(`/api/isolated/srs-assessments/${encodeURIComponent(current.assessmentId)}`,
      { expectedVersion: current.version }, crypto.randomUUID());
    setCompleting(false);
    if (result.state !== "success") { setCompleteError(result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message); return; }
    onSaved(`Assessment complete — assessed ${formatDate(result.data.assessedOn)}.`);
  }
  const currentCompletion = useMemo(() => srsDashboard(framework, current, assessments).assessment, [framework, current, assessments]);
  const completionReady = currentCompletion.addressed === currentCompletion.total && currentCompletion.total > 0;
  const tableRows = model.pillars.map((pillar) => ({ label: pillar.label, level: pillar.level, stepName: pillar.stepName, target: pillar.targetLevel, delta: pillar.delta }));
  const standardLabel = standardKey ? model.standards.find((standard) => standard.key === standardKey)?.label ?? standardKey : "S1 and S2";

  return <>
    <div className="nz-cw-vhead"><div><div className="eyebrow">Disclosure</div><h2>UK SRS Readiness</h2></div><span style={{ flex: 1 }} />
      <span className={current.status === "draft" ? "nz-st need" : "nz-st done"}>{current.status === "draft" ? `In progress · ${currentCompletion.addressed} of ${currentCompletion.total} addressed` : "Assessed"}</span>
      {current.status === "draft"
        ? <>
          <GatedButton className="nz-btn" blocked={access.state !== "allowed"} blockedReason={access.state === "allowed" ? undefined : access.reason}
            reasonClassName="hint nz-gated-reason" onClick={() => onDrawer({ kind: "srs-assess", assessment: current })}>Continue assessment</GatedButton>
          {/* Dated on completion (S1, R3): it can be completed only once every requirement is addressed. */}
          <GatedButton className="nz-btn pri" blocked={access.state !== "allowed" || !completionReady || completing}
            blockedReason={access.state !== "allowed" ? access.reason
              : !completionReady ? `${currentCompletion.total - currentCompletion.addressed} of ${currentCompletion.total} requirements still to address — an assessment is complete when every one has a maturity.` : undefined}
            reasonClassName="hint nz-gated-reason" onClick={() => void complete()}>{completing ? "Completing…" : "Complete assessment"}</GatedButton>
        </>
        // A completed assessment is a record; reassessing starts a new one, which is what gives readiness a trend.
        : <GatedButton className="nz-btn" blocked={access.state !== "allowed"} blockedReason={access.state === "allowed" ? undefined : access.reason}
          reasonClassName="hint nz-gated-reason" onClick={() => onDrawer({ kind: "srs-start" })}>Reassess</GatedButton>}
      {/* S3, R5: the report — from the latest completed assessment, as the UK SRS template draws it. */}
      {assessments.some((entry) => entry.status === "complete")
        ? <a className="nz-btn" href={`/clients/${encodeURIComponent(client.id)}/srs-report?template=uk-srs${model.assessment.assessedOn ? `&assessment=${encodeURIComponent(model.assessment.id)}` : ""}`}>Readiness report (PDF)</a>
        : null}
    </div>
    {completeError ? <div className="nz-banner warn" role="alert">{completeError}</div> : null}
    <p className="nz-cw-vsub">{client.name} · {model.assessment.assessedOn
      ? <>assessed {formatDate(model.assessment.assessedOn)}</>
      : <>started {formatDate(model.assessment.startedOn)} · not yet assessed — it is dated when every requirement is addressed</>} · consultant-led by {assessment.assessedBy} · measured against {model.frameworkLabel} version {model.frameworkVersion}.</p>

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
      <CardHead eyebrow="Maturity" title="By pillar" right={<span className="nz-srs-seg" role="group" aria-label="Show as">
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
          <CardHead eyebrow="Maturity" title="The readiness web" right={<span className="hint">4 pillars · ≤ 2 shapes</span>} />
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
          <CardHead eyebrow="Change" title="Readiness over time" right={<span className="nz-srs-seg" role="group" aria-label="Trend by">
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

    {/* R4: the heatmap — every requirement on the ramp, with its number; the register below is its table view. */}
    <section className="nz-panel">
      <CardHead eyebrow="Detail" title="Every requirement, by pillar" right={<span className="hint">{standardLabel} · the register below lists the same scores</span>} />
      <div className="nz-card-b">
        <SrsHeatmap provisional={provisional} columns={groupByPillar(model).map(({ label, requirements }) => ({
          label, cells: requirements.map((requirement) => ({
            code: requirement.code, title: requirement.title, maturity: requirement.maturity, stepName: requirement.stepName, target: requirement.target,
            detail: [evidenceLine(requirement), ...(requirement.owner ? [`Owner: ${requirement.owner}`] : []), ...(requirement.dueDate ? [`Due ${formatDate(requirement.dueDate)}`] : [])],
          })),
        }))} />
        <p className="nz-maps">A dark corner notch marks a requirement below its own target; a dashed empty cell is not yet answered — not a zero.</p>
      </div>
    </section>

    <div className="nz-cw-grid">
      <div className="nz-cw-col">
        <MetricsReadThrough model={model} />
        <section className="nz-panel">
          <CardHead eyebrow="Benchmark" title="Sector comparison" right={<span className="nz-st est">Future</span>} />
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
          <CardHead eyebrow="Roadmap" title="Path to SRS-ready" right={<span className="hint">gaps → actions</span>} />
          <div style={{ padding: "6px 16px 12px" }}>
            {gaps.length === 0
              ? <p className="sub" style={{ margin: "6px 0" }}>No requirement sits below its target. Reassess as the framework moves.</p>
              : gaps.slice(0, 8).map((gap) => <div className="nz-srs-rm" key={gap.requirement.id}>
                <span className="dot" aria-hidden="true" />
                <div>
                  <div className="nm">{gap.requirement.title}</div>
                  <div className="sub">{framework.pillars.find((pillar) => pillar.key === gap.requirement.pillarKey)?.label} · {gap.requirement.standardKey}
                    {gap.owner ? ` · owner ${gap.owner}` : ""}</div>
                  <AlignedStrategies strategies={strategiesByRequirement.get(gap.requirement.id) ?? []} />
                </div>
                <span className="d">{gap.dueDate ? formatDate(gap.dueDate) : "No date"}</span>
              </div>)}
            {gaps.length > 8 ? <p className="nz-maps">{gaps.length - 8} further gaps are in the register.</p> : null}
          </div>
        </section>
      </div>
    </div>

    <SrsRegister model={model} assessment={assessment} framework={framework} access={access} onDrawer={onDrawer} strategiesByRequirement={strategiesByRequirement}
      plan={workspace.strategies.plan} suggestions={workspace.srs.suggestions} />
  </>;
}

const evidenceLine = (requirement: SrsDashboardRequirement) => requirement.evidence
  ? `Evidence (${requirement.evidence.kind}): ${(requirement.evidence.ref ?? requirement.evidence.note).slice(0, 60)}`
  : "No evidence recorded";

/** The model's requirements, by pillar in the framework's order — the heatmap's columns. */
function groupByPillar(model: SrsDashboardModel) {
  const groups: Array<{ key: string; label: string; requirements: SrsDashboardRequirement[] }> = [];
  for (const requirement of model.requirements) {
    let group = groups.find((entry) => entry.key === requirement.pillarKey);
    if (!group) { group = { key: requirement.pillarKey, label: requirement.pillarLabel, requirements: [] }; groups.push(group); }
    group.requirements.push(requirement);
  }
  return groups;
}

/**
 * R7: Metrics & targets as the client's assured NZI record answered it — read through with its provenance (the evidence
 * each pre-filled answer carries), not re-keyed and not redrawn as new numbers.
 */
function MetricsReadThrough({ model }: { model: SrsDashboardModel }) {
  const fromData = model.requirements.filter((requirement) => requirement.source === "auto");
  return <section className="nz-panel">
    <CardHead eyebrow="Metrics & targets" title="From the assured NZI record" right={<span className="hint">read-through · not re-keyed</span>} />
    <div style={{ padding: "6px 16px 12px" }}>
      {fromData.length === 0
        ? <p className="sub" style={{ margin: "6px 0" }}>Nothing in this assessment was answered from the client&apos;s assured record — no assured emissions, targets or intensity metrics were held when it was started, so the consultant answered every requirement.</p>
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

type SortKey = "order" | "code" | "maturity" | "gap" | "due";

/**
 * R6: the register — every requirement with its score, evidence, owner and due, sortable: the always-available non-chart
 * view, and the heatmap's table. Its last column is the **gap→action hook** (S3, R1): what bridges the gap — an action
 * written from it (`srs_gap`, naming the requirement) or the one the assessment links — else the strategies that advance
 * it; and on an unbridged gap, **Bridge this gap**: the library's aligned actions first, AI ideas second, or your own.
 */
function SrsRegister({ model, assessment, framework, access, onDrawer, strategiesByRequirement, plan, suggestions }: {
  model: SrsDashboardModel; assessment: SrsAssessment; framework: SrsFramework; access: EditAccess; onDrawer: (request: SrsDrawerRequest) => void;
  strategiesByRequirement: Map<string, ClientStrategy[]>; plan: readonly ClientStrategy[]; suggestions: readonly SrsGapSuggestion[];
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "order", dir: 1 });
  const order = new Map(model.requirements.map((requirement, index) => [requirement.id, index]));
  const sorted = [...model.requirements].sort((a, b) => {
    const by: Record<SortKey, number> = {
      order: order.get(a.id)! - order.get(b.id)!,
      code: a.code.localeCompare(b.code),
      maturity: (a.maturity ?? -1) - (b.maturity ?? -1),
      gap: Number(b.gap) - Number(a.gap) || ((a.maturity ?? -1) - a.target) - ((b.maturity ?? -1) - b.target),
      due: (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
    };
    return (by[sort.key] || order.get(a.id)! - order.get(b.id)!) * sort.dir;
  });
  const header = (key: SortKey, label: string) => <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
    <button type="button" className="nz-srs-sort" onClick={() => setSort((now) => ({ key, dir: now.key === key ? (now.dir === 1 ? -1 : 1) : 1 }))}>{label}{sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}</button>
  </th>;
  const editable = assessment.status === "draft";

  return <section className="nz-panel" style={{ marginTop: 16 }}>
    <CardHead eyebrow="Assessment" title="Requirement register" right={<span className="hint">{model.requirements.length} requirements · sortable · the heatmap&apos;s table</span>} />
    <div className="nz-srs-tablewrap">
      <table className="nz-tbl nz-srs-register">
        <thead><tr>{header("code", "Requirement")}<th scope="col">Pillar</th>{header("maturity", "Maturity")}<th scope="col">Target</th><th scope="col">Evidence</th><th scope="col">Owner</th>{header("due", "Due")}{header("gap", "Gap → action")}<th /></tr></thead>
        <tbody>
          {sorted.map((requirement) => {
            const bridged = srsBridgedBy(requirement.id, plan, requirement.linkedActionId ?? null);
            const aligned = (strategiesByRequirement.get(requirement.id) ?? []).filter((strategy) => !bridged.some((action) => action.id === strategy.id));
            const ideas = suggestions.filter((idea) => idea.assessmentId === assessment.assessmentId && idea.requirementId === requirement.id).length;
            const frameworkRequirement = framework.requirements.find((entry) => entry.id === requirement.id) ?? null;
            const item = assessment.items.find((entry) => entry.requirementId === requirement.id) ?? null;
            return <tr key={requirement.id}>
              <td><b>{requirement.title}</b>{requirement.helpText ? <InfoTip label={`About ${requirement.code}`}>{requirement.helpText}</InfoTip> : null}
                <div className="muted">{requirement.code} · {requirement.standardKey}{requirement.source === "auto" ? " · from NZI data" : ""}</div></td>
              <td>{requirement.pillarLabel}</td>
              <td>{requirement.maturity === null ? <span className="muted">Not answered</span>
                : <><span className="nz-srs-chip" data-step={requirement.maturity}>{requirement.maturity}</span> {requirement.stepName}{model.assessment.provisional ? <span className="muted"> · provisional</span> : null}</>}</td>
              <td className="num">{requirement.target}</td>
              <td>{requirement.evidence ? <span title={requirement.evidence.note}>{requirement.evidence.kind} · {(requirement.evidence.ref ?? requirement.evidence.note).slice(0, 40)}</span> : <span className="up">none</span>}</td>
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
                {frameworkRequirement ? <GatedButton className="nz-editlink" blocked={access.state !== "allowed" || !editable}
                  blockedReason={access.state !== "allowed" ? access.reason : !editable ? "This assessment is complete — start a reassessment to change it." : undefined}
                  reasonClassName="hint nz-gated-reason" onClick={() => onDrawer({ kind: "srs-item", assessment, requirement: frameworkRequirement, item })}>Assess</GatedButton> : null}
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    <div className="nz-card-b">
      <p className="nz-maps">The framework is Admin-managed and versioned; this assessment is measured against version {model.frameworkVersion}, and a later version does not restate it.</p>
    </div>
  </section>;
}
