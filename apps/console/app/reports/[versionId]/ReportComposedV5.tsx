import { Fragment, type ReactNode } from "react";
import {
  crpScopeCategoryLabel, isReportGap, reportSectionLayout, reportSectionPlanOf, strategyControlLevelLabels, strategyControlLevels, strategyStatusLabels,
  type ReportComposition,
} from "@nzi/contracts";
import { LogoMark } from "../../lib/LogoMark";

/**
 * `composed@5` (BUILD-report-studio-composed5): the Report Studio mockup (`_handoff/MOCKUP-report-studio.html`), rendered —
 * page for page, chart for chart — and bound to the **frozen composition**, never to the mockup's sample figures. Every
 * figure in the copy is a locked token holding the composition's own number; a field the composition does not hold is said to
 * be unavailable, never invented. No turnover amount anywhere (NZC-120).
 *
 * A fork: `composed@1/2/3/4` draw through `ComposedV1`, untouched. Light "paper" look only — the print and PDF target.
 *
 * Checkpoint 1: the cover and the Executive Summary. Later sections follow at the next checkpoints.
 */

/** Where an asset is served from: the staff routes by default; the portal passes its grant-checked ones. */
export type LogoSrc = (assetId: string) => string;

// The mockup's formatters, exactly: one decimal with thousands separators; a share to one decimal, ".0" dropped.
const f1 = (value: number) => value.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pc = (value: number, total: number) => (total ? Math.round((value / total) * 1000) / 10 : 0);
const dd = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// Brand-locked scope identity (S1 coral, S2 amber, S3 emerald) — explicit hex for print determinism.
const SCOPE_COLOUR: Record<string, string> = { "1": "#FF5C48", "2": "#FFC24B", "3": "#0BA75E" };
const INK = "#0B1B2B", MUTED = "#616B65", PAPER = "#FFFFFF";

/** The reporting year as the mockup names it: "2025–2026" for a split year, "2025" for a calendar one. */
export function reportingYearLabel(composition: ReportComposition): string {
  const period = composition.reportingPeriod;
  if (!period) return String(composition.reportingYear);
  const [from, to] = [period.from.slice(0, 4), period.to.slice(0, 4)];
  return from === to ? from : `${from}–${to}`;
}

const reportTitle = (composition: ReportComposition) => `Carbon Reduction Plan ${reportingYearLabel(composition)}`;

/** "Whole client · all 3 sites", or the selected sites under a site scope. */
function scopeLabel(composition: ReportComposition): string {
  if (composition.scope?.kind === "sites") return composition.scope.siteLabels.join(", ");
  const sites = isReportGap(composition.emissions) ? 0 : (composition.emissions.sites ?? []).filter((site) => site.siteId !== null).length;
  return sites > 0 ? `Whole client · all ${sites} site${sites === 1 ? "" : "s"}` : "Whole client";
}

/** A locked data token: a frozen figure from the composition, never typed. */
const Tok = ({ children }: { children: ReactNode }) => <span className="r5-tok">{children}</span>;

type Scopes = Array<{ key: string; label: string; value: number; colour: string }>;

function scopesOf(composition: ReportComposition): Scopes | null {
  if (isReportGap(composition.emissions)) return null;
  const by = new Map(composition.emissions.byScope.map((entry) => [entry.scope, entry.tco2e]));
  return ["1", "2", "3"].map((scope) => ({ key: scope, label: `Scope ${scope}`, value: by.get(scope) ?? 0, colour: SCOPE_COLOUR[scope]! }));
}

