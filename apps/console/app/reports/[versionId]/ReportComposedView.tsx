import { NziIcon, type NziIconKey } from "@nzi/ui";
import {
  strategyScopeLabel, strategyStatusLabels, isReportGap, reportCompositionSectionMeta,
  reportHeadline, reportMethodologyRows, reportResidualTco2e,
  type StrategyScope, type ReportComposition, type ReportProvenance, type ReportSectionGap,
} from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";

/**
 * The composed report (`report_v1`).
 *
 * Reads a **frozen composition** — what this report version said when it was issued — and
 * renders it. It resolves nothing and recomputes nothing: if a figure is not in the
 * composition it is not in the report, which is what makes an issued document stable while
 * the client's live records carry on changing underneath it.
 *
 * Deliberately a single light "paper" look. This is the print and PDF target, so it does
 * not follow the viewer's theme — a report that renders dark on screen and light in the PDF
 * is two documents, and only one of them is the one the client was sent.
 *
 * Icons are the curated `NziIcon` line set (currentColor, print-safe), never emoji: an
 * emoji is a different glyph in every renderer, and this has to look the same on screen, in
 * the portal and in the PDF.
 */

const iconKey = (key: string): NziIconKey => key as NziIconKey;
const tonnes = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 0 });

export function ReportComposedView({ composition }: { composition: ReportComposition }) {
  const { emissions, intensity, targets, plan, srs } = composition;
  const footer = `${composition.client} · Carbon Reduction Plan FY${composition.reportingYear}`;
  // The figure the pathway actually lands on — read from the model, never assumed to be 0.
  const residual = isReportGap(targets) ? null : reportResidualTco2e(targets);

  return <main className="nzr-doc">
    <Cover composition={composition} />

    <Page footer={footer} number={2}>
      <SectionHead n="01" section="executive-summary" />
      <p className="nzr-lede">{reportHeadline(emissions, composition.reportingYear)}</p>
      {!isReportGap(emissions) ? <div className="nzr-figures">
        <Figure label="Assured footprint" value={tonnes(emissions.totalTco2e)} unit="tCO₂e" />
        {emissions.byScope.map((entry) => <Figure key={entry.scope}
          label={strategyScopeLabel(entry.scope as StrategyScope)} value={tonnes(entry.tco2e)} unit="tCO₂e" />)}
      </div> : <Gap section={emissions} />}
    </Page>

    <Page footer={footer} number={3}>
      <SectionHead n="02" section="emissions" />
      {isReportGap(emissions)
        ? <Gap section={emissions} />
        : <>
          <table className="nzr-tbl">
            <thead><tr><th>Scope</th><th className="r">tCO₂e</th><th className="r">Share</th></tr></thead>
            <tbody>
              {emissions.byScope.map((entry) => <tr key={entry.scope}>
                <td>{strategyScopeLabel(entry.scope as StrategyScope)}</td>
                <td className="r num">{tonnes(entry.tco2e)}</td>
                <td className="r num">{emissions.totalTco2e === 0 ? "—" : `${((entry.tco2e / emissions.totalTco2e) * 100).toFixed(1)}%`}</td>
              </tr>)}
            </tbody>
            <tfoot><tr><td>Total</td><td className="r num">{tonnes(emissions.totalTco2e)}</td><td className="r num">100%</td></tr></tfoot>
          </table>
          {emissions.priorYear === null
            ? <p className="nzr-note">This is the first assured year, so there is no prior year to compare against.</p>
            : <p className="nzr-note">FY{emissions.priorYear.year} assured total: {tonnes(emissions.priorYear.totalTco2e)} tCO₂e.</p>}
          <Provenance provenance={emissions.provenance} />
        </>}
    </Page>

    <Page footer={footer} number={4}>
      <SectionHead n="03" section="intensity" />
      {isReportGap(intensity)
        ? <Gap section={intensity} />
        : <>
          <div className="nzr-metrics">
            {intensity.metrics.map((metric) => <div className="nzr-metric" key={metric.key}>
              <span className="ic"><NziIcon name={iconKey(metric.iconKey)} size={18} /></span>
              <div>
                <div className="l">{metric.label}</div>
                {/* A measure with no value says why, in its own words. Never a dash, and
                    never 0 — which would read as "no emissions per employee". */}
                {metric.value === null
                  ? <div className="u">{metric.unavailableReason}</div>
                  : <div className="v num">{metric.value.toLocaleString("en-GB", { maximumFractionDigits: 2 })} <small>{metric.unit}</small></div>}
              </div>
            </div>)}
          </div>
          <Provenance provenance={intensity.provenance} />
        </>}
    </Page>

    <Page footer={footer} number={5}>
      <SectionHead n="04" section="targets" />
      {isReportGap(targets)
        ? <Gap section={targets} />
        : <>
          {targets.benchmark === null
            ? <p className="nzr-note">The baseline these targets were measured against is not recorded.</p>
            : <p className="nzr-note">
              Measured against the FY{targets.benchmark.year} baseline of {tonnes(targets.benchmark.totalTco2e)} tCO₂e
              {targets.benchmark.reference ? ` (${targets.benchmark.reference})` : ""}.
            </p>}
          {/* NZC-068 — a re-baseline HOLDS targets rather than restating them. A report
              issued in that state must say so, not present a pathway measured against a
              benchmark that no longer applies as though nothing had moved. */}
          {targets.benchmarkStale ? <p className="nzr-gap">
            These targets were set against a baseline that has since been restated. They are held as set, and
            have not been recalculated against the new baseline — so the pathway below is the one the client
            agreed, not a revised one.
          </p> : null}
          <table className="nzr-tbl">
            <thead><tr><th>Year</th><th>Milestone</th><th className="r">Reduction</th><th className="r">tCO₂e</th></tr></thead>
            <tbody>{targets.trajectory.map((point) => <tr key={`${point.kind}-${point.year}`}>
              <td>FY{point.year}</td>
              <td>{point.kind === "benchmark" ? "Baseline" : point.kind === "near-term" ? "Near-term target" : "Net zero"}</td>
              <td className="r num">{point.kind === "benchmark" ? "—" : `${point.pct}%`}</td>
              <td className="r num">{tonnes(point.tco2e)}</td>
            </tr>)}</tbody>
          </table>
          {/* Net zero carries its residual. A pathway drawn to a flat zero claims something
              the client's target model does not say. */}
          {residual !== null && residual > 0 ? <p className="nzr-note">
            Net zero here means a residual of {tonnes(residual)} tCO₂e, addressed through removals
            rather than reduced to nothing.
          </p> : null}
          <Provenance provenance={targets.provenance} />
        </>}
    </Page>

    <Page footer={footer} number={6}>
      <SectionHead n="05" section="plan" />
      {isReportGap(plan)
        ? <Gap section={plan} />
        : <>
          <div className="nzr-plan-summary">
            <span><b className="num">{plan.summary.total}</b> actions</span>
            <span><b className="num">{plan.summary.inProgress}</b> in progress</span>
            <span><b className="num">{plan.summary.complete}</b> complete</span>
            <span><b className="num">{plan.summary.planned}</b> planned</span>
          </div>
          {plan.groups.map((group) => <section className="nzr-plan-group" key={group.controlLevel}>
            <h3>{group.label}</h3>
            {group.actions.map((action, index) => <div className="nzr-action" key={`${action.title}-${index}`}>
              <div className="nm">{action.title}</div>
              <div className="mt">
                <span className="nzr-tag">{strategyScopeLabel(action.scope as StrategyScope)}</span>
                {[action.category, action.owner, action.targetDate === null ? "" : formatDate(action.targetDate)]
                  .filter(Boolean).join(" · ")}
              </div>
              <div className="st">{strategyStatusLabels[action.status]} · {action.progressPct}%</div>
            </div>)}
          </section>)}
          <p className="nzr-note">
            The plan is tracked qualitatively: the percentages above are reported progress against each
            action, not a modelled carbon reduction. Quantified impact per lever is not yet part of this
            report.
          </p>
        </>}
    </Page>

    <Page footer={footer} number={7}>
      <SectionHead n="06" section="srs" />
      {isReportGap(srs)
        ? <Gap section={srs} />
        : <>
          <p className="nzr-lede">
            UK SRS readiness stands at <b>{srs.overallLabel} ({srs.overallPct}%)</b>, assessed
            on {formatDate(srs.assessedOn)} against framework version {srs.frameworkVersion}.
          </p>
          <table className="nzr-tbl">
            <thead><tr><th>Pillar</th><th>Maturity</th></tr></thead>
            <tbody>{srs.pillars.map((pillar) => <tr key={pillar.label}>
              <td>{pillar.label}</td><td>{pillar.maturityLabel}</td>
            </tr>)}</tbody>
          </table>
          <p className="nzr-note">
            Readiness is an assessment of this organisation&rsquo;s own reporting maturity. It is not a
            statement that the disclosure has been prepared, filed or assured.
          </p>
        </>}
    </Page>

    <Page footer={footer} number={8}>
      <SectionHead n="07" section="methodology" />
      <table className="nzr-tbl">
        <tbody>{reportMethodologyRows(composition).map((row) => <tr key={row.label}>
          <td>{row.label}</td><td>{row.value}</td>
        </tr>)}</tbody>
      </table>
      <p className="nzr-note">
        Every figure in this report was resolved from the client&rsquo;s reviewed snapshot and the records
        that stood when it was issued, and frozen at that point — later changes to the plan, the intensity
        measures or the readiness assessment do not alter this document. Charts are generated from the data,
        never captured as images, and render identically on screen, in the portal and in print.
      </p>
    </Page>
  </main>;
}

