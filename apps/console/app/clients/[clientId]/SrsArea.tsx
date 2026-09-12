"use client";

import { useMemo } from "react";
import { CRP_RESOLVER_VERSION, RENDERER_VERSION, SrsGapHeatmap, SrsMaturityBullets, SrsPillarRadar, SrsReadinessTrend, TOKENS_VERSION } from "@nzi/charts";
import { GatedButton, InfoTip } from "@nzi/ui";
import {
  benchmark as resolveBenchmark, evidenceCoverage, gaps as resolveGaps, maturityLabel,
  orderedRequirements, overallReadiness, pillarReadiness, readinessTrend, standardReadiness,
  type SrsAssessment, type SrsFramework, type SrsMaturity,
} from "@nzi/contracts";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { CardHead, Empty } from "./OverviewArea";
import type { SrsDrawerRequest } from "./srsDrawers";

/**
 * UK SRS Readiness (per the redesign brief and `srs_readiness_v1`).
 *
 * Two audiences, one screen: a client tracking and closing gaps, and a prospect seeing
 * where they stand. So it leads with a level and a number — never a bare percentage — and
 * every graphic is drawn from this client's own answers against the framework version the
 * assessment was made against.
 *
 * Maturity is drawn on the sequential status ramp, never the scope palette: scope colour
 * means scope, and borrowing it for "how ready" would make two different things look alike.
 */