/** The mockup's donut: segments by scope, the total in the centre. Deterministic SVG. */
function Donut({ scopes, total, size = 200 }: { scopes: Scopes; total: number; size?: number }) {
  const cx = size / 2, cy = size / 2, R = size / 2 - 8, thickness = size * 0.095, r = R - thickness, C = 2 * Math.PI;
  const sum = scopes.reduce((acc, scope) => acc + scope.value, 0) || 1;
  let angle = -Math.PI / 2;
  const paths = scopes.map((scope) => {
    const frac = scope.value / sum, next = angle + frac * C;
    const [x1, y1, x2, y2] = [cx + R * Math.cos(angle), cy + R * Math.sin(angle), cx + R * Math.cos(next), cy + R * Math.sin(next)];
    const [x3, y3, x4, y4] = [cx + r * Math.cos(next), cy + r * Math.sin(next), cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    const large = frac > 0.5 ? 1 : 0;
    angle = next;
    return scope.value > 0
      ? <path key={scope.key} d={`M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L${x3.toFixed(2)} ${y3.toFixed(2)} A${r} ${r} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`} fill={scope.colour} stroke={PAPER} strokeWidth={1.6} />
      : null;
  });
  const num = f1(total), fs = Math.min(size * 0.15, (2 * r * 0.8) / (0.6 * num.length));
  return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Emissions by scope">
    {paths}
    <text x={cx} y={(cy - fs * 0.08).toFixed(1)} textAnchor="middle" dominantBaseline="middle" fontFamily="Inter" fontSize={fs.toFixed(1)} fontWeight={700} fill={INK}>{num}</text>
    <text x={cx} y={(cy + fs * 0.6 + 7).toFixed(1)} textAnchor="middle" fontFamily="Inter" fontSize={(size * 0.05).toFixed(1)} fontWeight={600} fill={MUTED} letterSpacing={1}>tCO₂e TOTAL</text>
  </svg>;
}

function DonutLegend({ scopes, total }: { scopes: Scopes; total: number }) {
  return <div className="r5-leg">
    {scopes.map((scope) => <div className="r5-lr" key={scope.key}><span className="r5-sw" style={{ background: scope.colour }} /><span className="r5-nm">{scope.label}</span>
      <span className="r5-vv">{f1(scope.value)}</span><span className="r5-pc">{pc(scope.value, total)}%</span></div>)}
    <div className="r5-lr r5-tot"><span className="r5-sw" /><span className="r5-nm">Total</span><span className="r5-vv">{f1(total)}</span><span className="r5-pc">100%</span></div>
  </div>;
}

const SvgTag = () => <span className="r5-svgtag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M4 4h16v16H4z" /><path d="M4 14l4-4 4 4 4-6 4 4" /></svg>SVG · print-safe</span>;

/** The one source line, from the frozen sources and the snapshot's own date. */
function SrcLine({ composition }: { composition: ReportComposition }) {
  const summary = composition.sources?.summary;
  const asAt = composition.chartBasis?.generatedAt;
  if (!summary) return null;
  return <div className="r5-srcline">Source {summary.charAt(0).toLowerCase() + summary.slice(1)}{asAt ? ` · as at ${dd(asAt)}` : ""} — derived, not captured.</div>;
}

/** The narrative's state. composed@5 draws the default template, data-bound; editing and AI drafting are the fast-follow. */
const Narrative = ({ children }: { children: ReactNode }) =>
  <div className="r5-editblock"><span className="r5-spill">Default template</span><div className="r5-prose">{children}</div></div>;

function Cover({ composition, issuerLogoSrc, clientLogoSrc, preview }: { composition: ReportComposition; issuerLogoSrc: LogoSrc; clientLogoSrc: LogoSrc; preview: boolean }) {
  const issuer = composition.issuer;
  const rows: Array<[string, ReactNode]> = [
    ["Client", composition.client],
    // The title keeps its year whole ("2025–2026" never breaks at the dash), however long the client's name.
    ["Report Title", <>{composition.client} <span className="r5-nowrap">{reportTitle(composition)}</span></>],
    // A period the snapshot did not stamp is left out, never guessed.
    ...(composition.reportingPeriod ? [["Reporting Period", `${dd(composition.reportingPeriod.from)} – ${dd(composition.reportingPeriod.to)}`] as [string, ReactNode]] : []),
    ["Scope", scopeLabel(composition)],
    ["Report Generated", preview ? "Not issued — preview" : dd(composition.issuedAt)],
  ];
  return <div className="r5-cover">
    {issuer?.logoAssetId
      ? <img className="r5-nzilogo" src={issuerLogoSrc(issuer.logoAssetId)} alt={issuer.displayName} />
      : issuer ? <LogoMark src={null} name={issuer.displayName} className="r5-nzimark" /> : null}
    <div className="r5-cover-title"><div className="r5-cn">{composition.client}</div><div className="r5-rtt">{reportTitle(composition)}</div></div>
    {composition.clientLogoAssetId
      ? <div className="r5-clientlogo"><div className="r5-clframe"><img src={clientLogoSrc(composition.clientLogoAssetId)} alt={`${composition.client} logo`} /></div></div>
      : null}
    <div className="r5-metacard">{rows.map(([label, value]) => <div className="r5-row" key={label}><span className="r5-k">{label}</span><b>{value}</b></div>)}</div>
    <div className="r5-conf">{issuer ? `Prepared by ${issuer.displayName} — ` : ""}Private &amp; Confidential. For authorised recipients only.</div>
  </div>;
}

function ExecutiveSummary({ composition, number }: { composition: ReportComposition; number: string }) {
  const scopes = scopesOf(composition);
  const flag = composition.scope?.kind === "sites" ? <div className="r5-scopeflag">Recomposed for: {scopeLabel(composition)}</div> : null;
  const head = <><div className="r5-kicker">{number} · Overview</div><h2 className="r5-h2">Executive Summary</h2>{flag}</>;
  if (!scopes || isReportGap(composition.emissions)) {
    return <>{head}<p className="r5-unavailable">{isReportGap(composition.emissions) ? composition.emissions.reason : "Emissions are unavailable for this report."}</p></>;
  }
  const total = composition.emissions.totalTco2e;
  const [s1, s2, s3] = scopes.map((scope) => scope.value) as [number, number, number];
  const year = reportingYearLabel(composition);
  return <>
    {head}
    <Narrative>
      <p>{composition.client} recorded total greenhouse gas emissions of <Tok>{f1(total)} tCO₂e</Tok> for the <Tok>{year}</Tok> reporting year, comprising <Tok>{f1(s1)} tCO₂e</Tok> from Scope 1, <Tok>{f1(s2)} tCO₂e</Tok> from Scope 2 and <Tok>{f1(s3)} tCO₂e</Tok> from Scope 3, prepared under the GHG Protocol Corporate Standard on an operational control boundary.</p>
      <p>Scope 3 value-chain activity represents <Tok>{pc(s3, total)}%</Tok> of total emissions. This report sets out the reduction pathway to net zero and the prioritised carbon reduction actions, and records the reviewed evidence from which every figure is derived.</p>
    </Narrative>
    <div className="r5-chartcard">
      <div className="r5-chead"><b>Emissions summary by scope</b><SvgTag /></div>
      <div className="r5-donutwrap"><Donut scopes={scopes} total={total} /><DonutLegend scopes={scopes} total={total} /></div>
      <SrcLine composition={composition} />
    </div>
  </>;
}

/** The mockup's `flag(kind)`: a client-level section says so, whatever the scope; a site section names a site scope. */
const ClientFlag = () => <div className="r5-scopeflag r5-client">Client-level — shown for the whole client regardless of site scope</div>;

/** The year a target or baseline is named by, in the report's own convention (a split reporting year reads "2022–2023"). */
function yearLabel(composition: ReportComposition, year: number): string {
  const period = composition.reportingPeriod;
  return period && period.from.slice(0, 4) !== period.to.slice(0, 4) ? `${year}–${year + 1}` : String(year);
}

/** The frozen targets' interim (near-term) and net-zero points, and the baseline they are measured from. */
function targetPoints(composition: ReportComposition) {
  if (isReportGap(composition.targets)) return null;
  const { trajectory, benchmark } = composition.targets;
  return { interim: trajectory.find((point) => point.kind === "near-term") ?? null, netZero: trajectory.find((point) => point.kind === "net-zero") ?? null, benchmark };
}

const COMMITMENTS = ["Achieve the reduction targets set out in this plan.", "Set realistic short- and long-term targets consistent with the net zero commitment.",
  "Report total greenhouse gas emissions at least annually."];

function NetZeroCommitment({ composition, number }: { composition: ReportComposition; number: string }) {
  const points = targetPoints(composition);
  const head = <><div className="r5-kicker">{number} · Commitment</div><h2 className="r5-h2">Net Zero Commitment</h2><ClientFlag /></>;
  if (!points || !points.netZero) {
    return <>{head}<p className="r5-unavailable">{isReportGap(composition.targets) ? composition.targets.reason : "No net zero target was set for this client when the report was issued."}</p></>;
  }
  const { interim, netZero, benchmark } = points;
  return <>
    {head}
    <Narrative>
      <p>{composition.client} is committed to achieving net zero greenhouse gas emissions across all scopes by <Tok>{netZero.year}</Tok>, supported by a credible, evidence-led reduction pathway{benchmark ? <> anchored to the client&apos;s <Tok>{yearLabel(composition, benchmark.year)}</Tok> baseline set in its targets</> : null}.</p>
    </Narrative>
    <ul className="r5-commit-list">{COMMITMENTS.map((line) => <li key={line}>{line}</li>)}</ul>
    <h3 className="r5-h3">Reduction targets</h3>
    <table className="r5-rt">
      <thead><tr><th>Target type</th><th className="r5-num">Year</th><th className="r5-num">Reduction</th><th>Scope</th></tr></thead>
      <tbody>
        {interim ? <tr><td>Interim target</td><td className="r5-num">{interim.year}</td><td className="r5-num">{interim.pct}%</td><td>1, 2 &amp; 3</td></tr> : null}
        <tr className="r5-sub"><td>Net zero target</td><td className="r5-num">{netZero.year}</td><td className="r5-num">{netZero.pct}%</td><td>1, 2 &amp; 3</td></tr>
      </tbody>
    </table>
  </>;
}

/** The sites the report covers: the frozen site rows (the organisation-level line is not a site). */
const siteCount = (composition: ReportComposition) =>
  isReportGap(composition.emissions) ? 0 : (composition.emissions.sites ?? []).filter((site) => site.siteId !== null).length;

/** The employees the report states: the frozen wording of the client's employees measure ("240 employees"), when it has one. */
function employeesOf(composition: ReportComposition): string | null {
  if (isReportGap(composition.intensity)) return null;
  const text = composition.intensity.metrics.find((metric) => metric.key === "employees")?.denominatorText ?? null;
  return text ? text.split(" ")[0]! : null;
}

const NOT_RECORDED = <span className="r5-nr">Not recorded</span>;

function Background({ composition, number }: { composition: ReportComposition; number: string }) {
  const sites = siteCount(composition), employees = employeesOf(composition);
  const period = composition.reportingPeriod;
  return <>
    <div className="r5-kicker">{number} · Background</div><h2 className="r5-h2">Background &amp; Organisation</h2>
    <Narrative>
      <p>{composition.client} reports its greenhouse gas emissions for the <Tok>{reportingYearLabel(composition)}</Tok> reporting year under the operational control approach{sites > 0 ? <>, across <Tok>{sites} site{sites === 1 ? "" : "s"}</Tok> in its reporting boundary</> : null}.</p>
      <p>Boundary and methodology decisions are recorded in the standards and methodology section and in the assurance record.</p>
    </Narrative>
    <div className="r5-kv">
      <div className="r5-kvbox">
        <div className="r5-kr"><span>Organisation</span><b>{composition.client}</b></div>
        {/* Frozen from the client record at compose (decision 1); a field the record lacks reads "Not recorded", never guessed. */}
        <div className="r5-kr"><span>Industry</span><b>{composition.organisation?.industry ?? NOT_RECORDED}</b></div>
        <div className="r5-kr"><span>Location</span><b>{composition.organisation?.location ?? NOT_RECORDED}</b></div>
        <div className="r5-kr"><span>Sites</span><b>{sites > 0 ? sites : NOT_RECORDED}</b></div>
      </div>
      <div className="r5-kvbox">
        <div className="r5-kr"><span>Employees</span><b>{employees ?? NOT_RECORDED}</b></div>
        <div className="r5-kr"><span>Reporting period</span><b>{period ? `${dd(period.from)} – ${dd(period.to)}` : NOT_RECORDED}</b></div>
        <div className="r5-kr"><span>Boundary</span><b>Operational control</b></div>
        <div className="r5-kr"><span>Framework</span><b>GHG Protocol</b></div>
      </div>
    </div>
  </>;
}

// ── 04 · Sites & Reporting Boundary, 05 · Carbon Emissions Overview ─────────────────────────────────────────────────
/** The mockup's by-site categorical set (validated, distinct from the scope palette); the organisation-level line in grey. */
const SITE_COLOURS = ["#2E86C1", "#6B4E9B", "#0B7A4B"];
const ORG_LEVEL_COLOUR = "#9AA59F";
const f0 = (value: number) => Math.round(value).toLocaleString("en-GB");

const SiteFlag = ({ composition }: { composition: ReportComposition }) =>
  composition.scope?.kind === "sites" ? <div className="r5-scopeflag">Recomposed for: {scopeLabel(composition)}</div> : null;

/** The frozen site rows, each with its colour: the sites first, the organisation-level line (whole client only) last, in grey. */
function siteSlices(composition: ReportComposition) {
  if (isReportGap(composition.emissions)) return [];
  let index = 0;
  return (composition.emissions.sites ?? []).map((site) => ({ site, colour: site.siteId === null ? ORG_LEVEL_COLOUR : SITE_COLOURS[index++ % SITE_COLOURS.length]! }));
}

/** The mockup's horizontal activity bars: one bar per frozen activity, largest first. */
function Bars({ items }: { items: Array<{ label: string; value: number }> }) {
  const max = Math.max(...items.map((item) => item.value), 0) || 1;
  return <>{items.map((item) => <div className="r5-barrow" key={item.label}><span className="r5-bn">{item.label}</span>
    <div className="r5-bartrack"><div className="r5-barfill" style={{ width: `${Math.max(1.5, (item.value / max) * 100)}%` }} /></div>
    <span className="r5-bv">{f1(item.value)}</span></div>)}</>;
}

const ICONS: Record<string, ReactNode> = {
  people: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="7" r="3" /><path d="M2 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1" /><path d="M16 4a3 3 0 0 1 0 6" /></svg>,
  currency: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M17 5a3.5 3.5 0 0 0-6 2.5V19" /><path d="M8 12h6" /><path d="M7 19h10" /></svg>,
  box: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 8 12 3 3 8l9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>,
};
const iconFor = (iconKey: string) => ICONS[iconKey] ?? ICONS.box;

/**
 * A site's intensity rows: one per measure the client reports. Only floor area exists per site (R-S1 (A′)); every other
 * measure is the client's whole value, so it is stated as client-level — never apportioned to a site. No turnover amount.
 */
function SiteIntensity({ composition, site }: { composition: ReportComposition; site: NonNullable<Extract<ReportComposition["emissions"], { totalTco2e: number }>["sites"]>[number] }) {
  if (isReportGap(composition.intensity) || composition.intensity.metrics.length === 0) return null;
  return <>
    <h4 className="r5-sitecard-sh">Intensity</h4>
    {composition.intensity.metrics.map((metric) => {
      const floor = metric.key === "floor-area" ? site.floorAreaIntensity : undefined;
      const value = floor?.value ?? null;
      return <div className="r5-imrow" key={metric.key}>
        <div className="r5-im-ic">{iconFor(metric.iconKey)}</div>
        <div><div className="r5-nm">{metric.label}</div>
          <div className="r5-u">{floor ? (floor.floorAreaM2 !== null ? `${f0(floor.floorAreaM2)} m²` : floor.reason ?? "Floor area not recorded") : "Reported for the whole client only"}</div></div>
        <div className="r5-val">{value !== null ? <><b>{f1(value)}</b> <span className="r5-uu">{floor!.unit}</span></> : <span className="r5-nr">Not apportioned to sites</span>}</div>
      </div>;
    })}
  </>;
}

function SiteSubsection({ composition, site }: { composition: ReportComposition; site: Parameters<typeof SiteIntensity>[0]["site"] }) {
  const by = new Map(site.byScope.map((entry) => [entry.scope, entry.tco2e]));
  const scopes: Scopes = ["1", "2", "3"].map((scope) => ({ key: scope, label: `Scope ${scope}`, value: by.get(scope) ?? 0, colour: SCOPE_COLOUR[scope]! }));
  return <div className="r5-sitecard">
    <div className="r5-sitecard-h">{site.label}</div>
    <div className="r5-grid2">
      <div className="r5-chartcard r5-flush"><div className="r5-chead"><b>By scope</b><SvgTag /></div>
        <div className="r5-donutwrap"><Donut scopes={scopes} total={site.totalTco2e} size={160} /><DonutLegend scopes={scopes} total={site.totalTco2e} /></div></div>
      <div className="r5-chartcard r5-flush"><div className="r5-chead"><b>By activity</b><SvgTag /></div>
        <Bars items={site.activities.map((activity) => ({ label: activity.label, value: activity.tco2e }))} /></div>
    </div>
    <SiteIntensity composition={composition} site={site} />
  </div>;
}

function SitesSection({ composition, number }: { composition: ReportComposition; number: string }) {
  const head = <><div className="r5-kicker">{number} · Boundary</div><h2 className="r5-h2">Sites &amp; Reporting Boundary</h2><SiteFlag composition={composition} /></>;
  const slices = siteSlices(composition);
  if (isReportGap(composition.emissions) || slices.length === 0) {
    return <>{head}<p className="r5-unavailable">{isReportGap(composition.emissions) ? composition.emissions.reason : "This report has no site breakdown."}</p></>;
  }
  const total = slices.reduce((sum, slice) => sum + slice.site.totalTco2e, 0);
  const scopes: Scopes = slices.map(({ site, colour }) => ({ key: site.siteId ?? "org", label: site.label, value: site.totalTco2e, colour }));
  const realSites = slices.filter((slice) => slice.site.siteId !== null);
  // The site's floor area for the period (frozen at compose), else the floor-area measure's own, when either is held.
  const floors = slices.map(({ site }) => site.floorAreaM2 ?? site.floorAreaIntensity?.floorAreaM2 ?? null);
  return <>
    {head}
    <p className="r5-prose r5-lead">This report covers the following sites:</p>
    <div className="r5-chartcard">
      <div className="r5-chead"><b>Emissions by site</b><SvgTag /></div>
      <div className="r5-donutwrap"><Donut scopes={scopes} total={total} /><DonutLegend scopes={scopes} total={total} /></div>
      <SrcLine composition={composition} />
    </div>
    <table className="r5-rt r5-gap">
      <thead><tr><th>Site</th><th>In service</th><th className="r5-num">Floor m²</th><th className="r5-num">tCO₂e</th><th className="r5-num">% of client</th></tr></thead>
      <tbody>
        {slices.map(({ site }, index) => <tr key={site.siteId ?? "org"}>
          <td>{site.label}</td>
          {/* The site record's first day in service (frozen at compose); "before records" when it has none. */}
          <td>{site.siteId === null ? "" : site.inServiceFrom ? dd(site.inServiceFrom) : site.inServiceFrom === null ? "Before records" : NOT_RECORDED}</td>
          <td className="r5-num">{floors[index] !== null ? f0(floors[index]!) : site.siteId === null ? "" : NOT_RECORDED}</td>
          <td className="r5-num">{f1(site.totalTco2e)}</td><td className="r5-num">{pc(site.totalTco2e, total)}%</td>
        </tr>)}
        <tr className="r5-total"><td>Total ({realSites.length})</td><td /><td className="r5-num">{floors.every((floor, index) => floor !== null || slices[index]!.site.siteId === null) && floors.some((floor) => floor !== null) ? f0(floors.reduce<number>((sum, floor) => sum + (floor ?? 0), 0)) : ""}</td>
          <td className="r5-num">{f1(total)}</td><td className="r5-num" /></tr>
      </tbody>
    </table>
    {realSites.length > 1 ? <><h3 className="r5-h3">By site</h3>{realSites.map(({ site }) => <SiteSubsection key={site.siteId} composition={composition} site={site} />)}</> : null}
  </>;
}

const COLUMN_HEADS: Record<string, string> = { baseline: "Baseline period", previous: "Previous period", current: "Current period" };
const DASH = <span className="r5-nr">—</span>;
/** The mockup's "% difference": signed, one decimal, a true minus sign. */
const pctChange = (current: number | null, base: number | null) => {
  if (current === null || base === null || !(base > 0)) return DASH;
  const change = ((current - base) / base) * 100;
  return <b>{change > 0 ? "+" : change < 0 ? "−" : ""}{f1(Math.abs(change))}%</b>;
};

/**
 * Emissions by site, year-aware: the frozen comparison's own columns (baseline, previous, current — as the assured periods
 * that exist allow, F3) and each site's own figure in each (ACCEPT-composed5-checkpoint3). A site with no figure for a period
 * reads "—", never a modelled number. The total row is the comparison's own column totals.
 */
function SiteComparisonTable({ composition, slices }: { composition: ReportComposition; slices: ReturnType<typeof siteSlices> }) {
  const comparison = isReportGap(composition.emissions) ? undefined : composition.emissions.comparison;
  const columns = comparison?.sites ? comparison.columns : [{ key: "current", year: composition.reportingYear, label: "" }];
  const valuesOf = (siteId: string | null, current: number) => comparison?.sites?.find((entry) => entry.siteId === siteId)?.values ?? columns.map((column) => column.key === "current" ? current : null);
  const totals = comparison?.sites ? comparison.totals : [slices.reduce((sum, slice) => sum + slice.site.totalTco2e, 0)];
  const baseAt = columns.findIndex((column) => column.key === "baseline"), currentAt = columns.length - 1;
  const cell = (value: number | null | undefined) => <td className="r5-num">{value === null || value === undefined ? DASH : f1(value)}</td>;
  return <table className="r5-rt">
    <thead><tr><th>Site</th>{columns.map((column) => <th key={column.key} className="r5-num">{COLUMN_HEADS[column.key] ?? column.label}</th>)}{baseAt >= 0 ? <th className="r5-num">% difference</th> : null}</tr></thead>
    <tbody>
      {slices.map(({ site }) => {
        const values = valuesOf(site.siteId, site.totalTco2e);
        return <tr key={site.siteId ?? "org"}><td>{site.label}</td>{values.map((value, index) => <Fragment key={index}>{cell(value)}</Fragment>)}
          {baseAt >= 0 ? <td className="r5-num">{pctChange(values[currentAt] ?? null, values[baseAt] ?? null)}</td> : null}</tr>;
      })}
      <tr className="r5-total"><td>Total</td>{totals.map((value, index) => <Fragment key={index}>{cell(value)}</Fragment>)}
        {baseAt >= 0 ? <td className="r5-num">{pctChange(totals[currentAt] ?? null, totals[baseAt] ?? null)}</td> : null}</tr>
    </tbody>
  </table>;
}

const FACTOR_NOTE = "Calculated emissions use the most up-to-date emission factors at publication; factors are applied retrospectively, so values may change when recalculated in future years.";

function OverviewSection({ composition, number }: { composition: ReportComposition; number: string }) {
  const head = <><div className="r5-kicker">{number} · Overview</div><h2 className="r5-h2">Carbon Emissions Overview</h2><SiteFlag composition={composition} /></>;
  const scopes = scopesOf(composition);
  if (!scopes || isReportGap(composition.emissions)) {
    return <>{head}<p className="r5-unavailable">{isReportGap(composition.emissions) ? composition.emissions.reason : "Emissions are unavailable for this report."}</p></>;
  }
  const total = composition.emissions.totalTco2e;
  const slices = siteSlices(composition);
  const period = composition.reportingPeriod;
  return <>
    {head}
    <div className="r5-overview-top">
      <div className="r5-statbig"><div className="r5-lbl">Total carbon emissions</div><div className="r5-big">{f1(total)}</div>
        <div className="r5-u">tCO₂e{period ? ` · ${dd(period.from)} – ${dd(period.to)}` : ` · ${reportingYearLabel(composition)}`}</div></div>
      {slices.length > 0 ? <div className="r5-overview-sites"><h3 className="r5-h3 r5-flush">Emissions by site</h3>
        <SiteComparisonTable composition={composition} slices={slices} />
      </div> : null}
    </div>
    <div className="r5-note">{FACTOR_NOTE}</div>
    <div className="r5-chartcard">
      <div className="r5-chead"><b>Emissions summary by scope</b><SvgTag /></div>
      <div className="r5-donutwrap"><Donut scopes={scopes} total={total} /><DonutLegend scopes={scopes} total={total} /></div>
      <SrcLine composition={composition} />
    </div>
  </>;
}

// ── 06 · Intensity Metric Analysis, 07 · Targets & Reduction Pathway ──────────────────────────────────────────────────
const SKY = "#2E86C1", VIOLET = "#6B4E9B", BRAND = "#0BA75E", BRAND_DEEP = "#0B7A4B", AMBER = "#FFC24B", LINE = "#E3EAE6", SURFACE_2 = "#F1F5F2";

/** "tCO₂e per £m" as the mockup prints a unit beside a value: "tCO₂e / £m". */
const unitShort = (unit: string) => unit.replace(/ per /, " / ");

/** A rounded axis ceiling a little above the largest value — 14,020 tops out at 16,000, as the mockup's pathway does. */
function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 1.2, 1.5, 1.6, 2, 2.5, 3, 4, 5, 6, 8, 10].map((step) => step * power).find((step) => step >= value * 1.08) ?? 10 * power);
}
/** An axis label: whole numbers, as the mockup's axes read, unless the scale is under 10. */
const axisLabel = (value: number, max: number) => max >= 10 ? f0(value) : f1(value);

