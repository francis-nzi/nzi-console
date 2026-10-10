import { Fragment } from "react";
import { NziIcon, type NziIconKey } from "@nzi/ui";
import {
  CRP_RESOLVER_VERSION, EmissionsByActivity, EmissionsScopeDonut, EmissionsSiteDonut, IntensityPathway, PurchasedGoodsBreakdown, ReductionPathway,
  RENDERER_VERSION, resolveCrpCoreCharts, ScopeYearOnYearBar, SrsPillarRadar, TOKENS_VERSION,
  type EmissionsByActivityData, type IntensityPathwayData, type PurchasedGoodsBreakdownData, type ScopeDonutData,
  type ScopeYearOnYearData,
} from "@nzi/charts";
import {
  strategyControlLevelLabels, strategyScopeLabel, strategyStatusLabels, isReportGap, reportCompositionSectionMeta,
  isReportDataSection, reportHeadline, reportMethodologyRows, reportOmittedSections, reportRendererOf, reportResidualTco2e, reportScopeFlag, reportSectionLayout,
  reportSectionPlanOf, reportSrsRadarChart,
  type ReportCompositionScope, type ReportCompositionSectionKey, type ReportEmissionsComparison,
  type StrategyScope, type ReportComposition, type ReportProvenance, type ReportSectionGap,
  type ReportSrsRoadmap, type ReportSrsSection,
} from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";
import { LogoMark } from "../../lib/LogoMark";
import { reportPathway, siteActivities, siteScopeDonut, sitesDonut } from "./scopeCharts";

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
  // F-0 (RULING-reporting-F Q4): the layout is chosen by the composition, not by whichever view is deployed. A layout
  // change that would alter an issued report forks to a new renderer; it never redraws this one.
  const renderer = reportRendererOf(composition);
  if (renderer === "composed@1") return <ComposedV1 composition={composition} />;
  // F-2 (chart parity): composed@1 plus the manifest's charts, drawn from the frozen chart basis by the resolver the portal
  // uses — so a client loses no chart they see today when the portal moves onto the composed report (F-4).
  if (renderer === "composed@2") return <ComposedV1 composition={composition} charts={composition.chartBasis ? resolveCrpCoreCharts(composition.chartBasis as Parameters<typeof resolveCrpCoreCharts>[0]) : []} />;
  return <UnknownRenderer renderer={composition.renderer ?? ""} />;
}

type ComposedCharts = ReturnType<typeof resolveCrpCoreCharts>;

/**
 * `composed@1`: the layout every composition issued up to F-0 was drawn with. Pinned byte-for-byte in CI
 * (`reportComposedRenderer.test.ts`). Do not change what it draws — fork to `composed@2`. `charts` is composed@2's addition:
 * absent, this draws composed@1 exactly.
 */
