// @nzi/charts — the portal Metrics view's re-formattable marks (BUILD-portal-shell-lookandfeel R8).
//
// The same figures drawn in the forms their job allows — part-to-whole as donut, pie or bar; a trend as line or bar — chosen by
// the caller from `metricFormsFor` (console). Built to the dataviz mark specs: thin marks, a 2px surface gap between fills,
// 4px rounded data-ends on the value side, 2px lines with ≥8px markers, one y-axis only, a recessive grid, and text in the ink
// tokens — never the series colour; identity is carried by the mark beside the label. Every mark has a <title>, so hovering it
// says what it is and its value. Colours come from `tokens` only (deterministic, as every chart here).
import { tokens } from "./tokens";

export type MetricSlice = { key: string; label: string; value: number; color: string; muted?: boolean };
export type MetricSeries = { key: string; label: string; color: string; values: Array<number | null> };

const fmt = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: value >= 100 ? 0 : 1 });
const pct = (part: number, whole: number) => whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
const text = { fontFamily: tokens.font } as const;

/** Part-to-whole as a ring (or, `pie`, a filled disc), with the legend as direct labels: swatch, name, value, share. */
export function MetricRing({ slices, pie = false, unit, title }: { slices: MetricSlice[]; pie?: boolean; unit: string; title: string }) {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const size = 200, r = 92, inner = pie ? 0 : 58, cx = size / 2, cy = size / 2;
  let angle = -Math.PI / 2;
  const arcs = slices.filter((slice) => slice.value > 0).map((slice) => {
    const sweep = total > 0 ? (slice.value / total) * Math.PI * 2 : 0;
    const start = angle, end = angle + sweep;
    angle = end;
    return { slice, start, end };
  });
  const point = (radius: number, theta: number) => `${cx + radius * Math.cos(theta)} ${cy + radius * Math.sin(theta)}`;
  const path = ({ start, end }: { start: number; end: number }) => {
    // A single full slice is a full circle (SVG arcs cannot close on themselves).
    if (end - start >= Math.PI * 2 - 1e-6) return pie ? `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`
      : `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 M ${cx - inner} ${cy} a ${inner} ${inner} 0 1 1 ${inner * 2} 0 a ${inner} ${inner} 0 1 1 ${-inner * 2} 0`;
    const large = end - start > Math.PI ? 1 : 0;
    return inner === 0
      ? `M ${cx} ${cy} L ${point(r, start)} A ${r} ${r} 0 ${large} 1 ${point(r, end)} Z`
      : `M ${point(r, start)} A ${r} ${r} 0 ${large} 1 ${point(r, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)} Z`;
  };
  return (
    <div className="nz-metric-ring" style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${title}: ${slices.map((slice) => `${slice.label} ${fmt(slice.value)} ${unit}`).join(", ")}`}>
        {arcs.map((arc) => (
          // The 2px surface stroke is the gap between neighbouring fills.
          <path key={arc.slice.key} d={path(arc)} fill={arc.slice.color} fillRule="evenodd" stroke={tokens.surface} strokeWidth={2}>
            <title>{`${arc.slice.label}: ${fmt(arc.slice.value)} ${unit} (${pct(arc.slice.value, total)})`}</title>
          </path>
        ))}
        {pie ? null : <>
          <text x={cx} y={cy - 2} textAnchor="middle" style={{ ...text, fontSize: 24, fontWeight: 800 }} fill={tokens.ink.primary}>{fmt(total)}</text>
          <text x={cx} y={cy + 16} textAnchor="middle" style={{ ...text, fontSize: 11 }} fill={tokens.ink.muted}>{unit} total</text>
        </>}
      </svg>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8, minWidth: 0, flex: "1 1 180px" }}>
        {slices.map((slice) => (
          <li key={slice.key} style={{ display: "grid", gridTemplateColumns: "12px 1fr auto auto", gap: 10, alignItems: "center", fontSize: 13, color: tokens.ink.primary }}>
            <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 3, background: slice.color }} />
            <span>{slice.label}</span>
            <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(slice.value)} <small style={{ color: tokens.ink.muted, fontWeight: 500 }}>{unit}</small></b>
            <span style={{ color: tokens.ink.secondary, fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right" }}>{pct(slice.value, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Magnitude (or part-to-whole) as horizontal bars, largest first, each labelled with its value; `muted` bars recede (emphasis). */
export function MetricBars({ rows, unit, title }: { rows: MetricSlice[]; unit: string; title: string }) {
  const max = Math.max(0, ...rows.map((row) => row.value));
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
  return (
    <div role="img" aria-label={`${title}: ${rows.map((row) => `${row.label} ${fmt(row.value)} ${unit}`).join(", ")}`} style={{ display: "grid", gap: 9 }}>
      {rows.map((row) => (
        <div key={row.key} style={{ display: "grid", gridTemplateColumns: "minmax(90px, 32%) 1fr auto", gap: 12, alignItems: "center", fontSize: 13, color: row.muted ? tokens.ink.muted : tokens.ink.primary }}>
          <span style={{ overflowWrap: "anywhere" }}>{row.label}</span>
          <svg viewBox="0 0 100 12" preserveAspectRatio="none" height={12} style={{ width: "100%", display: "block" }} aria-hidden="true">
            <rect x={0} y={0} width={100} height={12} fill={tokens.line2} rx={3} />
            <rect x={0} y={0} width={max > 0 ? Math.max(0.6, (row.value / max) * 100) : 0} height={12} rx={3} fill={row.muted ? tokens.line : row.color}>
              <title>{`${row.label}: ${fmt(row.value)} ${unit} (${pct(row.value, total)})`}</title>
            </rect>
          </svg>
          <b style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmt(row.value)} <small style={{ color: tokens.ink.muted, fontWeight: 500 }}>{unit} · {pct(row.value, total)}</small></b>
        </div>
      ))}
    </div>
  );
}

/** Change over time on one y-axis: lines (2px, 8px markers, labelled at the end) or grouped bars per year. A gap year is a gap. */
export function MetricTrend({ years, series, form, unit, title }: { years: number[]; series: MetricSeries[]; form: "line" | "bar"; unit: string; title: string }) {
  const width = 640, height = 260, left = 44, right = form === "line" ? 96 : 12, top = 12, bottom = 28;
  const plotW = width - left - right, plotH = height - top - bottom;
  const max = Math.max(1, ...series.flatMap((entry) => entry.values.filter((value): value is number => value !== null)));
  const step = niceStep(max / 4);
  const ceiling = Math.ceil(max / step) * step;
  const y = (value: number) => top + plotH - (value / ceiling) * plotH;
  const band = plotW / Math.max(1, years.length);
  const x = (index: number) => left + band * index + band / 2;
  const ticks = Array.from({ length: Math.round(ceiling / step) + 1 }, (_, index) => index * step);
  const barW = Math.min(22, (band * 0.7) / Math.max(1, series.length));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", display: "block" }} role="img"
      aria-label={`${title}: ${series.map((entry) => `${entry.label} ${entry.values.map((value, index) => `${years[index]} ${value === null ? "no report" : fmt(value)}`).join(", ")}`).join("; ")} ${unit}`}>
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke={tokens.line2} strokeWidth={1} />
          <text x={left - 8} y={y(tick) + 4} textAnchor="end" style={{ ...text, fontSize: 10.5 }} fill={tokens.ink.muted}>{fmt(tick)}</text>
        </g>
      ))}
      <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} stroke={tokens.line} strokeWidth={1} />
      {years.map((year, index) => <text key={year} x={x(index)} y={height - 8} textAnchor="middle" style={{ ...text, fontSize: 11 }} fill={tokens.ink.secondary}>{year}</text>)}
      {form === "bar" ? series.map((entry, seriesIndex) => entry.values.map((value, index) => value === null ? null : (
        <rect key={`${entry.key}-${index}`} x={x(index) - (barW * series.length) / 2 + seriesIndex * barW + 1} width={Math.max(1, barW - 2)}
          y={y(value)} height={Math.max(0, y(0) - y(value))} rx={3} fill={entry.color}>
          <title>{`${entry.label}, ${years[index]}: ${fmt(value)} ${unit}`}</title>
        </rect>
      ))) : series.map((entry) => {
        const points = entry.values.map((value, index) => value === null ? null : { x: x(index), y: y(value), value, year: years[index] });
        // Each run of reported years is its own line: a year with no report breaks it rather than being drawn through.
        const runs: Array<Array<{ x: number; y: number }>> = [];
        points.forEach((p, index) => { if (!p) return; if (index === 0 || !points[index - 1]) runs.push([]); runs[runs.length - 1]!.push(p); });
        const last = [...points].reverse().find(Boolean);
        return (
          <g key={entry.key}>
            {runs.map((run, index) => <polyline key={index} points={run.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={entry.color} strokeWidth={2} strokeLinejoin="round" />)}
            {points.map((p) => p ? (
              <circle key={p.year} cx={p.x} cy={p.y} r={4.5} fill={entry.color} stroke={tokens.surface} strokeWidth={2}>
                <title>{`${entry.label}, ${p.year}: ${fmt(p.value)} ${unit}`}</title>
              </circle>
            ) : null)}
            {last ? <text x={last.x + 10} y={last.y + 4} style={{ ...text, fontSize: 11, fontWeight: 700 }} fill={tokens.ink.secondary}>{entry.label}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}

function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const scaled = raw / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}