function ChartLegend({ items }: { items: Array<{ label: string; colour: string }> }) {
  return <div className="r5-chartlegend">{items.map((item) => <span key={item.label}><span className="r5-legline" style={{ background: item.colour }} />{item.label}</span>)}</div>;
}

type Point = { year: number; value: number };

/**
 * The reported measure's intensity pathway to its target year, in the mockup's style: the baseline and this year's intensity
 * (solid), then the target milestones (dashed), with the interim and end years marked. Only the reported measure has targets
 * (the client's intensity target, frozen in the chart basis); no other measure's line is drawn — never assumed.
 */
function IntensityTargetsChart({ actual, target, interimYear, endYear }: { actual: Point[]; target: Point[]; interimYear: number | null; endYear: number }) {
  const W = 680, H = 240, pl = 46, pb = 30, pt = 14, pr = 14;
  const years = [...actual, ...target].map((point) => point.year), x0 = Math.min(...years), x1 = Math.max(...years, endYear);
  const max = niceMax(Math.max(...[...actual, ...target].map((point) => point.value)));
  const X = (year: number) => pl + (W - pl - pr) * ((year - x0) / Math.max(1, x1 - x0)), Y = (value: number) => pt + (H - pt - pb) * (1 - value / max);
  const path = (points: Point[]) => points.map((point, index) => `${index ? "L" : "M"}${X(point.year).toFixed(1)} ${Y(point.value).toFixed(1)}`).join(" ");
  const ticks = [...new Set([x0, ...[2030, 2035, 2040, 2045, 2050].filter((year) => year > x0 && year < x1), x1])];
  return <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Intensity pathway to the target year">
    {[0, 1, 2, 3, 4].map((i) => { const y = pt + (H - pt - pb) * (i / 4); return <g key={i}><line x1={pl} y1={y.toFixed(1)} x2={W - pr} y2={y.toFixed(1)} stroke={LINE} />
      <text x={pl - 6} y={(y + 3).toFixed(1)} textAnchor="end" fontFamily="Inter" fontSize={9} fill={MUTED}>{axisLabel(max * (1 - i / 4), max)}</text></g>; })}
    {[interimYear, endYear].filter((year): year is number => year !== null).map((year) =>
      <line key={year} x1={X(year)} y1={pt} x2={X(year)} y2={H - pb} stroke={year === endYear ? BRAND : AMBER} strokeDasharray="3 3" opacity={0.7} />)}
    {ticks.map((year) => <text key={year} x={X(year).toFixed(1)} y={H - 9} textAnchor="middle" fontFamily="Inter" fontSize={9} fill={MUTED}>{year}</text>)}
    <path d={path(actual)} fill="none" stroke={BRAND_DEEP} strokeWidth={2.6} />
    <path d={path(target)} fill="none" stroke={SKY} strokeWidth={2.4} strokeDasharray="5 4" />
    {target.map((point) => <circle key={`t${point.year}`} cx={X(point.year).toFixed(1)} cy={Y(point.value).toFixed(1)} r={3.4} fill={SKY} />)}
    {actual.map((point) => <circle key={`a${point.year}`} cx={X(point.year).toFixed(1)} cy={Y(point.value).toFixed(1)} r={4} fill={BRAND_DEEP} />)}
  </svg>;
}

