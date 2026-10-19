import { Fragment } from "react";
import { NziIcon, type NziIconKey } from "@nzi/ui";
import {
  CRP_RESOLVER_AGGREGATED, CRP_RESOLVER_VERSION, EmissionsByActivity, EmissionsScopeDonut, EmissionsSiteDonut, IntensityPathway, PurchasedGoodsBreakdown, ReductionPathway,
  RENDERER_VERSION, resolveCrpCoreCharts, ScopeYearOnYearBar, SrsPillarRadar, TOKENS_VERSION, withSourceSummary,
  type AnyChartData, type EmissionsByActivityData, type IntensityPathwayData, type PurchasedGoodsBreakdownData, type ScopeDonutData,
  type ScopeYearOnYearData,
} from "@nzi/charts";
import {
  strategyControlLevelLabels, strategyScopeLabel, strategyStatusLabels, isReportGap, reportCompositionSectionMeta, reportSectionMetaV4, reportComposed4Sections,
  isReportDataSection, reportHeadline, reportMethodologyRows, reportOmittedSections, reportRendererOf, reportResidualTco2e, reportScopeFlag, reportSectionLayout,
  reportSectionPlanOf, reportSrsRadarChart, qualityTierLabel,
  type ReportAuditAppendix, type ReportCompositionScope, type ReportCompositionSectionKey, type ReportEmissionsComparison,
  type StrategyScope, type ReportComposition, type ReportProvenance, type ReportSectionGap,
  type ReportSrsRoadmap, type ReportSrsSection,
} from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";
import { LogoMark } from "../../lib/LogoMark";
import { ComposedV5, type NarrativeEditor } from "./ReportComposedV5";
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

/** Where the issuer's logo is served from: the staff route by default; the portal passes its grant-checked route (F-4, D4). */
export type IssuerLogoSrc = (assetId: string) => string;
export const staffIssuerLogoSrc: IssuerLogoSrc = (assetId) => `/api/isolated/organisation/logo?asset=${encodeURIComponent(assetId)}`;

