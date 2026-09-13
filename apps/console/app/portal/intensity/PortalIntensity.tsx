"use client";

/**
 * Client portal · emissions intensity — READ-ONLY.
 *
 * Every figure on this page is `resolveIntensity(assured total, the measure's value)` from
 * `@nzi/contracts` — the one computation the client workspace, the report and this page all
 * share, so the client cannot be shown a different number from their consultant. Nothing is
 * computed locally, nothing is inferred: a measure with no value recorded for a year reads
 * "Unavailable" with the reason, never 0 and never borrowed from another year.
 *
 * The icons are the console's own `IntensityMetricIcon`, keyed by the definition's
 * `iconKey`, so a measure wears the same glyph here as it does in the console and the
 * report.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  activeMetrics, intensityUnit, intensityUnitShort, resolveIntensity,
  type IntensityMetricDefinition, type ResolvedIntensity,
} from "@nzi/contracts";
import type { PortalIntensityReadModel, PortalIntensityYear } from "@nzi/isolated-backend";
import { IntensityMetricIcon } from "../../clients/[clientId]/IntensityMetricIcon";
import { formatDate } from "../../lib/formatDate";
import { redirectIfPortalSessionEnded } from "../portalSessionClient";
import { isPortalIntensity } from "./portalIntensityValidation";

type Point = { year: number; intensity: ResolvedIntensity };
type Resolved = Extract<ResolvedIntensity, { state: "resolved" }>;
type ResolvedPoint = { year: number; intensity: Resolved };

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; model: PortalIntensityReadModel };

const fy = (year: number) => `FY${String(year).slice(-2)}`;
const figure = (value: number) => value >= 100
  ? Math.round(value).toLocaleString("en-GB")
  : value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
const isResolved = (point: Point): point is ResolvedPoint => point.intensity.state === "resolved";

/**
 * What the client calls the measure, in plain words: "Per employee", "Per £m turnover",
 * "Per m² floor area". The unit wording alone is enough when the label says the same thing
 * ("employee" / "Employees"); a symbol like "£m" needs the label to mean anything.
 */
function metricName(definition: IntensityMetricDefinition): string {
  const unit = definition.unitWording.trim(), label = definition.label.trim().toLowerCase();
  if (!unit) return `Per ${label}`;
  const said = label.includes(unit.toLowerCase()) || unit.toLowerCase().includes(label);
  return said ? `Per ${unit}` : `Per ${unit} ${label}`;
}

/** One year on one measure, through the shared resolver. The denominator's own reason wins. */
function intensityFor(year: PortalIntensityYear, definition: IntensityMetricDefinition): ResolvedIntensity {
  const denominator = year.denominators[definition.key];
  const resolved = resolveIntensity({
    definition,
    emissionsTco2e: year.totalTco2e,
    value: denominator?.value ?? null,
    source: denominator?.source === "none" ? undefined : denominator?.source,
  });
  if (resolved.state === "unavailable" && denominator?.reason) return { ...resolved, reason: denominator.reason };
  return resolved;
}

const seriesFor = (years: readonly PortalIntensityYear[], definition: IntensityMetricDefinition): Point[] =>
  years.map((year) => ({ year: year.year, intensity: intensityFor(year, definition) }));

export function PortalIntensity() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const response = await fetch("/api/portal/intensity", { cache: "no-store" });
      if (await redirectIfPortalSessionEnded(response)) return;
      if (!response.ok) { setState({ kind: "failed", message: "Your intensity figures could not be loaded." }); return; }
      const body: unknown = await response.json();
      if (!isPortalIntensity(body)) { setState({ kind: "failed", message: "The assured figures could not be verified." }); return; }
      setState({ kind: "ready", model: body });
    } catch (cause) {
      setState({ kind: "failed", message: cause instanceof Error ? cause.message : "Your intensity figures could not be loaded." });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state.kind === "loading") {
    return <div className="nz-portal-state loading" role="status"><i>↻</i><div>
      <b>Loading your intensity figures</b>
      <span>Reading your assured reporting years and the measures set up for your business…</span>
    </div></div>;
  }
  if (state.kind === "failed") {
    return <div className="nz-portal-state failed" role="alert"><i>!</i><div>
      <b>Your intensity figures are temporarily unavailable</b>
      <span>{state.message} Nothing has been estimated or filled in — no figure is shown until it can be read from your assured report.</span>
      <button className="nz-btn" onClick={() => void load()}>Try again</button>
    </div></div>;
  }

  return <PortalIntensityView model={state.model} />;
}