function IntensitySection({ composition, number }: { composition: ReportComposition; number: string }) {
  const head = <><div className="r5-kicker">{number} · Performance</div><h2 className="r5-h2">Intensity Metric Analysis</h2><SiteFlag composition={composition} /></>;
  if (isReportGap(composition.intensity) || composition.intensity.metrics.length === 0) {
    return <>{head}<p className="r5-unavailable">{isReportGap(composition.intensity) ? composition.intensity.reason : "No intensity measures were set up for this client when the report was issued."}</p></>;
  }
  const metrics = composition.intensity.metrics;
  const reported = metrics.find((metric) => metric.reported) ?? null;
  // The reported measure's target, frozen in the chart basis (whole client only): its baseline, this year, the milestones.
  const basis = composition.chartBasis?.intensityTarget as undefined | null | {
    baselineYear: number; baselineIntensity: number; interimYear: number | null; interimReductionPercent: number | null;
    targetYear?: number | null; targetReductionPercent?: number | null; netZeroYear: number | null; reportingIntensity?: number | null; reportingDenominator?: number | null };
  const current = reported?.value ?? null;
  const chart = basis && reported ? (() => {
    const actual: Point[] = [{ year: basis.baselineYear, value: basis.baselineIntensity }, ...(current !== null && composition.reportingYear !== basis.baselineYear ? [{ year: composition.reportingYear, value: current }] : [])];
    const milestones: Point[] = [
      ...(basis.interimYear !== null && basis.interimReductionPercent !== null ? [{ year: basis.interimYear, value: basis.baselineIntensity * (1 - basis.interimReductionPercent / 100) }] : []),
      ...(basis.targetYear != null && basis.targetReductionPercent != null ? [{ year: basis.targetYear, value: basis.baselineIntensity * (1 - basis.targetReductionPercent / 100) }] : []),
    ];
    if (milestones.length === 0) return null;
    return { actual, target: [actual[actual.length - 1]!, ...milestones], interimYear: basis.interimYear, endYear: milestones[milestones.length - 1]!.year };
  })() : null;
  return <>
    {head}
    <Narrative>
      <p>Intensity metrics normalise emissions against business activity so performance can be compared year on year regardless of changes in scale. {composition.client} reports {metrics.length === 1 ? "one intensity measure" : `${metrics.length} intensity measures`}: {metrics.map((metric) => metric.label.toLowerCase()).join(", ")}.</p>
    </Narrative>
    <div className="r5-imrows">
      {metrics.map((metric) => <div className="r5-imrow" key={metric.key}>
        <div className="r5-im-ic">{iconFor(metric.iconKey)}</div>
        {/* No turnover amount (NZC-120): a currency measure's denominator is not frozen, so its line names the unit only. */}
        {/* RULING-intensity-badge: no pill on an intensity row — neither "Standard" nor "Reported in the CRP". */}
        <div><div className="r5-nm">{metric.label}</div>
          <div className="r5-u">{metric.denominatorText ?? unitShort(metric.unit)}</div></div>
        <div className="r5-val">{metric.value !== null ? <><b>{f1(metric.value)}</b> <span className="r5-uu">{unitShort(metric.unit)}</span></> : <span className="r5-nr">{metric.unavailableReason ?? "Unavailable"}</span>}</div>
      </div>)}
    </div>
    {chart && reported ? <div className="r5-chartcard">
      <div className="r5-chead"><b>{composition.client} intensity — {reported.label.toLowerCase()} pathway to {chart.endYear}</b><SvgTag /></div>
      <IntensityTargetsChart {...chart} />
      <ChartLegend items={[{ label: `Actual (${unitShort(reported.unit)})`, colour: BRAND_DEEP }, { label: "Target pathway", colour: SKY }]} />
      <SrcLine composition={composition} />
    </div> : null}
    <div className="r5-prov"><b>One resolver.</b> Intensity is emissions × divider ÷ value, computed by the single resolver the client workspace, the portal and this report all use, so they cannot diverge. A measure with no recorded value reads &quot;unavailable&quot;, never 0.</div>
  </>;
}

