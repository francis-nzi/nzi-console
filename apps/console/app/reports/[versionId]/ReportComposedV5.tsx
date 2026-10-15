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

/** The sections composed@5 draws so far, by plan key — the rest arrive at later checkpoints. */
const DRAWN: Record<string, (composition: ReportComposition, number: string) => ReactNode> = {
  "executive-summary": (composition, number) => <ExecutiveSummary composition={composition} number={number} />,
};

export function ComposedV5({ composition, issuerLogoSrc, clientLogoSrc = (assetId) => `/api/isolated/logo-assets/${encodeURIComponent(assetId)}`, preview = false, mode = "page" }: {
  composition: ReportComposition; issuerLogoSrc: LogoSrc; clientLogoSrc?: LogoSrc; preview?: boolean;
  /** The mockup's two views: A4 pages with running head and foot, or one continuous flow with page-break markers. */
  mode?: "page" | "flow";
}) {
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
