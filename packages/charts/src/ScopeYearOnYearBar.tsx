import type { CSSProperties } from "react";
import type { ScopeYearOnYearData } from "./types";
import { tokens, scopeColor } from "./tokens";
import { comma, niceTicks, scaleLinear } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";

const W = 760, H = 340, M = { top: 28, right: 28, bottom: 54, left: 62 };
const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

export function ScopeYearOnYearBar({ data, width, showChrome = true }: { data: ScopeYearOnYearData; width?: number; showChrome?: boolean }) {
  const max = Math.max(0, ...data.years.flatMap((year) => year.values.map((value) => value.value)));
  const ticks = niceTicks(max, 4), yMax = ticks.at(-1) ?? 1;
  const y = scaleLinear(0, yMax, M.top + PH, M.top);
  const groupW = PW / Math.max(1, data.years.length), barW = Math.min(34, groupW / 4.5), gap = 5;
  const svg = <svg viewBox={`0 0 ${W} ${H}`} width={width ?? "100%"} height={width ? width * H / W : undefined} role="img" aria-label={data.spec.title} style={{ display: "block", fontFamily: tokens.font }}>
    {ticks.map((tick) => <g key={tick}><line x1={M.left} x2={M.left + PW} y1={y(tick)} y2={y(tick)} stroke={tokens.line} /><text x={M.left - 10} y={y(tick) + 4} textAnchor="end" fontSize={11} fill={tokens.ink.muted}>{comma(tick)}</text></g>)}
    {data.years.map((group, groupIndex) => {
      const centre = M.left + groupW * groupIndex + groupW / 2;
      const totalW = group.values.length * barW + (group.values.length - 1) * gap;
      return <g key={group.year}>{group.values.map((item, itemIndex) => { const x = centre - totalW / 2 + itemIndex * (barW + gap), top = y(item.value); return <rect key={item.scope} x={x} y={top} width={barW} height={M.top + PH - top} rx={3} fill={scopeColor(item.scope)}><title>{`${group.year} · Scope ${item.scope}: ${comma(item.value)} ${data.unit}`}</title></rect>; })}<text x={centre} y={M.top + PH + 24} textAnchor="middle" fontSize={12} fill={tokens.ink.secondary}>{group.year}</text></g>;
    })}
    <g transform={`translate(${M.left} 12)`}>{["1", "2", "3"].map((scope, i) => <g key={scope} transform={`translate(${i * 105} 0)`}><rect width={11} height={11} rx={3} fill={scopeColor(scope)} /><text x={17} y={10} fontSize={12} fill={tokens.ink.secondary}>Scope {scope}</text></g>)}</g>
  </svg>;
  return showChrome ? <figure style={frame}><figcaption><span style={kick}>{data.spec.subtitle ?? "Annual comparison"}</span><h3 style={title}>{data.spec.title}</h3></figcaption>{svg}<Footer data={data} /></figure> : svg;
}
function Footer({ data }: { data: ScopeYearOnYearData }) { return <p style={footer}><b>Source</b>{"  "}{data.provenance.factorSets.join(" · ")} · as at {formatDate(data.provenance.generatedAt)}</p>; }
const frame: CSSProperties = { background: tokens.surface, border: `1px solid ${tokens.line}`, borderRadius: 12, padding: "16px 18px 12px", margin: 0 };
const kick: CSSProperties = { fontSize: 10.5, letterSpacing: ".12em", textTransform: "uppercase", color: tokens.brand.emerald, fontWeight: 600 };
const title: CSSProperties = { fontSize: 16, fontWeight: 600, margin: "3px 0 2px", color: tokens.ink.primary };
const footer: CSSProperties = { fontSize: 11, color: tokens.ink.muted, margin: "8px 0 2px" };
