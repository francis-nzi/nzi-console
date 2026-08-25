import type { CSSProperties } from "react";
import type { SiteDonutData } from "./types";
import { tokens, siteColor } from "./tokens";
import { annularSector, comma, compact, pct } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";

const W = 760, H = 320, CX = 150, CY = 160, OUT = 118, INNER = 88;
const MID = (OUT + INNER) / 2, GAP = (2 / MID) * (180 / Math.PI);

export function EmissionsSiteDonut({ data, width, showChrome = true }: { data: SiteDonutData; width?: number; showChrome?: boolean }) {
  const ordered = [...data.sites].filter((site) => site.value > 0).sort((a, b) => b.value - a.value);
  const visible = ordered.length <= 6 ? ordered : [...ordered.slice(0, 5), { id: "other", label: "Other sites", value: ordered.slice(5).reduce((sum, site) => sum + site.value, 0) }];
  const total = data.total ?? ordered.reduce((sum, site) => sum + site.value, 0);
  let cursor = 0;
  const arcs = visible.map((site) => { const sweep = total ? site.value / total * 360 : 0; const start = cursor + GAP / 2, end = cursor + sweep - GAP / 2; cursor += sweep; return { site, color: siteColor(site.id), path: end > start ? annularSector(CX, CY, OUT, INNER, start, end) : "" }; });
  const rowH = Math.min(44, 250 / Math.max(1, visible.length));
  const svg = <svg viewBox={`0 0 ${W} ${H}`} width={width ?? "100%"} height={width ? width * H / W : undefined} role="img" aria-label={data.spec.title} style={{ display: "block", fontFamily: tokens.font }}>
    {arcs.map(({ site, color, path }) => path && <path key={site.id} d={path} fill={color}><title>{`${site.label}: ${comma(site.value)} ${data.unit} (${pct(site.value, total)})`}</title></path>)}
    <text x={CX} y={CY - 4} textAnchor="middle" fontSize={38} fontWeight={600} fill={tokens.ink.primary}>{compact(total)}</text><text x={CX} y={CY + 18} textAnchor="middle" fontSize={13} fill={tokens.ink.secondary}>{data.unit}</text><text x={CX} y={CY + 36} textAnchor="middle" fontSize={10.5} letterSpacing={1.2} fill={tokens.ink.muted}>TOTAL</text>
    <g transform={`translate(320 ${CY - visible.length * rowH / 2})`}>{visible.map((site, i) => <g key={site.id} transform={`translate(0 ${i * rowH})`}><rect width={11} height={11} rx={3} fill={siteColor(site.id)} /><text x={20} y={10} fontSize={12.5} fontWeight={600} fill={tokens.ink.primary}>{site.label}</text><text x={0} y={29} fontSize={13.5} fontWeight={600} fill={tokens.ink.primary}>{comma(site.value)}<tspan fontSize={10.5} fontWeight={400} fill={tokens.ink.muted}> {data.unit}</tspan></text><text x={250} y={29} textAnchor="end" fontSize={12} fill={tokens.ink.secondary}>{pct(site.value, total)}</text></g>)}</g>
  </svg>;
  return showChrome ? <figure style={frame}><figcaption><span style={kick}>{data.spec.subtitle ?? "Emissions by site"}</span><h3 style={title}>{data.spec.title}</h3></figcaption>{svg}<p style={footer}><b>Source</b>{"  "}{data.provenance.factorSets.join(" · ")} · as at {formatDate(data.provenance.generatedAt)}</p></figure> : svg;
}
const frame: CSSProperties = { background: tokens.surface, border: `1px solid ${tokens.line}`, borderRadius: 12, padding: "16px 18px 12px", margin: 0 };
const kick: CSSProperties = { fontSize: 10.5, letterSpacing: ".12em", textTransform: "uppercase", color: tokens.brand.emerald, fontWeight: 600 };
const title: CSSProperties = { fontSize: 16, fontWeight: 600, margin: "3px 0 2px", color: tokens.ink.primary };
const footer: CSSProperties = { fontSize: 11, color: tokens.ink.muted, margin: "8px 0 2px" };
