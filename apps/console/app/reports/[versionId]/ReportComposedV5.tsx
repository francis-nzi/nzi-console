import type { ReactNode } from "react";
import { isReportGap, reportSectionLayout, reportSectionPlanOf, type ReportComposition } from "@nzi/contracts";
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
  const floors = slices.map(({ site }) => site.floorAreaIntensity?.floorAreaM2 ?? null);
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
          {/* Not frozen into the composition — listed for Cowork's ruling (CHECKPOINT-composed5-3). */}
          <td>{site.siteId === null ? "" : NOT_RECORDED}</td>
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
        {/* Per-site figures exist for this period only; earlier periods are not frozen by site (listed for the ruling). */}
        <table className="r5-rt">
          <thead><tr><th>Site</th><th className="r5-num">Current period</th></tr></thead>
          <tbody>
            {slices.map(({ site }) => <tr key={site.siteId ?? "org"}><td>{site.label}</td><td className="r5-num">{f1(site.totalTco2e)}</td></tr>)}
            <tr className="r5-total"><td>Total</td><td className="r5-num">{f1(slices.reduce((sum, slice) => sum + slice.site.totalTco2e, 0))}</td></tr>
          </tbody>
        </table></div> : null}
    </div>
    <div className="r5-note">{FACTOR_NOTE}</div>
    <div className="r5-chartcard">
      <div className="r5-chead"><b>Emissions summary by scope</b><SvgTag /></div>
      <div className="r5-donutwrap"><Donut scopes={scopes} total={total} /><DonutLegend scopes={scopes} total={total} /></div>
      <SrcLine composition={composition} />
    </div>
  </>;
}

/** composed@5's section titles, as its pages head them — the studio's rail names its rows by these. */
export const COMPOSED5_TITLES: Readonly<Record<string, string>> = {
  "executive-summary": "Executive Summary",
  "narrative:net-zero-commitment": "Net Zero Commitment",
  "narrative:background": "Background & Organisation",
  sites: "Sites & Reporting Boundary",
  emissions: "Carbon Emissions Overview",
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