function ComposedV1({ composition, charts }: { composition: ReportComposition; charts?: ComposedCharts }) {
  const chart = <T,>(type: string) => charts?.find((entry) => entry.spec.type === type) as T | undefined;
  const scopeDonut = chart<ScopeDonutData>("emissions_scope_donut"), yearOnYear = chart<ScopeYearOnYearData>("scope_year_on_year_bar");
  const byActivity = chart<EmissionsByActivityData>("emissions_by_activity"), purchasedGoods = chart<PurchasedGoodsBreakdownData>("purchased_goods_breakdown");
  const intensityPathway = chart<IntensityPathwayData>("intensity_pathway");
  const { emissions, intensity, targets, plan, srs } = composition;
  // The reduction pathway is the report's own targets (the client target model), not the resolver's job-level target.
  const pathway = charts && !isReportGap(targets) ? reportPathway(composition, targets) : null;
  const footer = `${composition.client} · Carbon Reduction Plan FY${composition.reportingYear}`;
  // The figure the pathway actually lands on — read from the model, never assumed to be 0.
  const residual = isReportGap(targets) ? null : reportResidualTco2e(targets);
  // S-2: a composition with a sites breakdown gains the "Sites & reporting boundary" section; one frozen before S-2 has
  // none, and the plan's numbering closes over it.
  const hasSites = !isReportGap(emissions) && (emissions.sites?.length ?? 0) > 0;
  const scope = composition.scope;
  const realSites = hasSites && !isReportGap(emissions) ? (emissions.sites ?? []).filter((site) => site.siteId !== null) : [];
  // composed@1 draws the data sections; the narrative is not part of this layout (Q6: it renders with a later one).
  const sectionPlan = reportSectionPlanOf(composition);
  const layout = reportSectionLayout(sectionPlan, (key) => isReportDataSection(key) && (key !== "sites" || hasSites));
  // F-1: a section left out at the issuer's choice is said on the Methodology page, never silently dropped.
  const omitted = reportOmittedSections(sectionPlan);

  // One renderer per section; the plan decides which appear, in what order, with what number and page.
  const sections: Record<ReportCompositionSectionKey, (n: string, page: number) => React.ReactNode> = {
    cover: () => <Cover composition={composition} />,

    "executive-summary": (n, page) => <Page footer={footer} number={page}>
      <SectionHead n={n} section="executive-summary" />
      <ScopeFlag scope={scope} kind="site" />
      <p className="nzr-lede">{reportHeadline(emissions, composition.reportingYear, scope)}</p>
      {!isReportGap(emissions) ? <div className="nzr-figures">
        <Figure label="Assured emissions" value={tonnes(emissions.totalTco2e)} unit="tCO₂e" />
        {emissions.byScope.map((entry) => <Figure key={entry.scope}
          label={strategyScopeLabel(entry.scope as StrategyScope)} value={tonnes(entry.tco2e)} unit="tCO₂e" />)}
      </div> : <Gap section={emissions} />}
      {!isReportGap(emissions) && emissions.unallocated ? <Unallocated statement={emissions.unallocated.statement} /> : null}
    </Page>,

    emissions: (n, page) => <Page footer={footer} number={page}>
      <SectionHead n={n} section="emissions" />
      <ScopeFlag scope={scope} kind="site" />
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
          {emissions.unallocated ? <Unallocated statement={emissions.unallocated.statement} /> : null}
          {emissions.periodConflicts?.length ? <div className="nzr-callout warn" role="note">{emissions.periodConflicts.map((conflict) => <p key={conflict.period}>{conflict.jobNumbers.join(" and ")} both report {conflict.period}. Resolve which stands before comparing that period — it is not summed or chosen here.</p>)}</div> : null}
          {emissions.comparison
            ? <Comparison comparison={emissions.comparison} chartHasEarlierYears={yearOnYear?.years.some((entry) => entry.year < composition.reportingYear) ?? false} />
            : emissions.priorYear === null
            ? <p className="nzr-note">This is the first assured year, so there is no prior year to compare against.</p>
            : <p className="nzr-note">FY{emissions.priorYear.year} assured total: {tonnes(emissions.priorYear.totalTco2e)} tCO₂e.</p>}
          {charts ? <div className="nzr-charts">
            {scopeDonut ? <div className="nzr-chart"><EmissionsScopeDonut data={scopeDonut} /></div> : null}
            {yearOnYear ? <div className="nzr-chart wide"><ScopeYearOnYearBar data={yearOnYear} /></div> : null}
            {byActivity ? <div className="nzr-chart wide"><EmissionsByActivity data={byActivity} /></div> : null}
            {purchasedGoods ? <div className="nzr-chart wide"><PurchasedGoodsBreakdown data={purchasedGoods} /></div> : null}
          </div> : null}
          <Provenance provenance={emissions.provenance} />
        </>}
    </Page>,

    // Present only where a site breakdown was frozen (the layout's `present`), so emissions is never a gap here.
    sites: (n, page) => isReportGap(emissions) ? null : <Page footer={footer} number={page}>
      <SectionHead n={n} section="sites" />
      <ScopeFlag scope={scope} kind="site" />
      <p className="nzr-note">{scope?.kind === "sites" ? "This report covers the selected sites below." : "This report covers the following sites, and the organisation-level emissions not attributable to any one of them."}</p>
      <div className="nzr-chart"><EmissionsSiteDonut data={sitesDonut(composition, emissions)} /></div>
      <table className="nzr-tbl">
        <thead><tr><th>Site</th><th className="r">tCO₂e</th><th className="r">Share</th></tr></thead>
        <tbody>{(emissions.sites ?? []).map((site) => <tr key={site.siteId ?? "unallocated"}><td>{site.label}</td><td className="r num">{tonnes(site.totalTco2e)}</td><td className="r num">{emissions.totalTco2e === 0 || site.siteId === null && scope?.kind === "sites" ? "—" : `${((site.totalTco2e / emissions.totalTco2e) * 100).toFixed(1)}%`}</td></tr>)}</tbody>
        <tfoot><tr><td>Total</td><td className="r num">{tonnes(emissions.totalTco2e)}</td><td className="r num">100%</td></tr></tfoot>
      </table>
      {emissions.unallocated ? <Unallocated statement={emissions.unallocated.statement} /> : null}
      {realSites.length > 1 ? <>
        <h3 className="nzr-h3">By site</h3>
        {realSites.map((site) => <section className="nzr-site" key={site.siteId}>
          <h4>{site.label}</h4>
          <div className="nzr-site-charts"><EmissionsScopeDonut data={siteScopeDonut(composition, emissions, site)} /><EmissionsByActivity data={siteActivities(composition, emissions, site)} /></div>
          {site.floorAreaIntensity ? <p className="nzr-note">Floor-area intensity: {site.floorAreaIntensity.value === null ? site.floorAreaIntensity.reason : <><b className="num">{site.floorAreaIntensity.value.toLocaleString("en-GB", { maximumFractionDigits: 3 })}</b> {site.floorAreaIntensity.unit} over {site.floorAreaIntensity.floorAreaM2?.toLocaleString("en-GB")} m²</>}. Other measures are reported at whole-client level only.</p> : null}
        </section>)}
      </> : null}
      <Provenance provenance={emissions.provenance} />
    </Page>,

    intensity: (n, page) => <Page footer={footer} number={page}>
      <SectionHead n={n} section="intensity" />
      <ScopeFlag scope={scope} kind="site" />
      {isReportGap(intensity)
        ? <Gap section={intensity} />
        : <>
          {/* RF-1, to the Report Studio mockup: one row per measure — icon, name, what it is per, the figure. The measure the
              CRP reports carries the drawer's own words; a composition frozen before RF-1 has no mark and no per-line, and
              shows exactly the figures it always did. */}
          <div className="nzr-metrics">
            {intensity.metrics.map((metric) => <div className={`nzr-metric${metric.reported ? " reported" : ""}`} key={metric.key}>
              <span className="ic"><NziIcon name={iconKey(metric.iconKey)} size={18} /></span>
              <div className="nm">
                <div className="l">{metric.label}{metric.reported ? <span className="nzr-tag reported">Reported in the CRP</span> : null}{metric.scopeNote ? <span className="nzr-tag whole">{metric.scopeNote}</span> : null}</div>
                {metric.denominatorText ? <div className="u">{metric.denominatorText}</div> : null}
              </div>
              {/* A measure with no value says why, in its own words. Never a dash, and
                  never 0 — which would read as "no emissions per employee". */}
              {metric.value === null
                ? <div className="u why">{metric.unavailableReason}</div>
                : <div className="v num">{metric.value.toLocaleString("en-GB", { maximumFractionDigits: 2 })} <small>{metric.unit}</small></div>}
            </div>)}
          </div>
          <Provenance provenance={intensity.provenance} />
        </>}
      {/* Found by the F-2 render: drawn only beside a composed Intensity section — a page that says "no intensity measures"
          never also draws an intensity pathway. */}
      {intensityPathway && !isReportGap(intensity) ? <div className="nzr-chart wide"><IntensityPathway data={intensityPathway} /></div> : null}
    </Page>,

    targets: (n, page) => <Page footer={footer} number={page}>
      <SectionHead n={n} section="targets" />
      <ScopeFlag scope={scope} kind="client" />
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
      {pathway ? <div className="nzr-chart wide"><ReductionPathway data={pathway} /></div> : null}
    </Page>,

    plan: (n, page) => <Page footer={footer} number={page}>
      <SectionHead n={n} section="plan" />
      <ScopeFlag scope={scope} kind="client" />
      {isReportGap(plan)
        ? <Gap section={plan} />
        : <>
          <div className="nzr-plan-summary">
            <span><b className="num">{plan.summary.total}</b> strategies</span>
            <span><b className="num">{plan.summary.inProgress}</b> in progress</span>
            <span><b className="num">{plan.summary.complete}</b> complete</span>
            <span><b className="num">{plan.summary.planned}</b> planned</span>
          </div>
          {/* Grouped by lever — the theme a strategy sits under. */}
          {plan.groups.map((group) => <section className="nzr-plan-group" key={group.leverId}>
            <h3>{group.label}</h3>
            {group.strategies.map((strategy, index) => <div className="nzr-strategy" key={`${strategy.title}-${index}`}>
              <div className="nm">{strategy.title}</div>
              <div className="mt">
                <span className="nzr-tag">{strategyScopeLabel(strategy.scope as StrategyScope)}</span>
                {/* How much of it the client controls — an attribute of this strategy, not a
                    grouping; lever remains the grouping above. Absent on compositions frozen
                    before it was carried, which render without the chip rather than guessing. */}
                {strategy.controlLevel !== undefined
                  ? <span className="nzr-tag ctl">{strategyControlLevelLabels[strategy.controlLevel]}</span>
                  : null}
                {/* What it advances. The whole point of the alignment is that a reader can
                    see which disclosure each strategy is for. */}
                {strategy.srsRequirementCodes.map((code) => <span className="nzr-tag srs" key={code}>{code}</span>)}
                {[strategy.category, strategy.owner, strategy.targetDate === null ? "" : formatDate(strategy.targetDate)]
                  .filter(Boolean).join(" · ")}
              </div>
              <div className="st">{strategyStatusLabels[strategy.status]} · {strategy.progressPct}%</div>
            </div>)}
          </section>)}
          {/* Said plainly: this is a selection, not necessarily the whole plan. */}
          {plan.excludedCount > 0 ? <p className="nzr-note">
            {plan.excludedCount} further {plan.excludedCount === 1 ? "strategy is" : "strategies are"} on this
            client&rsquo;s plan but not included in this report.
          </p> : null}
          <p className="nzr-note">
            The plan is tracked qualitatively: the percentages above are reported progress against each
            strategy, not a modelled carbon reduction. Each strategy shows the UK SRS requirement it
            advances. Quantified impact per strategy is not yet part of this report.
          </p>
        </>}
    </Page>,

    srs: (n, page) => <Page footer={footer} number={page}>
      <SectionHead n={n} section="srs" />
      <ScopeFlag scope={scope} kind="client" />
      {isReportGap(srs)
        ? <Gap section={srs} />
        : <>
          <p className="nzr-lede">
            UK SRS readiness stands at <b>{srs.overallLabel} ({srs.overallPct}%)</b>, assessed
            on {formatDate(srs.assessedOn)} against framework version {srs.frameworkVersion}.
          </p>
          <div className="nzr-srs">
            {srs.radar ? <SrsRadar srs={srs} /> : null}
            <table className="nzr-tbl">
              <thead><tr><th>Pillar</th><th>Maturity</th></tr></thead>
              <tbody>{srs.pillars.map((pillar) => <tr key={pillar.label}>
                <td>{pillar.label}</td><td>{pillar.maturityLabel}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {/* A composition frozen before the roadmap shipped carries none, and renders none. */}
          {srs.roadmap ? <SrsRoadmap roadmap={srs.roadmap} /> : null}
          <p className="nzr-note">
            Readiness is an assessment of this organisation&rsquo;s own reporting maturity. It is not a
            statement that the disclosure has been prepared, filed or assured.
          </p>
        </>}
    </Page>,

    methodology: (n, page) => <Page footer={footer} number={page}>
      <SectionHead n={n} section="methodology" />
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
      {omitted.length > 0 ? <p className="nzr-note nzr-omitted">Omitted from this report at the issuer&rsquo;s choice: {omitted.join(", ")}.</p> : null}
    </Page>,
  };

  return <main className="nzr-doc">
    {layout.map((entry) => isReportDataSection(entry.key)
      ? <Fragment key={entry.key}>{sections[entry.key](entry.number ?? "", entry.page)}</Fragment>
      : null)}
  </main>;
}

/**
 * A composition naming a layout this code does not carry. Drawing it with another layout would show the client a document
 * they were never sent, so it says so instead. Its frozen figures are untouched.
 */
function UnknownRenderer({ renderer }: { renderer: string }) {
  return <main className="nzr-doc"><section className="nzr-page">
    <p className="nzr-gap">
      This report was issued with a layout ({renderer}) this console does not carry, so it is not drawn here rather than
      drawn differently from how it was issued. Its frozen figures are unchanged.
    </p>
  </section></main>;
}

function Cover({ composition }: { composition: ReportComposition }) {
  // The issuer frozen at validation (0143): a profile edited since does not change a document already issued.
  const issuer = composition.issuer ?? null;
  return <section className="nzr-page nzr-cover">
    <div className="nzr-brand">
      {issuer
        ? <LogoMark src={issuer.logoAssetId ? `/api/isolated/organisation/logo?asset=${encodeURIComponent(issuer.logoAssetId)}` : null} name={issuer.displayName} className="nzr-brand-mark" />
        : <span className="nzr-brand-mark" aria-hidden="true">N</span>}
      <div><b>NZ Insights Pro</b>{issuer ? <small>{issuer.displayName}</small> : null}</div>
    </div>
    <h1>{reportCompositionSectionMeta.cover.title}</h1>
    <div className="nzr-cover-client">{composition.client}</div>
    {/* F-1 (R-D1): the client's issuer line, frozen at validation. Absent on every report issued before it. */}
    {composition.issuerLine ? <div className="nzr-cover-issuer">{composition.issuerLine}</div> : null}
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

/**
 * Readiness by pillar, drawn from the frozen composition.
 *
 * The same `SrsPillarRadar` the workspace uses — one spec, one renderer, so screen, portal
 * and PDF cannot drift apart. It reads `srs.radar` and nothing live: the shape is what this
 * report said when it was issued, not what the client has reassessed to since.
 *
 * Axis labels are shortened to fit 300px. That is presentation, so it happens here and is
 * never frozen — the full pillar names stay in the table beside it.
 */
function SrsRadar({ srs }: { srs: ReportSrsSection }) {
  const chart = reportSrsRadarChart(srs);
  if (!chart) return null;
  return <div className="nzr-chart">
    <SrsPillarRadar showChrome={false} width={300} data={{
      spec: { id: `report-srs-radar-${srs.assessedOn}`, type: "srs_pillar_radar", title: "Readiness by pillar", family: "crp", specVersion: 1 },
      unit: "level", state: "success",
      // Readiness is derived from the client's own answers, not from the footprint: it has
      // no factor set and no snapshot behind it, and borrowing the emissions provenance
      // would attribute it to a measurement it never came from. Same as the workspace radar.
      provenance: {
        jobId: "", dataHash: "", factorSets: [], generatedAt: srs.assessedOn, reviewedSnapshotId: "",
        resolverVersion: CRP_RESOLVER_VERSION, tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION,
      },
      ...chart,
    }} />
  </div>;
}

/**
 * What to work on next, and what the client is already doing about it.
 *
 * Every word comes from the frozen composition: the gaps as assessed at issue, answered by
 * the plan this same report froze. A gap with nothing against it says so — that is the
 * useful half of the picture, and filling it in would be inventing work.
 */
function SrsRoadmap({ roadmap }: { roadmap: ReportSrsRoadmap }) {
  if (roadmap.pillars.length === 0) {
    return <p className="nzr-note">
      No requirement sits below the maturity the framework expects of it, so there is nothing outstanding
      on this assessment.
    </p>;
  }
  return <div className="nzr-roadmap">
    <h3>What to address next</h3>
    <p className="nzr-note" style={{ marginTop: 0 }}>
      Requirements below the maturity expected of them, furthest short first, with the reduction
      strategies on this plan that advance each one.
      {roadmap.unaddressedCount > 0
        ? ` ${roadmap.unaddressedCount} ${roadmap.unaddressedCount === 1 ? "has" : "have"} no strategy aligned yet.`
        : ""}
    </p>
    {roadmap.pillars.map((pillar) => <div className="nzr-roadmap-pillar" key={pillar.key}>
      <h4>{pillar.label}</h4>
      {pillar.gaps.map((gap) => <div className="nzr-roadmap-gap" key={gap.code}>
        <div className="hd">
          <span className="nzr-tag srs">{gap.code}</span>
          <b>{gap.title}</b>
          <span className="lv">{gap.maturityLabel} → {gap.targetLabel}</span>
        </div>
        {gap.strategies.length > 0
          ? <ul>{gap.strategies.map((strategy) => <li key={strategy.title}>
            {strategy.title} <span className="st">{strategy.statusLabel}</span>
          </li>)}</ul>
          : <p className="none">No strategy aligned yet.</p>}
      </div>)}
    </div>)}
  </div>;
}

function SectionHead({ n, section }: { n: string; section: keyof typeof reportCompositionSectionMeta }) {
  const meta = reportCompositionSectionMeta[section];
  return <div className="nzr-sechd">
    <span className="n">{n}</span>
    <div><div className="eyebrow">{meta.eyebrow}</div><h2>{meta.title}</h2></div>
  </div>;
}

/** S-2: which view this section is — "Recomposed for: …" on site sections, "Client-level …" on the client's own records. */
function ScopeFlag({ scope, kind }: { scope: ReportCompositionScope | undefined; kind: "site" | "client" }) {
  const flag = reportScopeFlag(scope, kind);
  return flag ? <div className={`nzr-scopeflag ${kind}`}>{flag}</div> : null;
}

/** S-2, sub-ruling 1: what a site view leaves out, said where the headline figure is — never apportioned, never a footnote. */
function Unallocated({ statement }: { statement: string }) {
  return <div className="nzr-callout unallocated" role="note"><b>Organisation-level emissions are not in this view.</b> {statement}</div>;
}

/**
 * S-2, sub-ruling 4: year-on-year for this scope — the columns are the assured periods that exist, never a toggle.
 *
 * `chartHasEarlierYears` (composed@2 only, F-2 finding 3): the year-on-year chart reads the snapshot's *reviewed* history —
 * native or re-ingested v7 — which can reach back past the first *assured* period. The note then says which is which rather
 * than denying the chart beneath it. composed@1 draws no chart, never passes it, and keeps its issued text.
 */
function Comparison({ comparison, chartHasEarlierYears = false }: { comparison: ReportEmissionsComparison; chartHasEarlierYears?: boolean }) {
  const cell = (value: number | null) => value === null ? <span className="muted">Not attributable</span> : tonnes(value);
  // With only the current period the table would repeat the scope table above: say there is nothing earlier instead.
  if (comparison.columns.length === 1) return chartHasEarlierYears
    ? <p className="nzr-note">This is the first assured period, so there is no earlier assured period to compare against. The chart below includes earlier reviewed years.</p>
    : <p className="nzr-note">This is the first assured period, so there is no earlier period to compare against.</p>;
  return <>
    <table className="nzr-tbl nzr-compare">
      <thead><tr><th>Scope</th>{comparison.columns.map((column) => <th className="r" key={column.key}>{column.label}</th>)}{comparison.changeVsBaselinePct !== null ? <th className="r">vs baseline</th> : null}</tr></thead>
      <tbody>{comparison.rows.map((row) => <tr key={row.scope}><td>{strategyScopeLabel(row.scope as StrategyScope)}</td>{row.values.map((value, index) => <td className="r num" key={index}>{cell(value)}</td>)}{comparison.changeVsBaselinePct !== null ? <td /> : null}</tr>)}</tbody>
      <tfoot><tr><td>Total</td>{comparison.totals.map((value, index) => <td className="r num" key={index}>{cell(value)}</td>)}{comparison.changeVsBaselinePct !== null ? <td className="r num">{comparison.changeVsBaselinePct > 0 ? "+" : comparison.changeVsBaselinePct < 0 ? "−" : ""}{Math.abs(comparison.changeVsBaselinePct).toFixed(1)}%</td> : null}</tr></tfoot>
    </table>
    {comparison.notes.map((note) => <p className="nzr-note" key={note}>{note}</p>)}
  </>;
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
