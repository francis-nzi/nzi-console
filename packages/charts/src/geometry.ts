// @nzi/charts — pure SVG geometry & formatting helpers (no React, no DOM).
// Deterministic: identical output on server (print) and client (screen).

/** Point on a circle, angle in degrees measured clockwise from 12 o'clock. */
export function polar(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): [number, number] {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** SVG path for an annular sector (donut segment) between two radii and angles. */
export function annularSector(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const large = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  const [xo0, yo0] = polar(cx, cy, rOuter, startAngle);
  const [xo1, yo1] = polar(cx, cy, rOuter, endAngle);
  const [xi1, yi1] = polar(cx, cy, rInner, endAngle);
  const [xi0, yi0] = polar(cx, cy, rInner, startAngle);
  return [
    `M ${f(xo0)} ${f(yo0)}`,
    `A ${f(rOuter)} ${f(rOuter)} 0 ${large} 1 ${f(xo1)} ${f(yo1)}`,
    `L ${f(xi1)} ${f(yi1)}`,
    `A ${f(rInner)} ${f(rInner)} 0 ${large} 0 ${f(xi0)} ${f(yi0)}`,
    "Z",
  ].join(" ");
}

/** Linear scale factory mapping [d0,d1] → [r0,r1]. */
export function scaleLinear(
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): (v: number) => number {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** "Nice" rounded tick values across [0, max] (max is raised to a clean bound). */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Polyline points string from [x,y] pairs. */
export function points(pts: Array<[number, number]>): string {
  return pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");
}

/** Round to 2dp for compact, stable SVG output. */
export function f(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Thousands-separated integer (tabular contexts). */
export function comma(n: number): string {
  return Math.round(n).toLocaleString("en-GB");
}

/** Compact tonnes label: 1,418 / 12.9k / 1.24M. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(n / 1000)}k`;
  return comma(n);
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

export function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}