export function ReportComposedView({ composition, issuerLogoSrc = staffIssuerLogoSrc, clientLogoSrc, preview = false, mode = "page", narrativeEditor }: {
  composition: ReportComposition; issuerLogoSrc?: IssuerLogoSrc;
  /** composed@5: where the client's frozen logo is served from (the staff route by default; the portal passes its own). */
  clientLogoSrc?: IssuerLogoSrc;
  /** B0/B1: a composition shown before it is issued. Only `composed@3` draws it ("preview — not issued"); earlier layouts ignore it. */
  preview?: boolean;
  /** composed@5: the mockup's page view (A4 sheets) or continuous view. Earlier layouts ignore it. */
  mode?: "page" | "flow";
  /** B2-4 (composed@6): the Report Studio's narrative editor, on a draft only. Every other caller leaves it out. */
  narrativeEditor?: NarrativeEditor;
}) {
  // F-0 (RULING-reporting-F Q4): the layout is chosen by the composition, not by whichever view is deployed. A layout
  // change that would alter an issued report forks to a new renderer; it never redraws this one.
  const renderer = reportRendererOf(composition);
  if (renderer === "composed@1") return <ComposedV1 composition={composition} issuerLogoSrc={issuerLogoSrc} />;
  // F-2 (chart parity): composed@1 plus the manifest's charts, drawn from the frozen chart basis by the resolver the portal
  // uses — so a client loses no chart they see today when the portal moves onto the composed report (F-4).
  if (renderer === "composed@2") return <ComposedV1 composition={composition} issuerLogoSrc={issuerLogoSrc} charts={composition.chartBasis ? resolveCrpCoreCharts(composition.chartBasis as Parameters<typeof resolveCrpCoreCharts>[0]) : []} />;
  // B1 (composed@3): one source line per chart and section from the frozen `sources`, activities aggregated (resolver v2),
  // the audit appendix closing Methodology, and a preview that says it is one.
  if (renderer === "composed@3") return <ComposedV1 composition={composition} issuerLogoSrc={issuerLogoSrc} v3={{ preview }}
    charts={withSourceSummary(composition.chartBasis ? resolveCrpCoreCharts(composition.chartBasis as Parameters<typeof resolveCrpCoreCharts>[0], { resolverVersion: CRP_RESOLVER_AGGREGATED }) : [], composition.sources?.summary)} />;
  // B2-3 (composed@4): composed@3 with the mockup's section set and titles — Analysis by Scope, Emissions by Scope & Category,
  // and the reference block after Methodology (Glossary, the Full Emissions Audit, Appendix 2) — the cover's metacard and the
  // sign-off. The same charts as composed@3.
  if (renderer === "composed@4") return <ComposedV1 composition={composition} issuerLogoSrc={issuerLogoSrc} v3={{ preview, v4: true }}
    charts={withSourceSummary(composition.chartBasis ? resolveCrpCoreCharts(composition.chartBasis as Parameters<typeof resolveCrpCoreCharts>[0], { resolverVersion: CRP_RESOLVER_AGGREGATED }) : [], composition.sources?.summary)} />;
  // BUILD-report-studio-composed5: the mockup's document, its own renderer (ReportComposedV5.tsx) — composed@1/2/3/4 above
  // are untouched by it.
  if (renderer === "composed@5") return <ComposedV5 composition={composition} issuerLogoSrc={issuerLogoSrc} {...(clientLogoSrc ? { clientLogoSrc } : {})} preview={preview} mode={mode} />;
  // B2-4 (RULING-report-studio-B2-4 (a)): composed@6 is composed@5 drawing its frozen narrative — the same renderer, its own branch.
  if (renderer === "composed@6") return <ComposedV5 composition={composition} issuerLogoSrc={issuerLogoSrc} {...(clientLogoSrc ? { clientLogoSrc } : {})} preview={preview} mode={mode} narrativeEditor={narrativeEditor} />;
  return <UnknownRenderer renderer={composition.renderer ?? ""} />;
}

type ComposedCharts = ReturnType<typeof resolveCrpCoreCharts>;

/** `composed@3`'s additions, and `composed@4`'s (`v4`). Absent, `ComposedV1` draws `composed@1/2` exactly as pinned. */
type ComposedV3 = { preview: boolean; v4?: boolean };

/**
 * `composed@1`: the layout every composition issued up to F-0 was drawn with. Pinned byte-for-byte in CI
 * (`reportComposedRenderer.test.ts`). Do not change what it draws — fork to `composed@2`. `charts` is composed@2's addition:
 * absent, this draws composed@1 exactly.
 */