export function SrsArea({ workspace, access, onDrawer }: {
  workspace: ClientWorkspaceReadModel;
  access: EditAccess;
  onDrawer: (request: SrsDrawerRequest) => void;
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

  return <SrsDashboard workspace={workspace} framework={framework} assessment={current} assessments={assessments} access={access} onDrawer={onDrawer} />;
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
        <p className="nz-maps">Requirements the client&apos;s own assured record already answers — the footprint, its targets and its intensity metrics — can be filled in from that record rather than asked again, each marked as resolved from NZI data.</p>
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

function SrsDashboard({ workspace, framework, assessment, assessments, access, onDrawer }: {
  workspace: ClientWorkspaceReadModel;
  framework: SrsFramework;
  assessment: SrsAssessment;
  assessments: SrsAssessment[];
  access: EditAccess;
  onDrawer: (request: SrsDrawerRequest) => void;
}) {
  const { client } = workspace;
  const overall = useMemo(() => overallReadiness(framework, assessment.items), [framework, assessment]);
  const pillars = useMemo(() => pillarReadiness(framework, assessment.items), [framework, assessment]);
  const standards = useMemo(() => standardReadiness(framework, assessment.items), [framework, assessment]);
  const coverage = useMemo(() => evidenceCoverage(framework, assessment.items), [framework, assessment]);
  const gaps = useMemo(() => resolveGaps(framework, assessment.items), [framework, assessment]);
  const trend = useMemo(() => readinessTrend(framework, assessments.filter((entry) => entry.status === "complete" || entry.assessmentId === assessment.assessmentId)), [framework, assessments, assessment]);
  const mark = resolveBenchmark(assessment);
  const climate = framework.standards.find((standard) => standard.climateLed) ?? framework.standards[0]!;
  const other = framework.standards.find((standard) => standard.key !== climate.key) ?? null;
  const itemsByRequirement = new Map(assessment.items.map((item) => [item.requirementId, item]));

  const provenance = {
    jobId: client.id, dataHash: "", factorSets: [], generatedAt: assessment.assessedOn,
    reviewedSnapshotId: assessment.assessmentId, resolverVersion: CRP_RESOLVER_VERSION,
    tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION,
  };
  const maxLevel = framework.maturityLevels.length - 1;
  // Axis and column labels have to fit the chart: the full wording stays everywhere else,
  // and the chart's own title and tooltips carry it for anyone who needs it spelled out.
  const shortPillar = (label: string) => label.length <= 11 ? label
    : label.replace(/\bmanagement\b/i, "mgmt").replace(/\s*&\s*targets$/i, "").slice(0, 12).trim();
  const levelLabels = framework.maturityLevels.map((level) => level.label.split(" ")[0]!.slice(0, 3));

  return <>
    <div className="nz-cw-vhead"><div><div className="eyebrow">Disclosure</div><h2>UK SRS Readiness</h2></div><span style={{ flex: 1 }} />
      <span className="nz-st need">{assessment.status === "draft" ? "In progress" : "Complete"}</span>
      <GatedButton className="nz-btn" blocked={access.state !== "allowed"} blockedReason={access.state === "allowed" ? undefined : access.reason}
        reasonClassName="hint nz-gated-reason" onClick={() => onDrawer({ kind: "srs-assess", assessment })}>
        {assessment.status === "draft" ? "Continue assessment" : "Reassess"}
      </GatedButton>
    </div>
    <p className="nz-cw-vsub">{client.name} · assessed {formatDate(assessment.assessedOn)} · consultant-led by {assessment.assessedBy} · measured against {framework.label} version {assessment.frameworkVersion}.</p>

    {/* The headline: a level and a number, with the confidence behind it. */}
    <section className="nz-panel nz-srs-hero">
      <div className="nz-srs-score">
        <div className="v num">{Math.round(overall.percent)}<small>%</small></div>
        <span className="nz-st done">{maturityLabel(framework, overall.level)}</span>
      </div>
      <div className="nz-srs-stat"><div className="l">Evidence coverage</div><div className="v num">{coverage.evidenced} / {coverage.total}</div><div className="sub">requirements evidenced</div></div>
      <div className="nz-srs-stat"><div className="l">Standards assessed</div>
        <div className="v">{standards.map(({ standard, rollup }) => <span key={standard.key} className="nz-srs-std">
          <b>{standard.key}</b> <span className="muted">{standard.climateLed ? "climate · led" : "general"}</span> <span className="num">{Math.round(rollup.percent)}%</span>
        </span>)}</div>
      </div>
      <div className="nz-srs-stat"><div className="l">Assessed</div><div className="v num">{overall.assessed} / {overall.total}</div>
        <div className="sub">{overall.gaps} below target</div></div>
    </section>

    <div className="nz-cw-grid">
      <div className="nz-cw-col">
        <section className="nz-panel">
          <CardHead eyebrow="Maturity" title="Readiness by pillar" right={<span className="hint">0 → {framework.maturityLevels[maxLevel]?.label}</span>} />
          <div className="nz-card-b nz-srs-radar">
            <SrsPillarRadar showChrome={false} width={300} data={{
              spec: { id: `srs-radar-${assessment.assessmentId}`, type: "srs_pillar_radar", title: "Readiness by pillar", family: "crp", specVersion: 1 },
              unit: "level", state: "success", provenance,
              pillars: pillars.map((pillar) => shortPillar(pillar.label)),
              series: [climate, ...(other ? [other] : [])].map((standard) => ({
                key: standard.key === climate.key ? "S2" as const : "S1" as const,
                label: standard.label.replace(/^UK SRS \w+ — /, ""),
                values: pillars.map((pillar) => pillar.byStandard[standard.key]?.level ?? 0),
              })),
              target: pillars.map((pillar) => pillar.targetLevel),
              maxLevel,
            }} />
            <div style={{ flex: 1, minWidth: 250 }}>
              <SrsMaturityBullets showChrome={false} data={{
                spec: { id: `srs-bullets-${assessment.assessmentId}`, type: "srs_maturity_bullets", title: "Maturity by pillar", family: "crp", specVersion: 1 },
                unit: "level", state: "success", provenance, maxLevel,
                rows: pillars.map((pillar) => ({
                  label: pillar.label,
                  value: pillar.byStandard[climate.key]?.level ?? 0,
                  valueLabel: maturityLabel(framework, pillar.byStandard[climate.key]?.level ?? 0),
                  comparison: other ? pillar.byStandard[other.key]?.level ?? 0 : null,
                  target: pillar.targetLevel,
                })),
              }} />
            </div>
          </div>
        </section>

        <section className="nz-panel">
          <CardHead eyebrow="Gaps" title="Requirement heatmap" right={<span className="hint">{climate.key} {climate.climateLed ? "climate" : ""} shown</span>} />
          <div className="nz-card-b">
            <SrsGapHeatmap showChrome={false} data={{
              spec: { id: `srs-heat-${assessment.assessmentId}`, type: "srs_gap_heatmap", title: "Requirements by maturity", family: "crp", specVersion: 1 },
              unit: "level", state: "success", provenance, levels: levelLabels,
              groups: framework.pillars.slice().sort((a, b) => a.ordering - b.ordering).map((pillar) => ({
                label: pillar.label,
                rows: framework.requirements
                  .filter((requirement) => requirement.active && requirement.pillarKey === pillar.key && requirement.standardKey === climate.key)
                  .sort((a, b) => a.ordering - b.ordering)
                  .map((requirement) => ({
                    label: requirement.title,
                    value: itemsByRequirement.get(requirement.id)?.maturity ?? 0,
                    target: requirement.targetMaturity,
                  })),
              })).filter((group) => group.rows.length > 0),
            }} />
            <p className="nz-maps">Each row is a requirement&apos;s maturity on the five-step ladder, with its target marked. A requirement below its target becomes an action on the roadmap.</p>
          </div>
        </section>
      </div>

      <div className="nz-cw-col">
        <section className="nz-panel">
          <CardHead eyebrow="Confidence" title="Evidence & trend" />
          <div style={{ padding: "6px 16px 12px" }}>
            <div className="nz-kv"><span className="k">Requirements evidenced</span><span className="v">{coverage.evidenced} / {coverage.total} · {coverage.percent}%</span></div>
            {coverage.byPillar.map((pillar) => <div className="nz-kv" key={pillar.pillarKey}>
              <span className="k">{pillar.label}</span>
              <span className={`v${pillar.evidenced < pillar.total ? " up" : ""}`}>{pillar.evidenced} / {pillar.total}{pillar.evidenced < pillar.total ? " gaps" : ""}</span>
            </div>)}
            <div style={{ marginTop: 10 }}>
              <div className="hint" style={{ marginBottom: 4 }}>Overall readiness over time</div>
              {trend.length < 2
                ? <p className="sub" style={{ margin: 0 }}>One assessment so far — the trend appears on reassessment.</p>
                : <SrsReadinessTrend showChrome={false} data={{
                  spec: { id: `srs-trend-${client.id}`, type: "srs_readiness_trend", title: "Readiness over time", family: "crp", specVersion: 1 },
                  unit: "%", state: "success", provenance,
                  points: trend.map((point) => ({ label: point.label, value: point.value })),
                }} />}
            </div>
          </div>
        </section>

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
                    {gap.linkedActionId ? " · linked action" : " · no action yet"}
                    {gap.owner ? ` · owner ${gap.owner}` : ""}</div>
                </div>
                <span className="d">{gap.dueDate ? formatDate(gap.dueDate) : "No date"}</span>
              </div>)}
            {gaps.length > 8 ? <p className="nz-maps">{gaps.length - 8} further gaps are in the register.</p> : null}
            <p className="nz-maps">A gap becomes an action in the action-lever library, so the readiness roadmap and the decarbonisation plan share one spine. Linking is enabled once that library lands.</p>
          </div>
        </section>

        <section className="nz-panel">
          <CardHead eyebrow="Benchmark" title="Sector comparison" right={<span className="nz-st est">Future</span>} />
          <div className="nz-card-b">
            <div className="nz-srs-future">
              {mark.state === "future"
                ? <>Sector and peer benchmarking is <b>built into the model</b> (sector tagging and a percentile slot) and will populate once a defensible peer dataset is available — no invented comparisons. Until then the picture leads on the radar and the roadmap.</>
                : <>This client sits at the <b>{mark.percentile}th percentile</b> for {mark.sectorKey}, per {mark.source}.</>}
            </div>
          </div>
        </section>
      </div>
    </div>

    <SrsRegister framework={framework} assessment={assessment} access={access} onDrawer={onDrawer} />
  </>;
}