function Cover({ composition }: { composition: ReportComposition }) {
  return <section className="nzr-page nzr-cover">
    <div className="nzr-brand"><span>N</span><div><b>NZI Pro</b><small>Net Zero International</small></div></div>
    <h1>{reportCompositionSectionMeta.cover.title}</h1>
    <div className="nzr-cover-client">{composition.client}</div>
    <div className="nzr-cover-meta">
      FY{composition.reportingYear} · {composition.jobNumber} · issued {formatDate(composition.issuedAt.slice(0, 10))}
    </div>
    {/* The basis appears on the cover as well as the methodology page: whoever reads only
        the first page should still know what this document is and is not. */}
    <div className="nzr-cover-basis">{composition.assurance.statement}</div>
  </section>;
}

function Page({ children, footer, number }: { children: React.ReactNode; footer: string; number: number }) {
  return <section className="nzr-page">
    {children}
    <div className="nzr-pf"><span>{footer}</span><span>{number}</span></div>
  </section>;
}

function SectionHead({ n, section }: { n: string; section: keyof typeof reportCompositionSectionMeta }) {
  const meta = reportCompositionSectionMeta[section];
  return <div className="nzr-sechd">
    <span className="n">{n}</span>
    <div><div className="eyebrow">{meta.eyebrow}</div><h2>{meta.title}</h2></div>
  </div>;
}

/** A section with nothing to say, saying so — never zeros standing in for absence. */
function Gap({ section }: { section: ReportSectionGap }) {
  return <p className="nzr-gap">{section.reason}</p>;
}

function Figure({ label, value, unit }: { label: string; value: string; unit: string }) {
  return <div className="nzr-figure"><div className="l">{label}</div><div className="v num">{value} <small>{unit}</small></div></div>;
}

/** What this section rested on, beside the numbers rather than only on a back page. */
function Provenance({ provenance }: { provenance: ReportProvenance }) {
  const tiers = provenance.qualityTiers.map((tier) => `${tier.tier} ${tier.count}`).join(" · ");
  return <div className="nzr-prov">
    {provenance.factorSets.length > 0 ? <>Factor set: {provenance.factorSets.join(" · ")}. </> : null}
    As at {formatDate(provenance.asAt)}. {tiers ? <>Data quality: {tiers}. </> : null}
    Evidence hash {provenance.dataHash}.
  </div>;
}