/** The mockup's reduction pathway: the target line (dashed, violet, labelled milestones) and the actuals (solid). */
function PathwayChart({ target, actual }: { target: Array<Point & { label: string }>; actual: Point[] }) {
  const W = 680, H = 250, pl = 58, pb = 30, pt = 14, pr = 14;
  const years = [...target, ...actual].map((point) => point.year), x0 = Math.min(...years), x1 = Math.max(...years);
  const max = niceMax(Math.max(...[...target, ...actual].map((point) => point.value)));
  const X = (year: number) => pl + (W - pl - pr) * ((year - x0) / Math.max(1, x1 - x0)), Y = (value: number) => pt + (H - pt - pb) * (1 - value / max);
  const path = (points: Point[]) => points.map((point, index) => `${index ? "L" : "M"}${X(point.year).toFixed(1)} ${Y(point.value).toFixed(1)}`).join(" ");
  const ticks = [...new Set([...target, ...actual].map((point) => point.year))].sort((a, b) => a - b);
  return <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Emissions reduction pathway">
    {[0, 1, 2, 3, 4].map((i) => { const y = pt + (H - pt - pb) * (i / 4); return <g key={i}><line x1={pl} y1={y.toFixed(1)} x2={W - pr} y2={y.toFixed(1)} stroke={LINE} />
      <text x={pl - 6} y={(y + 3).toFixed(1)} textAnchor="end" fontFamily="Inter" fontSize={9.5} fill={MUTED}>{f0(max * (1 - i / 4))}</text></g>; })}
    {ticks.map((year) => <text key={year} x={X(year).toFixed(1)} y={H - 9} textAnchor="middle" fontFamily="Inter" fontSize={9.5} fill={MUTED}>{year}</text>)}
    <path d={path(target)} fill="none" stroke={VIOLET} strokeWidth={2} strokeDasharray="6 5" />
    <path d={path(actual)} fill="none" stroke={BRAND_DEEP} strokeWidth={2.6} />
    {target.map((point) => <g key={`t${point.year}`}><circle cx={X(point.year).toFixed(1)} cy={Y(point.value).toFixed(1)} r={4} fill={VIOLET} />
      <text x={X(point.year).toFixed(1)} y={(Y(point.value) - 10).toFixed(1)} textAnchor="middle" fontFamily="Inter" fontSize={9.5} fontWeight={700} fill={INK}>{point.label}</text></g>)}
    {actual.map((point) => <circle key={`a${point.year}`} cx={X(point.year).toFixed(1)} cy={Y(point.value).toFixed(1)} r={4} fill={BRAND_DEEP} />)}
  </svg>;
}