function SrsRegister({ framework, assessment, access, onDrawer }: {
  framework: SrsFramework; assessment: SrsAssessment; access: EditAccess; onDrawer: (request: SrsDrawerRequest) => void;
}) {
  const items = new Map(assessment.items.map((item) => [item.requirementId, item]));
  const requirements = orderedRequirements(framework);
  const level = (maturity: SrsMaturity | null) => maturity === null ? null : framework.maturityLevels.find((entry) => entry.level === maturity) ?? null;

  return <section className="nz-panel" style={{ marginTop: 16 }}>
    <CardHead eyebrow="Assessment" title="Requirement register" right={<span className="hint">consultant-led · framework Admin-versioned</span>} />
    <table className="nz-tbl">
      <thead><tr><th>Requirement</th><th>Std</th><th>Pillar</th><th>Maturity</th><th>Evidence</th><th>Gap → action</th><th /></tr></thead>
      <tbody>
        {requirements.map((requirement) => {
          const item = items.get(requirement.id) ?? null;
          const maturity = item?.maturity ?? null;
          const shortOfTarget = maturity === null || maturity < requirement.targetMaturity;
          return <tr key={requirement.id}>
            <td><b>{requirement.title}</b>{requirement.helpText ? <InfoTip label={`About ${requirement.code}`}>{requirement.helpText}</InfoTip> : null}
              <div className="muted">{requirement.code}{requirement.source === "nzi-data" ? " · from NZI data" : ""}</div></td>
            <td><span className="nz-st est">{requirement.standardKey}</span></td>
            <td>{framework.pillars.find((pillar) => pillar.key === requirement.pillarKey)?.label}</td>
            <td>{maturity === null
              ? <span className="muted">Not assessed</span>
              : <span className={`nz-srs-mtag m${maturity}`}>{level(maturity)?.label}</span>}</td>
            <td>{item?.evidence
              ? <span title={item.evidence.note}>{item.evidence.ref ?? item.evidence.note.slice(0, 40) ?? item.evidence.kind}</span>
              : <span className="up">none</span>}</td>
            <td>{shortOfTarget
              ? <span className="nz-srs-gap">{item?.linkedActionId ? "Linked action" : `Needs ${level(requirement.targetMaturity)?.label}`} →</span>
              : <span className="muted">—</span>}</td>
            <td style={{ textAlign: "right" }}>
              <GatedButton className="nz-editlink" blocked={access.state !== "allowed" || assessment.status !== "draft"}
                blockedReason={access.state !== "allowed" ? access.reason : assessment.status !== "draft" ? "This assessment is complete — start a reassessment to change it." : undefined}
                reasonClassName="hint nz-gated-reason" onClick={() => onDrawer({ kind: "srs-item", assessment, requirement, item })}>Assess</GatedButton>
            </td>
          </tr>;
        })}
      </tbody>
    </table>
    <div className="nz-card-b">
      <p className="nz-maps">The framework — standards, pillars, requirements, weights and the maturity definitions — is Admin-managed and versioned, so the tool tracks UK SRS as it changes (the mandatory rules proposed for 2027) without a code change. This assessment is measured against version {assessment.frameworkVersion}; a later version does not restate it.</p>
    </div>
  </section>;
}