function ComposedV1({ composition, charts, issuerLogoSrc, v3 }: { composition: ReportComposition; charts?: ComposedCharts; issuerLogoSrc: IssuerLogoSrc; v3?: ComposedV3 }) {
  // composed@3: the one source line, frozen at compose — undefined on composed@1/2, whose charts and sections name what
  // they always did.
  const summary = v3 ? composition.sources?.summary : undefined;
  const sourced = <T extends AnyChartData>(data: T): T => withSourceSummary([data], summary)[0]!;
  const chart = <T,>(type: string) => charts?.find((entry) => entry.spec.type === type) as T | undefined;
  const scopeDonut = chart<ScopeDonutData>("emissions_scope_donut"), yearOnYear = chart<ScopeYearOnYearData>("scope_year_on_year_bar");
  const byActivity = chart<EmissionsByActivityData>("emissions_by_activity"), purchasedGoods = chart<PurchasedGoodsBreakdownData>("purchased_goods_breakdown");
  const intensityPathway = chart<IntensityPathwayData>("intensity_pathway");
  const { emissions, targets, plan, srs } = composition;
  // B2-3 (RULING-report-B2-3 / F4, NZC-120): composed@4 never prints a money amount — a currency measure's frozen denominator
  // ("£12,500,000", RF-1) is left out; its ratio unit ("tCO₂e / £m") stays. composed@1/2/3 draw what they always did.
  const intensity = v3?.v4 && !isReportGap(composition.intensity)
    ? { ...composition.intensity, metrics: composition.intensity.metrics.map((metric) => isMoneyText(metric.denominatorText) ? { ...metric, denominatorText: null } : metric) }
    : composition.intensity;
  // The reduction pathway is the report's own targets (the client target model), not the resolver's job-level target.
  const drawnPathway = charts && !isReportGap(targets) ? reportPathway(composition, targets) : null;
  const pathway = drawnPathway ? sourced(drawnPathway) : null;
  const footer = `${composition.client} · Carbon Reduction Plan FY${composition.reportingYear}`;
  // The figure the pathway actually lands on — read from the model, never assumed to be 0.
  const residual = isReportGap(targets) ? null : reportResidualTco2e(targets);
  // S-2: a composition with a sites breakdown gains the "Sites & reporting boundary" section; one frozen before S-2 has
  // none, and the plan's numbering closes over it.
  const hasSites = !isReportGap(emissions) && (emissions.sites?.length ?? 0) > 0;
  const scope = composition.scope;
  const realSites = hasSites && !isReportGap(emissions) ? (emissions.sites ?? []).filter((site) => site.siteId !== null) : [];
  // composed@1 draws the data sections; the narrative is not part of this layout (Q6: it renders with a later one).
  // B2-3: composed@4 also draws its own sections, by its own titles; composed@1/2/3 never draw them, whatever a plan holds.
  const v4 = v3?.v4 === true;
  const meta = v4 ? reportSectionMetaV4 : reportCompositionSectionMeta;
  const sectionPlan = reportSectionPlanOf(composition);
  const layout = reportSectionLayout(sectionPlan, (key) => isReportDataSection(key) && (key !== "sites" || hasSites) && (v4 || !reportComposed4Sections.includes(key)));
  // F-1: a section left out at the issuer's choice is said on the Methodology page, never silently dropped.
  const omitted = v4 ? sectionPlan.filter((entry) => !entry.included && isReportDataSection(entry.key)).map((entry) => reportSectionMetaV4[entry.key as ReportCompositionSectionKey].title) : reportOmittedSections(sectionPlan);
  // B2-3: composed@4's Appendix-derived tables, summed at render from the frozen audit rows (no new frozen data, no money).
  const auditRows = v4 ? composition.audit?.rows ?? [] : [];

  // One renderer per section; the plan decides which appear, in what order, with what number and page.
  const sections: Record<ReportCompositionSectionKey, (n: string, page: number) => React.ReactNode> = {
    cover: () => <Cover composition={composition} issuerLogoSrc={issuerLogoSrc} preview={v3?.preview ?? false} v4={v4} />,

    "executive-summary": (n, page) => <Page footer={footer} number={page}>
      <SectionHead meta={meta} n={n} section="executive-summary" />
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
      <SectionHead meta={meta} n={n} section="emissions" />
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
          {/* B2-3: composed@4 draws the comparison and the year-on-year chart in Analysis by Scope, and the purchased-goods
              breakdown in Emissions by Scope & Category. */}
          {v4 ? null : emissions.comparison
            ? <Comparison comparison={emissions.comparison} chartHasEarlierYears={yearOnYear?.years.some((entry) => entry.year < composition.reportingYear) ?? false} />
            : emissions.priorYear === null
            ? <p className="nzr-note">This is the first assured year, so there is no prior year to compare against.</p>
            : <p className="nzr-note">FY{emissions.priorYear.year} assured total: {tonnes(emissions.priorYear.totalTco2e)} tCO₂e.</p>}
          {charts ? <div className="nzr-charts">
            {scopeDonut ? <div className="nzr-chart"><EmissionsScopeDonut data={scopeDonut} /></div> : null}
            {yearOnYear && !v4 ? <div className="nzr-chart wide"><ScopeYearOnYearBar data={yearOnYear} /></div> : null}
            {byActivity ? <div className="nzr-chart wide"><EmissionsByActivity data={byActivity} /></div> : null}
            {purchasedGoods && !v4 ? <div className="nzr-chart wide"><PurchasedGoodsBreakdown data={purchasedGoods} /></div> : null}
          </div> : null}
          <Provenance provenance={emissions.provenance} summary={summary} />
        </>}
    </Page>,

    // Present only where a site breakdown was frozen (the layout's `present`), so emissions is never a gap here.
    sites: (n, page) => isReportGap(emissions) ? null : <Page footer={footer} number={page}>
      <SectionHead meta={meta} n={n} section="sites" />
      <ScopeFlag scope={scope} kind="site" />
      <p className="nzr-note">{scope?.kind === "sites" ? "This report covers the selected sites below." : "This report covers the following sites, and the organisation-level emissions not attributable to any one of them."}</p>
      <div className="nzr-chart"><EmissionsSiteDonut data={sourced(sitesDonut(composition, emissions))} /></div>
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
          <div className="nzr-site-charts"><EmissionsScopeDonut data={sourced(siteScopeDonut(composition, emissions, site))} /><EmissionsByActivity data={sourced(siteActivities(composition, emissions, site))} /></div>
          {site.floorAreaIntensity ? <p className="nzr-note">Floor-area intensity: {site.floorAreaIntensity.value === null ? site.floorAreaIntensity.reason : <><b className="num">{site.floorAreaIntensity.value.toLocaleString("en-GB", { maximumFractionDigits: 3 })}</b> {site.floorAreaIntensity.unit} over {site.floorAreaIntensity.floorAreaM2?.toLocaleString("en-GB")} m²</>}. Other measures are reported at whole-client level only.</p> : null}
        </section>)}
      </> : null}
      <Provenance provenance={emissions.provenance} summary={summary} />
    </Page>,

    intensity: (n, page) => <Page footer={footer} number={page}>
      <SectionHead meta={meta} n={n} section="intensity" />
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
          <Provenance provenance={intensity.provenance} summary={summary} />
        </>}
      {/* Found by the F-2 render: drawn only beside a composed Intensity section — a page that says "no intensity measures"
          never also draws an intensity pathway. */}
      {intensityPathway && !isReportGap(intensity) ? <div className="nzr-chart wide"><IntensityPathway data={intensityPathway} /></div> : null}
    </Page>,

    targets: (n, page) => <Page footer={footer} number={page}>
      <SectionHead meta={meta} n={n} section="targets" />
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
          <Provenance provenance={targets.provenance} summary={summary} />
        </>}
      {pathway ? <div className="nzr-chart wide"><ReductionPathway data={pathway} /></div> : null}
    </Page>,

    plan: (n, page) => <Page footer={footer} number={page}>
      <SectionHead meta={meta} n={n} section="plan" />
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
      <SectionHead meta={meta} n={n} section="srs" />
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
      <SectionHead meta={meta} n={n} section="methodology" />
      <table className="nzr-tbl">
        <tbody>{(v3 ? reportMethodologyRows(composition, { factorSet: summary, issued: v3.preview ? "Not issued — preview" : undefined }) : reportMethodologyRows(composition)).map((row) => <tr key={row.label}>
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
      {/* composed@3 closes Methodology with the audit; composed@4 gives it its own section and closes with the sign-off. */}
      {v3 && !v4 && composition.audit ? <AuditAppendix audit={composition.audit} /> : null}
      {v4 ? <SignOff composition={composition} preview={v3?.preview ?? false} /> : null}
    </Page>,

    // ── B2-3: composed@4's sections (RULING-report-B2-3). composed@1/2/3 never reach these: their layouts never hold them. ──

    "scope-analysis": (n, page) => <Page footer={footer} number={page}>
      <SectionHead meta={meta} n={n} section="scope-analysis" />
      <ScopeFlag scope={scope} kind="site" />
      {isReportGap(emissions)
        ? <Gap section={emissions} />
        : <>
          {/* F3: the comparison shows the columns the assured periods support — never a chooser, never a guessed year. */}
          {emissions.comparison
            ? <Comparison comparison={emissions.comparison} chartHasEarlierYears={yearOnYear?.years.some((entry) => entry.year < composition.reportingYear) ?? false} />
            : emissions.priorYear === null
            ? <p className="nzr-note">This is the first assured year, so there is no prior year to compare against.</p>
            : <p className="nzr-note">FY{emissions.priorYear.year} assured total: {tonnes(emissions.priorYear.totalTco2e)} tCO₂e.</p>}
          {yearOnYear ? <div className="nzr-chart wide"><ScopeYearOnYearBar data={yearOnYear} /></div> : null}
          <Provenance provenance={emissions.provenance} summary={summary} />
        </>}
    </Page>,

    "category-analysis": (n, page) => <Page footer={footer} number={page}>
      <SectionHead meta={meta} n={n} section="category-analysis" />
      <ScopeFlag scope={scope} kind="site" />
      {isReportGap(emissions) || auditRows.length === 0
        ? <Gap section={isReportGap(emissions) ? emissions : { state: "unavailable", reason: "This report holds no row-level detail to group by category." }} />
        : <>
          <CategoryTable rows={auditRows} />
          {purchasedGoods ? <div className="nzr-chart wide"><PurchasedGoodsBreakdown data={purchasedGoods} /></div> : null}
          <p className="nzr-note">Categories are this period&rsquo;s, summed from the rows in the Full Emissions Audit. A comparison by category across periods is not part of this report.</p>
        </>}
    </Page>,

    glossary: (n, page) => <Page footer={footer} number={page}>
      <SectionHead meta={meta} n={n} section="glossary" />
      <table className="nzr-tbl nzr-glossary">
        <thead><tr><th>Term</th><th>Definition</th></tr></thead>
        <tbody>{REPORT_GLOSSARY.map((entry) => <tr key={entry.term}><td>{entry.term}</td><td>{entry.definition}</td></tr>)}</tbody>
      </table>
    </Page>,

    audit: (n, page) => <Page footer={footer} number={page}>
      <SectionHead meta={meta} n={n} section="audit" />
      {composition.audit ? <AuditAppendix audit={composition.audit} heading={false} /> : <Gap section={{ state: "unavailable", reason: "This report holds no row-level audit." }} />}
    </Page>,

    "appendix-sites": (n, page) => <Page footer={footer} number={page}>
      <SectionHead meta={meta} n={n} section="appendix-sites" />
      {auditRows.length === 0 ? <Gap section={{ state: "unavailable", reason: "This report holds no row-level detail to group by site." }} /> : <SiteScopeAppendix rows={auditRows} />}
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

function Cover({ composition, issuerLogoSrc, preview, v4 = false }: { composition: ReportComposition; issuerLogoSrc: IssuerLogoSrc; preview: boolean; v4?: boolean }) {
  // The issuer frozen at validation (0143): a profile edited since does not change a document already issued.
  const issuer = composition.issuer ?? null;
  return <section className="nzr-page nzr-cover">
    <div className="nzr-brand">
      {issuer
        ? <LogoMark src={issuer.logoAssetId ? issuerLogoSrc(issuer.logoAssetId) : null} name={issuer.displayName} className="nzr-brand-mark" />
        : <span className="nzr-brand-mark" aria-hidden="true">N</span>}
      <div><b>NZ Insights Pro</b>{issuer ? <small>{issuer.displayName}</small> : null}</div>
    </div>
    <h1>{reportCompositionSectionMeta.cover.title}</h1>
    <div className="nzr-cover-client">{composition.client}</div>
    {/* F-1 (R-D1): the client's issuer line, frozen at validation. Absent on every report issued before it. */}
    {composition.issuerLine ? <div className="nzr-cover-issuer">{composition.issuerLine}</div> : null}
    <div className="nzr-cover-meta">
      {/* composed@3 preview (B0's deferred wording): nothing has been issued, so the cover does not claim an issue date. */}
      {preview
        ? <>FY{composition.reportingYear} · {composition.jobNumber} · preview — not issued</>
        : <>FY{composition.reportingYear} · {composition.jobNumber} · issued {formatDate(composition.issuedAt.slice(0, 10))}</>}
    </div>
    {/* B2-3 (composed@4): the mockup's metacard. A row the composition does not hold (no stamped period) is left out, never guessed. */}
    {v4 ? <Metacard composition={composition} preview={preview} /> : null}
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

/** A section's number, eyebrow and title — from the renderer's own title table (composed@1/2/3's, or composed@4's). */
function SectionHead({ n, section, meta: titles = reportCompositionSectionMeta }: { n: string; section: ReportCompositionSectionKey; meta?: Record<ReportCompositionSectionKey, { eyebrow: string; title: string }> }) {
  const meta = titles[section];
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

/**
 * composed@3 (B1, ruled): the audit appendix, closing Methodology until B2's section rail gives it its own section — every
 * row the report's figures sum, frozen at compose and cut to its scope, with the factor and dataset it rests on. The per-row
 * detail lives here so the charts and sections can name their sources once.
 */
function AuditAppendix({ audit, heading = true }: { audit: ReportAuditAppendix; heading?: boolean }) {
  const t = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  return <section className="nzr-audit" aria-label="Full emissions audit">
    {/* composed@4 draws the audit as its own section, whose heading names it; composed@3's closing block names itself. */}
    {heading ? <h3 className="nzr-h3">Full emissions audit</h3> : null}
    <p className="nzr-note">Each of the {audit.rows.length} row{audit.rows.length === 1 ? "" : "s"} the figures in this report sum, with the factor applied, the dataset or client factor it came from and its data quality.</p>
    <table className="nzr-tbl nzr-audit-tbl">
      <thead><tr><th>Category</th><th>Activity</th><th>Site</th><th>Factor</th><th>Source</th><th>Quality</th><th className="r">tCO₂e</th></tr></thead>
      <tbody>{audit.rows.map((row, index) => <tr key={index}>
        <td>{row.category}</td><td>{row.activity}</td><td>{row.site ?? "Organisation-level"}</td><td>{row.factor}</td><td>{row.source}</td>
        <td>{qualityTierLabel(row.qualityTier) ?? "Not recorded"}</td><td className="r num">{t(row.tco2e)}</td>
      </tr>)}</tbody>
      <tfoot><tr><td colSpan={6}>Total</td><td className="r num">{t(audit.totalTco2e)}</td></tr></tfoot>
    </table>
  </section>;
}

/** A section with nothing to say, saying so — never zeros standing in for absence. */
function Gap({ section }: { section: ReportSectionGap }) {
  return <p className="nzr-gap">{section.reason}</p>;
}

/* ── B2-3: composed@4's pieces (RULING-report-B2-3). Each draws only what the composition froze; none carries money. ── */

type AuditRows = ReportAuditAppendix["rows"];
/** A money amount — a currency symbol, or a currency code beside a figure (the issuer-line rule's shape). */
const isMoneyText = (text: string | null | undefined): boolean =>
  !!text && /[£$€¥₹]|\b(GBP|USD|EUR|AED|CHF|JPY|AUD|CAD|NZD|SAR|INR)\b/i.test(text);
const dd = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const share = (part: number, total: number) => total === 0 ? "—" : `${((part / total) * 100).toFixed(1)}%`;
const t2 = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 2 });

/** The cover's metacard: client, title, reporting period (when frozen), scope, and when the report was generated. */
function Metacard({ composition, preview }: { composition: ReportComposition; preview: boolean }) {
  const scope = composition.scope?.kind === "sites" ? composition.scope.siteLabels.join(", ") : "Whole client";
  const rows: Array<[string, string]> = [
    ["Client", composition.client],
    ["Report title", `${composition.client} Carbon Reduction Plan FY${composition.reportingYear}`],
    ...(composition.reportingPeriod ? [["Reporting period", `${dd(composition.reportingPeriod.from)} – ${dd(composition.reportingPeriod.to)}`] as [string, string]] : []),
    ["Scope", scope],
    ["Report generated", preview ? "Not issued — preview" : formatDate(composition.issuedAt.slice(0, 10))],
  ];
  return <dl className="nzr-metacard">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

/**
 * The declaration and sign-off (call 2): the firm's side is the frozen issuer; the client's is the signee the version named at
 * validate — with blank signature and date lines for wet signing. No other identity is introduced.
 */
function SignOff({ composition, preview }: { composition: ReportComposition; preview: boolean }) {
  return <section className="nzr-signoff" aria-label="Declaration and sign-off">
    <h3 className="nzr-h3">Declaration &amp; sign-off</h3>
    <p className="nzr-note">{preview
      ? "This is a preview: the report is signed once it is issued."
      : "Prepared from the reviewed snapshot named above. Signed by the client to confirm the report reflects its organisation and boundary."}</p>
    <div className="nzr-signoff-boxes">
      <div className="nzr-signoff-box"><div className="eyebrow">Prepared by</div><b>{composition.issuer?.displayName ?? "The issuing organisation"}</b>
        <div className="nzr-signoff-line">Signature</div><div className="nzr-signoff-line">Date</div></div>
      <div className="nzr-signoff-box"><div className="eyebrow">Client approval</div>
        <b>{composition.signee ? composition.signee.name : <span className="muted">Name</span>}</b>
        {composition.signee?.jobTitle ? <div className="nzr-note">{composition.signee.jobTitle}</div> : null}
        <div className="nzr-signoff-line">Signature</div><div className="nzr-signoff-line">Date</div></div>
    </div>
  </section>;
}

/** Emissions by scope and category, this period — summed from the frozen audit rows (call 3). */
function CategoryTable({ rows }: { rows: AuditRows }) {
  const groups = new Map<string, { scope: string; scopeCode: string; category: string; tco2e: number }>();
  for (const row of rows) {
    const current = groups.get(row.scopeCode) ?? { scope: row.scope, scopeCode: row.scopeCode, category: row.category, tco2e: 0 };
    current.tco2e += row.tco2e;
    groups.set(row.scopeCode, current);
  }
  const ordered = [...groups.values()].sort((a, b) => a.scopeCode.localeCompare(b.scopeCode, "en", { numeric: true }));
  const total = ordered.reduce((sum, group) => sum + group.tco2e, 0);
  return <table className="nzr-tbl nzr-category-tbl">
    <thead><tr><th>Scope</th><th>Category</th><th className="r">tCO₂e</th><th className="r">Share</th></tr></thead>
    <tbody>{ordered.map((group) => <tr key={group.scopeCode}><td>{strategyScopeLabel(group.scope as StrategyScope)}</td><td>{group.category}</td><td className="r num">{t2(group.tco2e)}</td><td className="r num">{share(group.tco2e, total)}</td></tr>)}</tbody>
    <tfoot><tr><td colSpan={2}>Total</td><td className="r num">{t2(total)}</td><td className="r num">100%</td></tr></tfoot>
  </table>;
}

/** Appendix 2: each site's total, then its Scope 1, 2 and 3 — summed from the frozen audit rows. */
function SiteScopeAppendix({ rows }: { rows: AuditRows }) {
  const sites = new Map<string, { label: string; byScope: Map<string, number>; total: number }>();
  for (const row of rows) {
    const label = row.site ?? "Organisation-level";
    const site = sites.get(label) ?? { label, byScope: new Map<string, number>(), total: 0 };
    site.byScope.set(row.scope, (site.byScope.get(row.scope) ?? 0) + row.tco2e);
    site.total += row.tco2e;
    sites.set(label, site);
  }
  const ordered = [...sites.values()].sort((a, b) => (a.label === "Organisation-level" ? 1 : 0) - (b.label === "Organisation-level" ? 1 : 0) || a.label.localeCompare(b.label));
  const total = ordered.reduce((sum, site) => sum + site.total, 0);
  return <table className="nzr-tbl nzr-site-scope-tbl">
    <thead><tr><th>Site &amp; scope</th><th className="r">tCO₂e</th></tr></thead>
    <tbody>{ordered.map((site) => <Fragment key={site.label}>
      <tr className="sub"><td><b>{site.label}</b></td><td className="r num"><b>{t2(site.total)}</b></td></tr>
      {(["1", "2", "3"] as const).filter((scope) => site.byScope.has(scope)).map((scope) => <tr key={`${site.label}-${scope}`}><td className="ind">{strategyScopeLabel(scope as StrategyScope)}</td><td className="r num">{t2(site.byScope.get(scope)!)}</td></tr>)}
    </Fragment>)}</tbody>
    <tfoot><tr><td>Total emissions</td><td className="r num">{t2(total)}</td></tr></tfoot>
  </table>;
}

/** The Glossary — fixed text, versioned with composed@4. Words only: no figures, no money. */
const REPORT_GLOSSARY: ReadonlyArray<{ term: string; definition: string }> = [
  { term: "tCO₂e", definition: "Tonnes of carbon dioxide equivalent: greenhouse gases expressed as the amount of carbon dioxide with the same warming effect." },
  { term: "Scope 1", definition: "Direct emissions from sources the organisation owns or controls, such as fuel burned on its sites or in its own vehicles." },
  { term: "Scope 2", definition: "Indirect emissions from the electricity, heat and steam the organisation buys." },
  { term: "Scope 3", definition: "Other indirect emissions in the organisation's value chain, such as purchased goods and services, business travel and waste." },
  { term: "Reporting boundary", definition: "The sites and activities this report includes." },
  { term: "Emission factor", definition: "The figure that converts an activity — energy used, distance travelled, goods bought — into emissions. Each factor's source is named in the Full Emissions Audit." },
  { term: "Data quality", definition: "How each figure was obtained: measured, estimated, spend-based or from a survey." },
  { term: "Baseline", definition: "The reference period against which reductions are measured." },
  { term: "Net zero", definition: "Reducing emissions as far as possible, and addressing the residual that remains through removals." },
];

function Figure({ label, value, unit }: { label: string; value: string; unit: string }) {
  return <div className="nzr-figure"><div className="l">{label}</div><div className="v num">{value} <small>{unit}</small></div></div>;
}

/**
 * What this section rested on, beside the numbers rather than only on a back page. composed@3 (`summary`) names the snapshot
 * and its datasets once; composed@1/2 name the section's frozen factor sets, as they were issued.
 */
function Provenance({ provenance, summary }: { provenance: ReportProvenance; summary?: string }) {
  const tiers = provenance.qualityTiers.map((tier) => `${tier.tier} ${tier.count}`).join(" · ");
  return <div className="nzr-prov">
    {summary ? <>Source: {summary}. </> : provenance.factorSets.length > 0 ? <>Factor set: {provenance.factorSets.join(" · ")}. </> : null}
    As at {formatDate(provenance.asAt)}. {tiers ? <>Data quality: {tiers}. </> : null}
    Evidence hash {provenance.dataHash}.
  </div>;
}