/** The mockup's progress ring: the share of the way to the interim reduction, clamped to 0–100%. */
function Ring({ fraction, label, sub }: { fraction: number; label: string; sub: string }) {
  const size = 150, c = 75, r = 58, sw = 15, C = 2 * Math.PI * r, dash = Math.max(0, Math.min(1, fraction)) * C;
  return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${sub}: ${label}`}>
    <circle cx={c} cy={c} r={r} fill="none" stroke={SURFACE_2} strokeWidth={sw} />
    <circle cx={c} cy={c} r={r} fill="none" stroke={BRAND} strokeWidth={sw} strokeLinecap="round" strokeDasharray={`${dash.toFixed(1)} ${(C - dash).toFixed(1)}`} transform={`rotate(-90 ${c} ${c})`} />
    <text x={c} y={c - 1} textAnchor="middle" fontFamily="Inter" fontSize={26} fontWeight={800} fill={INK}>{label}</text>
    <text x={c} y={c + 16} textAnchor="middle" fontFamily="Inter" fontSize={9} fill={MUTED}>{sub}</text>
  </svg>;
}

function TargetsSection({ composition, number }: { composition: ReportComposition; number: string }) {
  const head = <><div className="r5-kicker">{number} · Trajectory</div><h2 className="r5-h2">Targets &amp; Reduction Pathway</h2><ClientFlag /></>;
  if (isReportGap(composition.targets)) return <>{head}<p className="r5-unavailable">{composition.targets.reason}</p></>;
  const { trajectory, benchmark } = composition.targets;
  const baseline = trajectory.find((point) => point.kind === "benchmark") ?? null;
  const interim = trajectory.find((point) => point.kind === "near-term") ?? null, netZero = trajectory.find((point) => point.kind === "net-zero") ?? null;
  // The client's current total, against a client-level target — whole-client reports only (a site view does not hold it).
  const current = composition.scope?.kind !== "sites" && !isReportGap(composition.emissions) ? composition.emissions.totalTco2e : null;
  const year = reportingYearLabel(composition);
  const target = trajectory.map((point) => ({ year: point.year, value: point.tco2e,
    label: point.kind === "benchmark" ? "Baseline" : point.kind === "near-term" ? `Interim −${point.pct}%` : `Net zero −${point.pct}%` }));
  const actual = baseline ? [{ year: baseline.year, value: baseline.tco2e }, ...(current !== null && composition.reportingYear !== baseline.year ? [{ year: composition.reportingYear, value: current }] : [])] : [];
  const reduction = baseline && current !== null && baseline.tco2e > 0 ? (baseline.tco2e - current) / baseline.tco2e : null;
  const progress = reduction !== null && interim && interim.pct > 0 ? reduction / (interim.pct / 100) : null;
  const baselineLabel = baseline ? yearLabel(composition, baseline.year) : null;
  return <>
    {head}
    <p className="r5-prose">Actual emissions (solid) against the agreed target pathway (dashed), anchored on the baseline. A partial target is drawn as its own reduction; net zero carries its residual, not zero.</p>
    {current !== null ? <div className="r5-chartcard">
      <div className="r5-chead"><b>Emissions reduction pathway to net zero</b><SvgTag /></div>
      <PathwayChart target={target} actual={actual} />
      <ChartLegend items={[{ label: "Actual", colour: BRAND_DEEP }, { label: "Target pathway", colour: VIOLET }]} />
      <SrcLine composition={composition} />
    </div> : <p className="r5-unavailable">The pathway compares the whole client's emissions with its targets, so a site view does not draw it.</p>}
    <div className="r5-grid2">
      <div className="r5-chartcard"><div className="r5-chead"><b>Progress to interim target</b><SvgTag /></div>
        {progress !== null && interim
          ? <><div className="r5-centre"><Ring fraction={progress} label={`${Math.round(Math.max(0, progress) * 100)}%`} sub={`to −${interim.pct}% by ${interim.year}`} /></div>
            <div className="r5-note r5-centre-text">{reduction! >= 0 ? "Down" : "Up"} {f1(Math.abs(reduction! * 100))}% on the client&apos;s {baselineLabel} baseline — about {Math.round(Math.max(0, progress) * 100)}% of the way to the −{interim.pct}% interim target.</div></>
          : <p className="r5-unavailable">{interim ? "Progress needs the whole client's current emissions and its baseline." : "No interim target was set."}</p>}
      </div>
      <div className="r5-chartcard"><div className="r5-chead"><b>Target summary</b></div>
        <table className="r5-rt"><tbody>
          <tr><td>Baseline ({baselineLabel ?? "—"}, from client targets)</td><td className="r5-num">{benchmark ? f1(benchmark.totalTco2e) : baseline ? f1(baseline.tco2e) : DASH}</td></tr>
          <tr><td>Current ({year})</td><td className="r5-num">{current !== null ? f1(current) : DASH}</td></tr>
          {interim ? <tr><td>Interim target</td><td className="r5-num">−{interim.pct}% · {interim.year}</td></tr> : null}
          {netZero ? <tr className="r5-total"><td>Net zero</td><td className="r5-num">−{netZero.pct}% · {netZero.year}</td></tr> : null}
        </tbody></table>
      </div>
    </div>
  </>;
}

// ── 08 · Analysis by Scope, 09 · Emissions by Scope & Category ───────────────────────────────────────────────────────────
/** The mockup's vertical bars: one bar per item, its value above it. */
function VBars({ items }: { items: Array<{ label: string; value: number; colour: string }> }) {
  const W = 660, H = 220, pl = 46, pb = 28, pt = 12, pr = 8, cw = (W - pl - pr) / Math.max(1, items.length);
  const max = niceMax(Math.max(...items.map((item) => item.value), 0) * 1.06);
  return <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Emissions by scope, bar chart">
    {[0, 1, 2, 3, 4].map((i) => { const y = pt + (H - pt - pb) * (i / 4); return <g key={i}><line x1={pl} y1={y.toFixed(1)} x2={W - pr} y2={y.toFixed(1)} stroke={LINE} />
      <text x={pl - 6} y={(y + 3).toFixed(1)} textAnchor="end" fontFamily="Inter" fontSize={9.5} fill={MUTED}>{axisLabel(max * (1 - i / 4), max)}</text></g>; })}
    {items.map((item, index) => {
      const bh = (H - pt - pb) * (item.value / max), x = pl + cw * index + cw * 0.25, bw = cw * 0.5, y = H - pb - bh;
      return <g key={item.label}>
        <rect x={x.toFixed(1)} y={y.toFixed(1)} width={bw.toFixed(1)} height={Math.max(0, bh).toFixed(1)} rx={3} fill={item.colour} />
        <text x={(x + bw / 2).toFixed(1)} y={(y - 5).toFixed(1)} textAnchor="middle" fontFamily="Inter" fontSize={10} fontWeight={700} fill={INK}>{f1(item.value)}</text>
        <text x={(pl + cw * index + cw / 2).toFixed(1)} y={H - 9} textAnchor="middle" fontFamily="Inter" fontSize={10} fill={INK_2}>{item.label}</text>
      </g>;
    })}
  </svg>;
}
const INK_2 = "#3E4C45";

/** A year-aware comparison table's head and cells — the frozen comparison's own columns, the % difference against the baseline. */
function comparisonColumns(composition: ReportComposition) {
  const comparison = isReportGap(composition.emissions) ? undefined : composition.emissions.comparison;
  const columns = comparison?.columns ?? [];
  const baseAt = columns.findIndex((column) => column.key === "baseline"), currentAt = columns.length - 1;
  const head = <>{columns.map((column) => <th key={column.key} className="r5-num">{COLUMN_HEADS[column.key] ?? column.label}</th>)}{baseAt >= 0 ? <th className="r5-num">% difference</th> : null}</>;
  const cells = (values: ReadonlyArray<number | null>) => <>{values.map((value, index) => <td key={index} className="r5-num">{value === null ? DASH : f1(value)}</td>)}
    {baseAt >= 0 ? <td className="r5-num">{pctChange(values[currentAt] ?? null, values[baseAt] ?? null)}</td> : null}</>;
  return { comparison, head, cells };
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "1": "Fuels used at company premises and company vehicles.",
  "2": "Purchased electricity used at the company's premises.",
  "3": "Purchased goods, transport, commuting, waste and all other value-chain activities.",
};

function ScopeAnalysis({ composition, number }: { composition: ReportComposition; number: string }) {
  const head = <><div className="r5-kicker">{number} · Analysis</div><h2 className="r5-h2">Analysis by Scope</h2><SiteFlag composition={composition} /></>;
  const scopes = scopesOf(composition);
  if (!scopes || isReportGap(composition.emissions)) return <>{head}<p className="r5-unavailable">{isReportGap(composition.emissions) ? composition.emissions.reason : "Emissions are unavailable for this report."}</p></>;
  const total = composition.emissions.totalTco2e;
  const { comparison, head: columnsHead, cells } = comparisonColumns(composition);
  return <>
    {head}
    <div className="r5-chartcard">
      <div className="r5-chead"><b>Year-on-year comparison by scope</b><SvgTag /></div>
      <VBars items={[...scopes.map((scope) => ({ label: scope.label, value: scope.value, colour: BRAND_DEEP })), { label: "Total", value: total, colour: BRAND_DEEP }]} />
      <ChartLegend items={[{ label: `Current year ${reportingYearLabel(composition)}`, colour: BRAND_DEEP }]} />
      <SrcLine composition={composition} />
    </div>
    <h3 className="r5-h3">Emissions by scope</h3>
    {comparison ? <table className="r5-rt">
      <thead><tr><th>Scope</th><th>Description</th>{columnsHead}</tr></thead>
      <tbody>
        {comparison.rows.map((row) => <tr key={row.scope}><td>{row.scope}</td><td>{SCOPE_DESCRIPTIONS[row.scope]}</td>{cells(row.values)}</tr>)}
        <tr className="r5-total"><td colSpan={2}>Total</td>{cells(comparison.totals)}</tr>
      </tbody>
    </table> : <p className="r5-unavailable">This report has no comparison by period.</p>}
  </>;
}

/** The scopes in order of size, for the category narrative — never assumes which is largest. */
function scopeOrder(scopes: Scopes) {
  return [...scopes].sort((a, b) => b.value - a.value);
}

function CategoryAnalysis({ composition, number }: { composition: ReportComposition; number: string }) {
  const head = <><div className="r5-kicker">{number} · Analysis</div><h2 className="r5-h2">Emissions by Scope &amp; Category</h2><SiteFlag composition={composition} /></>;
  const scopes = scopesOf(composition);
  const { comparison, head: columnsHead, cells } = comparisonColumns(composition);
  if (!scopes || isReportGap(composition.emissions) || !comparison?.categories?.length) {
    return <>{head}<p className="r5-unavailable">{isReportGap(composition.emissions) ? composition.emissions.reason : "This report holds no category breakdown."}</p></>;
  }
  const total = composition.emissions.totalTco2e;
  const [largest, second, third] = scopeOrder(scopes) as [Scopes[number], Scopes[number], Scopes[number]];
  return <>
    {head}
    <table className="r5-rt">
      <thead><tr><th>Scope</th><th>Category</th>{columnsHead}</tr></thead>
      <tbody>
        {comparison.categories.map((category) => <tr key={category.scopeCode}><td className="r5-nowrap">Scope {category.scope}</td><td>{crpScopeCategoryLabel(category.scopeCode)}</td>{cells(category.values)}</tr>)}
        <tr className="r5-total"><td colSpan={2}>Total emissions</td>{cells(comparison.totals)}</tr>
      </tbody>
    </table>
    <div className="r5-gap">
      <Narrative>
        <p>For the <Tok>{reportingYearLabel(composition)}</Tok> reporting year total measured carbon emissions are <Tok>{f1(total)} tCO₂e</Tok>. {largest.label} is the largest share at <Tok>{f1(largest.value)} tCO₂e</Tok> (<Tok>{pc(largest.value, total)}%</Tok>), followed by {second.label} at <Tok>{f1(second.value)} tCO₂e</Tok> and {third.label} at <Tok>{f1(third.value)} tCO₂e</Tok>.</p>
        <p>The largest categories are the focus of the reduction actions.</p>
      </Narrative>
    </div>
  </>;
}

// ── 10 · Carbon Reduction Actions, 11 · UK SRS Readiness ─────────────────────────────────────────────────────────────────
const ACTION_ICONS: Record<string, ReactNode> = {
  bolt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>,
  truck: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M2 7h11v9H2z" /><path d="M13 10h4l3 3v3h-7z" /><circle cx="6" cy="18" r="1.6" /><circle cx="17" cy="18" r="1.6" /></svg>,
  handshake: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m11 17 2 2 4-4" /><path d="M3 9l4-4 5 3 5-3 4 4-5 5-2-2-3 2z" /></svg>,
  recycle: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M7 5l2-3 2 3" /><path d="M9 2v7" /><path d="M17 9l3 1-1 3" /><path d="M4 14l-1 3 3 1" /></svg>,
};
type PlanStrategy = Extract<ReportComposition["plan"], { groups: unknown }>["groups"][number]["strategies"][number];
/** A strategy's icon, from what it is about: energy, transport, else how much of it the client controls. */
const actionIcon = (strategy: PlanStrategy) =>
  /energy|electric|power|heat/i.test(strategy.category) ? ACTION_ICONS.bolt
    : /transport|fleet|travel|vehicle|logistic/i.test(strategy.category) ? ACTION_ICONS.truck
      : strategy.controlLevel === "supply_chain" ? ACTION_ICONS.handshake : strategy.controlLevel === "influence" ? ACTION_ICONS.recycle : ACTION_ICONS.bolt;
/** The chip the mockup puts beside an action: who does it. */
const CONTROL_CHIP: Record<string, string> = { direct_control: "Operational", supply_chain: "Value chain", influence: "Influence" };

function ActionsSection({ composition, number }: { composition: ReportComposition; number: string }) {
  const head = <><div className="r5-kicker">{number} · Plan</div><h2 className="r5-h2">Carbon Reduction Actions</h2><ClientFlag /></>;
  if (isReportGap(composition.plan)) return <>{head}<p className="r5-unavailable">{composition.plan.reason}</p></>;
  const strategies = composition.plan.groups.flatMap((group) => group.strategies);
  // Grouped by how much of each the client controls, in the mockup's order; a strategy frozen without one is said to be so.
  const levels = [...strategyControlLevels, null] as const;
  const groups = levels.map((level) => ({ level, items: strategies.filter((strategy) => (strategy.controlLevel ?? null) === level) })).filter((group) => group.items.length);
  const points = targetPoints(composition);
  const total = isReportGap(composition.emissions) ? null : composition.emissions.totalTco2e;
  return <>
    {head}
    <Narrative>
      <p>{composition.client} has identified <Tok>{strategies.length}</Tok> carbon reduction action{strategies.length === 1 ? "" : "s"}, grouped by how much of each the client controls{total !== null ? <> and targeted at the categories that drive its <Tok>{f1(total)} tCO₂e</Tok> emissions</> : null}.</p>
      {points?.netZero ? <p>Progress is reviewed at least annually alongside the recalculated emissions{points.interim ? <>, on the pathway to <Tok>−{points.interim.pct}% by {points.interim.year}</Tok></> : null} and net zero by <Tok>{points.netZero.year}</Tok>.</p> : null}
    </Narrative>
    {groups.map((group) => <div key={group.level ?? "none"}>
      <div className="r5-control-level">{group.level ? strategyControlLevelLabels[group.level] : "Not classified by control level"}</div>
      {group.items.map((strategy) => <div className="r5-act" key={strategy.title}>
        <div className="r5-ai">{actionIcon(strategy)}</div>
        <div><div className="r5-nm">{strategy.title}{strategy.controlLevel ? <span className="r5-cl">{CONTROL_CHIP[strategy.controlLevel]}</span> : null}</div>
          <div className="r5-u">Scope {strategy.scope} · {strategy.category}</div></div>
        <span className={`r5-st r5-st-${strategy.status}`}>{strategyStatusLabels[strategy.status]}{strategy.status === "in_progress" ? ` · ${strategy.progressPct}%` : ""}</span>
      </div>)}
    </div>)}
    <div className="r5-note">{composition.plan.excludedCount > 0 ? `${composition.plan.excludedCount} further strateg${composition.plan.excludedCount === 1 ? "y is" : "ies are"} on the client's plan but not included in this report. ` : ""}The plan is qualitative: its percentages are progress, not carbon.</div>
  </>;
}