function PortalIntensityView({ model }: { model: PortalIntensityReadModel }) {
  const metrics = useMemo(() => activeMetrics(model.metrics), [model.metrics]);
  const years = model.years;
  const [metricKey, setMetricKey] = useState<string>("");
  const chosen = metrics.find((metric) => metric.key === metricKey) ?? metrics[0] ?? null;

  if (years.length === 0) {
    return <div className="nz-portal-state" role="status"><i>✓</i><div>
      <b>Your first assured year will appear here</b>
      <span>
        Intensity is measured against your assured emissions, so it appears once your NZI team publishes a
        verified report for your business. Nothing is shown from work in progress.
      </span>
    </div></div>;
  }

  if (metrics.length === 0) {
    return <div className="nz-portal-state" role="status"><i>◈</i><div>
      <b>No measures are set up for your business yet</b>
      <span>
        Intensity compares your emissions against a measure of your activity — people, turnover, floor area,
        or anything else that matters to you. Your NZI consultant sets these up with you; once they are in
        place, your figures appear here for every assured year.
      </span>
    </div></div>;
  }

  const latest = years[years.length - 1]!;

  return <>
    <p className="nz-pi-lead">
      <span className="nz-pi-assured">✓ Assured figures</span>
      Every number below comes from your published, verified footprint — {fy(latest.year)}
      {model.reportingYear !== null && model.publishedAt !== null
        ? <> and the assured years before it, published {formatDate(model.publishedAt)}.</>
        : <> and the assured years before it.</>}
      {" "}Intensity shows whether your emissions are falling against how much business you are doing.
    </p>

    <div className="nz-pi-tiles">
      {metrics.map((metric) => <MetricTile key={metric.key} definition={metric} points={seriesFor(years, metric)} />)}
    </div>

    <section className="nz-pi-card" aria-label="Intensity over time">
      <div className="nz-pi-card-head">
        <h2>Intensity over time</h2>
        <span className="sp" />
        <label className="nz-sr-only" htmlFor="nz-pi-metric">Measure</label>
        <select id="nz-pi-metric" value={chosen?.key ?? ""} onChange={(event) => setMetricKey(event.target.value)}>
          {metrics.map((metric) => <option key={metric.key} value={metric.key}>{metricName(metric)}</option>)}
        </select>
      </div>
      {chosen ? <MetricChart definition={chosen} points={seriesFor(years, chosen)} /> : null}
      <p className="nz-pi-foot">
        Intensity = your assured emissions divided by the measure shown. Measures and their icons are set with
        your NZI consultant; the values are recorded each reporting year. <b>Lower is better.</b>
      </p>
    </section>

    {model.dataHash ? <p className="nz-pi-evidence">
      Evidence identity {model.dataHash.slice(0, 15)}… · emissions in tCO₂e · figures read from your published report, never re-stated here.
    </p> : null}
  </>;
}

/* ── Tiles ──────────────────────────────────────────────────────────────────────────── */

function MetricTile({ definition, points }: { definition: IntensityMetricDefinition; points: Point[] }) {
  const resolved = points.filter(isResolved);
  const current = resolved[resolved.length - 1] ?? null;
  const previous = resolved[resolved.length - 2] ?? null;
  const change = current && previous && previous.intensity.value !== 0
    ? ((current.intensity.value - previous.intensity.value) / previous.intensity.value) * 100
    : null;
  const direction = change === null ? "flat" : change < -0.05 ? "down" : change > 0.05 ? "up" : "flat";
  const latest = points[points.length - 1];
  const reason = latest && latest.intensity.state === "unavailable" ? latest.intensity.reason : null;

  return <article className="nz-pi-tile">
    <div className="nz-pi-tile-top">
      <span className="ic"><IntensityMetricIcon iconKey={definition.iconKey} size={18} /></span>
      <span className="nm">{metricName(definition)}</span>
    </div>

    {current === null
      ? <>
        <div className="nz-pi-na">Unavailable</div>
        <p className="nz-pi-note">{reason ?? `No value has been recorded for ${definition.label.toLowerCase()} in any assured year yet.`}</p>
      </>
      : <>
        <div className="nz-pi-big">
          {figure(current.intensity.value)}
          <span className="u">{intensityUnit(definition)}</span>
        </div>
        {change === null || previous === null
          ? <p className="nz-pi-note">{fy(current.year)} is the first year this measure resolves — a year-on-year change needs two.</p>
          : <div className={`nz-pi-delta ${direction}`}>
            {direction === "down" ? "▼" : direction === "up" ? "▲" : "■"}{" "}
            {direction === "flat" ? "No change" : `${Math.abs(change).toFixed(1)}%`} vs {fy(previous.year)}
          </div>}
        {latest && latest.intensity.state === "unavailable"
          ? <p className="nz-pi-note">{fy(latest.year)}: unavailable — {latest.intensity.reason} The figure above is {fy(current.year)}.</p>
          : null}
        <div className="nz-pi-spark">
          <Sparkline values={resolved.map((point) => point.intensity.value)} improving={direction !== "up"}
            label={`${definition.label} intensity, ${resolved.map((point) => `${fy(point.year)} ${figure(point.intensity.value)}`).join(", ")} ${intensityUnitShort(definition)}`} />
        </div>
      </>}
  </article>;
}

