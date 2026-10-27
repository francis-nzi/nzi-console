import { SrsDial, SrsHeatmap, SrsPillarTable, SrsRadar, SrsScaleKey, SrsTrend } from "@nzi/charts";
import type { ReadinessReportSection, SrsDashboardRequirement } from "@nzi/contracts";
import type { SrsReportReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../../lib/formatDate";

/**
 * The SRS readiness report, drawn from its **template** (S3, R5/R6). One renderer: the template says which sections, in
 * which order, with which words; each section kind is drawn here from the readiness model with S2's components — the same
 * dials, radar, heatmap and trend the CRM and the portal show, on the one validated ladder, in print as on screen.
 *
 * A completed assessment only; no staff identity (the firm prepared it); no money; no figure the model does not hold —
 * the benchmark is a truthful "Future". Printed by the browser (the console's PDF route, as the issued CRP report is):
 * each section starts a page, and nothing interactive prints.
 */

type Ready = Extract<SrsReportReadModel, { state: "ready" }>;

const shortPillar = (label: string) => label.length <= 11 ? label : label.replace(/\bmanagement\b/i, "mgmt").replace(/\s*&\s*targets$/i, "").slice(0, 12).trim();

export function SrsReportDocument({ report }: { report: Ready }) {
  const { template } = report;
  return <article className="nzsr" data-template={`${template.key}@${template.version}`}>
    <header className="nzsr-cover">
      <div className="nzsr-kicker">{report.preparedBy}</div>
      <h1>{template.title}</h1>
      <div className="nzsr-client">{report.client.name}</div>
      <p className="nzsr-strap">{template.strapline}</p>
      <dl className="nzsr-facts">
        <div><dt>Assessed</dt><dd>{formatDate(report.assessment.assessedOn)}</dd></div>
        <div><dt>Against</dt><dd>{report.assessment.frameworkLabel}, version {report.assessment.frameworkVersion}</dd></div>
        <div><dt>Prepared</dt><dd>{formatDate(report.generatedOn)}</dd></div>
      </dl>
      <p className="nzsr-disclaimer">{template.disclaimer}</p>
    </header>
    {template.sections.map((section) => <section key={section.kind} className={`nzsr-section nzsr-${section.kind}`} aria-labelledby={`nzsr-h-${section.kind}`}>
      <h2 id={`nzsr-h-${section.kind}`}>{section.heading}</h2>
      {section.intro ? <p className="nzsr-intro">{section.intro}</p> : null}
      <SectionBody section={section} report={report} />
    </section>)}
    <footer className="nzsr-foot">
      {report.client.name} · {template.label} · assessed {formatDate(report.assessment.assessedOn)} · prepared by {report.preparedBy} on {formatDate(report.generatedOn)}
    </footer>
  </article>;
}

function SectionBody({ section, report }: { section: ReadinessReportSection; report: Ready }) {
  const { dashboard } = report;
  const rows = dashboard.pillars.map((pillar) => ({ label: pillar.label, level: pillar.level, stepName: pillar.stepName, target: pillar.targetLevel, delta: pillar.delta }));
  switch (section.kind) {
    case "summary":
      return <>
        <div className="nzsr-hero">
          <div className="v">{dashboard.overall.level.toFixed(1)}<small> of 4</small></div>
          <div><span className="nz-srs-chip" data-step={dashboard.overall.step}>{dashboard.overall.step}</span> <b>{dashboard.overall.stepName}</b></div>
        </div>
        {report.narrative.map((line, index) => <p key={index}>{line}</p>)}
        <SrsScaleKey ladder={dashboard.ladder} />
      </>;
    case "pillars":
      return <>
        <div className="nzsr-dials">{dashboard.pillars.map((pillar) => <SrsDial key={pillar.key} label={pillar.label} level={pillar.level} stepName={pillar.stepName} target={pillar.targetLevel} size={150} />)}</div>
        <SrsPillarTable rows={rows} caption="Readiness by pillar" />
      </>;
    case "radar":
      return <div className="nzsr-two">
        <SrsRadar axes={dashboard.pillars.map((pillar) => ({ label: shortPillar(pillar.label), value: pillar.level, target: pillar.targetLevel }))} seriesLabel={report.client.name.length > 24 ? "Readiness" : report.client.name} size={320} />
        <SrsPillarTable rows={rows} caption="The same four positions" />
      </div>;
    case "heatmap":
      return <SrsHeatmap columns={byPillar(dashboard.requirements).map((group) => ({
        label: group.label,
        cells: group.requirements.map((requirement) => ({ code: requirement.code, title: requirement.title, maturity: requirement.maturity, stepName: requirement.stepName, target: requirement.target })),
      }))} />;
    case "trend":
      return dashboard.trend.overall.length <= 1
        ? <p>This is the first completed assessment, so there is one position and no trend yet. Reassessment adds the line.</p>
        : <>
          <SrsTrend title="Overall readiness" points={dashboard.trend.overall.map((point) => ({ label: formatDate(point.assessedOn), level: point.level }))} />
          <table className="nz-srs-table"><caption>Overall readiness at each completed assessment</caption>
            <thead><tr><th scope="col">Assessed</th><th scope="col">Readiness (of 4)</th></tr></thead>
            <tbody>{dashboard.trend.overall.map((point) => <tr key={point.assessmentId}><th scope="row">{formatDate(point.assessedOn)}</th><td className="num">{point.level.toFixed(1)}</td></tr>)}</tbody>
          </table>
        </>;
    case "metrics": {
      const fromRecord = dashboard.requirements.filter((requirement) => requirement.source === "auto");
      return fromRecord.length === 0
        ? <p>No requirement in this assessment was answered from the assured record.</p>
        : <table className="nz-srs-table"><caption>Answered from your reviewed data</caption>
          <thead><tr><th scope="col">Requirement</th><th scope="col">Step reached</th><th scope="col">From</th></tr></thead>
          <tbody>{fromRecord.map((requirement) => <tr key={requirement.id}>
            <th scope="row">{requirement.code} · {requirement.title}</th>
            <td>{requirement.maturity === null ? "Not answered" : `${requirement.maturity} · ${requirement.stepName}`}</td>
            <td>{requirement.evidence?.ref ?? "Your assured record"}</td>
          </tr>)}</tbody>
        </table>;
    }
    case "roadmap": {
      const total = report.roadmap.pillars.reduce((count, pillar) => count + pillar.gaps.length, 0);
      if (total === 0) return <p>No requirement sits below what the framework expects of it.</p>;
      return <>
        {report.roadmap.pillars.map((pillar) => <div key={pillar.key} className="nzsr-gaps">
          <h3>{pillar.label}</h3>
          {pillar.gaps.map((gap) => <div key={gap.code} className="nzsr-gap">
            <div className="hd"><b>{gap.code}</b> {gap.title}<span className="lv">{gap.maturityLabel} → {gap.targetLabel}</span></div>
            {gap.strategies.length > 0
              ? <ul>{gap.strategies.map((strategy) => <li key={strategy.title}>{strategy.title} <span className="st">{strategy.statusLabel}</span></li>)}</ul>
              : <p className="none">No action on the plan addresses this yet.</p>}
          </div>)}
        </div>)}
      </>;
    }
    case "benchmark":
      return dashboard.benchmark.state === "future"
        ? <p className="nzsr-future"><b>Future.</b> When a defensible peer dataset exists, this section will place you against your sector. Until then there is deliberately no figure here. {dashboard.benchmark.reason}</p>
        : <p>You sit at the {dashboard.benchmark.percentile}th percentile for {dashboard.benchmark.sectorKey}, per {dashboard.benchmark.source}.</p>;
    case "method":
      return <>
        <p>Readiness was assessed by {report.preparedBy} against {report.assessment.frameworkLabel}, version {report.assessment.frameworkVersion}, and is shown on its five-step ladder. Each requirement&rsquo;s step is weighted by the framework into the positions for each pillar and overall; the step shown is the step reached, never rounded up. Only completed assessments appear in this report.</p>
        <table className="nz-srs-table"><caption>The ladder</caption>
          <thead><tr><th scope="col">Step</th><th scope="col">Meaning</th></tr></thead>
          <tbody>{dashboard.ladder.map((step) => <tr key={step.level}><th scope="row"><span className="nz-srs-chip" data-step={step.level}>{step.level}</span> {step.name}</th><td>{step.definition}</td></tr>)}</tbody>
        </table>
        <p className="nzsr-disclaimer">{report.template.disclaimer}</p>
        <p className="nzsr-provenance">Template {report.template.key} version {report.template.version} · assessment {report.assessment.id} · assessed {formatDate(report.assessment.assessedOn)} · drawn {formatDate(report.generatedOn)}.</p>
      </>;
  }
}

function byPillar(requirements: readonly SrsDashboardRequirement[]) {
  const groups: Array<{ key: string; label: string; requirements: SrsDashboardRequirement[] }> = [];
  for (const requirement of requirements) {
    let group = groups.find((entry) => entry.key === requirement.pillarKey);
    if (!group) { group = { key: requirement.pillarKey, label: requirement.pillarLabel, requirements: [] }; groups.push(group); }
    group.requirements.push(requirement);
  }
  return groups;
}