/** The mockup's five-step ladder colours, lightest to darkest. */
const MATURITY_COLOURS = ["#E4E9E5", "#CDEBD9", "#8FD3AE", "#2E9E68", "#0B6B41"];

function SrsSection({ composition, number }: { composition: ReportComposition; number: string }) {
  const head = <><div className="r5-kicker">{number} · Disclosure</div><h2 className="r5-h2">UK SRS Readiness Statement</h2><ClientFlag /></>;
  if (isReportGap(composition.srs)) return <>{head}<p className="r5-unavailable">{composition.srs.reason}</p></>;
  const srs = composition.srs;
  const roadmap = srs.roadmap;
  const gaps = roadmap ? roadmap.pillars.flatMap((pillar) => pillar.gaps.map((gap) => ({ pillar, gap }))) : [];
  return <>
    {head}
    <p className="r5-prose">Assessed against UK SRS S2 (climate), led, with S1 (general) alongside — {srs.pillars.length === 4 ? "four" : srs.pillars.length} pillars on a five-step maturity ladder. Overall <b>{srs.overallLabel} ({Math.round(srs.overallPct)}%)</b>, assessed on {dd(srs.assessedOn)}. {roadmap ? "The roadmap below lists the shortfall-ordered gaps and the client strategies addressing each, frozen at issue." : ""}</p>
    <div className="r5-mgrid">
      {srs.pillars.map((pillar) => {
        // The pillar's frozen maturity (the average of its requirements, 0–4), drawn on the five-step ladder.
        const level = Math.max(0, Math.min(4, Math.round(pillar.maturity)));
        return <div className="r5-mat" key={pillar.label}><div className="r5-p">{pillar.label}</div><div className="r5-lv">{pillar.maturityLabel}</div>
          <div className="r5-dots">{[0, 1, 2, 3, 4].map((step) => <i key={step} style={{ background: step <= level ? MATURITY_COLOURS[level] : MATURITY_COLOURS[0] }} />)}</div></div>;
      })}
    </div>
    {roadmap ? <>
      <h3 className="r5-h3">Readiness roadmap</h3>
      {gaps.length === 0 ? <div className="r5-callout">Nothing sits below its target maturity.</div> : gaps.map(({ pillar, gap }) =>
        <div key={`${pillar.key}-${gap.code}`} className={`r5-callout${gap.strategies.length ? "" : " r5-callout-amber"}`}>
          {gap.code} {pillar.label} — {gap.title} · {gap.strategies.length
            ? <><b>Addressed by:</b> {gap.strategies.map((strategy) => `${strategy.title}, ${strategy.statusLabel.toLowerCase()}`).join("; ")}</>
            : "No strategy aligned yet"}
        </div>)}
    </> : null}
  </>;
}

// ── 12 · Methodology & Sign-off, 13 · Glossary, 14 · Appendix 1, 15 · Appendix 2 ─────────────────────────────────────────
/** The locked data-quality tiers (CLAUDE.md), in order, with their bar colours; a row the snapshot did not tier, last, in grey. */
const QUALITY_TIERS: Array<{ key: string; label: string; colour: string }> = [
  { key: "measured", label: "Measured", colour: BRAND }, { key: "estimated", label: "Estimated", colour: AMBER },
  { key: "spend-based", label: "Spend-based", colour: SKY }, { key: "survey", label: "Survey", colour: VIOLET },
  { key: "", label: "Not recorded", colour: "#C9D3CD" },
];

/** The quality mix by tCO₂e, summed at render from the frozen audit rows' own tier — nothing new frozen. */
function qualityMix(composition: ReportComposition) {
  const rows = composition.audit?.rows ?? [];
  const total = rows.reduce((sum, row) => sum + row.tco2e, 0);
  if (!(total > 0)) return null;
  return QUALITY_TIERS.map((tier) => ({ ...tier, value: rows.filter((row) => (row.qualityTier ?? "") === tier.key || (tier.key === "" && !QUALITY_TIERS.some((known) => known.key && known.key === row.qualityTier))).reduce((sum, row) => sum + row.tco2e, 0) }))
    .filter((tier) => tier.value > 0).map((tier) => ({ ...tier, share: pc(tier.value, total) }));
}

/** "Scope 1 & 2 measured · Scope 3 estimated & spend-based": each scope's tiers, from the frozen audit rows. */
function qualitySummary(composition: ReportComposition): string | null {
  const rows = composition.audit?.rows ?? [];
  if (!rows.length) return null;
  const tiersOf = (scope: string) => QUALITY_TIERS.filter((tier) => tier.key && rows.some((row) => row.scope === scope && row.qualityTier === tier.key)).map((tier) => tier.label.toLowerCase());
  const groups = new Map<string, string[]>();
  for (const scope of ["1", "2", "3"]) {
    const tiers = tiersOf(scope);
    if (!tiers.length) continue;
    const key = tiers.join(" & ");
    groups.set(key, [...(groups.get(key) ?? []), scope]);
  }
  return [...groups.entries()].map(([tiers, scopes]) => `Scope ${scopes.join(" & ")} ${tiers}`).join(" · ") || null;
}

/** The sections this report leaves out at the issuer's choice, by composed@5's titles — said on Methodology, never silent (F-1). */
function omittedSections(composition: ReportComposition): string[] {
  return reportSectionPlanOf(composition).filter((entry) => !entry.included && entry.key in DRAWN && entry.key !== "cover").map((entry) => COMPOSED5_TITLES[entry.key] ?? entry.key);
}

function MethodologySection({ composition, number }: { composition: ReportComposition; number: string }) {
  const issuer = composition.issuer;
  const mix = qualityMix(composition);
  const omitted = omittedSections(composition);
  const period = composition.reportingPeriod;
  const asAt = composition.chartBasis?.generatedAt;
  const factors = composition.sources?.sets.map((set) => set.label).join(" · ");
  return <>
    <div className="r5-kicker">{number} · Assurance</div><h2 className="r5-h2">Standards, Methodology &amp; Sign-off</h2>
    <div className="r5-kvbox">
      <div className="r5-kr"><span>Framework</span><b>GHG Protocol Corporate Standard</b></div>
      <div className="r5-kr"><span>Emission factors</span><b>{factors || NOT_RECORDED}</b></div>
      <div className="r5-kr"><span>Reporting boundary</span><b>Operational control · in-service sites for {reportingYearLabel(composition)}</b></div>
      <div className="r5-kr"><span>Data quality</span><b>{qualitySummary(composition) ?? NOT_RECORDED}</b></div>
      <div className="r5-kr"><span>Assurance basis</span><b>{composition.assurance.statement}</b></div>
      <div className="r5-kr"><span>As-at date</span><b>{asAt ? dd(asAt) : period ? dd(period.to) : NOT_RECORDED}</b></div>
    </div>
    <div className="r5-verify"><h4>Basis of preparation</h4>
      <p>This greenhouse gas emissions report has been prepared in accordance with the GHG Protocol Corporate Accounting and Reporting Standard. Every figure is derived from {composition.client}&apos;s reviewed measurement snapshot and carries its factor set, version, data hash and as-at date. The platform records who reviewed the measurement; this report is <b>not third-party assured</b>.</p>
      {omitted.length ? <p>Omitted from this report at the issuer&rsquo;s choice: {omitted.join(", ")}.</p> : null}
    </div>
    <h3 className="r5-h3">Data quality</h3>
    <p className="r5-prose r5-lead">The mix of measured, estimated, spend-based and survey activity data behind the reported emissions, by tCO₂e.</p>
    {mix ? <><div className="r5-dqbar">{mix.map((tier) => <div key={tier.label} className="r5-dqseg" style={{ width: `${tier.share}%`, background: tier.colour }} />)}</div>
      <div className="r5-dqleg">{mix.map((tier) => <span key={tier.label}><i style={{ background: tier.colour }} />{tier.label} {tier.share}%</span>)}</div></>
      : <p className="r5-unavailable">This report holds no per-row quality record.</p>}
    <h3 className="r5-h3">Declaration &amp; sign-off</h3>
    <div className="r5-signgrid">
      {/* The firm's side is the frozen issuer (D3); the client's, the signee the version named (B2-3 call 2) — never guessed. */}
      <div className="r5-signbox"><div className="r5-st">Consultant</div>
        <div className="r5-sl">{issuer ? issuer.displayName : "Name & position"}</div><div className="r5-sl">Signature</div><div className="r5-sl">Date</div></div>
      <div className="r5-signbox"><div className="r5-st">Client approval</div>
        <div className="r5-sl">{composition.signee ? `${composition.signee.name}${composition.signee.jobTitle ? `, ${composition.signee.jobTitle}` : ""}` : "Name & position"}</div><div className="r5-sl">Signature</div><div className="r5-sl">Date</div></div>
    </div>
  </>;
}