/** A shape, not a figure — the numbers are read out above and in the chart below. */
function Sparkline({ values, improving, label }: { values: number[]; improving: boolean; label: string }) {
  if (values.length < 2) return null;
  const width = 150, height = 34;
  const max = Math.max(...values), min = Math.min(...values);
  const range = max - min || Math.abs(max) || 1;
  const step = width / (values.length - 1);
  const y = (value: number) => height - 3 - ((value - min) / range) * (height - 6);
  const stroke = improving ? "var(--pine)" : "var(--danger)";
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
    <polyline points={values.map((value, index) => `${index * step},${y(value)}`).join(" ")}
      fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    <circle cx={width - 1.5} cy={y(values[values.length - 1]!)} r={3} fill={stroke} />
  </svg>;
}

/* ── The chart ──────────────────────────────────────────────────────────────────────── */

const VB_W = 900, VB_H = 262;
const PAD = { top: 26, right: 20, bottom: 34, left: 58 };

/** A rounded axis top, so the labels read as figures rather than as arbitrary decimals. */
function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => value <= candidate * magnitude) ?? 10;
  return step * magnitude;
}

function MetricChart({ definition, points }: { definition: IntensityMetricDefinition; points: Point[] }) {
  const resolved = points.filter(isResolved);
  const unit = intensityUnit(definition);

  const years = <div className="nz-pi-years">
    {points.slice().reverse().map((point) => <div key={point.year}>
      <span className="k">{fy(point.year)}</span>
      <span className={`v${point.intensity.state === "resolved" ? "" : " na"}`}>
        {point.intensity.state === "resolved"
          ? `${figure(point.intensity.value)} ${intensityUnitShort(definition)}`
          : `Unavailable — ${point.intensity.reason}`}
      </span>
    </div>)}
  </div>;

  if (resolved.length < 2) {
    return <>
      <p className="nz-pi-chart-note" style={{ paddingTop: 14 }}>
        {resolved.length === 1
          ? `Only ${fy(resolved[0]!.year)} resolves on this measure, so there is no line to draw yet — a trend needs two reporting years.`
          : "No reporting year resolves on this measure yet, so nothing is drawn. Nothing has been estimated in its place."}
      </p>
      {years}
    </>;
  }

  const top = niceMax(Math.max(...resolved.map((point) => point.intensity.value)) * 1.12);
  const ticks = [0, top / 4, top / 2, (top * 3) / 4, top];
  const plotW = VB_W - PAD.left - PAD.right, plotH = VB_H - PAD.top - PAD.bottom;
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const x = (index: number) => PAD.left + step * index;
  const y = (value: number) => PAD.top + plotH - (value / top) * plotH;

  // Runs of consecutive resolved years. A year that does not resolve breaks the line
  // rather than being bridged across — the gap is the truth.
  const runs: Array<Array<{ index: number; value: number }>> = [];
  let run: Array<{ index: number; value: number }> = [];
  points.forEach((point, index) => {
    if (point.intensity.state === "resolved") run.push({ index, value: point.intensity.value });
    else if (run.length) { runs.push(run); run = []; }
  });
  if (run.length) runs.push(run);

  return <>
    <div className="nz-pi-chart">
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} role="img"
        aria-label={`${definition.label} intensity by reporting year, in ${unit}. ${resolved.map((point) => `${fy(point.year)} ${figure(point.intensity.value)}`).join(", ")}.`}>
        <text x={PAD.left} y={14} fontSize={11.5} fill="var(--t3)">{unit}</text>
        {ticks.map((tick) => <g key={tick}>
          <line x1={PAD.left} x2={VB_W - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--line2)" strokeWidth={1} />
          <text x={PAD.left - 10} y={y(tick) + 4} textAnchor="end" fontSize={11} fill="var(--t3)"
            style={{ fontVariantNumeric: "tabular-nums" }}>{figure(tick)}</text>
        </g>)}
        {points.map((point, index) => <text key={point.year} x={x(index)} y={VB_H - 12} textAnchor="middle" fontSize={11.5}
          fill={point.intensity.state === "resolved" ? "var(--t2)" : "var(--t3)"}
          style={{ fontVariantNumeric: "tabular-nums" }}>{fy(point.year)}</text>)}
        {runs.map((segment) => segment.length < 2 ? null : <polyline key={`run-${segment[0]!.index}`}
          points={segment.map((entry) => `${x(entry.index)},${y(entry.value)}`).join(" ")}
          fill="none" stroke="var(--emerald)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />)}
        {resolved.map((point) => {
          const index = points.findIndex((entry) => entry.year === point.year);
          return <g key={point.year}>
            <circle cx={x(index)} cy={y(point.intensity.value)} r={4.5} fill="var(--emerald)" stroke="var(--card)" strokeWidth={2} />
            <text x={x(index)} y={y(point.intensity.value) - 11} textAnchor="middle" fontSize={11.5} fontWeight={700}
              fill="var(--t1)" style={{ fontVariantNumeric: "tabular-nums" }}>{figure(point.intensity.value)}</text>
          </g>;
        })}
      </svg>
    </div>
    <p className="nz-pi-chart-note">
      Measured in {unit}. Each point is that year&apos;s assured emissions divided by your recorded{" "}
      {definition.label.toLowerCase()} figure. A year with no recorded value is left out rather than joined up.
    </p>
    {years}
  </>;
}