/** The mockup's glossary: fixed terms, words only — no figures, no money. */
const GLOSSARY: Array<[string, string]> = [
  ["Baseline year", "The reference year against which emissions reductions are measured."],
  ["Emission factor", "A coefficient that converts activity data into GHG emissions."],
  ["GHG Protocol", "The globally recognised framework for measuring and managing greenhouse gas emissions."],
  ["Intensity metric", "Emissions normalised by business activity (per employee, per £ revenue, per tonne of product)."],
  ["Net zero", "A balance between greenhouse gas emissions produced and removed from the atmosphere."],
  ["Scope 1 / 2 / 3", "Direct emissions / purchased energy / all other value-chain emissions."],
  ["tCO₂e", "Tonnes of carbon dioxide equivalent — the standard unit for measuring carbon emissions."],
];

function GlossarySection() {
  return <>
    <div className="r5-kicker">Reference</div><h2 className="r5-h2">Glossary</h2>
    <table className="r5-rt"><thead><tr><th>Term</th><th>Definition</th></tr></thead>
      <tbody>{GLOSSARY.map(([term, definition]) => <tr key={term}><td className="r5-term">{term}</td><td>{definition}</td></tr>)}</tbody></table>
  </>;
}

function AuditSection({ composition }: { composition: ReportComposition }) {
  const head = <><div className="r5-kicker">Appendix 1</div><h2 className="r5-h2">Full Emissions Audit <span className="r5-thead-note">header repeats each page</span></h2><SiteFlag composition={composition} /></>;
  const audit = composition.audit;
  if (!audit || audit.rows.length === 0) return <>{head}<p className="r5-unavailable">This report holds no per-row audit record.</p></>;
  return <>
    {head}
    {/* The frozen audit, row for row, in the mockup's six columns. Details carries the activity, with the factor and its
        source beneath (composed@3's per-row provenance, B1); Quality stands where the mockup's Unit does — no unit is frozen. */}
    <table className="r5-rt r5-audit">
      <thead><tr><th>Site</th><th>Scope</th><th>Category</th><th>Details</th><th>Quality</th><th className="r5-num">tCO₂e</th></tr></thead>
      <tbody>
        {audit.rows.map((row, index) => <tr key={index}><td>{row.site ?? "Organisation-level"}</td><td className="r5-nowrap">Scope {row.scope}</td><td>{row.category}</td>
          <td>{row.activity}<div className="r5-prov-line">{row.factor}{row.source && row.source !== "Not recorded" ? ` · ${row.source}` : ""}</div></td>
          <td>{QUALITY_TIERS.find((tier) => tier.key && tier.key === row.qualityTier)?.label ?? "Not recorded"}</td><td className="r5-num">{f1(row.tco2e)}</td></tr>)}
        <tr className="r5-total"><td colSpan={5}>Total emissions</td><td className="r5-num">{f1(audit.totalTco2e)}</td></tr>
      </tbody>
    </table>
    <div className="r5-note">Every line item is derived from the job&apos;s reviewed figures; the total above reconciles to the report total with no rounding drift.</div>
  </>;
}

function SiteScopeAppendix({ composition }: { composition: ReportComposition }) {
  const head = <><div className="r5-kicker">Appendix 2</div><h2 className="r5-h2">Emissions by Site, Scope &amp; Category</h2><SiteFlag composition={composition} /></>;
  const slices = siteSlices(composition);
  if (!slices.length) return <>{head}<p className="r5-unavailable">This report has no site breakdown.</p></>;
  const total = slices.reduce((sum, slice) => sum + slice.site.totalTco2e, 0);
  return <>
    {head}
    <table className="r5-rt">
      <thead><tr><th>Site &amp; scope</th><th className="r5-num">tCO₂e</th></tr></thead>
      <tbody>
        {slices.map(({ site }) => {
          const by = new Map(site.byScope.map((entry) => [entry.scope, entry.tco2e]));
          return <Fragment key={site.siteId ?? "org"}>
            <tr className="r5-sub"><td>{site.label}</td><td className="r5-num">{f1(site.totalTco2e)}</td></tr>
            {["1", "2", "3"].filter((scope) => by.has(scope)).map((scope) => <tr key={scope}><td>Scope {scope}</td><td className="r5-num">{f1(by.get(scope)!)}</td></tr>)}
          </Fragment>;
        })}
        <tr className="r5-total"><td>Total emissions</td><td className="r5-num">{f1(total)}</td></tr>
      </tbody>
    </table>
  </>;
}

/** composed@5's section titles, as its pages head them — the studio's rail names its rows by these. */
export const COMPOSED5_TITLES: Readonly<Record<string, string>> = {
  "executive-summary": "Executive Summary",
  "narrative:net-zero-commitment": "Net Zero Commitment",
  "narrative:background": "Background & Organisation",
  sites: "Sites & Reporting Boundary",
  emissions: "Carbon Emissions Overview",
  intensity: "Intensity Metric Analysis",
  targets: "Targets & Reduction Pathway",
  "scope-analysis": "Analysis by Scope",
  "category-analysis": "Emissions by Scope & Category",
  plan: "Carbon Reduction Actions",
  srs: "UK SRS Readiness Statement",
  methodology: "Standards, Methodology & Sign-off",
  glossary: "Glossary",
  audit: "Full Emissions Audit",
  "appendix-sites": "Emissions by Site, Scope & Category",
};

/** Whether composed@5 draws a plan key as a page of its own — the same test its layout numbers by, shared with the rail. */
export const composed5Draws = (key: string): boolean => key in DRAWN;

/** The sections composed@5 draws so far, by plan key — the rest arrive at later checkpoints. */
const DRAWN: Record<string, (composition: ReportComposition, number: string) => ReactNode> = {
  "executive-summary": (composition, number) => <ExecutiveSummary composition={composition} number={number} />,
  "narrative:net-zero-commitment": (composition, number) => <NetZeroCommitment composition={composition} number={number} />,
  "narrative:background": (composition, number) => <Background composition={composition} number={number} />,
  sites: (composition, number) => <SitesSection composition={composition} number={number} />,
  emissions: (composition, number) => <OverviewSection composition={composition} number={number} />,
  intensity: (composition, number) => <IntensitySection composition={composition} number={number} />,
  targets: (composition, number) => <TargetsSection composition={composition} number={number} />,
  "scope-analysis": (composition, number) => <ScopeAnalysis composition={composition} number={number} />,
  "category-analysis": (composition, number) => <CategoryAnalysis composition={composition} number={number} />,
  plan: (composition, number) => <ActionsSection composition={composition} number={number} />,
  srs: (composition, number) => <SrsSection composition={composition} number={number} />,
  methodology: (composition, number) => <MethodologySection composition={composition} number={number} />,
  glossary: () => <GlossarySection />,
  audit: (composition) => <AuditSection composition={composition} />,
  "appendix-sites": (composition) => <SiteScopeAppendix composition={composition} />,
};


export function ComposedV5({ composition, issuerLogoSrc, clientLogoSrc = (assetId) => `/api/isolated/logo-assets/${encodeURIComponent(assetId)}`, preview = false, mode = "page" }: {
  composition: ReportComposition; issuerLogoSrc: LogoSrc; clientLogoSrc?: LogoSrc; preview?: boolean;
  /** The mockup's two views: A4 pages with running head and foot, or one continuous flow with page-break markers. */
  mode?: "page" | "flow";
}) {
  // The plan decides: Net Zero Commitment and Background are optional and movable like any section (decision 3).
  const layout = reportSectionLayout(reportSectionPlanOf(composition), (key) => key in DRAWN).filter((entry) => entry.key !== "cover");
  const pages = layout.length + 1;
  const title = reportTitle(composition);
  return <main className={`nzr5 r5-mode-${mode}`} data-renderer="composed@5">
    <div className="r5-pageflow">
      <section className="r5-page"><Cover composition={composition} issuerLogoSrc={issuerLogoSrc} clientLogoSrc={clientLogoSrc} preview={preview} /></section>
      {layout.map((entry, index) => {
        const page = index + 2;
        return <div key={entry.key} className="r5-pagewrap">
          <div className="r5-pbreak"><span className="r5-pb-num">Page {page} break</span></div>
          <section className="r5-page" data-section={entry.key}>
            <div className="r5-runhead"><b>{composition.client}</b>{title}</div>
            {DRAWN[entry.key]!(composition, entry.number ?? "")}
            <div className="r5-runfoot"><span>Private &amp; Confidential</span><span>{composition.client}</span><span className="r5-tnum">Page {page} of {pages}</span></div>
          </section>
        </div>;
      })}
    </div>
  </main>;
}
